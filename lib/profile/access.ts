import { HttpClient, HttpOptions } from '../http/http.js'

export type InstanceAuthCode = 'BAD_PASSWORD' | 'LOCKED_OUT' | 'OFFLINE' | 'STORAGE_ERROR' | 'UNKNOWN'
export type InstanceAuthResult = { success: true } | { success: false; code: InstanceAuthCode; error?: string }
export type InstanceAccessResult =
  { status: 'ready' | 'password-required' | 'invalid-password' } | { status: 'offline' | 'locked-out' | 'error'; error?: string }

export class InstanceAuthError extends Error {
  constructor(
    public readonly code: InstanceAuthCode,
    message: string
  ) {
    super(message)
  }
}

export async function requestInstanceToken(url: string, slug: string, password: string, fetcher?: HttpOptions['fetch']): Promise<string> {
  let response: Response
  let data: { success?: boolean; token?: unknown } | null
  try {
    response = await new HttpClient({ fetch: fetcher, timeoutMs: 10_000 }).fetch(
      `${url.replace(/\/$/, '')}/api/profiles/${encodeURIComponent(slug)}/auth`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Basic ${Buffer.from(`${slug}:${password}`).toString('base64')}` }
      }
    )
    data = await response.json().catch(() => null)
  } catch {
    throw new InstanceAuthError('OFFLINE', 'Instance authentication server could not be reached.')
  }
  if (response.status === 429) throw new InstanceAuthError('LOCKED_OUT', 'Instance authentication is temporarily rate-limited.')
  if (response.status >= 500 || response.status === 408)
    throw new InstanceAuthError('OFFLINE', 'Instance authentication server is temporarily unavailable.')
  if (response.status === 401 && data?.success === false) throw new InstanceAuthError('BAD_PASSWORD', 'Instance password was rejected.')
  if (!response.ok || data?.success !== true || typeof data.token !== 'string' || !data.token)
    throw new InstanceAuthError('UNKNOWN', `Unexpected instance authentication response (HTTP ${response.status}).`)
  return data.token
}

export interface ProfileCredentials {
  get(slug: string): string | null
  set(slug: string, password: string | null): void
}

/** Access state is process-local; the host supplies its own encrypted credential storage. */
export class ProfileAccess {
  private readonly tokens = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string | null>>()
  private readonly invalidated = new Set<string>()
  private readonly revisions = new Map<string, number>()
  constructor(
    private readonly url: string,
    private readonly credentials: ProfileCredentials,
    private readonly options: HttpOptions = {}
  ) {}

  getToken(slug: string): string | null {
    const token = this.tokens.get(slug)
    if (!token) return null
    try {
      const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      if (typeof exp === 'number' && Number.isFinite(exp) && Date.now() < exp * 1000 - 30_000) return token
    } catch {
      /* A token without a usable expiry must be renewed. */
    }
    this.tokens.delete(slug)
    return null
  }

  cacheToken(slug: string, token: string | null): void {
    if (token) this.tokens.set(slug, token)
    else this.tokens.delete(slug)
  }

  clear(): void {
    for (const slug of new Set([...this.pending.keys(), ...this.tokens.keys(), ...this.revisions.keys()])) {
      this.revisions.set(slug, (this.revisions.get(slug) ?? 0) + 1)
    }
    this.tokens.clear()
    this.pending.clear()
    this.invalidated.clear()
  }

  forget(slug: string): void {
    this.credentials.set(slug, null)
    this.revisions.set(slug, (this.revisions.get(slug) ?? 0) + 1)
    this.tokens.delete(slug)
    this.pending.delete(slug)
    this.invalidated.delete(slug)
  }

  hadCredential(slug: string): boolean {
    return Boolean(this.credentials.get(slug) || this.getToken(slug) || this.invalidated.has(slug))
  }

  async authenticate(slug: string, password: string): Promise<void> {
    const revision = (this.revisions.get(slug) ?? 0) + 1
    this.revisions.set(slug, revision)
    const token = await requestInstanceToken(this.url, slug, password, this.options.fetch)
    if (this.revisions.get(slug) !== revision) throw new InstanceAuthError('UNKNOWN', 'Instance access changed during authentication.')
    try {
      this.credentials.set(slug, password)
    } catch {
      throw new InstanceAuthError('STORAGE_ERROR', 'Could not save instance credentials.')
    }
    this.tokens.set(slug, token)
    this.invalidated.delete(slug)
  }

  async token(slug: string): Promise<string | null> {
    const cached = this.getToken(slug)
    if (cached) return cached
    const password = this.credentials.get(slug)
    if (!password) return null
    const existing = this.pending.get(slug)
    if (existing) return existing
    const revision = this.revisions.get(slug)
    const unchanged = () => this.credentials.get(slug) === password && this.revisions.get(slug) === revision
    let task!: Promise<string | null>
    task = (async () => {
      try {
        const token = await requestInstanceToken(this.url, slug, password, this.options.fetch)
        if (!unchanged()) return this.getToken(slug)
        this.tokens.set(slug, token)
        this.invalidated.delete(slug)
        return token
      } catch (error) {
        if (!unchanged()) return this.getToken(slug)
        if (!(error instanceof InstanceAuthError) || error.code !== 'BAD_PASSWORD') throw error
        this.credentials.set(slug, null)
        this.invalidated.add(slug)
        return null
      } finally {
        if (this.pending.get(slug) === task) this.pending.delete(slug)
      }
    })()
    this.pending.set(slug, task)
    return task
  }

  async check(slug: string, renew = false): Promise<InstanceAccessResult> {
    if (!slug) return { status: 'password-required' }
    if (renew) this.tokens.delete(slug)
    try {
      if (await this.token(slug)) return { status: 'ready' }
      return { status: this.invalidated.has(slug) ? 'invalid-password' : 'password-required' }
    } catch (error) {
      if (error instanceof InstanceAuthError && error.code === 'OFFLINE') return { status: 'offline' }
      if (error instanceof InstanceAuthError && error.code === 'LOCKED_OUT') return { status: 'locked-out' }
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not restore instance access.'
      }
    }
  }
}
