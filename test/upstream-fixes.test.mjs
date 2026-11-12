import assert from 'node:assert/strict'
import { test } from 'node:test'
import Skin from '../dist/lib/skin/skin.js'
import CrackAuth from '../dist/lib/auth/crack.js'

test('Microsoft skin uploads from a URL send the downloaded image as multipart', async (t) => {
  const account = {
    uuid: 'a'.repeat(32),
    accessToken: 'minecraft-test-token',
    meta: { type: 'msa', online: true }
  }
  const imageUrl = 'https://textures.example/skin.png'
  const image = new Uint8Array([137, 80, 78, 71])
  const calls = []
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, init) => {
    calls.push(url)
    if (url === imageUrl) {
      assert.equal(new Headers(init.headers).has('Authorization'), false)
      return new Response(image, { headers: { 'Content-Type': 'image/png' } })
    }
    assert.equal(url, 'https://api.minecraftservices.com/minecraft/profile/skins')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('Authorization'), 'Bearer minecraft-test-token')
    assert.equal(headers.has('Content-Type'), false)
    assert.ok(init.body instanceof FormData)
    assert.equal(init.body.get('variant'), 'slim')
    const file = init.body.get('file')
    assert.equal(file.name, 'skin.png')
    assert.equal(file.type, 'image/png')
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), image)
    return Response.json({ skins: [{ url: null, state: 'ACTIVE', variant: 'SLIM' }] })
  }
  await new Skin(account).updateSkin(imageUrl, 'slim')
  assert.deepEqual(calls, [imageUrl, 'https://api.minecraftservices.com/minecraft/profile/skins'])
})

test('offline account names cannot pass by matching just one line', () => {
  const auth = new CrackAuth()
  assert.equal(auth.auth('Valid_Name').name, 'Valid_Name')
  assert.throws(() => auth.auth('Valid_Name\ninvalid!'))
})
