import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import {
  KintareClient,
  KintareAuth,
  KintareEndpointResolver,
  ProfileAccess,
  Profile,
  requestInstanceToken,
  InstanceAuthError,
  HttpClient,
  EMLLibError,
  ErrorType,
  isEmlNetworkError,
  Launcher,
  AuthAgent,
  normalizeMemory,
  javaConfiguration,
  serverTarget
} from '../dist/index.js'
import { filterPreservedDownloads } from '../dist/lib/launcher/preservation.js'
import Cleaner from '../dist/lib/launcher/cleaner.js'
import Downloader from '../dist/lib/utils/downloader.js'
import { configureHttp, News } from '../dist/index.js'

const account = {
  name: 'Fixture',
  uuid: 'a'.repeat(32),
  accessToken: 'oidc-fixture',
  refreshToken: 'refresh-fixture',
  clientToken: 'client-fixture',
  sessionId: 'session-fixture',
  meta: { type: 'msa', online: false }
}
const jwt = () =>
  `fixture.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 7200 })).toString('base64url')}.fixture`
const png = () => {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(64, 16)
  bytes.writeUInt32BE(32, 20)
  return bytes
}
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eml-refactor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const noDiscovery = (next) => async (url, init) =>
  url.includes('/.well-known/') ? Response.json({}) : next(url, init)

test('connection failures remain retryable through refresh and game-token exchange', async () => {
  const auth = new KintareAuth({
    fetch: noDiscovery(async () => {
      throw new TypeError('Connection failed')
    })
  })
  for (const method of ['refresh', 'getGameToken'])
    await assert.rejects(
      auth[method](account),
      (error) => error.code === ErrorType.NET_ERROR && isEmlNetworkError(error)
    )
  assert.equal(isEmlNetworkError(new Error('Programming error')), false)
  assert.equal(isEmlNetworkError(new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid Java')), false)
  assert.equal(
    isEmlNetworkError(new EMLLibError(ErrorType.TOO_MANY_REQUESTS, 'Retry later')),
    false
  )
})

for (const [status, body, code] of [
  [400, { error: 'invalid_grant' }, ErrorType.AUTH_ERROR],
  [401, {}, ErrorType.AUTH_ERROR],
  [403, {}, ErrorType.AUTH_ERROR],
  [404, {}, ErrorType.INVALID_OPERATION],
  [429, {}, ErrorType.TOO_MANY_REQUESTS],
  [500, {}, ErrorType.FETCH_ERROR]
])
  test(`refresh preserves structured HTTP ${status} refusal`, async () => {
    const auth = new KintareAuth({
      fetch: noDiscovery(async () => Response.json(body, { status }))
    })
    await assert.rejects(
      auth.refresh(account),
      (error) => error.code === code && error.status === status && error.serverCode === body.error
    )
  })

test('the host transport is used and credentialed redirects are refused', async () => {
  let request
  const http = new HttpClient({
    fetch: async (url, init) => {
      request = { url, init }
      return Response.json({ ok: true })
    }
  })
  await http.fetch('https://fixture.invalid', { headers: { Authorization: 'Bearer fixture' } })
  assert.equal(request.init.redirect, 'error')
  assert.equal(request.init.signal instanceof AbortSignal, true)
  await http.fetch('https://fixture.invalid/token', {
    method: 'POST',
    body: 'refresh_token=fixture'
  })
  assert.equal(request.init.redirect, 'error')
})

test('dynamic issuer, discovered services, game endpoints and explicit extensions share one discovery', async () => {
  const calls = []
  const client = new KintareClient({
    issuer: 'https://identity.example/oidc',
    trustedOrigins: ['https://services.example', 'https://sessions.example'],
    endpoints: { render: 'https://render.example', authAgent: 'https://agents.example/download' },
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/.well-known/'))
        return Response.json({
          issuer: 'https://identity.example/oidc',
          token_endpoint: 'https://identity.example/oidc/token-v2',
          kintare_services_url: 'https://services.example/v2',
          kintare_sessions_url: 'https://sessions.example',
          kintare_yggdrasil: {
            minecraft_token_endpoint: 'https://identity.example/game',
            invalidate_endpoint: 'https://identity.example/game/invalidate'
          }
        })
      if (url.endsWith('/token-v2'))
        return Response.json({ access_token: jwt(), refresh_token: 'next-refresh' })
      if (url.endsWith('/game'))
        return Response.json({ accessToken: 'game-fixture', clientToken: 'game-client' })
      return Response.json({ profile: { id: account.uuid }, slots: [] })
    }
  })
  await Promise.all([
    client.auth.refresh(account),
    client.wardrobes.get(account, account.uuid),
    client.auth.getGameToken(account)
  ])
  assert.equal(calls.filter((c) => c.url.includes('/.well-known/')).length, 1)
  assert.ok(
    calls.some(
      (c) =>
        c.url ===
        'https://services.example/v2/minecraft/kintare/profiles/' + account.uuid + '/wardrobes'
    )
  )
  assert.ok(calls.some((c) => c.url === 'https://identity.example/game'))
  assert.ok(calls.every((c) => !c.url.includes('kintarestudio.com')))
  assert.equal((await client.endpoints.resolve()).render, 'https://render.example')
})

test('a failed custom discovery never sends its credentials to production', async () => {
  const calls = []
  const client = new KintareClient({
    issuer: 'https://private.example/mount',
    fetch: async (url) => {
      calls.push(url)
      if (url.includes('/.well-known/')) throw new TypeError('Unavailable')
      return Response.json({ access_token: jwt(), refresh_token: 'new' })
    }
  })
  await client.auth.refresh(account)
  assert.deepEqual(calls, [
    'https://private.example/mount/.well-known/openid-configuration',
    'https://private.example/mount/token'
  ])
})

test('malformed discovery cannot redirect credentials to arbitrary or decorated URLs', async () => {
  for (const target of [
    'https://foreign.example',
    'http://services.kintarestudio.com',
    'https://u:p@services.kintarestudio.com',
    'https://services.kintarestudio.com/?token=1'
  ]) {
    const endpoints = new KintareEndpointResolver({
      fetch: async () => Response.json({ kintare_services_url: target })
    })
    assert.equal((await endpoints.resolve()).services, 'https://services.kintarestudio.com')
  }
})

test('two real local deployments keep discovery and authenticated requests isolated', async (t) => {
  async function deployment(name) {
    const calls = []
    let origin
    const server = createServer(async (req, res) => {
      calls.push({ url: req.url, authorization: req.headers.authorization })
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify(
          req.url.includes('/.well-known/')
            ? {
                issuer: `${origin}/oidc`,
                token_endpoint: `${origin}/oidc/token`,
                kintare_services_url: origin
              }
            : req.url.endsWith('/token')
              ? { access_token: jwt(), refresh_token: name }
              : { profile: { id: account.uuid, name }, slots: [] }
        )
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
    t.after(() => new Promise((resolve) => server.close(resolve)))
    return { client: new KintareClient({ issuer: `${origin}/oidc` }), calls, name }
  }
  const a = await deployment('alpha'),
    b = await deployment('beta')
  const [wa, wb] = await Promise.all([
    a.client.wardrobes.get({ ...account, accessToken: 'alpha-token' }, account.uuid),
    b.client.wardrobes.get({ ...account, accessToken: 'beta-token' }, account.uuid)
  ])
  assert.equal(wa.profile.name, 'alpha')
  assert.equal(wb.profile.name, 'beta')
  assert.equal(a.calls.at(-1).authorization, 'Bearer alpha-token')
  assert.equal(b.calls.at(-1).authorization, 'Bearer beta-token')
})

test('device authentication uses the configured issuer and its discovered endpoints', async () => {
  const calls = []
  const auth = new KintareAuth({
    issuer: 'https://private.example/oidc',
    clientId: 'custom-client',
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/.well-known/'))
        return Response.json({
          device_authorization_endpoint: 'https://private.example/device',
          token_endpoint: 'https://private.example/exchange',
          kintare_services_url: 'https://private.example/services'
        })
      if (url.endsWith('/device'))
        return Response.json({
          device_code: 'fixture-device',
          user_code: 'ABC',
          verification_uri: 'https://private.example/verify',
          interval: 0,
          expires_in: 30
        })
      if (url.endsWith('/exchange'))
        return Response.json({ access_token: jwt(), refresh_token: 'refresh' })
      return Response.json([{ id: account.uuid, name: 'Player' }])
    }
  })
  let prompt
  const result = await auth.auth((code, url) => {
    prompt = { code, url }
  })
  assert.equal(result.name, 'Player')
  assert.equal(prompt.url, 'https://private.example/verify')
  assert.ok(
    calls.find((c) => c.url.endsWith('/device')).init.body.includes('client_id=custom-client')
  )
})

test('protected access deduplicates requests and forget prevents late successful restoration', async () => {
  let password = 'saved',
    resolve,
    calls = 0
  const access = new ProfileAccess(
    'https://fixture.invalid',
    {
      get: () => password,
      set: (_, value) => {
        password = value
      }
    },
    {
      fetch: async () => {
        calls++
        return new Promise((r) => {
          resolve = r
        })
      }
    }
  )
  const a = access.check('slug'),
    b = access.check('slug')
  assert.equal(calls, 1)
  access.forget('slug')
  resolve(Response.json({ success: true, token: jwt() }))
  assert.equal((await a).status, 'password-required')
  await b
  assert.equal(access.getToken('slug'), null)
})

test('a late manual authentication cannot restore a forgotten instance', async () => {
  let password = null,
    resolve
  const access = new ProfileAccess(
    'https://fixture.invalid',
    {
      get: () => password,
      set: (_, value) => {
        password = value
      }
    },
    {
      fetch: () =>
        new Promise((r) => {
          resolve = r
        })
    }
  )
  const pending = access.authenticate('slug', 'new')
  access.forget('slug')
  resolve(Response.json({ success: true, token: jwt() }))
  await assert.rejects(pending, /changed/)
  assert.equal(password, null)
})

for (const [status, body, expected] of [
  [401, { success: false }, 'BAD_PASSWORD'],
  [401, {}, 'UNKNOWN'],
  [403, { success: false }, 'UNKNOWN'],
  [429, {}, 'LOCKED_OUT'],
  [503, {}, 'OFFLINE']
])
  test(`protected authentication distinguishes HTTP ${status} with ${JSON.stringify(body)}`, async () => {
    await assert.rejects(
      requestInstanceToken('https://fixture.invalid', 'a/b', 'password', async (url) => {
        assert.ok(url.endsWith('/a%2Fb/auth'))
        return Response.json(body, { status })
      }),
      (error) => error instanceof InstanceAuthError && error.code === expected
    )
  })

test('Profile auth and externally cached metadata use the same injected transport', async () => {
  const calls = []
  const profile = new Profile('https://fixture.invalid', undefined, {
    fetch: async (url, init) => {
      calls.push({ url, init })
      return Response.json(
        url.endsWith('/auth') ? { success: true, token: jwt() } : { success: true, profiles: [] }
      )
    }
  })
  const result = await profile.auth('fixture', 'password')
  await profile.metadata(account, result.token)
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${result.token}`)
})

test('session refresh is persisted as OIDC, while its game token is released only once', async () => {
  const calls = [],
    updated = []
  const client = new KintareClient({
    fetch: noDiscovery(async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/token'))
        return Response.json({ access_token: jwt(), refresh_token: 'rotated' })
      if (url.endsWith('/player/profiles'))
        return Response.json([{ id: account.uuid, name: 'Renamed' }])
      if (url.endsWith('/oauth'))
        return Response.json({ accessToken: 'game-token', clientToken: 'game-client' })
      return Response.json({})
    })
  })
  const session = await client.auth.prepareGameSession(account, {
    onAccount: (value) => updated.push(value)
  })
  assert.equal(session.account.accessToken, 'game-token')
  assert.equal(session.account.name, 'Renamed')
  assert.ok(updated.every((value) => value.accessToken !== 'game-token'))
  await Promise.all([session.release(), session.release()])
  assert.equal(calls.filter((call) => call.url.endsWith('/invalidate')).length, 1)
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
    accessToken: 'game-token',
    clientToken: 'game-client'
  })
})

test('game session permits connectivity fallback only when explicitly enabled', async () => {
  const offline = []
  const client = new KintareClient({
    fetch: noDiscovery(async () => {
      throw new TypeError('Offline')
    })
  })
  const result = await client.auth.prepareGameSession(account, {
    allowOffline: true,
    onOffline: (source) => offline.push(source)
  })
  assert.equal(result.account.accessToken, account.accessToken)
  assert.deepEqual(offline, ['oidc', 'services', 'yggdrasil'])
  await assert.rejects(client.auth.prepareGameSession(account), (error) => isEmlNetworkError(error))
})

test('equal heaps, invalid values and a low-memory host yield consistent limits', () => {
  assert.deepEqual(normalizeMemory({ min: 4096, max: 4096 }), { min: 4096, max: 4096 })
  const launcher = new Launcher({
    root: 'fixture',
    account,
    minecraft: { version: '1.21.1' },
    memory: { min: 4096, max: 4096 },
    cleaning: { ignored: ['custom/'], ignoredMode: 'extend' }
  })
  assert.equal(launcher.config.memory.min, launcher.config.memory.max)
  assert.ok(launcher.config.cleaning.ignored.includes('saves/'))
  assert.ok(launcher.config.cleaning.ignored.includes('custom/'))
  const small = normalizeMemory({ min: 8192, max: NaN }, 2048)
  assert.ok(small.max >= small.min && small.max <= 2048)
  assert.deepEqual(javaConfiguration('C:/Java/bin/java.exe'), {
    install: 'manual',
    absolutePath: 'C:/Java/bin/java.exe'
  })
  assert.throws(() => javaConfiguration('path'), /again/)
})

test('preservation keeps user files while allowing managed modpack updates', async (t) => {
  const root = await directory(t)
  await mkdir(path.join(root, 'config'))
  await writeFile(path.join(root, 'config', 'user.toml'), 'user setting')
  await writeFile(path.join(root, 'config', 'managed.toml'), 'old managed setting')
  const files = ['user.toml', 'managed.toml', 'new.toml'].map((name) => ({
    name,
    path: 'config/',
    url: '',
    type: 'CONFIG'
  }))
  const selected = await filterPreservedDownloads(files, root, ['config/user.toml'])
  assert.deepEqual(
    selected.map((f) => f.name),
    ['managed.toml', 'new.toml']
  )
  assert.equal(await readFile(path.join(root, 'config', 'user.toml'), 'utf8'), 'user setting')
  const defaultMode = await filterPreservedDownloads(files, root, [])
  assert.equal(defaultMode.length, 3)
})

test('cleaner protects full path components and does not preserve a similarly named folder', async (t) => {
  const root = await directory(t)
  await mkdir(path.join(root, 'saves'))
  await mkdir(path.join(root, 'saves-old'))
  await writeFile(path.join(root, 'saves', 'world'), 'world')
  await writeFile(path.join(root, 'saves-old', 'obsolete'), 'obsolete')
  const cleaner = new Cleaner({ root })
  await cleaner.clean([], ['saves/'])
  assert.equal(await readFile(path.join(root, 'saves', 'world'), 'utf8'), 'world')
  assert.deepEqual(await readdir(path.join(root, 'saves-old')), [])
})

test('auth-agent cache handles ETag, concurrent calls, corrupt updates and offline reuse', async (t) => {
  const root = await directory(t)
  const valid = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4])
  let requests = 0,
    mode = 'download',
    conditional
  const agent = new AuthAgent({
    url: 'https://fixture.invalid/agent',
    cacheDirectory: root,
    fileName: 'loki.jar',
    fetch: async (_, init) => {
      requests++
      conditional = init.headers['If-None-Match']
      if (mode === 'offline') throw new TypeError('Offline')
      if (mode === 'not-modified') return new Response(null, { status: 304 })
      return new Response(mode === 'corrupt' ? 'not a jar' : valid, {
        headers: { etag: '"fixture"', 'content-length': String(valid.length) }
      })
    }
  })
  const [first, second] = await Promise.all([agent.ensure(), agent.ensure()])
  assert.equal(first, second)
  assert.equal(requests, 1)
  mode = 'not-modified'
  assert.equal(await agent.ensure(), first)
  assert.equal(conditional, '"fixture"')
  mode = 'corrupt'
  assert.equal(await agent.ensure(), first)
  assert.deepEqual(await readFile(first), valid)
  mode = 'offline'
  assert.equal(await agent.ensure(), first)
  assert.ok((await readdir(root)).every((name) => !name.includes('.tmp-')))
})

test('server target parsing remains a pure public utility', () => {
  assert.equal(serverTarget(null), null)
  assert.equal(serverTarget({ ip: '[::1]:25566' }).port, 25566)
})

test('concurrent operations share one refresh rotation without losing a selected profile', async () => {
  let rotations = 0,
    resolve
  const auth = new KintareAuth({
    fetch: noDiscovery(async () => {
      rotations++
      return new Promise((r) => {
        resolve = r
      })
    })
  })
  const first = auth.ensureSession({ ...account, noProfile: false, displayName: 'Operator' })
  const second = auth.ensureSession({ ...account, uuid: 'b'.repeat(32), name: 'Managed' })
  await new Promise((r) => setImmediate(r))
  assert.equal(rotations, 1)
  resolve(Response.json({ access_token: jwt() }))
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.refreshToken, account.refreshToken)
  assert.equal(a.displayName, 'Operator')
  assert.equal(b.name, 'Managed')
  assert.equal(b.uuid, 'b'.repeat(32))
})

test('connectivity probes and auth-agent arguments follow a configured deployment', async () => {
  const urls = []
  const client = new KintareClient({
    issuer: 'https://custom.example/oidc',
    fetch: async (url) => {
      urls.push(url)
      return Response.json({})
    }
  })
  assert.deepEqual(await client.ping(), { oidc: true, yggdrasil: true, services: true })
  assert.ok(urls.every((url) => url.startsWith('https://custom.example/')))
  const args = await client.authAgentArguments('/fixture/agent.jar')
  assert.ok(args[0].endsWith('=custom.example'))
  assert.ok(args.includes('-DLoki.enforce_secure_profile=true'))
})

test('existing news and downloader classes use the configured transport and do not retry a rate limit', async (t) => {
  const root = await directory(t)
  const nativeFetch = globalThis.fetch
  t.after(() => configureHttp({ fetch: nativeFetch }))
  let calls = 0
  configureHttp({
    fetch: async (url) => {
      calls++
      return url.endsWith('/news')
        ? Response.json({ success: true, news: [] })
        : Response.json({ error: 'rate_limited' }, { status: 429 })
    }
  })
  assert.deepEqual(await new News('https://fixture.invalid').getNews(), [])
  const downloader = new Downloader(root)
  await assert.rejects(
    downloader.download([
      {
        name: 'fixture.jar',
        path: '',
        url: 'https://fixture.invalid/file',
        size: 1,
        type: 'LIBRARY'
      }
    ]),
    (error) => error.status === 429 && error.code === ErrorType.TOO_MANY_REQUESTS
  )
  assert.equal(calls, 2)
})

test('discovery supports the current and legacy Kintare domains without accepting lookalikes', async () => {
  for (const base of ['https://services.kintare.studio', 'https://services.kintarestudio.com']) {
    const resolver = new KintareEndpointResolver({
      fetch: async () => Response.json({ kintare_services_url: base })
    })
    assert.equal((await resolver.resolve()).services, base)
  }
  const resolver = new KintareEndpointResolver({
    fetch: async () =>
      Response.json({ kintare_services_url: 'https://services.kintare.studio.evil.example' })
  })
  assert.equal((await resolver.resolve()).services, 'https://services.kintarestudio.com')
})
