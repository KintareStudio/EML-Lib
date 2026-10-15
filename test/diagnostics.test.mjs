import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import childProcess, { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { Java, Launcher, Downloader, CrashReport, ErrorType, redactSecrets, isEmlNetworkError } from '../dist/index.js'
import Patcher from '../dist/lib/launcher/patcher.js'
import { lockInstance, diskSpace, requireSpace } from '../dist/lib/utils/installation-state.js'
import { operationSignal } from '../dist/lib/utils/operation.js'

const sha1 = (body) => createHash('sha1').update(body).digest('hex')
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eml-diagnostics-test-'))
  t.after(async () => {
    const target = await fs.realpath(root)
    assert.equal(path.dirname(target), await fs.realpath(os.tmpdir()))
    assert.ok(path.basename(target).startsWith('eml-diagnostics-test-'))
    await fs.rm(target, { recursive: true, force: true })
  })
  return root
}
const config = (root) => ({
  root,
  java: { absolutePath: process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java' },
  minecraft: { loader: { loader: 'neoforge' } }
})

test('file inspection explains missing, wrong size and wrong hash, including local processor outputs', async (t) => {
  const root = await directory(t)
  for (const [name, content] of Object.entries({ size: 'x', hash: 'evil', good: 'good' })) await fs.writeFile(path.join(root, name), content)
  const files = ['missing', 'size', 'hash', 'good'].map((name) => ({ name, path: '', size: 4, sha1: sha1('good'), url: '', type: 'OTHER' }))
  const downloader = new Downloader(root)
  const issues = await downloader.inspect(files)
  assert.deepEqual(
    issues.map(({ file, reason }) => [file.name, reason]),
    [
      ['missing', 'missing'],
      ['size', 'size_mismatch'],
      ['hash', 'hash_mismatch']
    ]
  )
  assert.deepEqual(await downloader.getFilesToDownload(files), [])
})

test('secret masking covers headers, JSON, JVM properties, URLs and complete argument values', () => {
  const cases = [
    ['--accessToken flag-secret --other visible', 'flag-secret'],
    ['-Dkintare.token=property-secret', 'property-secret'],
    ['{"accessToken":"json-secret","refresh_token":"refresh-secret"}', 'json-secret', 'refresh-secret'],
    ['https://fixture.invalid/file?access_token=query-secret&next=visible', 'query-secret'],
    ['Authorization: Bearer bearer-secret', 'bearer-secret'],
    ['https://username:password@fixture.invalid/file', 'username:password'],
    ['{"password":"secret with spaces"}', 'secret with spaces'],
    ['https://fixture.invalid/file?X-Amz-Signature=signed-secret&x=visible', 'signed-secret'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'eyJhbGci']
  ]
  for (const [text, ...secrets] of cases) {
    const masked = redactSecrets(text)
    for (const secret of secrets) assert.ok(!masked.includes(secret), masked)
    assert.equal(redactSecrets(masked), masked)
  }
  const settings = { account: { accessToken: 'a+b/secret', refreshToken: 'refresh-value' }, profile: { token: 'profile-value' } }
  assert.ok(!redactSecrets('https://fixture.invalid/?unknown=a%2Bb%2Fsecret refresh-value profile-value', settings).includes('secret'))
  const args = ['--password', 'two words secret', '-Dkintare.token=another long secret', '--normal', 'visible']
  const original = [...args],
    masked = redactSecrets(args.join(' '), undefined, args)
  assert.ok(!masked.includes('two words secret'))
  assert.ok(!masked.includes('another long secret'))
  assert.ok(masked.includes('visible'))
  assert.deepEqual(args, original)
})

test('launcher diagnostics and crash reports share masks while actual launch arguments stay intact', () => {
  const launcher = new Launcher({
    root: 'fixture',
    minecraft: { version: 'fixture' },
    account: { name: 'Fixture', uuid: 'a'.repeat(32), accessToken: 'account-secret', refreshToken: 'refresh-secret', meta: { type: 'msa' } }
  })
  launcher.launchArgs_ = ['--password', 'whole secret phrase', '--accessToken', 'account-secret']
  const messages = []
  launcher.on('launch_debug', (value) => messages.push(value))
  launcher.emit('launch_debug', launcher.launchArgs.join(' '))
  launcher.emit('download_error', { filename: 'fixture', message: Error('url?token=custom-secret') })
  const stored = launcher.launcherLogs.join('\n')
  for (const text of [
    stored,
    messages[0],
    new CrashReport('https://fixture.invalid').sanitizeText('refresh-secret whole secret phrase -Dauth.token=custom-secret', launcher)
  ])
    for (const secret of ['account-secret', 'refresh-secret', 'whole secret phrase', 'custom-secret']) assert.ok(!text.includes(secret), text)
  assert.ok(launcher.launchArgs.includes('account-secret'))
  assert.ok(launcher.launchArgs.includes('whole secret phrase'))
})

test('instance locks resolve folder aliases and release without changing the target folder', async (t) => {
  const root = await directory(t),
    real = path.join(root, 'real'),
    alias = path.join(root, 'alias')
  await fs.mkdir(real)
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const release = await lockInstance(path.join(real, 'future'))
  try {
    await assert.rejects(lockInstance(path.join(alias, 'future')), (error) => error.code === ErrorType.INVALID_OPERATION)
  } finally {
    release()
  }
  const unlocked = await lockInstance(path.join(alias, 'future'))
  unlocked()
  assert.deepEqual(await fs.readdir(real), [])
})

test('different Launcher objects cannot operate on one root and release it after cancellation or failure', async (t) => {
  const root = await directory(t),
    ready = deferred(),
    controller = new AbortController()
  const a = new Launcher({ root: 'fixture', minecraft: { version: 'fixture' } }),
    b = new Launcher({ root: 'fixture', minecraft: { version: 'fixture' } })
  a.config.root = b.config.root = root
  const report = { downloads: [], issues: [], downloadSize: 0, java: { requiredVersion: 8 } }
  a.prepareAndRun = () =>
    new Promise((_resolve, reject) => {
      const signal = operationSignal()
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      ready.resolve()
    })
  b.prepareAndRun = async () => report
  const cancelled = assert.rejects(a.inspect({ signal: controller.signal }), (error) => error.code === ErrorType.OPERATION_CANCELLED)
  await ready.promise
  await assert.rejects(b.repair(), (error) => error.code === ErrorType.INVALID_OPERATION)
  controller.abort()
  await cancelled
  assert.deepEqual(await b.repair(), report)
  a.prepareAndRun = async () => {
    throw Error('fixture failure')
  }
  await assert.rejects(a.repair(), /fixture failure/)
  assert.deepEqual(await b.inspect(), report)
})

test('disk estimates include temporaries, detect low space and tolerate unsupported filesystems', async (t) => {
  const root = await directory(t)
  const statfs = t.mock.method(fs, 'statfs', async () => ({ bavail: 0, bsize: 4096 }))
  const info = await diskSpace(path.join(root, 'absent', 'instance'), 1024)
  assert.equal(info.requiredBytes, 2048 + 64 * 1024 * 1024)
  assert.equal(info.sufficient, false)
  assert.throws(
    () => requireSpace(info),
    (error) => error.code === ErrorType.FILE_ERROR && error.serverCode === 'INSUFFICIENT_SPACE' && !isEmlNetworkError(error)
  )
  statfs.mock.mockImplementation(async () => {
    throw Object.assign(Error('unsupported'), { code: 'ENOSYS' })
  })
  const unsupported = await diskSpace(root, 0)
  assert.equal(unsupported.sufficient, undefined)
  requireSpace(unsupported)
  assert.deepEqual(await fs.readdir(root), [])
})

test('Java timeout stops an owned hung process and distinguishes user cancellation', { timeout: 15000 }, async (t) => {
  const root = await directory(t),
    pidFile = path.join(root, 'pid'),
    spawn = childProcess.spawn
  const replacement = t.mock.method(childProcess, 'spawn', (command, args, options) =>
    command === 'eml-hanging-java-fixture'
      ? spawn(
          process.execPath,
          ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
          options
        )
      : spawn(command, args, options)
  )
  syncBuiltinESMExports()
  t.after(() => {
    replacement.mock.restore()
    syncBuiltinESMExports()
  })
  const java = new Java({ root: 'fixture' })
  await assert.rejects(
    java.check('eml-hanging-java-fixture', 8, { timeoutMs: 2000 }),
    (error) => error.code === ErrorType.JAVA_ERROR && /timed out/.test(error.message) && !isEmlNetworkError(error)
  )
  const pid = Number(await fs.readFile(pidFile, 'utf8'))
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === 'ESRCH'
  )
  await fs.unlink(pidFile)
  const controller = new AbortController()
  const cancelled = assert.rejects(
    java.check('eml-hanging-java-fixture', 8, { timeoutMs: 5000, signal: controller.signal }),
    (error) => error.code === ErrorType.OPERATION_CANCELLED
  )
  while (!(await fs.stat(pidFile).catch(() => null))) await delay(10)
  controller.abort()
  await cancelled
  const cancelledPid = Number(await fs.readFile(pidFile, 'utf8'))
  assert.throws(
    () => process.kill(cancelledPid, 0),
    (error) => error.code === 'ESRCH'
  )
  await assert.rejects(java.check('unused', 8, { timeoutMs: 0 }), (error) => error.code === ErrorType.CONFIG_ERROR)
})

test('real loader processors repair corrupt declared outputs and reject successful exits with bad hashes', { timeout: 120000 }, async (t) => {
  const root = await directory(t),
    classes = path.join(root, 'classes'),
    source = path.join(root, 'FixtureWriter.java')
  await fs.mkdir(classes)
  await fs.writeFile(
    source,
    'import java.nio.file.*; public class FixtureWriter { public static void main(String[] args) throws Exception { Path file = Path.of(args[0]); Files.createDirectories(file.getParent()); Files.writeString(file, args[1]); } }'
  )
  const tool = (name) => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name)
  execFileSync(tool('javac'), ['-d', classes, source], { windowsHide: true, timeout: 60000 })
  const jar = path.join(root, 'libraries', 'fixture', 'processor', '1', 'processor-1.jar')
  await fs.mkdir(path.dirname(jar), { recursive: true })
  execFileSync(tool('jar'), ['--create', '--file', jar, '--main-class', 'FixtureWriter', '-C', classes, '.'], { windowsHide: true, timeout: 60000 })
  const processor = { jar: 'fixture:processor:1', args: ['{OUTPUT}', 'good'], outputs: { '{OUTPUT}': '{HASH}' } }
  const profile = {
    data: { OUTPUT: { client: '[fixture:output:1]' }, HASH: { client: `'${sha1('good')}'` } },
    libraries: [],
    processors: [processor, { sides: ['server'], outputs: { invalid: 'invalid' } }]
  }
  const patcher = new Patcher(config(root), { id: 'fixture', javaVersion: { majorVersion: 8 } }, {}, profile)
  let patched = 0
  patcher.on('patch_progress', () => patched++)
  assert.equal((await patcher.inspect())[0].reason, 'missing')
  await patcher.patch()
  const output = path.join(root, 'libraries', 'fixture', 'output', '1', 'output-1.jar')
  assert.equal(await fs.readFile(output, 'utf8'), 'good')
  assert.deepEqual(await patcher.inspect(), [])
  await fs.writeFile(output, 'evil')
  assert.equal((await patcher.inspect())[0].reason, 'hash_mismatch')
  await patcher.patch()
  await patcher.patch()
  assert.equal(patched, 2)
  assert.equal(await fs.readFile(output, 'utf8'), 'good')
  await fs.writeFile(output, 'evil')
  processor.args[1] = 'evil'
  await assert.rejects(patcher.patch(), (error) => error.code === ErrorType.PATCHER_ERROR)
  assert.ok((await fs.stat(path.join(root, '.eml-patch-incomplete'))).isFile())
  assert.equal((await patcher.isPatched()).patched, false)
})
