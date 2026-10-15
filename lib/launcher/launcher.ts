import os from 'node:os'
import { DEFAULT_IGNORED_PATHS, jvmArguments, normalizeMemory } from './configuration.js'
import { filterPreservedDownloads } from './preservation.js'
/**
 * @license MIT
 * @copyright Copyright (c) 2026, GoldFrite
 */

import { IStatProvider, StatProvider } from '../../types/stats.js'
import { CleanerEvents, DownloaderEvents, FileManagerEvents, JavaEvents, LauncherEvents, PatcherEvents } from '../../types/events.js'
import EventEmitter from '../utils/events.js'
import manifests from '../utils/manifests.js'
import utils from '../utils/utils.js'
import { Config, ResolvedConfig } from './../../types/config.js'
import path_ from 'node:path'
import FileManager from './filemanager.js'
import Downloader from '../utils/downloader.js'
import Cleaner from './cleaner.js'
import Java, { JavaInfo } from '../java/java.js'
import fs from 'node:fs/promises'
import type { File } from '../../types/file.js'
import LoaderManager from './loadermanager.js'
import ArgumentManager from './argumentmanager.js'
import { spawn } from 'node:child_process'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import loader from '../utils/loader.js'
import logParser from '../utils/logparser.js'
import { OperationOptions, checkCancellation, withOperation } from '../utils/operation.js'

export interface LaunchOptions extends OperationOptions {
  optimization?: boolean
  debug?: boolean
}

export interface InstallationReport {
  downloads: File[]
  downloadSize: number
  java: { requiredVersion: number; info?: JavaInfo; error?: string }
}

export default class Launcher
  extends EventEmitter<LauncherEvents & DownloaderEvents & CleanerEvents & FileManagerEvents & JavaEvents & PatcherEvents>
  implements IStatProvider
{
  readonly statType: StatProvider = 'LAUNCHER'
  /**
   * The configuration of the launcher.
   */
  readonly config: ResolvedConfig
  private launchArgs_: string[] = []
  private launcherLogs_: string[] = []
  private launchInProgress = false

  /**
   * Launch Minecraft.
   * @param config The configuration of the launcher.
   *
   * _Need help? Try our [config generator](https://emlproject.com/resources/config-generator/)!_
   */
  constructor(config: Config) {
    super()

    if (!utils.isOSSupported()) {
      throw new EMLLibError(ErrorType.UNKNOWN_OS, `Unsupported OS: ${utils.getOS_MCCode()} ${utils.getArch_MCCode()}`)
    }

    let tmpConfig: Config & { slug?: string; token?: string } = {
      ...config,
      slug: undefined,
      token: undefined
    }
    tmpConfig.minecraft = this.setMinecraft(tmpConfig)
    tmpConfig.profile = this.setProfile(tmpConfig)
    tmpConfig.url = this.setUrl(tmpConfig)
    tmpConfig.storage = this.setStorage(tmpConfig)
    tmpConfig.root = this.setRoot(tmpConfig)
    tmpConfig.cleaning = this.setCleaning(tmpConfig)
    tmpConfig.account = this.setAccount(tmpConfig)
    tmpConfig.java = this.setJava(tmpConfig)
    tmpConfig.window = this.setWindow(tmpConfig)
    tmpConfig.memory = this.setMemory(tmpConfig)

    this.config = {
      url: tmpConfig.url,
      profile: tmpConfig.profile,
      storage: tmpConfig.storage!,
      root: tmpConfig.root!,
      minecraft: tmpConfig.minecraft!,
      cleaning: tmpConfig.cleaning!,
      account: tmpConfig.account,
      java: tmpConfig.java!,
      window: tmpConfig.window!,
      memory: tmpConfig.memory!
    } as ResolvedConfig
  }

  get launchArgs() {
    return this.launchArgs_
  }

  get launcherLogs() {
    return this.launcherLogs_
  }

  /**
   * Launch Minecraft.
   *
   * _This method will patch the [Log4j vulnerability](https://help.minecraft.net/hc/en-us/articles/4416199399693-Security-Vulnerability-in-Minecraft-Java-Edition)._
   */
  async launch(options: LaunchOptions = {}): Promise<void> {
    await this.execute('launch', options)
  }

  /** Inspect managed files without changing the instance; installer metadata uses a disposable directory. */
  inspect(options: OperationOptions = {}): Promise<InstallationReport> {
    return this.execute('inspect', options)
  }

  /** Restore managed files and extracted content without starting Minecraft or deleting user files. */
  repair(options: OperationOptions = {}): Promise<InstallationReport> {
    return this.execute('repair', options)
  }

  private async execute(mode: 'launch' | 'inspect' | 'repair', options: LaunchOptions): Promise<InstallationReport> {
    if (this.launchInProgress) throw new EMLLibError(ErrorType.INVALID_OPERATION, 'This launcher already has an active launch.')
    this.launchInProgress = true
    let scratch: string | undefined
    try {
      return await withOperation(options, async () => {
        scratch = await fs.mkdtemp(path_.join(os.tmpdir(), 'eml-inspect-'))
        return this.prepareAndRun(mode, options, scratch)
      })
    } catch (error) {
      if (error instanceof EMLLibError && error.code === ErrorType.OPERATION_CANCELLED) this.emit('launch_cancelled')
      throw error
    } finally {
      try {
        if (scratch) {
          if (path_.dirname(path_.resolve(scratch)) !== path_.resolve(os.tmpdir()) || !path_.basename(scratch).startsWith('eml-inspect-'))
            throw new EMLLibError(ErrorType.FILE_ERROR, 'Unexpected inspection directory; cleanup refused.')
          await fs.rm(scratch, { recursive: true, force: true })
        }
      } finally {
        this.launchInProgress = false
      }
    }
  }

  private async prepareAndRun(mode: 'launch' | 'inspect' | 'repair', options: LaunchOptions, scratch?: string): Promise<InstallationReport> {
    //* Init downloader
    const downloader = new Downloader(this.config.root, this.config.profile.token, { adminToolUrl: this.config.url })

    //* Init loader
    this.config.minecraft = await loader.updateMinecraftConfig(this.config)
    checkCancellation()
    const minecraftManifest = await manifests.getMinecraftManifest(this.config)
    const java = new Java(this.config)
    java.forwardEvents(this)
    const javaStatus: InstallationReport['java'] = { requiredVersion: minecraftManifest.javaVersion?.majorVersion ?? 8 }
    const verifyJava = async () => {
      javaStatus.info = await java.check(this.config.java.absolutePath, javaStatus.requiredVersion)
      delete javaStatus.error
    }
    const preflight = async () => {
      try {
        await verifyJava()
      } catch (error) {
        checkCancellation()
        if (!(error instanceof EMLLibError) || error.code !== ErrorType.JAVA_ERROR) throw error
        javaStatus.error = error.message
        if (mode !== 'inspect' && this.config.java.install === 'manual') throw error
      }
    }
    await preflight()
    const metadataConfig = scratch ? { ...this.config, root: scratch } : this.config
    const installer = await loader.getInstaller(this.config)
    const installerDownloads = await downloader.getFilesToDownload(installer ? [installer] : [], { readOnly: true })
    const installerConfig = installerDownloads.length ? metadataConfig : this.config
    await new Downloader(installerConfig.root).download(installerDownloads)

    //* Init manifests
    const installProfile = await manifests.getInstallProfile(installerConfig, installer)
    const loaderManifest = await manifests.getLoaderManifests(installerConfig, installProfile, installer)
    if ((loaderManifest?.javaVersion?.majorVersion ?? 0) > javaStatus.requiredVersion) {
      minecraftManifest.javaVersion = loaderManifest!.javaVersion
      javaStatus.requiredVersion = minecraftManifest.javaVersion!.majorVersion
      await preflight()
    }
    checkCancellation()
    if (mode !== 'inspect' && installerDownloads.length) {
      const cached = await fs.readFile(path_.join(installerConfig.root, installer!.path, installer!.name))
      await new Downloader(this.config.root, undefined, { fetch: async () => new Response(cached) }).download(installerDownloads)
    }

    const fileManager = new FileManager(
      mode === 'inspect' ? metadataConfig : this.config,
      minecraftManifest,
      loaderManifest,
      installProfile,
      installer
    )
    const loaderManager = new LoaderManager(this.config, minecraftManifest, loaderManifest, installProfile, installer)
    const cleaner = new Cleaner(this.config)

    fileManager.forwardEvents(this)
    loaderManager.forwardEvents(this)
    downloader.forwardEvents(this)
    cleaner.forwardEvents(this)

    //* Compute download
    checkCancellation()
    this.emit('launch_compute_download')

    const javaFiles = await fileManager.getJava()
    const modpackFiles = await fileManager.getModpack()
    const librariesFiles = await fileManager.getLibraries()
    const assetsFiles = await fileManager.getAssets()
    const loaderLibrariesFiles = await fileManager.getLoaderLibraries()
    const injectorFiles = await fileManager.getInjector()
    const loggingFiles = await fileManager.getLogging()

    const scan = (files: File[]) => downloader.getFilesToDownload(files, { readOnly: mode === 'inspect' })
    const javaFilesToDownload = await scan(javaFiles.java)
    const modpackFilesToDownload = await filterPreservedDownloads(
      await scan(modpackFiles.modpack),
      this.config.root,
      this.config.cleaning.preserveExisting ?? []
    )
    const librariesFilesToDownload = await scan(librariesFiles.libraries)
    const assetsFilesToDownload = await scan(assetsFiles.assets)
    const loaderLibrariesFilesToDownload = await scan(loaderLibrariesFiles.libraries)
    const injectorFilesToDownload = await scan(injectorFiles.injector)
    const loggingFilesToDownload = await scan(loggingFiles.logging)
    const filesToDownload = [
      ...(mode === 'inspect' ? installerDownloads : []),
      ...javaFilesToDownload,
      ...modpackFilesToDownload,
      ...librariesFilesToDownload,
      ...assetsFilesToDownload,
      ...loaderLibrariesFilesToDownload,
      ...injectorFilesToDownload,
      ...loggingFilesToDownload
    ]
    const report = { downloads: filesToDownload, downloadSize: filesToDownload.reduce((sum, file) => sum + (file.size ?? 0), 0), java: javaStatus }
    if (mode === 'inspect') return report

    //* Download
    checkCancellation()
    this.emit('launch_download', {
      total: {
        amount: filesToDownload.length,
        size: filesToDownload.reduce((acc, file) => acc + file.size!, 0)
      }
    })

    await downloader.download(javaFilesToDownload, true)
    checkCancellation()
    this.emit('launch_check_java')
    if (!javaStatus.info || javaStatus.error || javaFilesToDownload.length) await verifyJava()
    await downloader.download(modpackFilesToDownload, true)
    await downloader.download(librariesFilesToDownload, true)
    await downloader.download(assetsFilesToDownload, true)
    await downloader.download(loaderLibrariesFilesToDownload, true)
    await downloader.download(injectorFilesToDownload, true)
    await downloader.download(loggingFilesToDownload, true)

    //* Install loader
    checkCancellation()
    this.emit('launch_install_loader', this.config.minecraft)
    const loaderFiles = await loaderManager.extract()

    //* Path loader
    checkCancellation()
    this.emit('launch_patch_loader')
    const patchedFiles = await loaderManager.patchLoader()

    //* Extract natives
    checkCancellation()
    this.emit('launch_extract_natives')
    const extractedNativesFiles = await fileManager.extractNatives([...librariesFiles.libraries, ...loaderFiles.libraries])

    //* Copy assets
    checkCancellation()
    this.emit('launch_copy_assets')
    const copiedAssetsFiles = await fileManager.copyAssets()
    checkCancellation()
    if (mode === 'repair') return report

    //* Clean
    checkCancellation()
    this.emit('launch_clean')

    const files = [
      ...javaFiles.files,
      ...modpackFiles.files,
      ...librariesFiles.files,
      ...assetsFiles.files,
      ...loaderLibrariesFiles.files,
      ...injectorFiles.files,
      ...loggingFiles.files,
      ...extractedNativesFiles.files,
      ...copiedAssetsFiles.files,
      ...loaderFiles.files,
      ...patchedFiles.files
    ]
    await cleaner.clean(files, this.config.cleaning.ignored, !this.config.cleaning.enabled)

    const javaInfo = javaStatus.info!

    //* Launch
    checkCancellation()
    this.emit('launch_launch', {
      ...this.config,
      java: { ...this.config.java, version: javaInfo.version }
    })

    const argumentManager = new ArgumentManager(
      {
        ...this.config,
        java: {
          ...this.config.java,
          args: options.optimization || options.debug ? jvmArguments(options, this.config.java.args, javaInfo) : this.config.java.args
        }
      },
      minecraftManifest,
      loaderManifest
    )
    const customAuth = argumentManager.getCustomArgs(injectorFiles)
    const args = argumentManager.getArgs([...loaderFiles.libraries, ...librariesFiles.libraries, ...loaderLibrariesFiles.libraries], customAuth)
    const blindArgs = args.map((arg, i) => (i === args.findIndex((p) => p === '--accessToken') + 1 ? '**********' : arg))
    this.emit('launch_debug', `Launching Minecraft with args: ${blindArgs.join(' ')}`)

    await this.run(this.config.java.absolutePath.replace('${X}', minecraftManifest.javaVersion?.majorVersion.toString() ?? '8'), args)
    return report
  }

  // @ts-ignore
  protected emit(eventName: any, ...args: any[]) {
    const eventNameStr = String(eventName)

    if (eventNameStr === 'launch_data' || eventNameStr.endsWith('_progress')) {
      // @ts-ignore
      return super.emit(eventName, ...args)
    }

    const time = new Date().toTimeString().split(' ')[0]
    let level = 'INFO'

    if (eventNameStr.includes('error') || eventNameStr.includes('fail')) level = 'ERROR'
    else if (eventNameStr.includes('debug')) level = 'DEBUG'

    let message = this.formatEventMessage(eventNameStr, args)

    if (args[0] instanceof Error) {
      level = 'ERROR'
      message += `\n${args[0].stack || args[0].message}`
    } else if (args[0]?.message instanceof Error) {
      level = 'ERROR'
      message += `\n${args[0].message.stack || args[0].message.message}`
    }

    this.launcherLogs_.push(`[${time}] [${level}]: ${message}`)

    if (this.launcherLogs_.length > 500) {
      this.launcherLogs_.shift()
    }

    return super.emit(eventName, ...args)
  }

  private formatEventMessage(eventName: string, args: any[]): string {
    const arg = args[0]

    switch (eventName) {
      // --- Events WITHOUT arguments ---
      case 'launch_compute_download':
        return `Computing required files...`
      case 'launch_copy_assets':
        return `Copying game assets...`
      case 'launch_extract_natives':
        return `Extracting native libraries...`
      case 'launch_patch_loader':
        return `Applying loader patches...`
      case 'launch_check_java':
        return `Checking Java installation...`
      case 'launch_clean':
        return `Cleaning files...`

      // --- Events WITH arguments ---
      case 'launch_download':
        return `Preparing download of ${arg?.total?.amount ?? 0} files.`
      case 'launch_install_loader':
        return `Installing ${arg?.type} ${arg?.loaderVersion || ''} for Minecraft ${arg?.minecraftVersion}.`
      case 'launch_launch':
        return `Launching Minecraft process...`
      case 'launch_crash':
        return `The process crashed with code ${arg?.code}.`
      case 'launch_debug':
        return 'Launching Minecraft with args: see below.'

      // Downloader / FileManager / Cleaner
      case 'download_end':
        return `Download completed (${arg?.downloaded?.amount ?? 0} files).`
      case 'extract_end':
        return `Extraction of ${arg?.amount ?? 0} archives completed.`
      case 'copy_end':
        return `Copy of ${arg?.amount ?? 0} assets completed.`
      case 'clean_end':
        return `Cleanup completed (${arg?.amount ?? 0} files deleted).`

      // Java
      case 'java_info':
        return `Java environment detected: v${arg?.version} (${arg?.arch}).`

      // Auth
      case 'auth_success':
      case 'refresh_success':
      case 'validate_success':
        return `Valid session for player ${arg?.name}.`

      default:
        if (args.length === 0) return ''
        return args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    }
  }

  protected warn(message: string) {
    const time = new Date().toTimeString().split(' ')[0]
    const logLine = `[${time}] [WARN]: ${message}`
    console.warn(message)
    this.launcherLogs_.push(logLine)
  }

  private setMinecraft(config: Config) {
    const isValidProfile = !!(config.profile?.slug && config.profile.slug !== '' && config.profile.slug === utils.sanitizeSlug(config.profile.slug))

    const profileMc = isValidProfile && config.profile?.minecraft?.version ? config.profile.minecraft : null
    const rootMc = config.minecraft?.version ? config.minecraft : null
    const activeMcSource = profileMc || rootMc

    if (config.profile && !isValidProfile) {
      let reason = config.url ? 'EML AdminTool default profile' : 'latest Minecraft version'
      if (rootMc) reason = 'Minecraft config'
      this.warn(`Warning: Invalid profile. Launching with ${reason}.`)
    }

    if (!activeMcSource) {
      const version = config.url ? undefined : 'latest_release'
      return {
        version,
        loader: version ? { loader: 'vanilla' as const, version } : undefined,
        modpackUrl: undefined,
        args: config.minecraft?.args || []
      }
    }

    const version = activeMcSource.version!
    let loader: {
      loader: 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'quilt'
      version: string
      manifestUrl?: string
    }

    const loaderCfg = activeMcSource.loader
    if (!loaderCfg || loaderCfg.loader === 'vanilla') {
      loader = { loader: 'vanilla', version }
    } else {
      if (!loaderCfg.version) {
        throw new EMLLibError(ErrorType.CONFIG_ERROR, `You must provide a loader version in the config when using a loader different from vanilla.`)
      }
      loader = {
        loader: loaderCfg.loader,
        version: loaderCfg.version,
        manifestUrl: loaderCfg.manifestUrl
      }
    }

    const args = isValidProfile && config.profile?.minecraft?.args ? config.profile.minecraft.args : config.minecraft?.args || []

    return {
      version,
      loader,
      modpackUrl: activeMcSource.modpackUrl,
      args
    }
  }

  private setProfile(config: Config) {
    if (config.profile?.slug && config.profile.slug !== '' && config.profile.slug === utils.sanitizeSlug(config.profile.slug)) {
      if (config.profile?.token && config.profile.token !== '') {
        return { slug: config.profile.slug, token: config.profile.token }
      }
      return { slug: config.profile.slug }
    }
    return { slug: undefined, token: undefined }
  }

  private setUrl(config: Config) {
    if (config.minecraft?.version) {
      return undefined
    }
    if (config.url) {
      return config.url
    }
    return undefined
  }

  private setStorage(config: Config) {
    if (config.storage === 'shared') {
      return 'shared'
    }
    if (config.storage === 'isolated') {
      return 'isolated'
    }
    if (config.storageMode === 'shared') {
      return 'shared' // backwards compatibility
    }
    return 'isolated'
  }

  private setRoot(config: Config) {
    if (!config.root && !config.serverId) {
      throw new EMLLibError(ErrorType.CONFIG_ERROR, 'You must provide a root in the config to set the game folder.')
    }
    if (!config.root) {
      config.root = config.serverId // backwards compatibility
    }
    return utils.getRootFolder(config as ResolvedConfig)
  }

  private setCleaning(config: Config) {
    let enabled = true
    let ignored: string[] = [...DEFAULT_IGNORED_PATHS]

    if (config.cleaning?.enabled !== undefined) {
      enabled = config.cleaning.enabled
    } else if (config.cleaning?.clean !== undefined) {
      enabled = config.cleaning.clean // backwards compatibility
    } else {
      enabled = true
    }

    if (config.storage === 'shared' && enabled) {
      this.warn(
        'Warning: You are using shared storage mode with cleaning enabled. This may cause issues as the launcher will delete shared assets and libraries when launching different profiles. It is recommended to disable cleaning when using shared storage mode.'
      )
    }

    if (config.cleaning?.ignored) {
      ignored = config.cleaning.ignoredMode === 'extend' ? [...ignored, ...config.cleaning.ignored] : config.cleaning.ignored
    }

    return {
      enabled,
      ignored: [...new Set([...ignored, ...(config.cleaning?.additionalIgnored ?? [])])],
      preserveExisting: config.cleaning?.preserveExisting ?? []
    }
  }

  private setAccount(config: Config) {
    if (config.account?.meta.type === 'crack') {
      this.warn(
        'Warning: You are using a cracked account (offline mode). This authentication method is not secure and is not recommended. Use it only for testing purposes.'
      )
    }

    return config.account
  }

  private setJava(config: Config) {
    let install: 'auto' | 'manual' = 'auto'
    let absolutePath: string
    let args: string[] = []

    if (config.java?.install === 'manual') {
      install = 'manual'
      if (config.java.absolutePath) {
        absolutePath = config.java.absolutePath
      } else if (config.java.relativePath) {
        absolutePath = path_.join(config.root!, config.java.relativePath)
      } else {
        absolutePath = 'java'
      }
    } else {
      install = 'auto'
      absolutePath = path_.join(config.root!, 'runtime', 'jre-${X}', 'bin', 'java')
    }

    if (config.java?.args) {
      args = config.java.args
    }

    return { install, absolutePath, args }
  }

  private setWindow(config: Config) {
    let width = 854
    let height = 480
    let fullscreen = false

    if (config.window?.width && config.window.width > 100) {
      width = config.window.width
    }

    if (config.window?.height && config.window.height > 100) {
      height = config.window.height
    }

    if (config.window?.fullscreen) {
      fullscreen = config.window.fullscreen
    }

    return { width, height, fullscreen }
  }

  private setMemory(config: Config) {
    return normalizeMemory(config.memory, os.totalmem() / 1024 / 1024)
  }

  private async run(javaPath: string, args: string[]) {
    checkCancellation()
    this.launchArgs_ = args

    return new Promise<void>((resolve, reject) => {
      const minecraft = spawn(javaPath, args, { cwd: this.config.root, detached: true })

      minecraft.stdout.on('data', (data: Buffer) => {
        logParser.parse(data.toString()).forEach((line) => this.emit('launch_data', line))
      })
      minecraft.stderr.on('data', (data: Buffer) => {
        logParser.parse(data.toString()).forEach((line) => this.emit('launch_data', line))
      })
      minecraft.on('error', reject)
      minecraft.on('exit', (code) => {
        const exitCode = code ?? -1
        this.emit('launch_close', exitCode)
        if (exitCode !== 0) {
          this.emit('launch_crash', {
            code: exitCode,
            date: new Date().toISOString(),
            javaPath: javaPath,
            logsPath: path_.join(this.config.root, 'logs', 'latest.log'),
            crashReportsDir: path_.join(this.config.root, 'crash-reports')
          })
        }
        resolve()
      })
    })
  }
}
