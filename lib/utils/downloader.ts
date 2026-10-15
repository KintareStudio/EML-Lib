/**
 * @license MIT
 * @copyright Copyright (c) 2026, GoldFrite
 */
import { HttpClient, HttpOptions, httpError } from '../http/http.js'
import { File } from '../../types/file.js'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import EventEmitter from './events.js'
import { DownloaderEvents } from '../../types/events.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import { OperationOptions, cancellationError, checkCancellation, linkedSignals, operationSignal, retryDelay } from './operation.js'
import { adminToolDownloadUrl } from './trusted-download.js'

export interface DownloadOptions extends OperationOptions {
  /** Retries after the initial attempt. Defaults to 5. */
  retries?: number
  /** Base retry delay in milliseconds. Defaults to 1000. */
  retryDelayMs?: number
  timeoutMs?: number
}
export interface DownloaderOptions extends DownloadOptions, HttpOptions {
  /** Explicit trusted deployment; never inferred from a downloaded manifest. */
  adminToolUrl?: string
}

export default class Downloader extends EventEmitter<DownloaderEvents> {
  private readonly dest: string
  private readonly http: HttpClient
  private active = false
  private size = 0
  private amount = 0
  private downloaded = { amount: 0, size: 0 }
  private speed = 0
  private lastTime = 0
  private lastSize = 0

  constructor(
    dest: string,
    private readonly token?: string,
    private readonly options: DownloaderOptions = {}
  ) {
    super()
    this.dest = path.resolve(dest)
    this.http = new HttpClient(options)
  }

  async download(files: File[], skipCheck = false, options: DownloadOptions = {}): Promise<void> {
    if (this.active) throw new EMLLibError(ErrorType.INVALID_OPERATION, 'This downloader already has an active operation.')
    this.active = true
    this.downloaded = { amount: 0, size: 0 }
    const stop = new AbortController()
    const caller = linkedSignals([operationSignal(), this.options.signal, options.signal])
    const work = linkedSignals([caller.signal, stop.signal])
    const settings = { retries: 5, retryDelayMs: 1000, timeoutMs: 15 * 60_000, ...this.options, ...options }
    try {
      checkCancellation(caller.signal)
      if (
        !Number.isInteger(settings.retries) ||
        settings.retries < 0 ||
        !Number.isFinite(settings.retryDelayMs) ||
        settings.retryDelayMs < 0 ||
        !Number.isInteger(settings.timeoutMs) ||
        settings.timeoutMs <= 0 ||
        settings.timeoutMs > 0xffffffff
      )
        throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid download retry or timeout options.')
      files.forEach((file) => this.filePath(file))
      const selected = skipCheck ? files : await this.getFilesToDownload(files, { signal: caller.signal })
      const queue = selected.filter((file) => file.type !== 'FOLDER' && file.url)
      for (const folder of selected.filter((file) => file.type === 'FOLDER')) await this.directory(this.filePath(folder), caller.signal)
      this.size = queue.reduce((sum, file) => sum + (file.size ?? 0), 0)
      this.amount = queue.length
      this.downloaded = { amount: 0, size: 0 }
      this.speed = this.lastSize = 0
      this.lastTime = Date.now()
      let failure: unknown
      const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (!work.signal.aborted && queue.length) {
          const file = queue.shift()!
          try {
            await this.downloadWithRetry(file, settings, work.signal)
            this.downloaded.amount++
          } catch (error) {
            if (failure === undefined) {
              failure = error
              stop.abort(error)
              if (!caller.signal.aborted)
                this.emit('download_error', { filename: file.name, type: file.type, message: error instanceof Error ? error.message : String(error) })
            }
          }
        }
      })
      // Drain workers before returning: no sibling may keep writing after a rejection.
      const results = await Promise.allSettled(workers)
      checkCancellation(caller.signal)
      if (failure !== undefined) throw failure
      const rejected = results.find((result) => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      this.emit('download_end', { downloaded: { ...this.downloaded } })
    } catch (error) {
      if (caller.signal.aborted) {
        this.emit('download_cancelled', { downloaded: { ...this.downloaded } })
        throw cancellationError(caller.signal)
      }
      throw error
    } finally {
      caller.dispose()
      work.dispose()
      this.active = false
    }
  }

  async getFilesToDownload(files: File[], options: OperationOptions = {}): Promise<File[]> {
    const linked = linkedSignals([operationSignal(), this.options.signal, options.signal])
    try {
      const result: File[] = []
      for (const file of files) {
        checkCancellation(linked.signal)
        const target = this.filePath(file)
        await this.directory(file.type === 'FOLDER' ? target : path.dirname(target), linked.signal)
        if (file.type === 'FOLDER') continue
        let needed = false
        try {
          const info = await fs.lstat(target)
          if (info.isSymbolicLink() || !info.isFile()) throw new EMLLibError(ErrorType.FILE_ERROR, 'Download target is not a regular file.')
          needed = file.size !== undefined && file.size !== info.size
          if (!needed && file.sha1) {
            const hash = createHash('sha1')
            for await (const chunk of createReadStream(target, { signal: linked.signal })) hash.update(chunk)
            needed = hash.digest('hex') !== file.sha1.toLowerCase()
          }
        } catch (error) {
          checkCancellation(linked.signal)
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          needed = true
        }
        if (needed && file.url) result.push(file)
      }
      checkCancellation(linked.signal)
      return result
    } finally {
      linked.dispose()
    }
  }

  private filePath(file: File): string {
    if (!file.name || path.basename(file.name) !== file.name || /[\\/]/.test(file.name))
      throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Unsafe download filename.')
    const target = path.resolve(this.dest, file.path, file.name)
    const relative = path.relative(this.dest, target)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Download path escapes its destination.')
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0))
      throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid download size.')
    if (file.sha1 && !/^[a-f0-9]{40}$/i.test(file.sha1)) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid SHA-1 in download metadata.')
    return target
  }

  private async directory(destination: string, signal: AbortSignal): Promise<void> {
    checkCancellation(signal)
    await fs.mkdir(this.dest, { recursive: true })
    let current = this.dest
    for (const part of path.relative(this.dest, destination).split(path.sep).filter(Boolean)) {
      checkCancellation(signal)
      current = path.join(current, part)
      try {
        await fs.mkdir(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const info = await fs.lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new EMLLibError(ErrorType.FILE_ERROR, 'Download directory contains a symbolic link or non-directory.')
    }
    checkCancellation(signal)
  }

  private async downloadWithRetry(
    file: File,
    options: Required<Pick<DownloadOptions, 'retries' | 'retryDelayMs' | 'timeoutMs'>>,
    signal: AbortSignal
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      checkCancellation(signal)
      try {
        await this.downloadFile(file, options.timeoutMs, signal)
        return
      } catch (error) {
        checkCancellation(signal)
        const retryable =
          error instanceof EMLLibError
            ? [ErrorType.NET_ERROR, ErrorType.FETCH_ERROR, ErrorType.DOWNLOAD_ERROR, ErrorType.HASH_ERROR].includes(error.code as never) &&
              !(error.status && error.status >= 400 && error.status < 500 && error.status !== 408)
            : !['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')
        if (!retryable || attempt >= options.retries) throw error
        await retryDelay(options.retryDelayMs * (attempt + 1), signal)
      }
    }
  }

  private async downloadFile(file: File, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const target = this.filePath(file)
    await this.directory(path.dirname(target), signal)
    const temporary = path.join(path.dirname(target), `.${file.name}.${randomUUID()}.part`)
    const request = linkedSignals([signal, AbortSignal.timeout(timeoutMs)])
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    let stream: Readable | undefined
    let created = false,
      installed = false,
      received = 0,
      counted = 0
    try {
      const headers: HeadersInit = { Accept: 'application/octet-stream' }
      if (this.token && adminToolDownloadUrl(file.url, this.options.adminToolUrl)) headers.Authorization = `Bearer ${this.token}`
      const response = await this.http.fetch(file.url, {
        headers,
        signal: request.signal,
        ...(headers.Authorization ? { redirect: 'error' as const } : {})
      })
      if (!response.ok) throw await httpError(response, `Failed to download ${file.name}`)
      if (!response.body) throw new EMLLibError(ErrorType.FETCH_ERROR, `Empty response for ${file.name}`)
      stream = Readable.fromWeb(response.body as never, { signal: request.signal })
      // Cancellation can arrive while we inspect/open the destination, before async iteration starts.
      stream.on('error', () => {})
      const headerSize = response.headers.get('content-length')
      const identity = !response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity'
      const expectedSize = file.size ?? (identity && headerSize !== null && /^\d+$/.test(headerSize) ? Number(headerSize) : undefined)
      const hash = createHash('sha1')
      let mode = 0o666 & ~process.umask()
      try {
        const previous = await fs.lstat(target)
        if (!previous.isFile() || previous.isSymbolicLink()) throw new EMLLibError(ErrorType.FILE_ERROR, 'Download target is not a regular file.')
        mode = previous.mode & 0o777
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      checkCancellation(signal)
      handle = await fs.open(temporary, 'wx', 0o600)
      created = true
      for await (const chunk of stream) {
        checkCancellation(signal)
        received += chunk.length
        if (expectedSize !== undefined && received > expectedSize) throw new EMLLibError(ErrorType.HASH_ERROR, `Size mismatch for ${file.name}`)
        hash.update(chunk)
        await handle.writeFile(chunk)
        counted += chunk.length
        this.downloaded.size += chunk.length
        const now = Date.now(),
          elapsed = now - this.lastTime
        if (elapsed > 500) {
          this.speed = (this.downloaded.size - this.lastSize) / (elapsed / 1000)
          this.lastTime = now
          this.lastSize = this.downloaded.size
        }
        this.emit('download_progress', {
          total: { amount: this.amount, size: this.size },
          downloaded: { ...this.downloaded },
          speed: Math.floor(this.speed),
          type: file.type
        })
      }
      checkCancellation(signal)
      if ((expectedSize !== undefined && received !== expectedSize) || (file.sha1 && hash.digest('hex') !== file.sha1.toLowerCase()))
        throw new EMLLibError(ErrorType.HASH_ERROR, `Integrity check failed for ${file.name}`)
      await handle.chmod(process.platform !== 'win32' && file.executable ? 0o755 : mode)
      await handle.sync()
      await handle.close()
      handle = undefined
      checkCancellation(signal)
      await fs.rename(temporary, target)
      installed = true
    } finally {
      try {
        stream?.destroy()
        try {
          await handle?.close()
        } finally {
          if (created && !installed) {
            await fs.unlink(temporary).catch((error) => {
              if (error.code !== 'ENOENT') throw error
            })
            this.downloaded.size -= counted
            this.lastSize = Math.min(this.lastSize, this.downloaded.size)
          }
        }
      } finally {
        request.dispose()
      }
    }
  }
}
