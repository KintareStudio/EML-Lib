import { canManageProfiles } from '../kintare/profiles.js'
/**
 * @license MIT
 * @copyright Copyright (c) 2026, GoldFrite
 */

import { randomUUID } from 'node:crypto'
import { IStatProvider, StatProvider } from '../../types/stats.js'
import { Account, MultipleProfiles } from '../../types/account.js'
import { EMLLibError, ErrorCode, ErrorType } from '../../types/errors.js'
import { AuthEvents } from '../../types/events.js'
import EventEmitter from '../utils/events.js'

import { HttpClient, httpError, requestError } from '../http/http.js'
import { KintareEndpointResolver, KintareOptions } from '../kintare/endpoints.js'
import { KintareGameSession, GameSessionOptions } from '../kintare/game-session.js'

const DEFAULT_CLIENT_ID = '859de4f4-1db6-4ded-801f-68d321d9f106'
function classifyStatus(status: number): ErrorCode {
  return status === 429 ? ErrorType.TOO_MANY_REQUESTS : status >= 500 || status === 408 ? ErrorType.FETCH_ERROR : ErrorType.AUTH_ERROR
}

/**
 * Authenticate a user with [Kintare](https://kintare.studio/).
 *
 * **Attention!** For skin/cape management, use this class's own `uploadSkin()`, `uploadCape()`,
 * `deleteSkin()`, `deleteCape()` and `getPlayerProfile()` methods — **do not** use the generic
 * `Skin` class with a Kintare account. `Skin` only knows how to talk to Microsoft, Yggdrasil and
 * Azuriom accounts; since Kintare accounts are tagged `meta.type: 'msa'` for launch-argument
 * compatibility, `Skin` would silently route skin/cape calls to Microsoft's API instead of
 * Kintare's, and fail.
 */
export default class KintareAuth extends EventEmitter<AuthEvents> implements IStatProvider {
  /**
   * Kintare is a Yggdrasil-compatible provider, and is deliberately reported as `AUTH_YGGDRASIL`
   * rather than as a bespoke Kintare provider — `Stats` derives the reported login type from this
   * value, so logins are counted as `yggdrasil` upstream. The crash-report counterpart is
   * `meta.reportType` on the accounts built below.
   */
  public readonly statType: StatProvider = 'AUTH_YGGDRASIL'
  private readonly clientId: string
  private readonly http: HttpClient
  private readonly endpoints: KintareEndpointResolver
  private readonly refreshing = new Map<string, Promise<Account>>()

  /**
   * Authenticate a user with [Kintare](https://kintare.studio/).
   * @param clientId [Optional] Your Kintare application's client ID.
   */
  constructor(clientId?: string | (KintareOptions & { clientId?: string }), options: KintareOptions = {}, endpoints?: KintareEndpointResolver) {
    super()
    if (typeof clientId === 'object') options = clientId
    this.clientId = (typeof clientId === 'object' ? clientId.clientId : clientId) ?? DEFAULT_CLIENT_ID
    this.http = new HttpClient(options)
    this.endpoints = endpoints ?? new KintareEndpointResolver(options)
  }

  /**
   * Authenticate a user with Kintare using the device code flow.
   * @param onCode Called once the device code is ready — show the code and URL to the user.
   * @param selectProfile [Optional] Called when the account has more than one Minecraft profile, so
   * the consumer can prompt the user and resolve the choice asynchronously (e.g. over IPC). Return
   * `null` if the user cancels. If omitted, the previous behavior is preserved: a `MultipleProfiles`
   * object is returned for the caller to resolve later with the `selectProfile()` instance method.
   * @returns The account information. If there are multiple profiles and no `selectProfile` callback
   * was given, a `MultipleProfiles` object is returned instead.
   */
  async auth(
    onCode: (code: string, url: string) => void,
    selectProfile?: (profiles: { id: string; name: string }[]) => Promise<{ id?: string; name?: string } | null>
  ): Promise<Account | MultipleProfiles> {
    try {
      const ep = await this.endpoints.resolve()

      const deviceReq = await this.http.fetch(ep.deviceAuthorization, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_id=${encodeURIComponent(this.clientId)}&scope=${encodeURIComponent(`openid offline_access ${ep.minecraftTokenScope}`)}`
      })

      if (!deviceReq.ok) {
        throw await httpError(deviceReq, 'Kintare device auth failed')
      }
      const deviceData = await deviceReq.json()

      onCode(deviceData.user_code, deviceData.verification_uri_complete ?? deviceData.verification_uri)

      let interval: number = deviceData.interval ?? 5
      const expires = Date.now() + deviceData.expires_in * 1000

      while (Date.now() < expires) {
        await new Promise((r) => setTimeout(r, interval * 1000))

        const tokenReq = await this.http.fetch(ep.token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(deviceData.device_code)}&client_id=${encodeURIComponent(this.clientId)}`
        })

        const tokenData = await tokenReq.json()

        if (tokenReq.ok) {
          return await this.buildAccount(tokenData, selectProfile)
        }

        const error = tokenData.error
        if (error === 'authorization_pending') continue
        if (error === 'slow_down') {
          interval += 5
          continue
        }
        if (error === 'access_denied' || error === 'expired_token') {
          throw new EMLLibError(ErrorType.AUTH_CANCELLED, `Kintare auth cancelled: ${error}`)
        }
        throw new EMLLibError(classifyStatus(tokenReq.status), `Kintare token request failed: ${error}`, {
          status: tokenReq.status,
          serverCode: error
        })
      }

      throw new EMLLibError(ErrorType.AUTH_CANCELLED, 'Kintare device code expired')
    } catch (err: unknown) {
      const error = err instanceof EMLLibError ? err : requestError(err, 'Kintare authentication failed')
      this.emit('auth_error', { message: error.message })
      throw error
    }
  }

  /**
   * Select a profile for a user with multiple profiles.
   * @param profiles The multiple profiles object returned by `KintareAuth.auth`.
   * @param select The profile to select, by ID or name. If both provided, ID is used.
   * @returns The account information with the selected profile.
   */
  selectProfile(profiles: MultipleProfiles, select: { id?: string; name?: string }): Account {
    if (!select.id && !select.name) {
      throw new EMLLibError(ErrorType.AUTH_ERROR, 'Kintare profile selection failed: no profile ID or name provided')
    }

    const profile = select.id
      ? profiles.availableProfiles.find((p) => p.id === select.id)
      : profiles.availableProfiles.find((p) => p.name === select.name)

    if (!profile) {
      throw new EMLLibError(ErrorType.AUTH_ERROR, `Kintare profile selection failed: profile ${select.id ?? select.name} not found`)
    }

    return {
      name: profile.name,
      uuid: profile.id,
      accessToken: profiles.accessToken,
      clientToken: profiles.clientToken,
      refreshToken: profiles.refreshToken,
      userProperties: profiles.userProperties,
      meta: {
        online: false,
        type: 'msa',
        reportType: 'yggdrasil'
      }
    } as Account
  }

  /**
   * Decode the payload of a Kintare OIDC JWT (no signature verification — for reading claims only).
   * @param accessToken The JWT access token.
   * @returns The decoded payload, or `{}` if it couldn't be parsed.
   */
  decodeToken(accessToken: string): Record<string, any> {
    try {
      const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf-8'))
      return payload && typeof payload === 'object' ? payload : {}
    } catch {
      return {}
    }
  }

  /**
   * Extract the stable subject (`sub`) claim from a Kintare OIDC JWT, used as the account's `sessionId`.
   * @param accessToken The JWT access token.
   * @returns The `sub` claim, or a random UUID if it couldn't be read.
   */
  extractSub(accessToken: string): string {
    const payload = this.decodeToken(accessToken)
    return `${payload.sub ?? randomUUID()}`
  }

  /**
   * Resolve a human-friendly display name from a Kintare OIDC JWT's claims
   * (`preferred_username` > `name` > `email`), falling back if none are present.
   * @param accessToken The JWT access token.
   * @param fallback The value to use if no claim yields a usable name.
   */
  resolveDisplayName(accessToken: string, fallback: string): string {
    const payload = this.decodeToken(accessToken)
    const preferred = `${payload.preferred_username ?? payload.name ?? payload.email ?? ''}`.trim()
    return preferred || fallback
  }

  /**
   * Strip dashes from a profile/player UUID.
   * @param id The UUID, dashed or dashless.
   */
  normalizeProfileId(id: string): string {
    return (id ?? '').replace(/-/g, '')
  }

  /**
   * Deduplicate a list of profiles by their normalized (dashless) ID.
   * @param profiles The profiles to deduplicate.
   */
  dedupeProfiles(profiles: { id: string; name: string }[]): { id: string; name: string }[] {
    const seen = new Set<string>()
    const merged: { id: string; name: string }[] = []
    for (const profile of profiles) {
      const id = this.normalizeProfileId(profile.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      merged.push({ id, name: profile.name })
    }
    return merged
  }

  /**
   * Reconcile a stored account against a freshly-fetched profile list — e.g. after the user creates,
   * renames, or deletes their Minecraft profile elsewhere. Picks the profile that matches the
   * account's current UUID if still present, auto-selects when there's exactly one profile, and
   * otherwise marks the account as having no profile selected.
   * @param account The account as currently stored.
   * @param profiles The freshly-fetched profile list.
   * @returns The reconciled account.
   */
  reconcileProfiles(account: Account, profiles: { id: string; name: string }[], fallback: 'none' | 'first' = 'none'): Account {
    if (profiles.length === 0) {
      return this.markAccountWithoutProfile(account)
    }

    const currentUuid = this.normalizeProfileId(account.uuid || '')
    const current = profiles.find((profile) => this.normalizeProfileId(profile.id) === currentUuid)
    if (current) return this.assignProfile(account, current)
    if (profiles.length === 1 || fallback === 'first') return this.assignProfile(account, profiles[0])
    return this.markAccountWithoutProfile(account)
  }

  /**
   * Assign a specific profile to an existing account (e.g. after an explicit user selection).
   * @param account The account to update.
   * @param profile The profile to assign.
   */
  assignProfile(account: Account, profile: { id: string; name: string }): Account {
    const displayName = account.displayName ?? this.resolveDisplayName(account.accessToken, account.name || profile.name)
    return {
      ...account,
      name: profile.name,
      uuid: this.normalizeProfileId(profile.id),
      displayName,
      noProfile: undefined
    }
  }

  /**
   * Mark an account as having no Minecraft profile selected (e.g. the user hasn't created one yet).
   * @param account The account to mark.
   */
  markAccountWithoutProfile(account: Account): Account {
    const displayName = account.displayName ?? this.resolveDisplayName(account.accessToken, account.name || 'Kintare')
    return {
      ...account,
      name: displayName,
      uuid: account.sessionId ?? this.extractSub(account.accessToken),
      displayName,
      noProfile: true
    }
  }

  /**
   * Validate a user's OIDC JWT by checking its expiry locally — no network call.
   * @param user The user account to validate.
   * @returns `true` if the token is still valid, `false` otherwise.
   */
  async validate(user: Account): Promise<boolean> {
    try {
      const [, payload] = user.accessToken.split('.')
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
      const valid = decoded.exp > Math.floor(Date.now() / 1000)
      if (valid) this.emit('validate_success', { name: user.name })
      else this.emit('validate_error', { message: 'Kintare token expired' })
      return valid
    } catch (err: unknown) {
      this.emit('validate_error', { message: err instanceof Error ? err.message : `${err}` })
      return false
    }
  }

  /**
   * Refresh a user's OIDC tokens using the refresh token.
   * @param user The user account to refresh.
   * @returns The refreshed account information.
   */
  async refresh(user: Account): Promise<Account> {
    try {
      const ep = await this.endpoints.resolve()
      const req = await this.http.fetch(ep.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(user.refreshToken ?? '')}&client_id=${encodeURIComponent(this.clientId)}`
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare refresh failed')
      }
      const data = await req.json()

      const refreshed = {
        ...user,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? user.refreshToken,
        meta: {
          online: false,
          type: 'msa',
          reportType: 'yggdrasil'
        }
      } as Account
      if (typeof refreshed.accessToken !== 'string' || !refreshed.accessToken)
        throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid token refresh response.', {
          status: req.status
        })
      this.emit('refresh_success', { name: refreshed.name })
      return refreshed
    } catch (err: unknown) {
      const error = err instanceof EMLLibError ? err : requestError(err, 'Kintare refresh failed')
      this.emit('refresh_error', { message: error.message })
      throw error
    }
  }

  /**
   * List the Minecraft profiles on this Kintare account.
   * Also serves as a network-based token validation.
   * @param user The user account.
   * @returns Array of available profiles.
   */
  async getProfiles(user: Account): Promise<{ id: string; name: string }[]> {
    try {
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/player/profiles`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${user.accessToken}` }
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare profiles request failed')
      }
      const data = await req.json()

      return Array.isArray(data) ? data : (data.profiles ?? [])
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare profiles request failed')
    }
  }

  /**
   * Get a short-lived Yggdrasil JWT for game launch. Call this immediately before `launcher.launch()`.
   * @param user The user account.
   * @returns The Yggdrasil JWT (1h TTL) and its clientToken. Pass accessToken as
   * `config.account.accessToken`, and hang onto clientToken — it's required later to
   * validate/refresh/invalidate this specific token via the standard Yggdrasil API,
   * and there is no way to recover it after this call returns.
   */
  async getGameToken(user: Account): Promise<{ accessToken: string; clientToken?: string }> {
    try {
      const ep = await this.endpoints.resolve()
      const req = await this.http.fetch(ep.minecraftToken, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.accessToken}`
        },
        body: JSON.stringify({ uuid: user.uuid })
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare game token request failed')
      }
      const text = await req.text()
      const preview = text ? text.slice(0, 1200) : ''
      let data: any
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }

      // Debug logging helper - avoid importing logger here; throw detailed error instead
      if (!data) {
        throw new EMLLibError(ErrorType.AUTH_ERROR, `Kintare game token request returned empty body: HTTP ${req.status} ${preview}`)
      }

      // If data is a string 'undefined' or similar, treat as empty
      if (typeof data === 'string') {
        const s = data.trim()
        if (!s || s === 'undefined' || s === 'null') {
          throw new EMLLibError(ErrorType.AUTH_ERROR, `Kintare game token request returned invalid string: HTTP ${req.status} ${s.slice(0, 200)}`)
        }
        // Heuristic: a Yggdrasil/JWT token should contain at least two dots (header.payload.signature)
        if (s.split('.').length < 3 && !(s.includes('access_token') || s.includes('token'))) {
          throw new EMLLibError(ErrorType.AUTH_ERROR, `Kintare game token request returned unexpected string: HTTP ${req.status} ${s.slice(0, 200)}`)
        }
        // Plain-string response shape has no clientToken to extract.
        return { accessToken: s }
      }

      // Support multiple possible field names returned by the server
      const accessToken = data.access_token ?? data.accessToken ?? data.token ?? data.jwt ?? data.game_token
      if (typeof accessToken !== 'string' || !accessToken) throw new EMLLibError(ErrorType.AUTH_ERROR, 'Invalid Kintare game token response')
      const clientToken = data.clientToken ?? data.client_token
      return { accessToken, clientToken }
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare game token request failed')
    }
  }

  /**
   * Invalidate a single ephemeral Yggdrasil game token (as returned by `getGameToken()`).
   * Call this when the game process exits — it closes just that one Yggdrasil session
   * without touching the user's OIDC login (unlike `logout()`, which revokes the refresh
   * token for the whole account).
   * @param gameToken The Yggdrasil JWT previously obtained from `getGameToken()`.
   * @param clientToken The clientToken returned alongside that same token — required by
   * `/invalidate` to match the stored session; there's no way to invalidate without it.
   */
  async invalidateGameToken(gameToken: string, clientToken: string): Promise<void> {
    try {
      const ep = await this.endpoints.resolve()
      const req = await this.http.fetch(ep.minecraftTokenInvalidate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: gameToken, clientToken })
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare game token invalidation failed')
      }
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare game token invalidation failed')
    }
  }

  /**
   * Logout a user from Kintare by revoking their refresh token.
   * @param user The user account to logout.
   */
  async logout(user: Account): Promise<void> {
    try {
      const ep = await this.endpoints.resolve()
      const req = await this.http.fetch(ep.revocation, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(user.refreshToken ?? '')}&client_id=${encodeURIComponent(this.clientId)}`
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare logout failed')
      }

      this.emit('logout_success', { name: user.name })
    } catch (err: unknown) {
      const error = err instanceof EMLLibError ? err : requestError(err, 'Kintare logout failed')
      this.emit('logout_error', { message: error.message })
      throw error
    }
  }

  /**
   * Upload a skin for a specific player profile.
   * @param user The user account (for auth token).
   * @param profileId The Minecraft profile UUID (dashless).
   * @param file The skin PNG file as a Buffer.
   * @param model The skin model — `'slim'` for slim arms, or omit/empty string for classic.
   */
  async uploadSkin(user: Account, file: Buffer, model?: 'slim', profileId?: string): Promise<void> {
    try {
      const uuid = profileId ?? this.getDashlessUUID(user)
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(file)], { type: 'image/png' }), 'skin.png')
      if (model) form.append('model', model)

      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/api/user/profile/${uuid}/skin`), {
        method: 'PUT',
        headers: { Authorization: `Bearer ${user.accessToken}` },
        body: form
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare skin upload failed')
      }
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare skin upload failed')
    }
  }

  /**
   * Upload a cape for a specific player profile.
   * @param user The user account (for auth token).
   * @param profileId The Minecraft profile UUID (dashless).
   * @param file The cape PNG file as a Buffer.
   */
  async uploadCape(user: Account, file: Buffer, profileId?: string): Promise<void> {
    try {
      const uuid = profileId ?? this.getDashlessUUID(user)
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(file)], { type: 'image/png' }), 'cape.png')

      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/api/user/profile/${uuid}/cape`), {
        method: 'PUT',
        headers: { Authorization: `Bearer ${user.accessToken}` },
        body: form
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare cape upload failed')
      }
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare cape upload failed')
    }
  }

  /**
   * Delete the skin of a specific player profile.
   * @param user The user account (for auth token).
   * @param profileId The Minecraft profile UUID (dashless).
   */
  async deleteSkin(user: Account, profileId?: string): Promise<void> {
    try {
      const uuid = profileId ?? this.getDashlessUUID(user)
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/api/user/profile/${uuid}/skin`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.accessToken}` }
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare skin delete failed')
      }
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare skin delete failed')
    }
  }

  /**
   * Delete the cape of a specific player profile.
   * @param user The user account (for auth token).
   * @param profileId The Minecraft profile UUID (dashless).
   */
  async deleteCape(user: Account, profileId?: string): Promise<void> {
    try {
      const uuid = profileId ?? this.getDashlessUUID(user)
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/api/user/profile/${uuid}/cape`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.accessToken}` }
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare cape delete failed')
      }
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare cape delete failed')
    }
  }

  /**
   * Look up a player's UUID by their name. No authentication required.
   * @param name The player name to look up.
   * @returns The player's name and dashless UUID.
   */
  async lookupByName(name: string): Promise<{ name: string; id: string }> {
    try {
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/minecraft/profile/lookup/name/${encodeURIComponent(name)}`))
      if (!req.ok) {
        throw await httpError(req, 'Kintare name lookup failed')
      }
      return await req.json()
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare name lookup failed')
    }
  }

  /**
   * Look up a player's name by their UUID. No authentication required.
   * @param uuid The player UUID (dashless) to look up.
   * @returns The player's name and dashless UUID.
   */
  async lookupByUUID(uuid: string): Promise<{ name: string; id: string }> {
    try {
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/minecraft/profile/lookup/${encodeURIComponent(uuid)}`))
      if (!req.ok) {
        throw await httpError(req, 'Kintare UUID lookup failed')
      }
      return await req.json()
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare UUID lookup failed')
    }
  }

  /**
   * Look up multiple player UUIDs by name in a single request (max 10).
   * No authentication required.
   * @param names Array of player names (max 10).
   * @returns Array of `{ name, id }` for each found player.
   */
  async lookupBulk(names: string[]): Promise<{ name: string; id: string }[]> {
    try {
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/minecraft/profile/lookup/bulk/byname`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(names.slice(0, 10))
      })
      if (!req.ok) {
        throw await httpError(req, 'Kintare bulk lookup failed')
      }
      return await req.json()
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare bulk lookup failed')
    }
  }

  /**
   * Get a player's full profile including textures and profile actions from the session server.
   * No authentication required.
   * @param uuid The player UUID (dashless).
   * @param unsigned Set to `false` to include texture signatures. Defaults to `true`.
   * @returns The full player profile with properties and profileActions.
   */
  async getPlayerProfile(
    uuid: string,
    unsigned?: boolean
  ): Promise<{
    id: string
    name: string
    properties: { name: string; value: string; signature?: string }[]
    profileActions: string[]
  }> {
    try {
      const query = unsigned === false ? '?unsigned=false' : ''
      const req = await this.http.fetch(await this.endpoints.sessionsUrl(`/session/minecraft/profile/${encodeURIComponent(uuid)}${query}`))
      if (!req.ok) {
        throw await httpError(req, 'Kintare player profile request failed')
      }
      return await req.json()
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare player profile request failed')
    }
  }

  /**
   * Check if a player name is available. Permission-aware — higher-privilege users may see reserved names as available.
   * @param user The user account (for auth token).
   * @param name The player name to check.
   * @returns The availability status: `'AVAILABLE'`, `'DUPLICATE'`, or `'NOT_ALLOWED'`.
   */
  async checkNameAvailability(user: Account, name: string): Promise<'AVAILABLE' | 'DUPLICATE' | 'NOT_ALLOWED'> {
    try {
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/minecraft/profile/name/${encodeURIComponent(name)}/available`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${user.accessToken}` }
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare name availability check failed')
      }
      const data = await req.json()
      return data.status ?? 'NOT_ALLOWED'
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare name availability check failed')
    }
  }

  /**
   * Change the name of a player profile.
   * @param user The user account (for auth token).
   * @param playerId The player UUID (dashless).
   * @param name The desired new name.
   */
  async changeName(user: Account, playerId: string, name: string): Promise<void> {
    try {
      const req = await this.http.fetch(
        await this.endpoints.servicesUrl(`/minecraft/profiles/name/${encodeURIComponent(playerId)}/${encodeURIComponent(name)}`),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.accessToken}` }
        }
      )

      if (!req.ok) {
        throw await httpError(req, 'Kintare name change failed')
      }
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare name change failed')
    }
  }

  /**
   * Get account features and type for the authenticated user.
   * Requires the OIDC access token (not Yggdrasil).
   * @param user The user account.
   * @returns The account features including account type.
   */
  async getAccountFeatures(user: Account): Promise<any> {
    try {
      const req = await this.http.fetch(await this.endpoints.servicesUrl(`/api/kintare/accounts/features`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${user.accessToken}` }
      })

      if (!req.ok) {
        throw await httpError(req, 'Kintare account features request failed')
      }
      return await req.json()
    } catch (err: unknown) {
      if (err instanceof EMLLibError) throw err
      throw requestError(err, 'Kintare account features request failed')
    }
  }

  /** Prepare a game credential without replacing the persistent login credential. */
  prepareGameSession(account: Account, options: GameSessionOptions = {}): Promise<KintareGameSession> {
    return KintareGameSession.prepare(this, account, options)
  }

  /** Concurrent consumers share one refresh-token rotation. Persistence remains the host's job. */
  async ensureSession(account: Account): Promise<Account> {
    if (await this.validate(account)) return account
    const key = account.refreshToken ?? account.accessToken
    const existing = this.refreshing.get(key)
    if (existing) return { ...account, ...(await existing), uuid: account.uuid, name: account.name }
    const pending = this.refresh(account)
    this.refreshing.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.refreshing.get(key) === pending) this.refreshing.delete(key)
    }
  }

  async selectableProfiles(
    account: Account,
    managed: { id: string; name: string }[] = []
  ): Promise<{
    profiles: { id: string; name: string }[]
    managedProfiles: { id: string; name: string }[]
    accountType: string | null
  }> {
    const [owned, accountType] = await Promise.all([
      this.getProfiles(account),
      managed.length
        ? this.getAccountFeatures(account)
            .then((features) => String(features?.account?.type ?? 'user').toLowerCase())
            .catch(() => 'user')
        : Promise.resolve(null)
    ])
    if (!canManageProfiles(accountType ?? '')) return { profiles: this.dedupeProfiles(owned), managedProfiles: [], accountType }
    const refreshed = await this.refreshProfileIdentities(managed)
    return {
      profiles: this.dedupeProfiles([...owned, ...refreshed]),
      managedProfiles: refreshed,
      accountType
    }
  }

  async refreshProfileIdentities(profiles: { id: string; name: string }[]): Promise<{ id: string; name: string }[]> {
    const refreshed = await Promise.all(
      profiles.map(async (profile) => {
        try {
          return await this.lookupByUUID(this.normalizeProfileId(profile.id))
        } catch {
          return profile
        }
      })
    )
    return this.dedupeProfiles(refreshed)
  }

  async selectedProfileId(account: Account, profiles?: { id: string; name: string }[]): Promise<string> {
    if (account.noProfile)
      throw new EMLLibError(ErrorType.CONFIG_ERROR, 'No Minecraft profile selected. Create a profile in KintareAccounts and select it.')
    const available = profiles ?? (await this.getProfiles(account))
    const id = this.normalizeProfileId(account.uuid)
    const match =
      available.find((profile) => this.normalizeProfileId(profile.id) === id) ?? available.find((profile) => profile.name === account.name)
    if (match) return this.normalizeProfileId(match.id)
    if (available.length === 1) return this.normalizeProfileId(available[0].id)
    throw new EMLLibError(ErrorType.CONFIG_ERROR, 'No Minecraft profile selected. Choose a profile before continuing.')
  }

  private getDashlessUUID(user: Account): string {
    return this.normalizeProfileId(user.uuid)
  }

  private async buildAccount(
    tokenData: { access_token: string; refresh_token?: string },
    selectProfile?: (profiles: { id: string; name: string }[]) => Promise<{ id?: string; name?: string } | null>
  ): Promise<Account | MultipleProfiles> {
    const profiles = await this.getProfiles({ accessToken: tokenData.access_token } as Account)
    const clientToken = randomUUID()
    const sessionId = this.extractSub(tokenData.access_token)

    const baseAccount = {
      name: '',
      uuid: '',
      accessToken: tokenData.access_token,
      clientToken,
      refreshToken: tokenData.refresh_token,
      sessionId,
      userProperties: {},
      meta: { online: false, type: 'msa' as const, reportType: 'yggdrasil' as const }
    }

    if (profiles.length === 0) {
      const account = this.markAccountWithoutProfile(baseAccount as Account)
      this.emit('auth_success', { name: account.name })
      return account
    }

    if (profiles.length === 1) {
      const account = this.assignProfile(baseAccount as Account, profiles[0])
      this.emit('auth_success', { name: account.name })
      return account
    }

    if (!selectProfile) {
      const availableProfiles = profiles.map((p) => ({ id: p.id, name: p.name }))
      this.emit('auth_need_profile_selection', { availableProfiles })
      return {
        needsProfileSelection: true,
        accessToken: tokenData.access_token,
        clientToken,
        refreshToken: tokenData.refresh_token,
        userProperties: {},
        url: '',
        availableProfiles
      } as MultipleProfiles
    }

    const selection = await selectProfile(profiles)
    if (!selection) {
      throw new EMLLibError(ErrorType.AUTH_CANCELLED, 'Kintare profile selection cancelled')
    }

    const match = selection.id
      ? profiles.find((p) => this.normalizeProfileId(p.id) === this.normalizeProfileId(selection.id!))
      : profiles.find((p) => p.name === selection.name)

    if (!match) {
      throw new EMLLibError(ErrorType.AUTH_ERROR, `Kintare profile selection failed: profile ${selection.id ?? selection.name} not found`)
    }

    const account = this.assignProfile(baseAccount as Account, match)
    this.emit('auth_success', { name: account.name })
    return account
  }
}
