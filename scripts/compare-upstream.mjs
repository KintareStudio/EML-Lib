import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.argv[2]) throw Error('Provide a built upstream checkout: npm run compare:upstream -- ../EML-Lib-upstream')
const upstream = await import(pathToFileURL(path.resolve(process.argv[2], 'dist/index.js')).href)
const fork = await import('../dist/index.js')
const originalFetch = globalThis.fetch
const account = { name: 'Fixture', uuid: 'a'.repeat(32), accessToken: 'fixture', clientToken: 'fixture-client', meta: { online: false, type: 'msa' } }
const traces = []
const data = {
  '/api/profiles': { success: true, profiles: [{ slug: 'pack', name: 'Fixture', isDefault: true, visibility: 'PROTECTED' }] },
  '/api/profiles/pack/auth': { success: true, token: 'fixture-bearer' },
  '/api/news': { news: [{ id: 'news', title: 'Fixture', content: 'Example', categories: [], tags: [] }] },
  '/api/news/categories': { categories: [{ id: 'category', title: 'Launcher', date: '2026-10-15' }] },
  '/api/background': { file: { url: 'https://fixture.invalid/image.png' } },
  '/api/maintenance': { startTime: '2026-10-01T00:00:00Z', canBypass: true }
}
const fetcher = async (url, init = {}) => {
  const headers = new Headers(init.headers)
  traces.push({ url, method: init.method ?? 'GET', pseudo: headers.get('pseudo'), authorization: headers.get('authorization') })
  const payload = data[new URL(url).pathname]
  if (!payload) throw Error(`Unexpected request: ${url}`)
  return Response.json(payload)
}
async function exercise(EML) {
  traces.length = 0
  const url = 'https://admintool.fixture.invalid'
  const profile = new EML.Profiles(url)
  const results = [
    await profile.getProfiles(account),
    await profile.auth('pack', 'fixture-password'),
    await profile.getProfiles('pack'),
    await profile.getProfiles(account, 'pack'),
    await new EML.News(url).getNews(),
    await new EML.News(url).getCategories(),
    await new EML.Background(url).getBackground(),
    await new EML.Maintenance(url, account).getMaintenance()
  ]
  return { results, traces: [...traces] }
}
try {
  globalThis.fetch = fetcher
  fork.configureHttp({ fetch: fetcher })
  assert.deepEqual(await exercise(fork), await exercise(upstream))
  for (const cleaning of [undefined, { ignored: ['custom/'] }, { enabled: false }]) {
    const config = { root: 'fixture', account, minecraft: { version: '1.21.1' }, cleaning }
    const expected = new upstream.Launcher(config).config
    const actual = new fork.Launcher(config).config
    const { preserveExisting, ...actualCleaning } = actual.cleaning
    assert.deepEqual({ ...actual, cleaning: actualCleaning }, expected)
  }
  console.log('PASS: upstream and fork agree on 8 AdminTool operations, their URLs/headers/payloads and 3 unextended launch configurations.')
} finally {
  globalThis.fetch = originalFetch
  fork.configureHttp({ fetch: (url, init) => globalThis.fetch(url, init) })
}
