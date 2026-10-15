import KintareAuth from '../auth/kintare.js'
import { KintareWardrobes } from './wardrobes.js'
import { KintareEndpointResolver, KintareOptions } from './endpoints.js'
import { AuthAgent } from './auth-agent.js'
import { HttpClient } from '../http/http.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import { KintareProfiles } from './profiles.js'
import { KintareSessions } from './sessions.js'

/** A deployment's clients share discovery, transport, and trust configuration. */
export class KintareClient {
  readonly endpoints: KintareEndpointResolver
  readonly auth: KintareAuth
  readonly wardrobes: KintareWardrobes
  readonly profiles: KintareProfiles
  readonly sessions: KintareSessions
  private readonly http: HttpClient
  constructor(private readonly options: KintareOptions & { clientId?: string } = {}) {
    this.endpoints = new KintareEndpointResolver(options)
    this.http = new HttpClient(options)
    this.auth = new KintareAuth(options.clientId, options, this.endpoints)
    this.wardrobes = new KintareWardrobes(options, this.endpoints)
    this.profiles = new KintareProfiles(this.auth)
    this.sessions = new KintareSessions(this.auth)
  }
  async authAgent(cacheDirectory: string, fileName?: string): Promise<AuthAgent> {
    if (this.options.authAgentRelease !== false)
      return new AuthAgent({
        ...this.options,
        cacheDirectory,
        fileName,
        githubRelease: this.options.authAgentRelease ?? {
          repository: 'KintareStudio/Loki',
          assetPattern: /^Loki-[0-9][a-zA-Z0-9.+-]*\.jar$/
        }
      })
    return new AuthAgent({
      ...this.options,
      url: (await this.endpoints.resolve()).authAgent,
      cacheDirectory,
      fileName
    })
  }
  async authAgentArguments(jarPath: string): Promise<string[]> {
    return AuthAgent.javaArguments(jarPath, new URL(this.options.issuer ?? 'https://accounts.kintarestudio.com').host, {
      'Loki.enforce_secure_profile': true,
      'Loki.debug': true,
      'Loki.chat_restrictions': true
    })
  }
  async ping(): Promise<{ oidc: boolean; yggdrasil: boolean; services: boolean }> {
    const endpoints = await this.endpoints.resolve()
    const check = async (url: string) => {
      try {
        return (await this.http.fetch(url)).status < 500
      } catch {
        return false
      }
    }
    const [oidc, yggdrasil, services] = await Promise.all([
      check(`${(this.options.issuer ?? 'https://accounts.kintarestudio.com').replace(/\/$/, '')}/.well-known/openid-configuration`),
      check(`${new URL(endpoints.minecraftToken).origin}/`),
      check(`${endpoints.services}/`)
    ])
    return { oidc, yggdrasil, services }
  }
  async renderTexture(textureUrl: string, mode: 'kintareskin' | 'kintarecape'): Promise<Uint8Array> {
    if (!['kintareskin', 'kintarecape'].includes(mode)) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid texture render mode')
    const texture = await this.http.fetch(textureUrl)
    if (!texture.ok) throw new EMLLibError(ErrorType.FETCH_ERROR, `Failed to fetch texture: HTTP ${texture.status}`)
    const form = new FormData()
    const field = mode === 'kintarecape' ? 'cape' : 'skin'
    form.append(field, new Blob([await texture.arrayBuffer()], { type: 'image/png' }), `${field}.png`)
    const response = await this.http.fetch(`${(await this.endpoints.resolve()).render}/${mode}`, {
      method: 'POST',
      body: form,
      redirect: 'error'
    })
    if (!response.ok) throw new EMLLibError(ErrorType.FETCH_ERROR, `Render failed: HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Public avatar location for this deployment; no account credential is exposed. */
  async avatarUrl(identity: string, cacheKey?: string | number): Promise<string> {
    if (typeof identity !== 'string' || !identity.trim() || ['.', '..'].includes(identity.trim()))
      throw new EMLLibError(ErrorType.CONFIG_ERROR, 'A profile name or UUID is required')
    const url = new URL(`${(await this.endpoints.resolve()).render}/face/${encodeURIComponent(identity.trim())}`)
    if (cacheKey !== undefined) url.searchParams.set('t', String(cacheKey))
    return url.href
  }
}
