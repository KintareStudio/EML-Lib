import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { KintareClient } from '../dist/lib/kintare/client.js'

const account = {
  name: 'Player',
  uuid: 'a'.repeat(32),
  accessToken: 'oauth-access',
  refreshToken: 'oauth-refresh',
  clientToken: 'minecraft-client',
  meta: { type: 'msa', online: false }
}

function client(fetch, timeoutMs) {
  return new KintareClient({ issuer: 'https://accounts.example/oidc', fetch, timeoutMs })
}

function stream(...chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    }
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

test('remote session checks use the Accounts origin and distinguish revocation from unavailable', async () => {
  const responses = [
    new Response(null, { status: 204 }),
    Response.json({ error: 'revoked' }, { status: 403 }),
    Response.json({ error: 'expired' }, { status: 403 }),
    Response.json({ error: 'invalidated' }, { status: 403 }),
    Response.json({ error: 'invalid_token' }, { status: 403 }),
    new Response(null, { status: 404 }),
    new Response('proxy failure', { status: 403 }),
    new Response('proxy failure', { status: 502 }),
    new Response('<html>unexpected page</html>')
  ]
  const { sessions } = client(async (url, init) => {
    assert.equal(url, 'https://accounts.example/auth/session/events?check=1')
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer oauth-access')
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    return responses.shift()
  })
  for (const status of ['active', 'revoked', 'expired', 'invalidated', 'invalid_token', 'unsupported']) {
    assert.deepEqual(await sessions.check(account), { status })
  }
  for (const status of [403, 502, undefined]) {
    const result = await sessions.check(account)
    assert.equal(result.status, 'unknown')
    assert.equal(result.error.status, status)
  }
  assert.equal(responses.length, 0)
})

test('watch parses split SSE frames, rotates once with a concurrent caller, and reconnects with the new bearer', { timeout: 6000 }, async () => {
  const controller = new AbortController()
  let openRotation
  const rotationStarted = new Promise(resolve => { openRotation = resolve })
  let finishRotation
  const rotation = new Promise(resolve => { finishRotation = resolve })
  const bearers = []
  let rotations = 0
  const { auth, sessions } = client(async (url, init) => {
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://accounts.example/oidc' })
    if (url.endsWith('/oidc/token')) {
      rotations++
      assert.equal(new URLSearchParams(init.body).get('refresh_token'), account.refreshToken)
      openRotation()
      return rotation
    }
    assert.equal(url, 'https://accounts.example/auth/session/events')
    assert.equal(new Headers(init.headers).get('Accept'), 'text/event-stream')
    const bearer = new Headers(init.headers).get('Authorization')
    bearers.push(bearer)
    return bearer === 'Bearer oauth-access'
      ? stream(': connected\r\n\r', '\n: heartbeat\n\ndata: inval', 'idated\r\n\r\n')
      : stream('data: revoked\n\n')
  })
  const replacements = []
  const watching = sessions.watch(account, {
    signal: controller.signal,
    onRefresh: (next, previous) => { replacements.push([next, previous]) }
  })
  await rotationStarted
  const concurrent = auth.refresh({ ...account, name: 'Other profile', displayName: 'Saved label' })
  finishRotation(Response.json({ access_token: 'new-oauth-access', refresh_token: 'new-oauth-refresh' }))
  const other = await concurrent
  assert.equal(other.accessToken, 'new-oauth-access')
  assert.equal(other.name, 'Other profile')
  assert.equal(other.displayName, 'Saved label')
  const result = await watching
  assert.equal(result.status, 'revoked')
  assert.equal(result.account.refreshToken, 'new-oauth-refresh')
  assert.deepEqual(replacements, [[result.account, account]])
  assert.equal(rotations, 1)
  assert.deepEqual(bearers, ['Bearer oauth-access', 'Bearer new-oauth-access'])
})

test('a reconnect invalidated by server revocation requires login only after refresh is rejected', async () => {
  const { sessions } = client(async url => {
    if (url.endsWith('openid-configuration')) return Response.json({})
    if (url.endsWith('/oidc/token')) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    return Response.json({ error: 'invalidated' }, { status: 403 })
  })
  assert.deepEqual(await sessions.watch(account, {
    signal: new AbortController().signal,
    onRefresh: () => assert.fail('rejected refresh must not be persisted')
  }), { status: 'reauthenticate', account })
})

test('unsupported backend returns control to the host for periodic fallback', async () => {
  const { sessions } = client(async () => new Response(null, { status: 404 }))
  assert.deepEqual(await sessions.watch(account, {
    signal: new AbortController().signal,
    onRefresh: () => assert.fail('old backend must not rotate the token')
  }), { status: 'unsupported', account })
})

test('watch reconnects after EOF and can abort an idle stream after the normal HTTP deadline', { timeout: 7000 }, async () => {
  const controller = new AbortController()
  let openStream
  const opened = new Promise(resolve => { openStream = resolve })
  let closed = false
  let attempts = 0
  const { sessions } = client(async () => {
    if (++attempts === 1) return stream(': connected\n\n')
    return new Response(new ReadableStream({
      pull() { openStream() },
      cancel() { closed = true }
    }), { headers: { 'Content-Type': 'text/event-stream' } })
  }, 40)
  const watching = sessions.watch(account, {
    signal: controller.signal,
    onRefresh: () => assert.fail('EOF must not rotate a token')
  })
  await opened
  await delay(100)
  assert.equal(closed, false)
  controller.abort()
  assert.deepEqual(await watching, { status: 'aborted', account })
  assert.equal(attempts, 2)
  assert.equal(closed, true)
})

test('watch honors Retry-After and preserves the account when throttled', { timeout: 5000 }, async () => {
  const controller = new AbortController()
  let attempts = 0
  const { sessions } = client(async () => {
    attempts++
    return new Response(null, { status: 429, headers: { 'Retry-After': '3' } })
  })
  const watching = sessions.watch(account, {
    signal: controller.signal,
    onRefresh: () => assert.fail('rate limit must not rotate a token')
  })
  await delay(1200)
  controller.abort()
  assert.deepEqual(await watching, { status: 'aborted', account })
  assert.equal(attempts, 1)
})

test('a refresh completed after cancellation is still available for the host to persist', async () => {
  const controller = new AbortController()
  const { sessions } = client(async url => {
    if (url.endsWith('openid-configuration')) return Response.json({})
    if (url.endsWith('/oidc/token')) {
      controller.abort()
      return Response.json({ access_token: 'replacement', refresh_token: 'rotated' })
    }
    return Response.json({ error: 'expired' }, { status: 403 })
  })
  const replacements = []
  const result = await sessions.watch(account, {
    signal: controller.signal,
    onRefresh: (next, previous) => { replacements.push([next, previous]) }
  })
  assert.equal(result.status, 'aborted')
  assert.equal(result.account.refreshToken, 'rotated')
  assert.deepEqual(replacements, [[result.account, account]])
})
