/**
 * @license MIT
 * @copyright Copyright (c) 2026, GoldFrite
 */

/**
 * The error class for EMLLib.
 */
export class EMLLibError extends Error {
  code: ErrorCode
  message: any
  readonly status?: number
  readonly serverCode?: string
  readonly cause?: unknown

  constructor(code: ErrorCode, message: any, options: { status?: number; serverCode?: string; cause?: unknown } = {}) {
    super(message)
    this.code = code
    this.name = 'EMLLibError'
    this.status = options.status ?? (Number(/\bHTTP (\d{3})\b/.exec(String(message))?.[1]) || undefined)
    this.serverCode = options.serverCode
    this.cause = options.cause
  }
}

export const ErrorType = {
  MODULE_NOT_FOUND: 'MODULE_NOT_FOUND',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  TWOFA_CODE_REQUIRED: 'TWOFA_CODE_REQUIRED',
  AUTH_ERROR: 'AUTH_ERROR',
  AUTH_CANCELLED: 'AUTH_CANCELLED',
  HASH_ERROR: 'HASH_ERROR',
  DOWNLOAD_ERROR: 'DOWNLOAD_ERROR',
  UNKNOWN_OS: 'UNKNOWN_OS',
  FETCH_ERROR: 'FETCH_ERROR',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  NET_ERROR: 'NET_ERROR',
  FILE_ERROR: 'FILE_ERROR',
  EXEC_ERROR: 'EXEC_ERROR',
  JAVA_ERROR: 'JAVA_ERROR',
  PATCHER_ERROR: 'PATCHER_ERROR',
  MINECRAFT_ERROR: 'MINECRAFT_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  INVALID_OPERATION: 'INVALID_OPERATION'
} as const

export type ErrorCode =
  | typeof ErrorType.MODULE_NOT_FOUND
  | typeof ErrorType.UNKNOWN_ERROR
  | typeof ErrorType.TWOFA_CODE_REQUIRED
  | typeof ErrorType.AUTH_ERROR
  | typeof ErrorType.AUTH_CANCELLED
  | typeof ErrorType.DOWNLOAD_ERROR
  | typeof ErrorType.HASH_ERROR
  | typeof ErrorType.UNKNOWN_OS
  | typeof ErrorType.NET_ERROR
  | typeof ErrorType.FETCH_ERROR
  | typeof ErrorType.TOO_MANY_REQUESTS
  | typeof ErrorType.FILE_ERROR
  | typeof ErrorType.EXEC_ERROR
  | typeof ErrorType.JAVA_ERROR
  | typeof ErrorType.PATCHER_ERROR
  | typeof ErrorType.MINECRAFT_ERROR
  | typeof ErrorType.CONFIG_ERROR
  | typeof ErrorType.INVALID_OPERATION

/**
 * Classifies an error thrown by this library as a connectivity failure
 * (network unreachable, DNS, timeout, 5xx, etc.) versus a genuine rejection
 * from the server (bad credentials, invalid/expired token, insufficient
 * scope, and so on).
 *
 * Consumers can use this to decide whether a failure is worth retrying /
 * safe to degrade gracefully from (network) or should be treated as final
 * (auth) — e.g. falling back to an offline/cached state only makes sense
 * for the former.
 *
 * Programming/configuration failures and rate limits are not connectivity failures.
 * Native transport errors are recognized by their network/abort error names.
 */
export function isEmlNetworkError(err: unknown): boolean {
  if (err instanceof EMLLibError) {
    return (
      err.code === ErrorType.NET_ERROR ||
      (err.code === ErrorType.FETCH_ERROR && (err.status === undefined || err.status === 408 || err.status >= 500))
    )
  }
  return err instanceof Error && ['TypeError', 'AbortError', 'TimeoutError'].includes(err.name)
}
