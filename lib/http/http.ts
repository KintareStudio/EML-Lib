import { EMLLibError, ErrorType } from '../../types/errors.js'
import { checkCancellation, operationSignal, requestSignal } from '../utils/operation.js'

export type HttpTransport = (url: string, init?: RequestInit) => Promise<Response>
export interface HttpOptions {
  fetch?: HttpTransport
  timeoutMs?: number
}

export function classifyHttpStatus(status: number, serverCode?: string): (typeof ErrorType)[keyof typeof ErrorType] {
  if (status === 429) return ErrorType.TOO_MANY_REQUESTS
  if (status >= 500 || status === 408) return ErrorType.FETCH_ERROR
  if (status === 401 || status === 403 || serverCode === 'invalid_grant') return ErrorType.AUTH_ERROR
  return ErrorType.INVALID_OPERATION
}

export async function httpError(response: Response, operation = 'Request failed'): Promise<EMLLibError> {
  let body: {
    error?: string
    code?: string
    errorMessage?: string
    error_description?: string
    message?: string
  } | null = null
  try {
    body = await response.json()
  } catch {
    /* Proxy/non-JSON refusals retain their HTTP status. */
  }
  const serverCode = body?.code ?? body?.error
  return new EMLLibError(
    classifyHttpStatus(response.status, serverCode),
    `${operation}: HTTP ${response.status}${body?.errorMessage || body?.error_description || body?.message ? ` ${body.errorMessage || body.error_description || body.message}` : ''}`,
    { status: response.status, serverCode }
  )
}

export function requestError(cause: unknown, operation: string): EMLLibError {
  if (cause instanceof EMLLibError) return cause
  const network = cause instanceof Error && ['TypeError', 'AbortError', 'TimeoutError'].includes(cause.name)
  return new EMLLibError(network ? ErrorType.NET_ERROR : ErrorType.UNKNOWN_ERROR, operation, {
    cause
  })
}

let defaultTransport: HttpTransport = (url, init) => globalThis.fetch(url, init)

/** Set the application's default transport without replacing the global fetch function. */
export function configureHttp(options: { fetch: HttpTransport }): void {
  defaultTransport = options.fetch
}

export class HttpClient {
  constructor(private readonly options: HttpOptions = {}) {}

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    checkCancellation()
    const headers = new Headers(init.headers)
    const authenticated = headers.has('Authorization') || headers.has('Cookie') || init.body != null
    try {
      return await (this.options.fetch ?? defaultTransport)(url, {
        ...init,
        redirect: init.redirect ?? (authenticated ? 'error' : 'follow'),
        signal: init.signal ?? requestSignal(operationSignal(), this.options.timeoutMs ?? 30_000)
      })
    } catch (cause) {
      checkCancellation()
      if (cause instanceof EMLLibError) throw cause
      throw new EMLLibError(ErrorType.NET_ERROR, 'The server could not be reached.', { cause })
    }
  }

  async json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(url, init)
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new EMLLibError(
        classifyHttpStatus(response.status, body?.code ?? body?.error),
        body?.errorMessage || body?.message || `Request failed: HTTP ${response.status}`,
        { status: response.status, serverCode: body?.code ?? body?.error }
      )
    }
    if (response.status === 204) return undefined as T
    if (body === null)
      throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid JSON response.', {
        status: response.status
      })
    return body as T
  }
}

const client = new HttpClient()
export const httpFetch: HttpTransport = (url, init) => client.fetch(url, init)
