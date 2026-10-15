import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bootstrap, EMLLibError, ErrorType } from '../dist/index.js'

const info = { version: '2.0.0', releaseDate: '2026-10-15T00:00:00Z' }
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const operation of ['checkForUpdate', 'download', 'runUpdate']) {
  test(`Bootstrap shares concurrent ${operation} operations, including their result`, async () => {
    const gate = deferred(),
      calls = [],
      installs = []
    const bootstrap = new Bootstrap('https://fixture.invalid')
    bootstrap.autoUpdater = {
      currentVersion: { version: '1.0.0' },
      async checkForUpdates() {
        calls.push('check')
        await gate.promise
        return { updateInfo: info }
      },
      async downloadUpdate() {
        calls.push('download')
        await gate.promise
        return ['fixture.exe']
      },
      quitAndInstall(silent, force) {
        installs.push({ silent, force })
      }
    }
    const first = bootstrap[operation](false)
    const second = bootstrap[operation](true)
    assert.equal(first, second)
    await new Promise(setImmediate)
    assert.equal(calls.length, 1)
    gate.resolve()
    const result = await first
    if (operation === 'checkForUpdate') assert.equal(result.latestVersion, '2.0.0')
    if (operation === 'download') assert.equal(result, 'fixture.exe')
    if (operation === 'runUpdate') assert.deepEqual(installs, [{ silent: false, force: true }])
    assert.equal(await second, result)
  })
}

test('Bootstrap releases a failed operation so an explicit retry can succeed', async () => {
  const bootstrap = new Bootstrap('https://fixture.invalid')
  let calls = 0
  bootstrap.autoUpdater = {
    async downloadUpdate() {
      if (++calls === 1) throw Error('Fixture failure')
      return ['fixture.exe']
    }
  }
  const first = bootstrap.download(),
    second = bootstrap.download()
  assert.equal(first, second)
  await assert.rejects(
    first,
    (error) => error instanceof EMLLibError && error.code === ErrorType.DOWNLOAD_ERROR
  )
  assert.equal(await bootstrap.download(), 'fixture.exe')
  assert.equal(calls, 2)
})

test('Bootstrap initializes its updater once across different concurrent operations', async () => {
  const bootstrap = new Bootstrap('https://fixture.invalid'),
    gate = deferred()
  let initializations = 0
  const updater = {
    currentVersion: { version: '1.0.0' },
    checkForUpdates: async () => ({ updateInfo: info }),
    downloadUpdate: async () => ['fixture.exe']
  }
  bootstrap.initializeUpdater = async () => {
    initializations++
    await gate.promise
    return updater
  }
  const check = bootstrap.checkForUpdate(),
    download = bootstrap.download()
  assert.equal(initializations, 1)
  gate.resolve()
  await Promise.all([check, download])
})
