import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import yazl from 'yazl'
import { Launcher, Java, HttpClient, ErrorType, configureHttp, isEmlNetworkError } from '../dist/index.js'
import Cleaner from '../dist/lib/launcher/cleaner.js'
import FileManager from '../dist/lib/launcher/filemanager.js'
import ForgeLikeLoader from '../dist/lib/launcher/forgelike.js'
import Patcher from '../dist/lib/launcher/patcher.js'
import utils from '../dist/lib/utils/utils.js'
import { withOperation } from '../dist/lib/utils/operation.js'
import { preparationProcess } from '../dist/lib/utils/preparation-process.js'

const cancelled = (error) => error.code === ErrorType.OPERATION_CANCELLED && !isEmlNetworkError(error)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function directory(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'eml-prepare-test-'))
  t.after(async () => {
    const resolved = await fs.realpath(root),
      parent = await fs.realpath(tmpdir())
    assert.equal(path.dirname(resolved), parent)
    assert.ok(path.basename(resolved).startsWith('eml-prepare-test-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  return root
}
const config = (root) => ({
  root,
  minecraft: { version: 'fixture', loader: { loader: 'vanilla', version: 'fixture' } },
  profile: {},
  java: { install: 'manual', absolutePath: process.execPath },
  cleaning: { enabled: false },
  storage: 'isolated'
})
function transport(t, fetch) {
  configureHttp({ fetch })
  t.after(() => configureHttp({ fetch: (url, init) => globalThis.fetch(url, init) }))
}
async function zip(filename, entries) {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const archive = new yazl.ZipFile()
  const writing = pipeline(archive.outputStream, createWriteStream(filename))
  for (const [name, contents] of Object.entries(entries)) archive.addBuffer(Buffer.from(contents), name)
  archive.end()
  await writing
}
async function contents(filename) {
  const { zipfile, entries } = await utils.openZip(filename)
  try {
    return Object.fromEntries(
      await Promise.all(entries.map(async (entry) => [entry.fileName, (await utils.readEntryData(zipfile, entry)).toString()]))
    )
  } finally {
    zipfile.close()
  }
}

test('pre-aborted launch and Java download stop before HTTP or preparation', async (t) => {
  let calls = 0
  transport(t, async () => {
    calls++
    throw Error('Unexpected HTTP')
  })
  const controller = new AbortController()
  controller.abort()
  const launcher = new Launcher({ root: 'fixture', minecraft: { version: '1.21.1' } })
  let cancellations = 0,
    downloads = 0
  launcher.on('launch_cancelled', () => cancellations++)
  launcher.on('launch_download', () => downloads++)
  await assert.rejects(launcher.launch({ signal: controller.signal }), cancelled)
  await assert.rejects(new Java({ root: 'fixture', minecraft: { version: '1.21.1' } }).download({ signal: controller.signal }), cancelled)
  assert.equal(cancellations, 1)
  assert.equal(downloads, 0)
  assert.equal(calls, 0)
})

test('cancelling one launcher aborts its pending manifest without cancelling another launcher', async (t) => {
  const ready = deferred(),
    signals = []
  transport(t, async (_url, init) => {
    signals.push(init.signal)
    if (signals.length === 2) ready.resolve()
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  })
  const first = new AbortController(),
    second = new AbortController()
  const a = new Launcher({ root: 'fixture-a', minecraft: { version: '1.21.1' } })
  const b = new Launcher({ root: 'fixture-b', minecraft: { version: '1.21.1' } })
  let starts = 0,
    crashes = 0,
    ends = 0
  for (const launcher of [a, b]) {
    launcher.on('launch_launch', () => starts++)
    launcher.on('launch_crash', () => crashes++)
    launcher.on('download_end', () => ends++)
  }
  const runningA = a.launch({ signal: first.signal }),
    runningB = b.launch({ signal: second.signal })
  const rejectedA = assert.rejects(runningA, cancelled),
    rejectedB = assert.rejects(runningB, cancelled)
  await ready.promise
  first.abort()
  await rejectedA
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  second.abort()
  await rejectedB
  assert.equal(starts + crashes + ends, 0)
})

test('cancellation waits until the owned preparation process has exited', { timeout: 15000 }, async () => {
  const controller = new AbortController()
  let pid
  const running = preparationProcess(
    process.execPath,
    ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'],
    {},
    (chunk) => {
      pid = Number(chunk.toString().trim())
      controller.abort()
    },
    controller.signal
  )
  await assert.rejects(running, cancelled)
  assert.ok(pid > 0)
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === 'ESRCH'
  )
})

test('scoped HTTP keeps its timeout and classifies it as connectivity failure', async () => {
  const controller = new AbortController()
  const http = new HttpClient({
    timeoutMs: 10,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(Error('HTTP timeout did not fire')), 2000)
        init.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive)
            reject(init.signal.reason)
          },
          { once: true }
        )
      })
  })
  await assert.rejects(
    withOperation({ signal: controller.signal }, () => http.fetch('https://fixture.invalid')),
    (error) => error.code === ErrorType.NET_ERROR && isEmlNetworkError(error)
  )
  assert.equal(controller.signal.aborted, false)
})

test('cleaning stops before the next deletion after cancellation', async (t) => {
  const root = await directory(t),
    controller = new AbortController()
  await Promise.all(['a', 'b', 'c'].map((name) => fs.writeFile(path.join(root, name), name)))
  const cleaner = new Cleaner(config(root))
  let removed = 0,
    ended = 0
  cleaner.on('clean_progress', () => {
    removed++
    controller.abort()
  })
  cleaner.on('clean_end', () => ended++)
  await assert.rejects(
    withOperation({ signal: controller.signal }, () => cleaner.clean([])),
    cancelled
  )
  assert.equal(removed, 1)
  assert.equal(ended, 0)
  assert.equal((await fs.readdir(root)).length, 2)
})

test('native extraction closes the first archive and stops before the next archive', async (t) => {
  const root = await directory(t),
    controller = new AbortController()
  await zip(path.join(root, 'first.jar'), { 'first.dll': 'first' })
  await zip(path.join(root, 'second.jar'), { 'second.dll': 'second' })
  const manager = new FileManager(config(root), { id: 'fixture' }, null, null)
  let ended = 0
  manager.on('extract_progress', () => controller.abort())
  manager.on('extract_end', () => ended++)
  await assert.rejects(
    withOperation({ signal: controller.signal }, () =>
      manager.extractNatives(['first.jar', 'second.jar'].map((name) => ({ name, path: '', type: 'NATIVE' })))
    ),
    cancelled
  )
  assert.deepEqual(await fs.readdir(path.join(root, 'bin', 'fixture')), ['first.dll'])
  assert.equal(ended, 0)
  // On Windows this also proves there is no remaining archive handle preventing replacement.
  await fs.rename(path.join(root, 'first.jar'), path.join(root, 'closed.jar'))
})

test('modpack metadata sends a bearer only to the configured official AdminTool', async (t) => {
  const root = await directory(t),
    calls = []
  transport(t, async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers), redirect: init.redirect })
    return Response.json({ files: [] })
  })
  const local = config(root)
  local.profile.token = 'private-profile-token'
  local.minecraft.modpackUrl = 'https://external.invalid/api/files-updater/pack'
  await new FileManager(local, {}, null, null).getModpack()
  assert.equal(calls[0].headers.has('authorization'), false)
  local.url = 'https://official.invalid/mount'
  local.profile.slug = 'pack'
  await new FileManager(local, {}, null, null).getModpack()
  assert.equal(calls[1].url, 'https://official.invalid/mount/api/files-updater/pack')
  assert.equal(calls[1].headers.get('authorization'), 'Bearer private-profile-token')
  assert.equal(calls[1].redirect, 'error')
})

test('Forge merge preserves vanilla until success and removes cancelled temporary output', async (t) => {
  const root = await directory(t),
    controller = new AbortController()
  const original = path.join(root, 'versions', 'fixture', 'fixture.jar')
  await zip(original, { 'vanilla.txt': 'original', 'replace.txt': 'old', 'META-INF/signature': 'old signature' })
  await zip(path.join(root, 'forge.zip'), { 'replace.txt': 'new', 'forge.txt': 'forge' })
  const bytes = await fs.readFile(original)
  const loader = new ForgeLikeLoader(config(root), { id: 'fixture' }, {}, {}, { path: '', name: 'forge.zip' })
  loader.on('extract_progress', () => controller.abort())
  await assert.rejects(
    withOperation({ signal: controller.signal }, () => loader.extractZip()),
    cancelled
  )
  assert.deepEqual(await fs.readFile(original), bytes)
  assert.deepEqual(await fs.readdir(path.dirname(original)), ['fixture.jar'])
  const retry = new ForgeLikeLoader(config(root), { id: 'fixture' }, {}, {}, { path: '', name: 'forge.zip' })
  await retry.extractZip()
  assert.deepEqual(await contents(original), { 'vanilla.txt': 'original', 'replace.txt': 'new', 'forge.txt': 'forge' })
})

test('interrupted patch outputs cannot be treated as a completed installation on retry', async (t) => {
  const root = await directory(t),
    controller = new AbortController()
  const profile = {
    data: { OUTPUT: { client: '[fixture:output:1]' } },
    processors: [{ jar: 'fixture:processor:1', args: ['{OUTPUT}'], classpath: [] }],
    libraries: []
  }
  const patcher = new Patcher(config(root), { id: 'fixture' }, {}, profile)
  const target = path.join(root, 'libraries', 'fixture', 'output', '1', 'output-1.jar')
  patcher.getJarMain = async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'partially patched')
    controller.abort()
    return 'FixtureProcessor'
  }
  await assert.rejects(
    withOperation({ signal: controller.signal }, () => patcher.patch()),
    cancelled
  )
  assert.equal((await patcher.isPatched()).patched, false)
  assert.ok((await fs.stat(path.join(root, '.eml-patch-incomplete'))).isFile())
})

test('cancelling an entry pipeline closes its destination before rejection', async (t) => {
  const root = await directory(t),
    controller = new AbortController()
  const started = deferred()
  // A controlled entry stalls after its first chunk, so cancellation cannot race completion.
  const source = new Readable({
    read() {
      if (!this.sent) {
        this.sent = true
        this.push(Buffer.alloc(65536))
        started.resolve()
      }
    }
  })
  const zipfile = { openReadStream: (_entry, callback) => callback(null, source) }
  const target = path.join(root, 'target.bin')
  const running = withOperation({ signal: controller.signal }, () => utils.extractEntryToFile(zipfile, {}, target))
  const rejected = assert.rejects(running, cancelled)
  await started.promise
  controller.abort()
  await rejected
  assert.equal(source.destroyed, true)
  await fs.rename(target, path.join(root, 'closed.bin'))
})
