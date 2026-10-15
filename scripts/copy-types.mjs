import { copyFile, mkdir, readdir } from 'node:fs/promises'
await mkdir(new URL('../dist/types/', import.meta.url), { recursive: true })
for (const entry of await readdir(new URL('../types/', import.meta.url))) {
  if (entry.endsWith('.d.ts'))
    await copyFile(
      new URL(`../types/${entry}`, import.meta.url),
      new URL(`../dist/types/${entry}`, import.meta.url)
    )
}
