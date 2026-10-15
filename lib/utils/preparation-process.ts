import { spawn, SpawnOptionsWithoutStdio } from 'node:child_process'
import { cancellationError, checkCancellation, operationSignal } from './operation.js'

/** Wait for owned preparation processes to stop before reporting cancellation. */
export async function preparationProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {},
  output: (chunk: Buffer) => void = () => {},
  signal: AbortSignal | undefined = operationSignal()
): Promise<number | null> {
  checkCancellation(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', windowsHide: true })
    let failure: unknown, escalation: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        // A shell-backed Java processor has children; killing the shell alone leaves them running.
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => {
          child.kill()
        })
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
        escalation = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }, 1000)
        escalation.unref()
      }
    }
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.stdout?.on('data', output)
    child.stderr?.on('data', output)
    child.on('error', (error) => {
      failure = error
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', stop)
      if (escalation) clearTimeout(escalation)
      if (signal?.aborted) reject(cancellationError(signal))
      else if (failure) reject(failure)
      else resolve(code)
    })
  })
}
