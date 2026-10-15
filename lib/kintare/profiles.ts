import type KintareAuth from '../auth/kintare.js'
import type { Account } from '../../types/account.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'

export type ProfileIdentity = { id: string; name: string }
export const canManageProfiles = (type: string): boolean => ['admin', 'superadmin'].includes(type.toLowerCase())

/** Kintare profile rules; the host owns its local list of managed selections. */
export class KintareProfiles {
  constructor(private readonly auth: KintareAuth) {}

  async lookupManaged(account: Account, input: string): Promise<ProfileIdentity> {
    await this.requireManager(account)
    const query = String(input ?? '').trim()
    if (!query) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Player name or UUID is required.')
    const normalized = this.auth.normalizeProfileId(query)
    const result = /^[a-f0-9]{32}$/i.test(normalized) ? await this.auth.lookupByUUID(normalized) : await this.auth.lookupByName(query)
    return { id: this.auth.normalizeProfileId(result.id), name: result.name }
  }

  async addManaged(account: Account, profile: ProfileIdentity, existing: ProfileIdentity[]): Promise<ProfileIdentity[]> {
    await this.requireManager(account)
    const id = this.auth.normalizeProfileId(String(profile?.id ?? ''))
    const name = String(profile?.name ?? '').trim()
    if (!/^[a-f0-9]{32}$/i.test(id) || !name) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid managed profile.')
    const canonical = await this.auth.lookupByUUID(id).catch(() => ({ id, name }))
    return this.auth.dedupeProfiles([...existing, canonical])
  }

  async actions(account: Account): Promise<string[]> {
    if (!account.uuid || account.noProfile) return []
    const profile = await this.auth.getPlayerProfile(this.auth.normalizeProfileId(account.uuid))
    return profile.profileActions ?? []
  }

  private async requireManager(account: Account): Promise<void> {
    const features = await this.auth.getAccountFeatures(account)
    if (!canManageProfiles(String(features?.account?.type ?? 'user')))
      throw new EMLLibError(ErrorType.AUTH_ERROR, 'Managed profiles require admin or superadmin permissions.', { status: 403 })
  }
}
