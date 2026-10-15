/**
 * @license MIT
 * @copyright Copyright (c) 2026, GoldFrite
 */

import { ResolvedConfig } from '../../types/config.js'
import { File } from '../../types/file.js'
import { MinecraftManifest } from '../../types/manifest.js'
import utils from '../utils/utils.js'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path_ from 'node:path'
import { preparationProcess } from '../utils/preparation-process.js'
import { checkCancellation } from '../utils/operation.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import EventEmitter from '../utils/events.js'
import { PatcherEvents } from '../../types/events.js'

export default class Patcher extends EventEmitter<PatcherEvents> {
  private readonly config: ResolvedConfig
  private readonly minecraftManifest: MinecraftManifest
  private readonly loaderManifest: MinecraftManifest
  private readonly installProfile: any

  constructor(config: ResolvedConfig, minecraftManifest: MinecraftManifest, loaderManifest: MinecraftManifest, installProfile: any) {
    super()
    this.config = config
    this.minecraftManifest = minecraftManifest
    this.loaderManifest = loaderManifest
    this.installProfile = installProfile
  }

  async patch(): Promise<File[]> {
    checkCancellation()
    const files = await this.isPatched()
    let i = 0

    if (files.patched) {
      this.emit('patch_end', { amount: i })
      return files.files
    }

    if (!this.installProfile.processors || this.installProfile.processors.length === 0) {
      this.emit('patch_end', { amount: 0 })
      return files.files
    }

    const processors = this.installProfile.processors
    const incomplete = path_.join(this.config.root, '.eml-patch-incomplete')
    await fs.writeFile(incomplete, 'Loader preparation did not complete.\n')

    for (const processor of processors) {
      checkCancellation()
      if (processor?.sides && !processor.sides.includes('client')) continue

      const jarExtractPathName = path_.join(this.config.root, 'libraries', utils.getLibraryPath(processor.jar), utils.getLibraryName(processor.jar))
      const args = (processor.args as string[]).map((arg) => this.mapPath(this.mapArg(arg)))
      const classpath = (processor.classpath as string[]).map(
        (cp) => `"${path_.join(this.config.root, 'libraries', utils.getLibraryPath(cp), utils.getLibraryName(cp))}"`
      )
      const mainClass = await this.getJarMain(jarExtractPathName)

      if (!mainClass) {
        console.warn(`[Patcher] Could not find Main-Class for processor ${processor.jar}`)
        continue
      }

      const code = await preparationProcess(
        `"${this.config.java.absolutePath.replace('${X}', this.minecraftManifest.javaVersion?.majorVersion + '' || '8')}"`,
        ['-Xmx2G', '-classpath', [`"${jarExtractPathName}"`, ...classpath].join(path_.delimiter), mainClass, ...args],
        { shell: true },
        (data) => this.emit('patch_debug', data.toString('utf8').replace(/\n$/, ''))
      )
      checkCancellation()
      if (code !== 0) throw new EMLLibError(ErrorType.PATCHER_ERROR, `Loader processor failed with exit code ${code}`)
      this.emit('patch_progress', { filename: utils.getLibraryName(processor.jar) })
      i++
    }

    checkCancellation()
    await fs.unlink(incomplete)
    const resultAfterPatch = await this.isPatched()
    this.emit('patch_end', { amount: i })

    return resultAfterPatch.files
  }

  private async isPatched() {
    const processors = this.installProfile.processors

    let libraries: string[] = []

    processors?.forEach((processor: any) => {
      if (processor?.sides && !processor.sides.includes('client')) return

      processor.args.forEach((arg: string) => {
        arg = arg.replace(/[{}]/g, '')
        if (this.installProfile.data[arg]) {
          if (arg === 'BINPATCH') return

          const entry = this.installProfile.data[arg]
          const libPath = entry.client ?? entry.path ?? (typeof entry === 'string' ? entry : null)

          if (libPath) libraries.push(libPath)
        }
      })
    })

    libraries = [...new Set(libraries)]

    const promises = libraries.map(async (lib) => {
      const cleanLib = lib.replace('[', '').replace(']', '')
      const libName = utils.getLibraryName(cleanLib)
      const libPath = utils.getLibraryPath(cleanLib)
      const libExtractPath = path_.join(this.config.root, 'libraries', libPath)
      const fileObj = { name: libName, path: path_.join('libraries', libPath), url: '', type: 'LIBRARY' }

      try {
        await fs.access(path_.join(libExtractPath, libName))
        return { patched: true, file: fileObj }
      } catch {
        return { patched: false, file: fileObj }
      }
    })

    const result = await Promise.all(promises)
    const patched = !existsSync(path_.join(this.config.root, '.eml-patch-incomplete')) && result.length > 0 && result.every((c) => c.patched)
    const files = result.map((c) => c.file as File)

    return { patched, files }
  }

  private async getJarMain(jarPath: string): Promise<string | null> {
    checkCancellation()
    if (!existsSync(jarPath)) return null
    try {
      const { zipfile, entries } = await utils.openZip(jarPath)
      try {
        const entry = entries.find((entry) => entry.fileName === 'META-INF/MANIFEST.MF')
        if (!entry) return null
        const data = (await utils.readEntryData(zipfile, entry)).toString('utf8')
        return data.split('Main-Class: ')[1]?.split(/\r?\n/)[0]?.trim() ?? null
      } finally {
        await utils.closeZip(zipfile)
      }
    } catch (error) {
      checkCancellation()
      return null
    }
  }

  private mapArg(arg: string) {
    const loader = this.config.minecraft.loader!
    const argType = arg.replace(/[{}]/g, '')

    const universalMaven = this.installProfile.libraries.find((v: any) => {
      if (loader.loader === 'forge') return v.name.startsWith('net.minecraftforge:forge')
      if (loader.loader === 'neoforge') return v.name.startsWith('net.neoforged:neoforge')
    })

    if (this.installProfile.data[argType]) {
      if (argType === 'BINPATCH') {
        const clientDataName = utils.getLibraryName(this.installProfile.path ?? universalMaven.name).replace(/\.jar$/, '-clientdata.lzma')
        const clientDataExtractPath = utils.getLibraryPath(this.installProfile.path ?? universalMaven.name, this.config.root, 'libraries')
        return `"${path_.join(clientDataExtractPath, clientDataName)}"`
      }

      const entry = this.installProfile.data[argType]
      const val = entry.client ?? entry.path ?? (typeof entry === 'string' ? entry : arg)
      return val
    }

    const mappedArg = arg
      .replace('{SIDE}', `client`)
      .replace(/{ROOT}(.*?)/, `"${this.config.root}$1"`)
      .replace('{MINECRAFT_JAR}', `"${path_.join(this.config.root, 'versions', this.minecraftManifest.id, `${this.minecraftManifest.id}.jar`)}"`)
      .replace('{MINECRAFT_VERSION}', `"${path_.join(this.config.root, 'versions', this.minecraftManifest.id, `${this.minecraftManifest.id}.json`)}"`)
      .replace('{INSTALLER}', `"${path_.join(this.config.root, 'libraries')}"`)
      .replace('{LIBRARY_DIR}', `"${path_.join(this.config.root, 'libraries')}"`)

    return mappedArg
  }

  private mapPath(arg: string) {
    if (arg.startsWith('[')) {
      const result = `"${path_.join(
        this.config.root,
        'libraries',
        utils.getLibraryPath(arg.replace(/[\[\]]/g, '')),
        utils.getLibraryName(arg.replace(/[\[\]]/g, ''))
      )}"`
      return result
    }
    return arg
  }
}
