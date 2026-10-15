export interface Account {
  name: string
  uuid: string
  accessToken: string
  clientToken: string
  refreshToken?: string
  sessionId?: string
  userProperties?: any
  meta: {
    online: boolean
    type: 'msa' | 'azuriom' | 'yggdrasil' | 'crack'
    url?: string
    /**
     * The auth type to declare in telemetry (crash reports), when it differs from `type`.
     *
     * `type` is launch-critical — it selects the `${user_type}` launch argument and decides whether
     * the authlib injector is wired in — so a provider can't repurpose it just to be counted
     * correctly. Kintare accounts are tagged `type: 'msa'` so the game launches properly, but set
     * `reportType: 'yggdrasil'` so they're reported as the Yggdrasil-compatible provider they are.
     * Defaults to `type` when unset.
     */
    reportType?: 'msa' | 'azuriom' | 'yggdrasil' | 'crack'
  }
  xbox?: {
    xuid: string
    gamertag: string
    ageGroup: string
  }
  /** Kintare-only: `true` when the account has no Minecraft profile selected yet. */
  noProfile?: boolean
  /** Kintare-only: the display name resolved from the OIDC token claims (preferred_username/name/email). */
  displayName?: string
}

export interface MultipleProfiles {
  needsProfileSelection: true
  accessToken: string
  clientToken: string
  refreshToken?: string
  userProperties?: any
  url: string
  availableProfiles: { id: string; name: string }[]
}
