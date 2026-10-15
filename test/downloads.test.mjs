import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Downloader, ErrorType, isEmlNetworkError } from '../dist/index.js'

const sha1 = (value) => createHash('sha1').update(value).digest('hex')
const payload = Buffer.from('verified replacement')
const file = (name = 'game.jar', extra = {}) => ({
  name,
  path: '',
  url: 'https://fixture.invalid/file',
  size: payload.length,
  sha1: sha1(payload),
  type: 'OTHER',
  ...extra
})
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function directory(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'eml-download-test-'))
  t.after(async () => {
    const resolved = await fs.realpath(root),
      parent = await fs.realpath(tmpdir())
    assert.equal(path.dirname(resolved), parent)
    assert.ok(path.basename(resolved).startsWith('eml-download-test-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  return root
}
async function server(t, listener) {
  const server = createServer(listener)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

test('verified downloads replace the old file only after the whole payload is received', async (t) => {
  const root = await directory(t),
    destination = path.join(root, 'game.jar'),
    partial = deferred(),
    finish = deferred()
  await fs.writeFile(destination, 'old working file')
  const downloader = new Downloader(root, undefined, {
    retries: 0,
    fetch: async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(payload.subarray(0, 5))
            partial.resolve()
            await finish.promise
            controller.enqueue(payload.subarray(5))
            controller.close()
          }
        })
      )
  })
  const running = downloader.download([file()], true)
  await partial.promise
  assert.equal(await fs.readFile(destination, 'utf8'), 'old working file')
  finish.resolve()
  await running
  assert.deepEqual(await fs.readFile(destination), payload)
  assert.deepEqual(await fs.readdir(root), ['game.jar'])
})

for (const kind of ['hash', 'short', 'long', 'stream'])
  test(`${kind} failures retain the old file and remove temporary files`, async (t) => {
    const root = await directory(t),
      destination = path.join(root, 'game.jar')
    await fs.writeFile(destination, 'old working file')
    const downloader = new Downloader(root, undefined, {
      retries: 0,
      fetch: async () => {
        if (kind === 'stream') {
          let sent = false
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (!sent) {
                  sent = true
                  controller.enqueue(payload.subarray(0, 5))
                } else controller.error(new TypeError('Interrupted transfer'))
              }
            })
          )
        }
        return new Response(
          kind === 'hash' ? Buffer.alloc(payload.length, 1) : kind === 'short' ? payload.subarray(0, 3) : Buffer.concat([payload, payload])
        )
      }
    })
    await assert.rejects(downloader.download([file()], true))
    assert.equal(await fs.readFile(destination, 'utf8'), 'old working file')
    assert.deepEqual(await fs.readdir(root), ['game.jar'])
  })

test('failure to rename the verified temporary file never deletes the old destination', async (t) => {
  const root = await directory(t),
    destination = path.join(root, 'game.jar'),
    original = fs.rename
  await fs.writeFile(destination, 'old working file')
  fs.rename = async (source, target) => {
    if (target === destination) throw Object.assign(Error('Fixture sharing violation'), { code: 'EPERM' })
    return original(source, target)
  }
  t.after(() => {
    fs.rename = original
  })
  const downloader = new Downloader(root, undefined, { retries: 0, fetch: async () => new Response(payload) })
  await assert.rejects(downloader.download([file()], true), (error) => error.code === 'EPERM')
  assert.equal(await fs.readFile(destination, 'utf8'), 'old working file')
  assert.deepEqual(await fs.readdir(root), ['game.jar'])
})

test('zero-byte and unknown-size files are downloaded, and existing sizes are checked', async (t) => {
  const root = await directory(t)
  const downloader = new Downloader(root, undefined, { retries: 0, fetch: async (url) => new Response(url.endsWith('/empty') ? '' : payload) })
  await downloader.download([file('empty', { url: 'https://fixture.invalid/empty', size: 0, sha1: sha1('') }), file('unknown', { size: undefined })])
  assert.equal((await fs.stat(path.join(root, 'empty'))).size, 0)
  assert.deepEqual(await fs.readFile(path.join(root, 'unknown')), payload)
  assert.equal((await downloader.getFilesToDownload([file('unknown', { size: 2, sha1: undefined })])).length, 1)
})

test('cancelling a live stream drains workers and removes temporaries before rejection', async (t) => {
  const root = await directory(t),
    controller = new AbortController(),
    sourceCancelled = deferred()
  await fs.writeFile(path.join(root, 'game.jar'), 'old working file')
  const downloader = new Downloader(root, undefined, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(payload.subarray(0, 5))
          },
          cancel() {
            sourceCancelled.resolve()
          }
        })
      )
  })
  let ended = 0,
    cancelled = 0,
    failed = 0
  downloader.on('download_progress', () => controller.abort())
  downloader.on('download_end', () => ended++)
  downloader.on('download_cancelled', () => cancelled++)
  downloader.on('download_error', () => failed++)
  await assert.rejects(
    downloader.download([file()], true, { signal: controller.signal }),
    (error) => error.code === ErrorType.OPERATION_CANCELLED && !isEmlNetworkError(error)
  )
  await sourceCancelled.promise
  assert.deepEqual({ ended, cancelled, failed }, { ended: 0, cancelled: 1, failed: 0 })
  assert.equal(await fs.readFile(path.join(root, 'game.jar'), 'utf8'), 'old working file')
  assert.deepEqual(await fs.readdir(root), ['game.jar'])
})

test('cancellation interrupts a retry delay and prevents a second HTTP request', async (t) => {
  const root = await directory(t),
    controller = new AbortController(),
    started = deferred()
  let requests = 0
  const downloader = new Downloader(root, undefined, {
    retryDelayMs: 10000,
    fetch: async () => {
      requests++
      started.resolve()
      return Response.json({}, { status: 503 })
    }
  })
  const result = assert.rejects(
    downloader.download([file()], true, { signal: controller.signal }),
    (error) => error.code === ErrorType.OPERATION_CANCELLED
  )
  await started.promise
  await delay(20)
  controller.abort()
  await result
  assert.equal(requests, 1)
  assert.deepEqual(await fs.readdir(root), [])
})

test('a failed worker cancels siblings and returns only when all temporary files are gone', async (t) => {
  const root = await directory(t),
    slowStarted = deferred(),
    cancelled = deferred()
  const downloader = new Downloader(root, undefined, {
    retries: 0,
    fetch: async (url) => {
      if (url.endsWith('/bad')) {
        await slowStarted.promise
        return Response.json({}, { status: 401 })
      }
      slowStarted.resolve()
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(Buffer.from('partial'))
          },
          cancel() {
            cancelled.resolve()
          }
        })
      )
    }
  })
  await assert.rejects(
    downloader.download([file('bad', { url: 'https://fixture.invalid/bad' }), file('slow', { size: undefined, sha1: undefined })], true),
    (error) => error.status === 401
  )
  await cancelled.promise
  assert.deepEqual(await fs.readdir(root), [])
})

test('retry progress counts only the successful attempt and emits completion once', async (t) => {
  const root = await directory(t)
  let requests = 0,
    ended
  const downloader = new Downloader(root, undefined, {
    retryDelayMs: 0,
    fetch: async () => (++requests === 1 ? Response.json({}, { status: 503 }) : new Response(payload))
  })
  downloader.on('download_end', (value) => {
    assert.equal(ended, undefined)
    ended = value
  })
  await downloader.download([file()])
  assert.equal(requests, 2)
  assert.deepEqual(ended.downloaded, { amount: 1, size: payload.length })
})

test('only the exact configured AdminTool origin, mount and download path receive credentials', async (t) => {
  const root = await directory(t),
    requests = []
  const base = 'https://admin.fixture.invalid/mount'
  const downloader = new Downloader(root, 'fixture-secret', {
    adminToolUrl: base,
    retries: 0,
    fetch: async (url, init) => {
      requests.push({ url, authorization: new Headers(init.headers).get('authorization'), redirect: init.redirect })
      return new Response(payload)
    }
  })
  const urls = [
    `${base}/files/files-updater/pack/file`,
    'https://foreign.invalid/mount/files/files-updater/pack/file',
    'https://sub.admin.fixture.invalid/mount/files/files-updater/pack/file',
    'http://admin.fixture.invalid/mount/files/files-updater/pack/file',
    'https://user:password@admin.fixture.invalid/mount/files/files-updater/pack/file',
    `${base}/elsewhere?next=files/files-updater`,
    `${base}/files/files-updater-evil/file`,
    `${base}/files/files-updater/pack%2ffile`
  ]
  for (let i = 0; i < urls.length; i++) await downloader.download([file(String(i), { url: urls[i] })], true)
  assert.equal(requests[0].authorization, 'Bearer fixture-secret')
  assert.equal(requests[0].redirect, 'error')
  assert.ok(requests.slice(1).every((request) => request.authorization === null))
  const legacy = new Downloader(root, 'fixture-secret', {
    retries: 0,
    fetch: async (_, init) => {
      assert.equal(new Headers(init.headers).get('authorization'), null)
      return new Response(payload)
    }
  })
  await legacy.download([file('legacy', { url: urls[0] })], true)
})

test('real HTTP redirects cannot forward a protected download bearer to another server', async (t) => {
  const root = await directory(t),
    foreignRequests = [],
    trustedRequests = []
  const foreign = await server(t, (request, response) => {
    foreignRequests.push(request.headers.authorization)
    response.end(payload)
  })
  const trusted = await server(t, (request, response) => {
    trustedRequests.push(request.headers.authorization)
    if (request.url.endsWith('/redirect')) {
      response.writeHead(302, { location: `${foreign}/files/files-updater/leak` })
      response.end()
    } else response.end(payload)
  })
  const downloader = new Downloader(root, 'fixture-secret', { adminToolUrl: trusted, retries: 0 })
  await downloader.download(
    [file('trusted', { url: `${trusted}/files/files-updater/pack/file` }), file('foreign', { url: `${foreign}/files/files-updater/pack/file` })],
    true
  )
  await assert.rejects(downloader.download([file('redirect', { url: `${trusted}/files/files-updater/pack/redirect` })], true))
  assert.deepEqual(trustedRequests, ['Bearer fixture-secret', 'Bearer fixture-secret'])
  assert.deepEqual(foreignRequests, [undefined])
})

test('skipCheck never bypasses path validation', async (t) => {
  const root = await directory(t)
  const downloader = new Downloader(root, undefined, {
    fetch: async () => {
      throw Error('Unexpected request')
    }
  })
  await assert.rejects(downloader.download([file('escape', { path: '..' })], true), (error) => error.code === ErrorType.CONFIG_ERROR)
  assert.deepEqual(await fs.readdir(root), [])
})
