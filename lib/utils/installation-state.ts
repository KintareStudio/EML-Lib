import fs from 'node:fs/promises'
import path from 'node:path'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import { checkCancellation } from './operation.js'

const active = new Set<string>()
async function existingParent(root: string): Promise<string> {
  let current = path.resolve(root)
  for (;;) {
    try {
      await fs.stat(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw error
      current = path.dirname(current)
    }
  }
}

/** Coordinate Launcher objects in this process, including aliases of the same directory. */
export async function lockInstance(root: string): Promise<() => void> {
  const parent = await existingParent(root)
  let key = path.join(await fs.realpath(parent), path.relative(parent, path.resolve(root)))
  if (process.platform === 'win32' || process.platform === 'darwin') key = key.toLowerCase()
  checkCancellation()
  if (active.has(key)) throw new EMLLibError(ErrorType.INVALID_OPERATION, 'This instance already has an active operation.')
  active.add(key)
  return () => {
    active.delete(key)
  }
}

export interface DiskSpaceInfo {
  requiredBytes: number
  availableBytes?: number
  sufficient?: boolean
}
/** An estimate: allow for downloaded content, temporary replacement and extraction. */
export async function diskSpace(root: string, downloadBytes: number): Promise<DiskSpaceInfo> {
  const result: DiskSpaceInfo = { requiredBytes: Math.ceil(downloadBytes * 2) + 64 * 1024 * 1024 }
  if (typeof fs.statfs !== 'function') return result
  try {
    const stat = await fs.statfs(await existingParent(root))
    if (stat.bavail >= 0 && stat.bsize > 0) {
      result.availableBytes = stat.bavail * stat.bsize
      result.sufficient = result.availableBytes >= result.requiredBytes
    }
    return result
  } catch (error) {
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) return result
    throw new EMLLibError(ErrorType.FILE_ERROR, 'Could not inspect available disk space.', { cause: error })
  }
}

export function requireSpace(space: DiskSpaceInfo): void {
  if (space.sufficient === false)
    throw new EMLLibError(
      ErrorType.FILE_ERROR,
      `Insufficient disk space: approximately ${space.requiredBytes} bytes required, ${space.availableBytes} available.`,
      { serverCode: 'INSUFFICIENT_SPACE' }
    )
}
