import type { ResolvedConfig } from '../../types/config.js'

export interface LaunchSummary {
  minecraft: { version?: string; loader?: { loader: string; version?: string } }
  java: { version?: string }
  memory: { min: number; max: number }
  profile: { slug?: string }
}

/** A launch event suitable for IPC: no account, bearer, JVM arguments or download URLs. */
export function launchSummary(config: ResolvedConfig & { java?: { version?: string } }): LaunchSummary {
  return {
    minecraft: {
      version: config.minecraft.version,
      ...(config.minecraft.loader
        ? {
            loader: {
              loader: config.minecraft.loader.loader,
              version: config.minecraft.loader.version
            }
          }
        : {})
    },
    java: { version: config.java.version },
    memory: { ...config.memory },
    profile: { slug: config.profile.slug }
  }
}

export const DEFAULT_IGNORED_PATHS = [
  'crash-reports/',
  'logs/',
  'resourcepacks/',
  'resources/',
  'saves/',
  'shaderpacks/',
  'options.txt',
  'optionsof.txt'
] as const

/** Optional protections for launchers that keep additional user data beside managed files. */
export const USER_DATA_IGNORED_PATHS = [
  ...DEFAULT_IGNORED_PATHS,
  'config/',
  'journeymap/',
  'XaeroWaypoints/',
  'XaeroWorldMap/',
  'schematics/',
  'screenshots/',
  'flashback/',
  'replay_recordings/',
  'servers.dat',
  'servers.dat_old'
] as const

/** Pure helpers are also usable by a renderer; memory is supplied by the host. */
export function reservedMemoryMB(totalGB: number): number {
  return totalGB <= 8 ? 2048 : totalGB <= 16 ? 3072 : 4096
}
export function memoryCeilingMB(totalMB: number): number {
  return Math.max(128, Math.floor(totalMB - reservedMemoryMB(totalMB / 1024)))
}
export function parseMemoryMB(value: string | number): number {
  if (typeof value === 'number') return value
  const match = /^\s*(\d+(?:\.\d+)?)\s*([GM]?)\s*$/i.exec(value)
  return match ? Number(match[1]) * (match[2].toUpperCase() === 'G' ? 1024 : 1) : NaN
}
export function normalizeMemory(input: { min?: number; max?: number } = {}, totalMB = Infinity): { min: number; max: number } {
  const ceiling = memoryCeilingMB(totalMB)
  const min = Math.min(ceiling, Math.max(128, Math.floor(Number.isFinite(input.min) ? input.min! : 512)))
  const max = Math.min(ceiling, Math.max(min, Math.floor(Number.isFinite(input.max) ? input.max! : 1023)))
  return { min, max }
}
export function javaConfiguration(selection: string): {
  install: 'auto' | 'manual'
  absolutePath?: string
} {
  if (!selection || selection === 'bundled') return { install: 'auto' }
  if (selection === 'system') return { install: 'manual', absolutePath: 'java' }
  if (selection === 'path' || selection === 'custom') throw new Error('Select the Java executable again to save its path.')
  return { install: 'manual', absolutePath: selection }
}

export function jvmArguments(options: { optimization?: boolean; debug?: boolean }, existing: string[] = []): string[] {
  return [
    ...new Set([
      ...existing,
      ...(options.optimization ? ['-XX:+UseZGC', '-XX:+ZGenerational'] : []),
      ...(options.debug ? ['-XX:-OmitStackTraceInFastThrow'] : [])
    ])
  ]
}
