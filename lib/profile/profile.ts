import { HttpClient, HttpOptions } from '../http/http.js'
import { requestInstanceToken, InstanceAuthError } from './access.js'
/**
 * @license MIT
 * @copyright Copyright (c) 2026, GoldFrite
 */

import { Account } from '../../types/account.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import { IProfile } from '../../types/profile.js'

export default class Profile {
  private readonly url: string
  private readonly baseUrl: string
  private readonly http: HttpClient
  private readonly tokens: Map<string, string> = new Map()

  /**
   * Get the profiles from the EML AdminTool.
   *
   * **Attention!** This class only works with EML AdminTool. Please do not use it without the it.
   *
   * @param url The URL of your EML AdminTool website.
   * @param account (Deprecated, provide the account in the `getProfiles()` method instead)
   */
  constructor(url: string, account?: Account, options: HttpOptions = {}) {
    this.baseUrl = url.replace(/\/$/, '')
    this.url = `${this.baseUrl}/api`
    this.http = new HttpClient(options)
  }

  /**
   * Get the profiles from the EML AdminTool.
   * @param account The account to use for authentication, to display any hidden profiles.
   * @returns The list of Profile objects.
   */
  async getProfiles(account?: Account): Promise<IProfile[]>

  /**
   * Get the profiles from the EML AdminTool.
   * @param slug The slug of the protected profile you want to access. You need to authenticate
   * against the profile first using the `auth()` method.
   * @returns The list of Profile objects.
   */
  async getProfiles(slug?: string): Promise<IProfile[]>

  /**
   * Get the profiles from the EML AdminTool.
   * @param account The account to use for authentication, to display any hidden profiles.
   * @param slug The slug of the protected profile you want to access. You need to authenticate
   * against the profile first using the `auth()` method.
   * @returns The list of Profile objects.
   */
  async getProfiles(account: Account, slug: string): Promise<IProfile[]>

  async getProfiles(arg1?: Account | string, arg2?: string): Promise<IProfile[]> {
    try {
      const headers: HeadersInit = this.setHeader(arg1, arg2)
      const req = await this.http.fetch(`${this.url}/profiles`, { headers })

      if (!req.ok) {
        const errorText = await req.text()
        throw new EMLLibError(ErrorType.FETCH_ERROR, `Error while fetching profiles: HTTP ${req.status} ${errorText}`)
      }
      const data: { success: boolean; message?: string; profiles: IProfile[] } = await req.json()

      if (!data.success) {
        throw new EMLLibError(ErrorType.FETCH_ERROR, `Error while fetching profiles: ${data.message ?? 'Unknown error'}`)
      }

      return data.profiles ?? []
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw new EMLLibError(ErrorType.FETCH_ERROR, `Error while fetching profiles: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * Authenticate against a protected profile.
   *
   * **Note:** The returned token is stored in memory and will be used for subsequent requests to the
   * EML AdminTool. You do not need to manually manage the token.
   *
   * @param slug The slug of the profile to authenticate against.
   * @param password The password for the profile.
   * @returns An object containing the slug and the authentication token.
   */
  async auth(slug: string, password: string): Promise<{ slug: string; token: string }> {
    try {
      const token = await requestInstanceToken(this.baseUrl, slug, password, (url, init) => this.http.fetch(url, init))
      this.tokens.set(slug, token)
      return { slug, token }
    } catch (cause) {
      if (!(cause instanceof InstanceAuthError)) throw cause
      const code =
        cause.code === 'BAD_PASSWORD'
          ? ErrorType.AUTH_ERROR
          : cause.code === 'LOCKED_OUT'
            ? ErrorType.TOO_MANY_REQUESTS
            : cause.code === 'OFFLINE'
              ? ErrorType.NET_ERROR
              : ErrorType.UNKNOWN_ERROR
      throw new EMLLibError(code, cause.message, {
        cause,
        status: cause.code === 'BAD_PASSWORD' ? 401 : cause.code === 'LOCKED_OUT' ? 429 : undefined
      })
    }
  }

  /** Query metadata with an externally managed bearer, without authenticating again. */
  async metadata(account?: Account, token?: string): Promise<IProfile[]> {
    const data = await this.http.json<{ success: boolean; profiles: IProfile[] }>(`${this.url}/profiles`, {
      headers: {
        ...(account?.name ? { pseudo: account.name } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      redirect: 'error'
    })
    if (data.success !== true || !Array.isArray(data.profiles)) throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid instance metadata response')
    return data.profiles
  }

  async search(query: string, account?: Account): Promise<IProfile[]> {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return (await this.getProfiles(account))
      .filter((profile) =>
        [profile.id, profile.slug, profile.name].some((value) =>
          String(value ?? '')
            .toLowerCase()
            .includes(needle)
        )
      )
      .map(({ token: _token, ...metadata }) => metadata)
  }

  /** Refresh redacted metadata without mistaking a rejected bearer for a rejected password. */
  async refresh(
    slug: string,
    account?: Account,
    token?: string,
    previous?: Partial<IProfile>
  ): Promise<{ profile: IProfile | null; tokenRejected: boolean }> {
    let profiles: IProfile[],
      authorized = Boolean(token),
      tokenRejected = false
    if (token) {
      try {
        profiles = await this.metadata(account, token)
      } catch (error) {
        if (!(error instanceof EMLLibError) || (error.status !== 401 && error.status !== 403)) throw error
        authorized = false
        tokenRejected = error.status === 401
        profiles = await this.getProfiles(account)
      }
    } else profiles = await this.getProfiles(account)
    const found = profiles.find((profile) => profile.slug === slug)
    if (!found) return { profile: null, tokenRejected }
    const { token: _token, ...metadata } = found
    if (!authorized && metadata.visibility === 'PROTECTED' && previous?.slug === slug && !metadata.ip) {
      metadata.ip = previous.ip
      metadata.port = previous.port
      metadata.tcpProtocol = previous.tcpProtocol
    }
    return { profile: metadata, tokenRejected }
  }

  private setHeader(arg1?: Account | string, arg2?: string): HeadersInit {
    if (typeof arg1 === 'object') {
      if (arg2) {
        return { pseudo: arg1.name, Authorization: `Bearer ${this.tokens.get(arg2)}` }
      }
      return { pseudo: arg1.name }
    }

    if (typeof arg1 === 'string') {
      const token = this.tokens.get(arg1)
      if (!token) {
        throw new EMLLibError(ErrorType.AUTH_ERROR, `No authentication token found for profile slug: ${arg1}`)
      }
      return { Authorization: `Bearer ${token}` }
    }

    return {}
  }
}
