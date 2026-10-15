import type { Account } from '../../types/account.js'
import type KintareAuth from '../auth/kintare.js'
import { isEmlNetworkError, EMLLibError, ErrorType } from '../../types/errors.js'

export interface GameSessionOptions {
  allowOffline?: boolean
  onAccount?: (account: Account) => void | Promise<void>
  onOffline?: (source: 'oidc' | 'services' | 'yggdrasil') => void
}

/** One game's credential, kept separate from the persistent OIDC account. */
export class KintareGameSession {
  private releaseTask?: Promise<void>
  private constructor(
    readonly account: Account,
    private readonly auth: KintareAuth,
    private readonly token?: { accessToken: string; clientToken?: string }
  ) {}

  static async prepare(auth: KintareAuth, account: Account, options: GameSessionOptions = {}): Promise<KintareGameSession> {
    if (account.noProfile) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'No Minecraft profile selected.')
    let current = account
    const tolerate = (error: unknown, source: 'oidc' | 'services' | 'yggdrasil') => {
      if (!options.allowOffline || !isEmlNetworkError(error)) throw error
      options.onOffline?.(source)
    }
    if (current.refreshToken) {
      try {
        const refreshed = await auth.ensureSession(current)
        if (refreshed !== current) {
          current = refreshed
          await options.onAccount?.(current)
        }
      } catch (error) {
        tolerate(error, 'oidc')
      }
      try {
        const profile = (await auth.getProfiles(current)).find((p) => auth.normalizeProfileId(p.id) === auth.normalizeProfileId(current.uuid))
        if (profile && profile.name !== current.name) {
          current = auth.assignProfile(current, profile)
          await options.onAccount?.(current)
        }
      } catch (error) {
        tolerate(error, 'services')
      }
      try {
        const token = await auth.getGameToken(current)
        if (typeof token.accessToken !== 'string' || !token.accessToken)
          throw new EMLLibError(ErrorType.AUTH_ERROR, 'Game token exchange returned an empty token.')
        return new KintareGameSession(
          {
            ...current,
            accessToken: token.accessToken,
            clientToken: token.clientToken ?? current.clientToken
          },
          auth,
          token
        )
      } catch (error) {
        tolerate(error, 'yggdrasil')
      }
    }
    return new KintareGameSession(current, auth)
  }

  release(): Promise<void> {
    this.releaseTask ??= this.token?.clientToken ? this.auth.invalidateGameToken(this.token.accessToken, this.token.clientToken) : Promise.resolve()
    return this.releaseTask
  }
}
