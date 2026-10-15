import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import * as EML from '../dist/index.js'

const contract = JSON.parse(await readFile(new URL('./fixtures/upstream-2.7.3.json', import.meta.url), 'utf8'))
const account = { name: 'Fixture', uuid: 'a'.repeat(32), accessToken: 'fixture', clientToken: 'client', meta: { type: 'crack', online: false } }
const configuration = { root: 'fixture', account, minecraft: { version: '1.21.1' } }

function descriptor(prototype, name) {
  for (let current = prototype; current; current = Object.getPrototypeOf(current)) {
    const found = Object.getOwnPropertyDescriptor(current, name)
    if (found) return found
  }
}

test('every upstream root export, default alias and public class member remains available', () => {
  for (const name of contract.named) {
    assert.equal(typeof EML[name], 'function', name)
    for (const member of contract.classes[name]) {
      const found = descriptor(EML[name].prototype, member.name)
      assert.equal(typeof (member.kind === 'getter' ? found?.get : found?.value), 'function', `${name}.${member.name}`)
    }
  }
  for (const name of contract.default) assert.equal(EML.default[name], EML[name], name)
  assert.equal(EML.Bootstraps, EML.Bootstrap)
  assert.equal(EML.Profiles, EML.Profile)
})

test('unconfigured launchers preserve upstream cleaning defaults and replacement semantics', () => {
  const defaults = ['crash-reports/', 'logs/', 'resourcepacks/', 'resources/', 'saves/', 'shaderpacks/', 'options.txt', 'optionsof.txt']
  assert.deepEqual(new EML.Launcher(configuration).config.cleaning.ignored, defaults)
  assert.deepEqual(new EML.Launcher({ ...configuration, cleaning: { ignored: ['custom/'] } }).config.cleaning.ignored, ['custom/'])
  const extended = new EML.Launcher({
    ...configuration,
    cleaning: { ignored: ['custom/'], ignoredMode: 'extend', additionalIgnored: ['screenshots/'] }
  })
  assert.deepEqual(extended.config.cleaning.ignored, [...defaults, 'custom/', 'screenshots/'])
})

test('crash-report cooldown is optional and does not change the upstream default', () => {
  const url = 'https://cooldown.fixture.invalid'
  EML.CrashReport.attempts.set(`${url}/api`, Date.now())
  assert.equal(new EML.CrashReport(url).canSend(), true)
  assert.equal(new EML.CrashReport(url, { cooldownMs: 600000 }).canSend(), false)
  EML.CrashReport.attempts.delete(`${url}/api`)
})

test('official AdminTool routes, pseudo/Basic/Bearer headers and response shapes need no Kintare service', async (t) => {
  const calls = []
  const profile = { id: 'fixture', name: 'Fixture', slug: 'pack', isDefault: true, visibility: 'PUBLIC' }
  const news = {
    id: 'news',
    title: 'Fixture news',
    content: 'Fixture',
    author: { id: 'author', username: 'Fixture' },
    createdAt: '2026-10-15T00:00:00Z'
  }
  const background = { id: 'background', file: { url: 'https://assets.fixture.invalid/background.png' } }
  const maintenance = { startTime: '2026-10-01T00:00:00Z', canBypass: true }
  EML.configureHttp({
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      calls.push({ path, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
      if (path === '/api/profiles/pack/auth') return Response.json({ success: true, token: 'profile-bearer' })
      if (path === '/api/profiles') return Response.json({ success: true, profiles: [profile] })
      if (path === '/api/news') return Response.json({ news: [news] })
      if (path === '/api/news/categories') return Response.json({ categories: [{ id: 'category', title: 'Launcher', date: '2026-10-15' }] })
      if (path === '/api/background') return Response.json(background)
      if (path === '/api/maintenance') return Response.json(maintenance)
      throw Error(`Unexpected endpoint ${url}`)
    }
  })
  t.after(() => EML.configureHttp({ fetch: (url, init) => globalThis.fetch(url, init) }))
  const profiles = new EML.Profiles('https://admintool.fixture.invalid')
  assert.deepEqual(await profiles.getProfiles(account), [profile])
  assert.equal(calls.at(-1).headers.get('pseudo'), account.name)
  assert.deepEqual(await profiles.auth('pack', 'password'), { slug: 'pack', token: 'profile-bearer' })
  assert.equal(calls.at(-1).method, 'POST')
  assert.equal(calls.at(-1).headers.get('authorization'), `Basic ${Buffer.from('pack:password').toString('base64')}`)
  assert.deepEqual(await profiles.getProfiles('pack'), [profile])
  assert.equal(calls.at(-1).headers.get('authorization'), 'Bearer profile-bearer')
  await profiles.getProfiles(account, 'pack')
  assert.equal(calls.at(-1).headers.get('pseudo'), account.name)
  assert.equal(calls.at(-1).headers.get('authorization'), 'Bearer profile-bearer')
  assert.deepEqual(await new EML.News('https://admintool.fixture.invalid').getNews(), [news])
  assert.equal((await new EML.News('https://admintool.fixture.invalid').getCategories())[0].title, 'Launcher')
  assert.deepEqual(await new EML.Background('https://admintool.fixture.invalid').getBackground(), background)
  assert.deepEqual(await new EML.Maintenance('https://admintool.fixture.invalid', account).getMaintenance(), maintenance)
  assert.equal(calls.at(-1).headers.get('pseudo'), account.name)
})
