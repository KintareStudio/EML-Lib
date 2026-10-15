import { httpFetch as fetch } from '../http/http.js'
import { checkCancellation, operationSignal, operationStream } from './operation.js'
/**
 * @license MIT
 * @copyright Copyright (c) 2026, GoldFrite
 */

import { EMLLibError, ErrorType } from '../../types/errors.js'
import path_ from 'node:path'
import fs, { createWriteStream } from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { ExtraFile } from '../../types/file.js'
import { ResolvedConfig } from '../../types/config.js'
import yauzl from 'yauzl'
import yazl from 'yazl'

class Utils {
  private readonly zipClosures = new WeakMap<yauzl.ZipFile, Promise<void>>()

  /** Wait for the archive's descriptor and all entry readers to close. */
  async closeZip(zipfile: yauzl.ZipFile): Promise<void> {
    const closed = this.zipClosures.get(zipfile)
    zipfile.close()
    await closed
  }
  /**
   * Get the current operating system code.
   * @returns The operating system code (`'win'`, `'mac'` or `'lin'`).
   */
  getOS(): 'win' | 'mac' | 'lin' {
    if (process.platform === 'win32') return 'win'
    if (process.platform === 'darwin') return 'mac'
    if (process.platform === 'linux') return 'lin'
    throw new EMLLibError(ErrorType.UNKNOWN_OS, 'Unknown operating system')
  }

  /**
   * Get the current operating system Minecraft-code.
   * @returns The operating system code (`'windows'`, `'osx'` or `'linux'`).
   */
  getOS_MCCode(): 'windows' | 'osx' | 'linux' {
    if (process.platform === 'win32') return 'windows'
    if (process.platform === 'darwin') return 'osx'
    if (process.platform === 'linux') return 'linux'
    throw new EMLLibError(ErrorType.UNKNOWN_OS, 'Unknown operating system')
  }

  /**
   * Get the current architecture.
   * @returns The architecture (`'64'` or `'32'`).
   */
  getArch(): '64' | '32' {
    if (process.arch.includes('64')) return '64'
    if (process.arch.includes('32')) return '32'
    throw new EMLLibError(ErrorType.UNKNOWN_OS, 'Unknown architecture')
  }

  /**
   * Get the current architecture Minecraft-code.
   * @returns The architecture (`'x64'`, `'arm64'` or `'x86'`).
   */
  getArch_MCCode() {
    if (process.arch === 'x64') return 'x64'
    if (process.arch === 'arm64') return 'arm64'
    return 'x86'
  }

  /**
   * Get the current operating system version.
   * @returns The operating system version (e.g. `10.0.19042`).
   */
  getOSVersion(): string {
    return os.release()
  }

  /**
   * Check if the current operating system is supported by EML Lib.
   * @returns `true` if the operating system is supported, `false` otherwise.
   */
  isOSSupported(): boolean {
    const os = this.getOS()
    const arch = this.getArch()
    if (arch === '32') return false
    if (os === 'win') return true
    if (os === 'mac') return true
    if (os === 'lin' && process.arch === 'x64') return true
    return false
  }

  /**
   * Get the path to the application data folder, depending on the operating system.
   * @returns The path to the application data folder (e.g. `'C:\Users\user\AppData\Roaming'`).
   */
  getAppDataFolder(): string {
    return this.getOS() === 'win'
      ? process.env.APPDATA + ''
      : this.getOS() === 'mac'
        ? process.env.HOME + '/Library/Application Support'
        : process.env.HOME + ''
  }

  /**
   * Get the path to the root folder.
   * @param serverId Your Minecraft server ID (e.g. `'minecraft'`).
   * @returns The path to the root folder (e.g. `'C:\Users\user\AppData\Roaming\.minecraft'`).
   */
  getRootFolder(config: ResolvedConfig): string {
    if (config.profile.slug && config.storage === 'isolated') {
      const slug = this.sanitizeSlug(config.profile.slug)
      return path_.join(this.getServerFolder(config.root), slug)
    }
    return this.getServerFolder(config.root)
  }

  /**
   * Get the path to the server folder.
   * @param serverId Your Minecraft server ID (e.g. `'minecraft'`).
   * @returns The path to the server folder (e.g. `'C:\Users\user\AppData\Roaming\.minecraft'`).
   */
  getServerFolder(serverId: string): string {
    serverId = serverId.replace(/[^a-z0-9]/gi, '_').toLowerCase()
    serverId = this.getOS() === 'mac' ? serverId : `.${serverId}`
    return path_.join(this.getAppDataFolder(), serverId)
  }

  /**
   * Sanitize a slug (e.g. a profile slug) by replacing spaces with dashes and removing special
   * characters.
   * @param slug The slug to sanitize.
   * @returns The sanitized slug (e.g. `'my-profile'`).
   */
  sanitizeSlug(slug: string): string {
    return slug
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '')
  }

  /**
   * Get the path of the temp folder, depending on the operating system.
   * @returns The path to the temp folder (e.g. `'C:\Users\user\AppData\Local\Temp'`).
   */
  getTempFolder(): string {
    return this.getOS() === 'win' ? process.env.TEMP + '' : '/tmp'
  }

  /**
   * Get the hash of a file.
   * @param filePath Path of the file.
   * @returns The hash of the file.
   */
  async getFileHash(filePath: string): Promise<string> {
    try {
      const hash = createHash('sha1')
      const input = operationStream(fs.createReadStream(filePath))
      await pipeline(input, hash)
      return hash.digest('hex')
    } catch (err) {
      throw new EMLLibError(ErrorType.HASH_ERROR, `Error while getting hash of the file ${filePath}: ${err}`)
    }
  }

  /**
   * Check if a single rule matches the current environment.
   * @param rule The rule to check.
   * @param features The feature flags to match against `rule.features` (unset features are `false`).
   * @returns `true` if every condition of the rule is satisfied.
   */
  private doesRuleMatch(rule: any, features: Record<string, boolean>): boolean {
    if (!rule || typeof rule !== 'object') return false

    if (rule.os) {
      if (rule.os.name && rule.os.name !== this.getOS_MCCode()) return false
      if (rule.os.arch && rule.os.arch !== this.getArch_MCCode()) return false
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(this.getOSVersion())) return false
        } catch {
          return false
        }
      }
    }

    if (rule.features) {
      for (const [feature, expected] of Object.entries(rule.features)) {
        if ((features[feature] ?? false) !== expected) return false
      }
    }

    return true
  }

  /**
   * Evaluate a Mojang rule list. Rules are applied in order and the last matching one wins; if
   * rules are present but none of them match, the item is denied.
   * @param rules The rules to evaluate.
   * @param features The feature flags to match against (unset features are `false`).
   * @returns `true` if the item is allowed for the current environment.
   */
  private evaluateRules(rules: any, features: Record<string, boolean> = {}): boolean {
    if (!Array.isArray(rules) || rules.length === 0) return true

    let allowed = false
    for (const rule of rules) {
      if (!this.doesRuleMatch(rule, features)) continue
      allowed = rule.action !== 'disallow'
    }
    return allowed
  }

  /**
   * Check if a library is allowed for the current operating system.
   * @param lib The library to check.
   * @returns `true` if the library is allowed, `false` otherwise.
   */
  isLibAllowed(lib: any): boolean {
    return this.evaluateRules(lib?.rules)
  }

  /**
   * Check if a JVM/game argument is allowed for the current operating system.
   * @param arg The argument to check.
   * @returns `true` if the argument is allowed, `false` otherwise.
   */
  isArgAllowed(arg: any): boolean {
    return this.evaluateRules(arg?.rules)
  }

  /**
   * Get the name of a Maven library.
   * @param libName The name of the library (e.g. `'com.mojang:authlib:1.5.25'`).
   * @returns The name of the library.
   */
  getLibraryName(libName: string): string {
    const parts = libName.split(':')

    if (libName.includes('@')) {
      if (parts.length === 4) {
        const name = parts[1]
        const version = parts[2]
        const classifierExt = parts[3]

        const [classifier, extension] = classifierExt.split('@')
        return `${name}-${version}${classifier ? '-' + classifier : ''}.${extension}`
      }
      if (parts.length === 3) {
        const name = parts[1]
        const versionExt = parts[2]

        const [version, extension] = versionExt.split('@')
        return `${name}-${version}.${extension}`
      }
    }

    const name = parts[1] || ''
    const version = parts[2] || ''
    const classifier = parts[3] || ''
    const ext = 'jar'

    return `${name}-${version}${classifier ? '-' + classifier : ''}.${ext}`
  }

  /**
   * Get the path of a Maven library.
   * @param libName The name of the library (e.g. `'com.mojang:authlib:1.5.25'`).
   * @param path [Optional] Additional path to add to the library path.
   * @returns The path of the library.
   */
  getLibraryPath(libName: string, ...path: string[]): string {
    const l = libName.replace(/@([a-z]*)$/, '').split(':')
    return path_.join(...path, `${l[0].replace(/\./g, '/')}/${l[1]}/${l[2]}/`)
  }

  /**
   * Get the group, name and version of a Maven library from its name or path.
   * @param libNameOrPath The name or path of the library.
   * @returns An object containing the group, name and version of the library.
   */
  getPartsFromNameOrPath(libNameOrPath: string): { group: string; name: string; version: string } {
    if (libNameOrPath.includes(':') && libNameOrPath.includes('@')) {
      libNameOrPath = this.getLibraryPath(libNameOrPath)
    }

    if (libNameOrPath.includes(':')) {
      const parts = libNameOrPath.split(':')
      return { group: parts[0], name: parts[1], version: parts[2] }
    }

    const parts = libNameOrPath.replaceAll('\\', '/').split('/')
    const l = parts.length
    const version = parts[l - 2]
    const group = parts.slice(0, l - 2).join('.')
    const name = parts[l - 1].replace(`-${version}.jar`, '')
    return { group, name, version }
  }

  /**
   * Check if a version is newer than another one.
   * @param refVersion Reference version.
   * @param checkVersion Version to check.
   * @returns `true` if `checkVersion` is newer than `refVersion`, `false` if `checkVersion` is
   * older than
   * `refVersion`, `null` if the versions are the same.
   */
  isNewer(ref: ExtraFile, check: ExtraFile): boolean | null {
    if (ref.sha1 === check.sha1) return null

    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '')
    const refArtifact = path_.dirname(normalize(ref.path))
    const checkArtifact = path_.dirname(normalize(check.path))

    if (refArtifact !== checkArtifact) return false

    const vRef = this.parseVersion(path_.basename(normalize(ref.path)))
    const vCheck = this.parseVersion(path_.basename(normalize(check.path)))

    for (let i = 0; i < Math.max(vRef.length, vCheck.length); i++) {
      const r = vRef[i] ?? 0
      const c = vCheck[i] ?? 0
      if (c > r) return true
      if (c < r) return false
    }

    return false
  }

  /**
   * Get the size of a remote file by sending a HEAD request to the file URL.
   * @param url URL of the file.
   * @param errorMsg Error message to include in the error if the request fails.
   * @returns The size of the file in bytes.
   */
  async getRemoteFileSize(url: string, errorMsg: string): Promise<number> {
    try {
      const req = await fetch(url, { method: 'HEAD', headers: { Connection: 'close' } })
      if (!req.ok) {
        throw new EMLLibError(ErrorType.FETCH_ERROR, `${errorMsg}: HTTP ${req.status} ${await req.text()}`)
      }
      return Number(req.headers.get('Content-Length') ?? 0)
    } catch (err) {
      throw new EMLLibError(ErrorType.FETCH_ERROR, `${errorMsg}: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * Get the SHA1 hash of a remote file by sending a GET request to the file URL and reading the
   * response as text.
   * @param url URL of the file.
   * @param errorMsg Error message to include in the error if the request fails.
   * @returns The SHA1 hash of the file as a string.
   */
  async getRemoteFileSha1(url: string, errorMsg: string): Promise<string> {
    try {
      const req = await fetch(`${url}.sha1`, { headers: { Connection: 'close' } })
      if (!req.ok) {
        throw new EMLLibError(ErrorType.FETCH_ERROR, `${errorMsg}: HTTP ${req.status} ${await req.text()}`)
      }
      return await req.text().then((text) => text.trim())
    } catch (err) {
      throw new EMLLibError(ErrorType.FETCH_ERROR, `${errorMsg}: ${err instanceof Error ? err.message : err}`)
    }
  }

  private parseVersion(v: string) {
    return v
      .split('-')[0]
      .split('+')[0]
      .split('.')
      .map((n) => parseInt(n) || 0)
  }

  /**
   * Open a zip file and return the zipfile object and an array of entries.
   * @param zipPath Path to the zip file.
   * @returns An object containing the zipfile and an array of entries.
   */
  openZip(zipPath: string): Promise<{ zipfile: yauzl.ZipFile; entries: yauzl.Entry[] }> {
    checkCancellation()
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: false, autoClose: false }, (err, zipfile) => {
        if (err || !zipfile) {
          return reject(err ?? new EMLLibError(ErrorType.FILE_ERROR, `Failed to open ${zipPath}`))
        }
        const entries: yauzl.Entry[] = []
        this.zipClosures.set(zipfile, new Promise((resolve) => zipfile.once('close', resolve)))
        const signal = operationSignal()
        const abort = () => {
          cleanup()
          void this.closeZip(zipfile).then(() => {
            try {
              checkCancellation(signal)
            } catch (error) {
              reject(error)
            }
          }, reject)
        }
        signal?.addEventListener('abort', abort, { once: true })
        const cleanup = () => signal?.removeEventListener('abort', abort)
        if (signal?.aborted) return abort()
        zipfile.on('entry', (entry) => entries.push(entry))
        zipfile.on('end', () => {
          cleanup()
          resolve({ zipfile, entries })
        })
        zipfile.on('error', (error) => {
          cleanup()
          void this.closeZip(zipfile).then(() => reject(error), reject)
        })
        zipfile.once('close', cleanup)
      })
    })
  }

  /**
   * Read the data of a zip entry and return it as a Buffer.
   * @param zipfile The zip file object.
   * @param entry The zip entry to read.
   * @returns A promise resolving to the buffer containing the entry data.
   */
  readEntryData(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
    checkCancellation()
    return new Promise((resolve, reject) => {
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err || !readStream) {
          return reject(err ?? new EMLLibError(ErrorType.FILE_ERROR, `Failed to open read stream for ${entry.fileName}`))
        }
        const chunks: Buffer[] = []
        operationStream(readStream)
        readStream.on('data', (chunk) => chunks.push(chunk))
        readStream.on('end', () => resolve(Buffer.concat(chunks)))
        readStream.on('error', reject)
      })
    })
  }

  /**
   * Extract a zip entry to a file.
   * @param zipfile The zip file object.
   * @param entry The zip entry to extract.
   * @param destPath The path to the destination file.
   * @returns A promise resolving when the extraction is complete.
   */
  extractEntryToFile(zipfile: yauzl.ZipFile, entry: yauzl.Entry, destPath: string): Promise<void> {
    checkCancellation()
    return new Promise((resolve, reject) => {
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err || !readStream) {
          return reject(err ?? new EMLLibError(ErrorType.FILE_ERROR, `Failed to open read stream for ${entry.fileName}`))
        }
        pipeline(readStream, createWriteStream(destPath), { signal: operationSignal() }).then(() => resolve(), reject)
      })
    })
  }

  /**
   * Pipe a zip entry from a source zip file to a destination zip file using yazl.
   * @param sourceZip The source zip file object.
   * @param entry The zip entry to pipe.
   * @param destZip The destination zip file object.
   * @returns A promise resolving when the piping is complete.
   */
  pipeEntryToYazl(sourceZip: yauzl.ZipFile, entry: yauzl.Entry, destZip: yazl.ZipFile): Promise<void> {
    checkCancellation()
    return new Promise((resolve, reject) => {
      sourceZip.openReadStream(entry, (err, readStream) => {
        if (err || !readStream) {
          return reject(err ?? new EMLLibError(ErrorType.FILE_ERROR, `Failed to open read stream for ${entry.fileName}`))
        }
        operationStream(readStream)
        const output = destZip.outputStream
        const cleanup = () => {
          output.removeListener('error', failed)
          output.removeListener('close', closed)
        }
        const failed = (error: Error) => {
          readStream.destroy()
          cleanup()
          reject(error)
        }
        const closed = () => failed(new EMLLibError(ErrorType.FILE_ERROR, 'Archive output closed before its entry completed.'))
        readStream.once('end', () => {
          cleanup()
          resolve()
        })
        readStream.once('error', (error) => {
          cleanup()
          reject(error)
        })
        output.once('error', failed)
        output.once('close', closed)
        if ((output as Readable).destroyed) return closed()
        try {
          destZip.addReadStream(readStream, entry.fileName)
        } catch (error) {
          failed(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }
}

export default new Utils()
