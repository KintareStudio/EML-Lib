import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { HttpClient, HttpOptions } from '../http/http.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import { GitHubReleaseOptions, GitHubReleaseCache, latestReleaseAsset, fetchReleaseAsset, releaseSelector } from './github-release.js'

export interface AuthAgentProgress {
  current: number
  total: number
}
export interface AuthAgentOptions extends HttpOptions {
  url?: string
  githubRelease?: GitHubReleaseOptions
  cacheDirectory: string
  sha256?: string
  fileName?: string
}

/** Conditional download and atomic cache installation, independent of Electron. */
export class AuthAgent {
  private readonly http: HttpClient
  private pending?: Promise<string | null>
  constructor(private readonly options: AuthAgentOptions) {
    this.http = new HttpClient(options)
  }

  ensure(onProgress?: (progress: AuthAgentProgress) => void): Promise<string | null> {
    if (this.pending) return this.pending
    const pending = this.install(onProgress).finally(() => {
      this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  static javaArguments(jarPath: string, server: string, properties: Record<string, string | boolean> = {}): string[] {
    return [`-javaagent:${jarPath}=${server}`, ...Object.entries(properties).map(([name, value]) => `-D${name}=${value}`)]
  }

  private valid(buffer: Buffer, sha256 = this.options.sha256): boolean {
    return (
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      (!sha256 || createHash('sha256').update(buffer).digest('hex') === sha256.toLowerCase())
    )
  }

  private async install(onProgress?: (progress: AuthAgentProgress) => void): Promise<string | null> {
    const fileName = this.options.fileName ?? 'auth-agent.jar'
    if (path.basename(fileName) !== fileName) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid auth agent cache filename.')
    const jar = path.join(this.options.cacheDirectory, fileName)
    const etagFile = `${jar}.etag`
    const cached = await fs.readFile(jar).catch(() => null)
    const hasCache = cached !== null && this.valid(cached)
    const releaseFile = `${jar}.release.json`
    const releaseCache: GitHubReleaseCache | null = await fs
      .readFile(releaseFile, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null)
    const cachedHash = hasCache ? createHash('sha256').update(cached!).digest('hex') : null
    const verifiedReleaseCache =
      hasCache &&
      this.options.githubRelease &&
      releaseCache?.repository === this.options.githubRelease.repository &&
      releaseCache.selector === releaseSelector(this.options.githubRelease) &&
      releaseCache?.asset &&
      releaseCache.localSha256 === cachedHash &&
      (!releaseCache.asset.sha256 || releaseCache.asset.sha256 === cachedHash)
        ? releaseCache
        : undefined
    const etag = hasCache ? await fs.readFile(etagFile, 'utf8').catch(() => null) : null
    let temporary: string | undefined
    try {
      let release: Awaited<ReturnType<typeof latestReleaseAsset>> | undefined
      if (this.options.githubRelease) {
        release = await latestReleaseAsset(this.http, this.options.githubRelease, verifiedReleaseCache)
        if (release === null) return jar
        if (
          hasCache &&
          ((release.asset.sha256 && release.asset.sha256 === cachedHash) ||
            (verifiedReleaseCache?.asset.id === release.asset.id && verifiedReleaseCache.asset.url === release.asset.url && !release.asset.sha256))
        ) {
          await this.writeReleaseCache(releaseFile, {
            repository: this.options.githubRelease.repository,
            selector: releaseSelector(this.options.githubRelease),
            ...release,
            localSha256: cachedHash!
          })
          return jar
        }
      }
      if (!release && !this.options.url) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Configure an auth-agent URL or GitHub release.')
      const response = release
        ? await fetchReleaseAsset(this.http, release.asset.url)
        : await this.http.fetch(this.options.url!, {
            headers: etag ? { 'If-None-Match': etag.trim() } : {},
            redirect: 'error'
          })
      if (response.status === 304) return hasCache ? jar : null
      if (!response.ok) return hasCache ? jar : null
      const total = Number(response.headers.get('content-length')) || 0
      const chunks: Uint8Array[] = []
      let current = 0
      if (!response.body) throw new Error('Empty auth agent response')
      const reader = response.body.getReader()
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          chunks.push(chunk.value)
          current += chunk.value.byteLength
          if (current > 64 * 1024 * 1024) throw new Error('Auth agent exceeds 64 MB')
          onProgress?.({ current, total: total || current })
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      const buffer = Buffer.concat(chunks)
      if (!this.valid(buffer) || (release && (!this.valid(buffer, release.asset.sha256) || buffer.length !== release.asset.size)))
        throw new EMLLibError(ErrorType.HASH_ERROR, 'Invalid auth agent JAR or checksum.')
      await fs.mkdir(this.options.cacheDirectory, { recursive: true })
      temporary = `${jar}.tmp-${randomUUID()}`
      await fs.writeFile(temporary, buffer, { flag: 'wx' })
      await fs.rename(temporary, jar)
      if (release && this.options.githubRelease) {
        await this.writeReleaseCache(releaseFile, {
          repository: this.options.githubRelease.repository,
          selector: releaseSelector(this.options.githubRelease),
          ...release,
          localSha256: createHash('sha256').update(buffer).digest('hex')
        })
      }
      const nextEtag = response.headers.get('etag')
      // An interrupted ETag update may cause another download, never a partial JAR.
      await fs.rm(etagFile, { force: true })
      if (nextEtag) await fs.writeFile(etagFile, nextEtag)
      return jar
    } catch {
      return hasCache ? jar : null
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  private async writeReleaseCache(file: string, data: GitHubReleaseCache): Promise<void> {
    const temporary = `${file}.tmp-${randomUUID()}`
    try {
      await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx' })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }
}
