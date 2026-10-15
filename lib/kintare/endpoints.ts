import { HttpClient, HttpOptions } from '../http/http.js'
import type { GitHubReleaseOptions } from './github-release.js'

export interface KintareEndpoints {
  deviceAuthorization: string
  token: string
  revocation: string
  minecraftToken: string
  minecraftTokenScope: string
  minecraftTokenInvalidate: string
  services: string
  sessions: string
  render: string
  authAgent: string
}

export interface KintareOptions extends HttpOptions {
  /** Stable GitHub releases are the default Loki source. false opts into endpoints.authAgent. */
  authAgentRelease?: GitHubReleaseOptions | false
  /** OIDC issuer, including its mount path. */
  issuer?: string
  /** Explicit locations override discovery. Useful for extensions absent on older servers. */
  endpoints?: Partial<KintareEndpoints>
  /** Additional origins authorized to receive credentials from this client. */
  trustedOrigins?: string[]
}

const accounts = 'https://accounts.kintarestudio.com'
const firstPartyHost = (host: string) => ['kintarestudio.com', 'kintare.studio'].some((domain) => host === domain || host.endsWith(`.${domain}`))
const fallback: KintareEndpoints = {
  deviceAuthorization: `${accounts}/device/auth`,
  token: `${accounts}/token`,
  revocation: `${accounts}/token/revocation`,
  minecraftToken: 'https://authserver.kintarestudio.com/oauth',
  minecraftTokenScope: 'Yggdrasil.MinecraftToken.Create',
  minecraftTokenInvalidate: 'https://authserver.kintarestudio.com/invalidate',
  services: 'https://services.kintarestudio.com',
  sessions: 'https://sessions.kintarestudio.com',
  render: 'https://render.kintarestudio.com',
  authAgent: `${accounts}/auth-agent/download`
}

export function trustedKintareUrl(value: unknown, defaultUrl: string, origins?: Set<string>): string {
  if (typeof value !== 'string') return defaultUrl
  try {
    const url = new URL(value)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (origins ? !origins.has(url.origin) : !firstPartyHost(url.hostname))
    )
      return defaultUrl
    return url.href.replace(/\/$/, '')
  } catch {
    return defaultUrl
  }
}

export class KintareEndpointResolver {
  private cached?: { value: KintareEndpoints; expires: number }
  private pending?: Promise<KintareEndpoints>
  private readonly http: HttpClient
  private readonly defaults: KintareEndpoints
  private readonly issuer: string
  private readonly origins?: Set<string>
  constructor(private readonly options: KintareOptions = {}) {
    this.http = new HttpClient({ timeoutMs: 5_000, ...options })
    this.issuer = (options.issuer ?? accounts).replace(/\/$/, '')
    const issuerUrl = new URL(this.issuer)
    if (trustedKintareUrl(this.issuer, '', new Set([issuerUrl.origin])) !== this.issuer) throw new Error('Invalid Kintare issuer URL.')
    const custom = !firstPartyHost(issuerUrl.hostname)
    this.origins =
      custom || options.trustedOrigins
        ? new Set([
            issuerUrl.origin,
            ...(options.trustedOrigins ?? []),
            ...Object.entries(options.endpoints ?? {})
              .filter(([key]) => key !== 'minecraftTokenScope')
              .map(([, value]) => new URL(value!).origin)
          ])
        : undefined
    this.defaults = {
      ...fallback,
      ...(this.issuer !== accounts
        ? {
            deviceAuthorization: `${this.issuer}/device-code`,
            token: `${this.issuer}/token`,
            revocation: `${this.issuer}/token/revocation`
          }
        : {}),
      ...(custom
        ? {
            // Never fall back from a private deployment to Kintare production with its credentials.
            services: issuerUrl.origin,
            sessions: issuerUrl.origin,
            render: issuerUrl.origin,
            minecraftToken: `${issuerUrl.origin}/oauth`,
            minecraftTokenInvalidate: `${issuerUrl.origin}/invalidate`,
            authAgent: `${issuerUrl.origin}/auth-agent/download`
          }
        : {}),
      ...options.endpoints
    }
    for (const [key, value] of Object.entries(this.defaults)) {
      if (key !== 'minecraftTokenScope' && trustedKintareUrl(value, '', this.origins) !== value) throw new Error(`Invalid Kintare endpoint: ${key}`)
    }
  }

  async resolve(): Promise<KintareEndpoints> {
    if (this.cached && this.cached.expires > Date.now()) return this.cached.value
    if (this.pending) return this.pending
    this.pending = (async () => {
      const fallback = this.defaults
      const accept = (value: unknown, defaultUrl: string) => trustedKintareUrl(value, defaultUrl, this.origins)
      let value = fallback
      let ttl = 60_000
      try {
        const doc = await this.http.json<any>(`${this.issuer}/.well-known/openid-configuration`, {
          redirect: 'error'
        })
        if (doc.issuer && doc.issuer.replace(/\/$/, '') !== this.issuer) throw new Error('Discovery issuer mismatch')
        const ygg = doc?.kintare_yggdrasil
        value = {
          deviceAuthorization: accept(doc?.device_authorization_endpoint, fallback.deviceAuthorization),
          token: accept(doc?.token_endpoint, fallback.token),
          revocation: accept(doc?.revocation_endpoint, fallback.revocation),
          minecraftToken: accept(ygg?.minecraft_token_endpoint, fallback.minecraftToken),
          minecraftTokenScope:
            typeof ygg?.minecraft_token_scope === 'string' && ygg.minecraft_token_scope ? ygg.minecraft_token_scope : fallback.minecraftTokenScope,
          minecraftTokenInvalidate: accept(ygg?.invalidate_endpoint, fallback.minecraftTokenInvalidate),
          services: accept(doc?.kintare_services_url, fallback.services),
          sessions: accept(doc?.kintare_sessions_url, fallback.sessions),
          render: accept(doc?.kintare_render_url, fallback.render),
          authAgent: accept(doc?.kintare_auth_agent_url, fallback.authAgent),
          ...this.options.endpoints
        }
        ttl = 60 * 60_000
      } catch {
        /* The trusted fallback remains available during discovery outages. */
      }
      this.cached = { value, expires: Date.now() + ttl }
      return value
    })()
    try {
      return await this.pending
    } finally {
      this.pending = undefined
    }
  }
  async servicesUrl(path: string): Promise<string> {
    return `${(await this.resolve()).services}${path}`
  }
  async sessionsUrl(path: string): Promise<string> {
    return `${(await this.resolve()).sessions}${path}`
  }
}

export function kintareEndpoints(options: KintareOptions = {}): KintareEndpointResolver {
  return new KintareEndpointResolver(options)
}
