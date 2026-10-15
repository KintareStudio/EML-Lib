import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import yazl from 'yazl'
import { Java, Launcher, EMLLibError, ErrorType, parseJavaInfo, jvmArguments, configureHttp } from '../dist/index.js'
import { MINECRAFT_MANIFEST_URL, JAVA_RUNTIME_URL } from '../dist/lib/utils/consts.js'

const javaPath = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java'
const hash = (value) => createHash('sha1').update(value).digest('hex')
const info = (majorVersion = 21, vmName = 'OpenJDK 64-Bit Server VM') => ({ majorVersion, vmName })
const properties = (version, architecture) =>
  `Property settings:\n    java.version = ${version}\n    os.arch = ${architecture}\n    java.vm.name = OpenJDK 64-Bit Server VM\n`
const javaError = (error) => error.code === ErrorType.JAVA_ERROR

test('Java versions and architectures come from the executable properties, including legacy and ARM', () => {
  for (const [version, major] of [
    ['1.8.0_462', 8],
    ['17.0.16', 17],
    ['21.0.12+7', 21],
    ['25-ea', 25]
  ]) {
    assert.equal(parseJavaInfo(properties(version, 'amd64')).majorVersion, major)
  }
  assert.equal(parseJavaInfo(properties('21', 'aarch64')).architecture, 'arm64')
  assert.equal(parseJavaInfo(properties('1.8.0_462', 'x86')).arch, '32-bit')
  assert.throws(() => parseJavaInfo('not a Java runtime'), javaError)
})

test('real Java inspection validates the executable and required version', async () => {
  const java = new Java({ root: 'fixture' }),
    events = []
  java.on('java_info', (event) => events.push(event))
  const detected = await java.check(javaPath)
  assert.equal(detected.architecture, process.arch)
  assert.ok(detected.majorVersion >= 8)
  assert.deepEqual(events, [{ version: detected.version, arch: detected.arch }])
  await assert.rejects(java.check(javaPath, 999), javaError)
  await assert.rejects(java.check(process.execPath), javaError)
  await assert.rejects(java.check('eml-nonexistent-java-fixture'), javaError)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(java.check(javaPath, 8, { signal: controller.signal }), (error) => error.code === ErrorType.OPERATION_CANCELLED)
})

test('optional JVM flags follow the detected VM and preserve manual collector choices', () => {
  for (const major of [8, 11, 14]) assert.deepEqual(jvmArguments({ optimization: true }, [], info(major)), [])
  for (const major of [15, 17, 23, 24, 25]) assert.deepEqual(jvmArguments({ optimization: true }, [], info(major)), ['-XX:+UseZGC'])
  for (const major of [21, 22]) assert.deepEqual(jvmArguments({ optimization: true }, [], info(major)), ['-XX:+UseZGC', '-XX:+ZGenerational'])
  assert.deepEqual(jvmArguments({ optimization: true, debug: true }, [], info(21, 'Eclipse OpenJ9 VM')), [])
  const manual = ['-Dfixture=true', '-XX:+UseG1GC']
  assert.deepEqual(jvmArguments({ optimization: true }, manual, info()), manual)
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'eml-install-test-'))
  t.after(async () => {
    const resolved = await fs.realpath(root)
    assert.equal(path.dirname(resolved), await fs.realpath(tmpdir()))
    assert.ok(path.basename(resolved).startsWith('eml-install-test-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  const bodies = { '/good': 'good', '/bad': 'fixed', '/missing': 'new', '/keep': 'remote', '/client': 'minecraft fixture' }
  const file = (name, directory, url) => ({
    name,
    path: directory,
    url: `https://fixture.invalid${url}`,
    sha1: hash(bodies[url]),
    size: Buffer.byteLength(bodies[url]),
    type: 'MOD'
  })
  const files = [
    file('good.jar', 'mods', '/good'),
    file('bad.jar', 'mods', '/bad'),
    file('missing.jar', 'mods', '/missing'),
    file('keep.json', 'config', '/keep')
  ]
  const manifest = {
    id: 'fixture',
    type: 'release',
    javaVersion: { majorVersion: 8, component: 'jre-legacy' },
    downloads: { client: { url: 'https://fixture.invalid/client', sha1: hash(bodies['/client']), size: bodies['/client'].length } },
    libraries: [],
    assets: 'fixture',
    assetIndex: { url: 'https://fixture.invalid/assets' },
    arguments: { jvm: [], game: [] },
    mainClass: 'Fixture.Main'
  }
  const routes = new Map(),
    runtimeFiles = {}
  const calls = [],
    downloads = []
  configureHttp({
    fetch: async (url, init) => {
      calls.push(url)
      if (routes.has(url)) return routes.get(url)(init)
      if (url === MINECRAFT_MANIFEST_URL) return Response.json({ versions: [{ id: 'fixture', url: 'https://fixture.invalid/manifest' }] })
      if (url.endsWith('/manifest')) return Response.json(manifest)
      if (url.endsWith('/patches.json')) return Response.json({ credits: 'fixture' })
      if (url === JAVA_RUNTIME_URL)
        return Response.json(
          Object.fromEntries(
            ['windows-x64', 'windows-arm64', 'mac-os', 'mac-os-arm64', 'linux'].map((arch) => [
              arch,
              { 'jre-legacy': [{ manifest: { url: 'https://fixture.invalid/runtime' } }] }
            ])
          )
        )
      if (url.endsWith('/runtime')) return Response.json({ files: runtimeFiles })
      if (url.endsWith('/assets')) return Response.json({ objects: {} })
      if (url.endsWith('/modpack')) return Response.json({ files })
      const body = bodies[new URL(url).pathname]
      assert.notEqual(body, undefined, `Unexpected HTTP ${url}`)
      downloads.push(url)
      return new Response(body)
    }
  })
  t.after(() => configureHttp({ fetch: (url, init) => globalThis.fetch(url, init) }))
  const launcher = new Launcher({
    root: 'fixture',
    account: { name: 'Fixture', uuid: 'a'.repeat(32), accessToken: 'fixture', meta: { type: 'microsoft' } },
    minecraft: { version: 'fixture', modpackUrl: 'https://fixture.invalid/modpack' },
    java: { install: 'manual', absolutePath: javaPath },
    cleaning: { enabled: true, preserveExisting: ['config/'] }
  })
  launcher.config.root = path.join(root, 'instance')
  let started = 0,
    cleaned = 0
  launcher.run = async (_java, args) => {
    started++
    launcher.fixtureArgs = args
  }
  launcher.on('launch_clean', () => cleaned++)
  const put = async (name, body) => {
    const target = path.join(launcher.config.root, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, body)
  }
  const snapshot = async () => {
    const result = {}
    const visit = async (dir) => {
      for (const name of await fs.readdir(dir)) {
        const filename = path.join(dir, name),
          relative = path.relative(launcher.config.root, filename),
          stat = await fs.stat(filename)
        if (stat.isDirectory()) {
          result[relative] = 'directory'
          await visit(filename)
        } else result[relative] = hash(await fs.readFile(filename))
      }
    }
    await visit(launcher.config.root)
    return result
  }
  return {
    launcher,
    manifest,
    routes,
    bodies,
    runtimeFiles,
    calls,
    downloads,
    put,
    snapshot,
    get started() {
      return started
    },
    get cleaned() {
      return cleaned
    }
  }
}

test('inspection finds missing and corrupt files without modifying the instance or preserved files', async (t) => {
  const f = await fixture(t)
  await f.put('mods/good.jar', 'good')
  await f.put('mods/bad.jar', 'wrong')
  await f.put('config/keep.json', 'personal settings')
  await f.put('saves/world.dat', 'my world')
  const before = await f.snapshot()
  const report = await f.launcher.inspect()
  assert.deepEqual(report.downloads.map((file) => file.name).sort(), ['bad.jar', 'fixture.jar', 'missing.jar'])
  assert.equal(report.downloadSize, 5 + 3 + 'minecraft fixture'.length)
  assert.equal(report.java.info.architecture, process.arch)
  assert.equal(report.java.error, undefined)
  assert.deepEqual(await f.snapshot(), before)
  assert.deepEqual(f.downloads, [])
  assert.equal(f.started + f.cleaned, 0)
})

test('inspection does not create an absent instance and reports an invalid manual Java', async (t) => {
  const f = await fixture(t)
  f.launcher.config.java.absolutePath = process.execPath
  const report = await f.launcher.inspect()
  assert.ok(report.java.error)
  await assert.rejects(fs.stat(f.launcher.config.root), (error) => error.code === 'ENOENT')
})

test('repair only downloads necessary files, preserves user data and never starts or cleans the game', async (t) => {
  const f = await fixture(t)
  await f.put('mods/good.jar', 'good')
  await f.put('mods/bad.jar', 'wrong')
  await f.put('config/keep.json', 'personal settings')
  await f.put('unmanaged.txt', 'personal file')
  const report = await f.launcher.repair()
  assert.equal(report.downloads.length, 3)
  assert.deepEqual(f.downloads.map((url) => new URL(url).pathname).sort(), ['/bad', '/client', '/missing'])
  assert.equal(await fs.readFile(path.join(f.launcher.config.root, 'config/keep.json'), 'utf8'), 'personal settings')
  assert.equal(await fs.readFile(path.join(f.launcher.config.root, 'unmanaged.txt'), 'utf8'), 'personal file')
  assert.equal(f.started + f.cleaned, 0)
  assert.deepEqual((await f.launcher.inspect()).downloads, [])
  await f.launcher.repair()
  assert.equal(f.downloads.length, 3)
})

test('incompatible manual Java stops launch and repair before installation writes or artifact requests', async (t) => {
  const f = await fixture(t)
  f.manifest.javaVersion.majorVersion = 999
  await f.put('unmanaged.txt', 'personal file')
  const before = await f.snapshot()
  for (const operation of ['launch', 'repair']) await assert.rejects(f.launcher[operation](), javaError)
  assert.ok(f.calls.every((url) => url === MINECRAFT_MANIFEST_URL || url.endsWith('/manifest')))
  assert.deepEqual(await f.snapshot(), before)
  assert.equal(f.started + f.cleaned, 0)
})

test('launch uses detected JVM options without changing configured manual arguments', async (t) => {
  const f = await fixture(t)
  const manual = ['-Dfixture=true', '-XX:+UseG1GC']
  f.launcher.config.java.args = [...manual]
  f.launcher.config.cleaning.enabled = false
  await f.launcher.launch({ optimization: true, debug: true })
  assert.equal(f.started, 1)
  assert.ok(f.launcher.fixtureArgs.includes('-XX:+UseG1GC'))
  assert.ok(!f.launcher.fixtureArgs.includes('-XX:+UseZGC'))
  assert.deepEqual(f.launcher.config.java.args, manual)
})

test('cancelled inspection removes its metadata directory and releases the operation guard', async (t) => {
  const f = await fixture(t),
    controller = new AbortController()
  const before = (await fs.readdir(tmpdir())).filter((name) => name.startsWith('eml-inspect-')).sort()
  configureHttp({
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        controller.abort()
      })
  })
  await assert.rejects(f.launcher.inspect({ signal: controller.signal }), (error) => error.code === ErrorType.OPERATION_CANCELLED)
  assert.deepEqual((await fs.readdir(tmpdir())).filter((name) => name.startsWith('eml-inspect-')).sort(), before)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(f.launcher.repair({ signal: aborted.signal }), (error) => error.code === ErrorType.OPERATION_CANCELLED)
})

test('automatic Java is downloaded and validated before any modpack payload', async (t) => {
  const f = await fixture(t)
  f.launcher.config.java.install = 'auto'
  f.launcher.config.java.absolutePath = path.join(f.launcher.config.root, 'runtime', 'jre-${X}', 'bin', 'java')
  f.bodies['/runtime-java'] = 'runtime fixture'
  f.runtimeFiles['bin/java'] = {
    type: 'file',
    executable: true,
    downloads: { raw: { url: 'https://fixture.invalid/runtime-java', size: 15, sha1: hash('runtime fixture') } }
  }
  let verified = false
  t.mock.method(Java.prototype, 'check', async (executable) => {
    const body = await fs.readFile(executable.replace('${X}', '8'), 'utf8').catch(() => '')
    if (!body) throw new EMLLibError(ErrorType.JAVA_ERROR, 'Runtime not installed')
    assert.equal(body, 'runtime fixture')
    assert.deepEqual(f.downloads, ['https://fixture.invalid/runtime-java'])
    verified = true
    return { version: '1.8.0_462', majorVersion: 8, architecture: process.arch, arch: '64-bit', vmName: 'OpenJDK 64-Bit Server VM' }
  })
  await f.launcher.repair()
  assert.equal(verified, true)
  assert.equal(f.started + f.cleaned, 0)
})

test('Forge installer metadata stays outside the instance until loader Java requirements pass', async (t) => {
  const f = await fixture(t),
    archive = new yazl.ZipFile()
  const chunks = [],
    collected = new Promise((resolve, reject) => {
      archive.outputStream.on('data', (chunk) => chunks.push(chunk))
      archive.outputStream.once('end', () => resolve(Buffer.concat(chunks)))
      archive.outputStream.once('error', reject)
    })
  archive.addBuffer(Buffer.from(JSON.stringify({ json: '/version.json', libraries: [], processors: [] })), 'install_profile.json')
  archive.addBuffer(
    Buffer.from(JSON.stringify({ id: 'fixture-loader', libraries: [], javaVersion: { component: 'jre-legacy', majorVersion: 999 } })),
    'version.json'
  )
  archive.end()
  const jar = await collected
  f.launcher.config.minecraft.loader = { loader: 'neoforge', version: 'fixture' }
  const url = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/fixture/neoforge-fixture-installer.jar'
  f.routes.set(url, (init) => new Response(init.method === 'HEAD' ? null : jar, { headers: { 'content-length': String(jar.length) } }))
  f.routes.set(`${url}.sha1`, () => new Response(hash(jar)))
  const report = await f.launcher.inspect()
  assert.equal(report.java.requiredVersion, 999)
  assert.ok(report.java.error)
  assert.ok(report.downloads.some((file) => file.name === 'neoforge-fixture-installer.jar'))
  await assert.rejects(f.launcher.repair(), javaError)
  await assert.rejects(fs.stat(f.launcher.config.root), (error) => error.code === 'ENOENT')
})
