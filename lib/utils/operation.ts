import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { addAbortSignal } from 'node:stream'
import { EMLLibError, ErrorType } from '../../types/errors.js'

export interface OperationOptions {
  signal?: AbortSignal
}

const operations = new AsyncLocalStorage<OperationOptions>()
export const operationSignal = (): AbortSignal | undefined => operations.getStore()?.signal

export function operationStream<T extends NodeJS.ReadableStream | NodeJS.WritableStream>(stream: T): T {
  const signal = operationSignal()
  if (signal) addAbortSignal(signal, stream)
  return stream
}

export async function settledOperations<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks)
  checkCancellation()
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  return results.map((result) => (result as PromiseFulfilledResult<T>).value)
}

export function cancellationError(signal?: AbortSignal): EMLLibError {
  return new EMLLibError(ErrorType.OPERATION_CANCELLED, 'The operation was cancelled.', { cause: signal?.reason })
}

export function checkCancellation(signal: AbortSignal | undefined = operationSignal()): void {
  if (signal?.aborted) throw cancellationError(signal)
}

/** Node 18 compatible composition with explicit listener disposal. */
export function linkedSignals(signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const listeners: (() => void)[] = []
  for (const signal of new Set(signals.filter((value): value is AbortSignal => Boolean(value)))) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', abort))
  }
  return { signal: controller.signal, dispose: () => listeners.forEach((remove) => remove()) }
}

/** Keep the HTTP deadline active while a scoped signal also governs the response body. */
export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs)
  if (!signal) return deadline
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, deadline])
  // Older Node 18 releases lack AbortSignal.any; dispose on either cancellation or deadline.
  const linked = linkedSignals([signal, deadline])
  if (linked.signal.aborted) linked.dispose()
  else linked.signal.addEventListener('abort', linked.dispose, { once: true })
  return linked.signal
}

/** The context belongs to this async operation, never to a global fetch replacement. */
export async function withOperation<T>(options: OperationOptions, work: () => Promise<T>): Promise<T> {
  const parent = operationSignal()
  if (!parent && !options.signal) return work()
  const linked = linkedSignals([parent, options.signal])
  try {
    return await operations.run({ signal: linked.signal }, async () => {
      checkCancellation()
      try {
        return await work()
      } catch (error) {
        checkCancellation()
        throw error
      }
    })
  } finally {
    linked.dispose()
  }
}

export async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkCancellation(signal)
  try {
    await delay(milliseconds, undefined, { signal })
  } catch (error) {
    checkCancellation(signal)
    throw error
  }
}
