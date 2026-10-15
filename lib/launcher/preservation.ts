import path from 'node:path'
import { lstat } from 'node:fs/promises'
import type { File } from '../../types/file.js'

/** Explicit user-owned paths may keep existing files; managed files otherwise receive updates. */
export async function filterPreservedDownloads(files: File[], root: string, preserve: string[]): Promise<File[]> {
  const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`)
  const base = path.resolve(root)
  const protectedPaths = preserve.map((p) => path.resolve(base, p)).filter((p) => inside(base, p))
  const result: File[] = []
  for (const file of files) {
    const target = path.resolve(base, file.path, file.name)
    const existing = protectedPaths.some((p) => inside(p, target)) && (await lstat(target).catch(() => null))
    if (!existing) result.push(file)
  }
  return result
}
