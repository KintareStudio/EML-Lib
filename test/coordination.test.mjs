import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  KintareSessions,
  KintareProfiles,
  KintareClient,
  Maintenance,
  Profile,
  EMLLibError,
  ErrorType,
  jvmArguments
} from '../dist/index.js'

const account = {
  name: 'Selected',
  uuid: 'a'.repeat(32),
  accessToken: 'fixture',
  refreshToken: 'refresh',
  sessionId: 'session',
  meta: { type: 'msa', online: false }
}
const identity = { id: account.uuid, name: account.name }

test('maintenance policy respects scheduled starts and account bypass without requiring a login', async () => {
  const maintenance = new Maintenance('https://fixture.invalid')
  const now = Date.now()
  let status = { startTime: new Date(now + 1), canBypass: false }
  maintenance.getMaintenance = async () => status
  assert.equal(await maintenance.getActiveMaintenance(now), null)
  status = { startTime: new Date(now), canBypass: true }
  assert.equal(await maintenance.getActiveMaintenance(now), null)
  status = { startTime: new Date(now), canBypass: false }
  assert.equal(await maintenance.getActiveMaintenance(now), status)
  status = null
  assert.equal(await maintenance.getActiveMaintenance(now), null)
})

test('avatar URLs follow discovered rendering endpoints and encode names without credentials', async () => {
  let requests = 0
  const client = new KintareClient({
    issuer: 'https://accounts.example.test/oidc',
    trustedOrigins: ['https://render.example.test'],
    fetch: async () => {
      requests++
      return Response.json({
        issuer: 'https://accounts.example.test/oidc',
        kintare_render_url: 'https://render.example.test/v1'
      })
    }
  })
  assert.equal(
    await client.avatarUrl('A B/"<'),
    'https://render.example.test/v1/face/A%20B%2F%22%3C'
  )
  assert.equal(
    await client.avatarUrl('Fixture', 'a&b'),
    'https://render.example.test/v1/face/Fixture?t=a%26b'
  )
  assert.equal(requests, 1)
  await assert.rejects(client.avatarUrl('..'), (error) => error.code === ErrorType.CONFIG_ERROR)
})

test('session restoration delegates profile reconciliation and returns managed identities', async () => {
  const managed = [{ id: 'b'.repeat(32), name: 'Managed' }]
  const sessions = new KintareSessions({
    ensureSession: async (value) => value,
    selectableProfiles: async () => ({ profiles: managed, managedProfiles: managed }),
    reconcileProfiles: (value, profiles, policy) => {
      assert.equal(policy, 'first')
      return { ...value, uuid: profiles[0].id, name: profiles[0].name }
    }
  })
  const result = await sessions.restore(account, managed)
  assert.equal(result.status, 'ready')
  assert.equal(result.account.name, 'Managed')
  assert.deepEqual(result.managedProfiles, managed)
})

for (const [code, status, expected] of [
  [ErrorType.AUTH_ERROR, 401, 'invalid'],
  [ErrorType.NET_ERROR, undefined, 'offline'],
  [ErrorType.TOO_MANY_REQUESTS, 429, 'error'],
  [ErrorType.CONFIG_ERROR, undefined, 'error']
])
  test(`session restoration distinguishes ${code} without dropping its account`, async () => {
    const error = new EMLLibError(code, 'Fixture refusal', { status })
    const result = await new KintareSessions({
      ensureSession: async () => {
        throw error
      }
    }).restore(account)
    assert.equal(result.status, expected)
    assert.equal(result.account, account)
    assert.equal(result.error, error)
  })

test('a profile-service outage retains the refreshed account and reports its source', async () => {
  const refreshed = { ...account, accessToken: 'updated' },
    offline = []
  const result = await new KintareSessions({
    ensureSession: async () => refreshed,
    selectableProfiles: async () => {
      throw new EMLLibError(ErrorType.NET_ERROR, 'Offline')
    }
  }).restore(account, [], (source) => offline.push(source))
  assert.equal(result.status, 'ready')
  assert.equal(result.account, refreshed)
  assert.deepEqual(offline, ['services'])
})

test('multi-account refresh stops on connectivity failure and retains completed updates', async () => {
  const called = []
  const result = await new KintareSessions({
    ensureSession: async (value) => {
      called.push(value.name)
      if (value.name === 'Second') throw new EMLLibError(ErrorType.NET_ERROR, 'Offline')
      return { ...value, accessToken: 'updated' }
    },
    resolveDisplayName: () => 'Operator'
  }).refreshAccounts([account, { ...account, name: 'Second' }, { ...account, name: 'Third' }])
  assert.equal(result.offline, true)
  assert.equal(result.updated.length, 1)
  assert.deepEqual(called, ['Selected', 'Second'])
})

test('managed profile permission is checked before lookup and identities are normalized', async () => {
  let role = 'user',
    lookups = 0
  const profiles = new KintareProfiles({
    getAccountFeatures: async () => ({ account: { type: role } }),
    normalizeProfileId: (value) => value.replaceAll('-', '').toLowerCase(),
    lookupByUUID: async (id) => {
      lookups++
      return { id, name: 'Canonical' }
    },
    lookupByName: async () => {
      throw Error('Unexpected lookup')
    }
  })
  await assert.rejects(
    profiles.lookupManaged(account, 'a'.repeat(32)),
    (error) => error.status === 403
  )
  assert.equal(lookups, 0)
  role = 'admin'
  const result = await profiles.lookupManaged(account, 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
  assert.equal(result.id, account.uuid)
  assert.equal(result.name, 'Canonical')
})

test('accounts without a selected profile do not request profile actions', async () => {
  const profiles = new KintareProfiles({
    getPlayerProfile: async () => {
      throw Error('Unexpected request')
    }
  })
  assert.deepEqual(await profiles.actions({ ...account, noProfile: true }), [])
})

test('instance refresh preserves a redacted address while rejecting only the expired bearer', async () => {
  let headers
  const profile = new Profile('https://fixture.invalid', undefined, {
    fetch: async (_, init) => {
      headers = init.headers
      return Response.json({}, { status: 401 })
    }
  })
  profile.getProfiles = async () => [
    { slug: 'private', name: 'Private', visibility: 'PROTECTED', token: 'must-not-leave' }
  ]
  const result = await profile.refresh('private', account, 'expired', {
    slug: 'private',
    ip: 'private.test',
    port: 25566
  })
  assert.equal(headers.Authorization, 'Bearer expired')
  assert.equal(result.tokenRejected, true)
  assert.equal(result.profile.ip, 'private.test')
  assert.equal(result.profile.port, 25566)
  assert.equal('token' in result.profile, false)
})

test('instance search is inert for an empty query and matches slug/name/id', async () => {
  const profile = new Profile('https://fixture.invalid')
  let requests = 0
  profile.getProfiles = async () => {
    requests++
    return [{ id: 'ID', slug: 'pack', name: 'Fixture', token: 'must-not-leave' }]
  }
  assert.deepEqual(await profile.search(' '), [])
  assert.equal(requests, 0)
  for (const query of ['id', 'PACK', 'fixture']) {
    const results = await profile.search(query)
    assert.equal(results.length, 1)
    assert.equal('token' in results[0], false)
  }
})

test('JVM argument construction preserves custom arguments and deduplicates optional flags', () => {
  const args = jvmArguments({ optimization: true, debug: true }, ['-Dfixture=true', '-XX:+UseZGC'])
  assert.equal(args.filter((arg) => arg === '-XX:+UseZGC').length, 1)
  assert.ok(args.includes('-Dfixture=true'))
  assert.deepEqual(jvmArguments({}), [])
})
