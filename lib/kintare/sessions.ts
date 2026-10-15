import type KintareAuth from '../auth/kintare.js'
import type { Account } from '../../types/account.js'
import type { ProfileIdentity } from './profiles.js'
import { EMLLibError, ErrorType, isEmlNetworkError } from '../../types/errors.js'

export type SessionRestoreResult =
  | { status: 'ready'; account: Account; managedProfiles?: ProfileIdentity[] }
  | { status: 'invalid' | 'offline' | 'error'; account: Account; error: unknown }

/** Session policy without filesystem, UI events or an application-owned interval. */
export class KintareSessions {
  constructor(private readonly auth: KintareAuth) {}

  async restore(account: Account, managed: ProfileIdentity[] = [], onOffline?: (source: 'services') => void): Promise<SessionRestoreResult> {
    let current: Account
    try {
      current = await this.auth.ensureSession(account)
    } catch (error) {
      const status = error instanceof EMLLibError && error.code === ErrorType.AUTH_ERROR ? 'invalid' : isEmlNetworkError(error) ? 'offline' : 'error'
      return { status, account, error }
    }
    try {
      const selectable = await this.auth.selectableProfiles(current, managed)
      return {
        status: 'ready',
        account: this.auth.reconcileProfiles(current, selectable.profiles, 'first'),
        managedProfiles: selectable.managedProfiles
      }
    } catch (error) {
      if (isEmlNetworkError(error)) onOffline?.('services')
      return { status: 'ready', account: current }
    }
  }

  async refreshAccounts(accounts: Account[]): Promise<{
    updated: Account[]
    failures: { account: Account; error: unknown }[]
    offline: boolean
  }> {
    const updated: Account[] = [],
      failures: { account: Account; error: unknown }[] = []
    let offline = false
    for (const account of accounts) {
      try {
        const refreshed = await this.auth.ensureSession(account)
        if (refreshed !== account)
          updated.push({
            ...refreshed,
            displayName: account.displayName ?? this.auth.resolveDisplayName(refreshed.accessToken, account.name)
          })
      } catch (error) {
        failures.push({ account, error })
        if (isEmlNetworkError(error)) {
          offline = true
          break
        }
      }
    }
    return { updated, failures, offline }
  }
}
