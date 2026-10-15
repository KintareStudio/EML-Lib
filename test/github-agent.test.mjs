import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuthAgent, KintareClient } from '../dist/index.js'

const bytes = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4])
const digest = createHash('sha256').update(bytes).digest('hex')
const assetUrl = 'https://github.com/KintareStudio/Loki/releases/download/v2.7.5/Loki-2.7.5.jar'
const apiUrl = 'https://api.github.com/repos/KintareStudio/Loki/releases/latest'
const cdnUrl =
  'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=fixture'
const release = () => ({
  tag_name: 'v2.7.5',
  draft: false,
  prerelease: false,
  assets: [
    {
      id: 123,
      name: 'Loki-2.7.5.jar',
      state: 'uploaded',
      size: bytes.length,
      digest: `sha256:${digest}`,
      browser_download_url: assetUrl
    }
  ]
})
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'eml-github-agent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('latest stable GitHub release downloads its JAR through the CDN and then reuses its verified cache', async (t) => {
  const root = await directory(t),
    calls = []
  const client = new KintareClient({
    fetch: async (url, init) => {
      calls.push({ url, init })
      assert.equal(new Headers(init.headers).has('Authorization'), false)
      if (url === apiUrl)
        return init.headers['If-None-Match']
          ? new Response(null, { status: 304 })
          : Response.json(release(), { headers: { etag: '"release-fixture"' } })
      assert.equal(url, assetUrl)
      assert.equal(init.redirect, 'follow')
      const response = new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
      Object.defineProperty(response, 'url', { value: cdnUrl })
      return response
    }
  })
  const agent = await client.authAgent(root, 'loki.jar')
  const result = await agent.ensure()
  assert.equal(result, path.join(root, 'loki.jar'))
  assert.deepEqual(await readFile(result), bytes)
  assert.equal(await agent.ensure(), result)
  assert.equal(calls.filter((c) => c.url === apiUrl).length, 2)
  assert.equal(calls.filter((c) => c.url === assetUrl).length, 1)
  const saved = JSON.parse(await readFile(`${result}.release.json`, 'utf8'))
  assert.equal(saved.asset.tag, 'v2.7.5')
  assert.equal(saved.localSha256, digest)
})

test('a changed local file cannot use a release 304 to skip verification', async (t) => {
  const root = await directory(t)
  let conditional
  const agent = new AuthAgent({
    cacheDirectory: root,
    githubRelease: { repository: 'KintareStudio/Loki' },
    fetch: async (url, init) => {
      if (url === apiUrl) {
        conditional = init.headers['If-None-Match']
        return Response.json(release(), { headers: { etag: '"fixture"' } })
      }
      return new Response(bytes)
    }
  })
  const result = await agent.ensure()
  await writeFile(result, Buffer.from([0x50, 0x4b, 3, 4, 9, 9, 9, 9]))
  await agent.ensure()
  assert.equal(conditional, undefined)
  assert.deepEqual(await readFile(result), bytes)
})

test('a new release with a bad digest preserves the working JAR', async (t) => {
  const root = await directory(t)
  let corrupt = false
  const agent = new AuthAgent({
    cacheDirectory: root,
    githubRelease: { repository: 'KintareStudio/Loki' },
    fetch: async (url) => {
      if (url === apiUrl) {
        const data = release()
        if (corrupt) {
          data.assets[0].id++
          data.assets[0].digest = `sha256:${'0'.repeat(64)}`
        }
        return Response.json(data)
      }
      return new Response(bytes)
    }
  })
  const result = await agent.ensure()
  corrupt = true
  assert.equal(await agent.ensure(), result)
  assert.deepEqual(await readFile(result), bytes)
  assert.equal(JSON.parse(await readFile(`${result}.release.json`, 'utf8')).asset.id, 123)
  assert.ok((await readdir(root)).every((name) => !name.includes('.tmp-')))
})

for (const status of [403, 404, 429, 503])
  test(`GitHub HTTP ${status} reuses a legacy cached agent and never calls Accounts`, async (t) => {
    const root = await directory(t)
    await writeFile(path.join(root, 'loki.jar'), bytes)
    const calls = []
    const client = new KintareClient({
      fetch: async (url) => {
        calls.push(url)
        return new Response(null, { status })
      }
    })
    const agent = await client.authAgent(root, 'loki.jar')
    assert.equal(await agent.ensure(), path.join(root, 'loki.jar'))
    assert.deepEqual(calls, [apiUrl])
  })

test('missing releases, ambiguous JAR assets and untrusted redirects fail without installing an agent', async (t) => {
  const root = await directory(t)
  for (const mode of ['missing', 'ambiguous', 'redirect', 'prerelease']) {
    const calls = []
    const agent = new AuthAgent({
      cacheDirectory: root,
      githubRelease: { repository: 'KintareStudio/Loki' },
      fetch: async (url) => {
        calls.push(url)
        if (url === apiUrl) {
          const data = release()
          if (mode === 'missing') data.assets = []
          if (mode === 'ambiguous')
            data.assets.push({ ...data.assets[0], id: 124, name: 'other.jar' })
          if (mode === 'prerelease') data.prerelease = true
          return Response.json(data)
        }
        return new Response(null, {
          status: 302,
          headers: { location: 'https://foreign.example/agent.jar' }
        })
      }
    })
    assert.equal(await agent.ensure(), null)
    assert.ok(calls.every((url) => !url.includes('foreign.example')))
  }
  assert.deepEqual(await readdir(root), [])
})
