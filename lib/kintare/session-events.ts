import type { Account } from '../../types/account.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import { HttpClient, httpError, requestError } from '../http/http.js'
import { checkCancellation, linkedSignals, operationSignal, retryDelay } from '../utils/operation.js'

type SessionRejection = 'revoked' | 'expired' | 'invalidated' | 'invalid_token'
type SessionState = 'active' | 'unsupported' | SessionRejection

export type SessionCheckResult =
  | { status: SessionState }
  | { status: 'unknown'; error: EMLLibError }

export interface SessionWatchOptions {
  signal: AbortSignal
  /** Persist the replacement if the saved credential still matches the previous one. */
  onRefresh: (account: Account, previous: Account) => void | Promise<void>
}

export interface SessionWatchResult {
  status: 'revoked' | 'reauthenticate' | 'unsupported' | 'aborted'
  account: Account
}

type Attempt =
  | { status: SessionState }
  | { status: 'retry'; error: EMLLibError; retryAfter?: number; healthy?: boolean }

const retryStart = 1000
const heartbeatMs = 25_000
const idleMs = 60_000
const frameLimit = 8192

function isRejection(value?: string): value is SessionRejection {
  return value === 'revoked' || value === 'expired' || value === 'invalidated' || value === 'invalid_token'
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  if (Number.isFinite(milliseconds)) return Math.min(2_147_483_647, Math.max(0, milliseconds))
}

async function readSessionEvent(body: ReadableStream<Uint8Array>, signal: AbortSignal, onChunk: () => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const cancel = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  let pending = ''
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done || signal.aborted) return
      onChunk()
      pending += decoder.decode(value, { stream: true })
      let boundary = /\r?\n\r?\n/.exec(pending)
      while (boundary) {
        if (boundary.index > frameLimit) break
        const frame = pending.slice(0, boundary.index)
        pending = pending.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (isRejection(data)) return data
        boundary = /\r?\n\r?\n/.exec(pending)
      }
      if (pending.length > frameLimit) throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid Kintare session event.')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

export class KintareSessionEvents {
  constructor(
    private readonly http: HttpClient,
    private readonly endpoint: string,
    private readonly timeoutMs = 30_000
  ) {}

  async check(account: Account, signal?: AbortSignal): Promise<SessionCheckResult> {
    const linked = linkedSignals([signal, operationSignal()])
    try {
      checkCancellation(linked.signal)
      const result = await this.attempt(account.accessToken, linked.signal, true)
      checkCancellation(linked.signal)
      return result.status === 'retry' ? { status: 'unknown', error: result.error } : result
    } finally {
      linked.dispose()
    }
  }

  async watch(
    account: Account,
    options: SessionWatchOptions,
    refresh: (account: Account) => Promise<Account>
  ): Promise<SessionWatchResult> {
    const linked = linkedSignals([options.signal, operationSignal()])
    const signal = linked.signal
    let current = account
    let waitMs = retryStart
    try {
      while (!signal.aborted) {
        const result = await this.attempt(current.accessToken, signal, false)
        if (signal.aborted) break
        if (result.status === 'revoked' || result.status === 'unsupported') {
          return { status: result.status, account: current }
        }
        if (result.status === 'invalid_token') return { status: 'reauthenticate', account: current }
        if (result.status === 'expired' || result.status === 'invalidated') {
          if (!current.refreshToken) return { status: 'reauthenticate', account: current }
          let replacement: Account | undefined
          try {
            replacement = await refresh(current)
          } catch (error) {
            if (signal.aborted) break
            if (error instanceof EMLLibError && error.serverCode === 'invalid_grant') {
              return { status: 'reauthenticate', account: current }
            }
          }
          if (replacement) {
            const previous = current
            current = replacement
            // A successful rotation needs persistence even if the account changed while awaiting it.
            await options.onRefresh(current, previous)
          }
        }
        if (signal.aborted) break
        if (result.status === 'retry' && result.healthy) waitMs = retryStart
        const delay = result.status === 'retry' ? Math.max(waitMs, result.retryAfter ?? 0) : waitMs
        try {
          await retryDelay(delay, signal)
        } catch (error) {
          if (signal.aborted) break
          throw error
        }
        waitMs = Math.min(waitMs * 2, 30_000)
      }
      return { status: 'aborted', account: current }
    } finally {
      linked.dispose()
    }
  }

  private async attempt(token: string, signal: AbortSignal, check: boolean): Promise<Attempt> {
    const request = new AbortController()
    const linked = linkedSignals([signal, request.signal])
    let timer = setTimeout(() => request.abort(), this.timeoutMs)
    const keepAlive = () => {
      clearTimeout(timer)
      timer = setTimeout(() => request.abort(), idleMs)
    }
    let connectedAt: number | undefined
    try {
      const response = await this.http.fetch(check ? this.endpoint + '?check=1' : this.endpoint, {
        headers: { Authorization: `Bearer ${token}`, Accept: check ? 'application/json' : 'text/event-stream' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: linked.signal
      })
      if (check && response.status === 204) return { status: 'active' }
      if (response.status === 404) return { status: 'unsupported' }
      if (!response.ok) {
        const error = await httpError(response, 'Kintare session check failed')
        if (response.status === 403 && isRejection(error.serverCode)) return { status: error.serverCode }
        return { status: 'retry', error, retryAfter: retryAfter(response.headers.get('Retry-After')) }
      }
      const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (check || response.status !== 200 || type !== 'text/event-stream' || !response.body) {
        return { status: 'retry', error: new EMLLibError(ErrorType.FETCH_ERROR, 'Unexpected Kintare session response.') }
      }
      connectedAt = Date.now()
      keepAlive()
      const event = await readSessionEvent(response.body, linked.signal, keepAlive)
      if (event) return { status: event }
      return {
        status: 'retry',
        healthy: Date.now() - connectedAt >= heartbeatMs,
        error: new EMLLibError(ErrorType.NET_ERROR, 'Kintare session stream disconnected.')
      }
    } catch (error) {
      return {
        status: 'retry',
        healthy: connectedAt !== undefined && Date.now() - connectedAt >= heartbeatMs,
        error: requestError(error, 'Kintare session check failed.')
      }
    } finally {
      clearTimeout(timer)
      request.abort()
      linked.dispose()
    }
  }
}
