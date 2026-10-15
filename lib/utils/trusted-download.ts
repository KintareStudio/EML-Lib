/** Credentials are bound to the configured deployment, never to URLs from its manifest. */
export function adminToolDownloadUrl(value: string, adminToolUrl?: string): boolean {
  return adminToolRoute(value, adminToolUrl, '/files/files-updater/')
}

export function adminToolMetadataUrl(value: string, adminToolUrl?: string): boolean {
  return adminToolRoute(value, adminToolUrl, '/api/files-updater/')
}

function adminToolRoute(value: string, adminToolUrl: string | undefined, route: string): boolean {
  if (!adminToolUrl) return false
  try {
    const base = new URL(adminToolUrl),
      target = new URL(value)
    if (
      !['https:', 'http:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      target.username ||
      target.password ||
      target.hash
    )
      return false
    const prefix = `${base.pathname.replace(/\/$/, '')}${route}`
    if (/%(?:2f|5c|2e|25)/i.test(target.pathname)) return false
    return target.origin === base.origin && target.pathname.startsWith(prefix)
  } catch {
    return false
  }
}
