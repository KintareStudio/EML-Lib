import { HttpClient } from '../http/http.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'

export interface GitHubReleaseOptions {
  repository: string
  assetName?: string
  assetPattern?: RegExp
}
export interface GitHubReleaseAsset {
  id: number
  tag: string
  name: string
  url: string
  size: number
  sha256?: string
}
export interface GitHubReleaseCache {
  repository: string
  selector: string
  etag?: string
  asset: GitHubReleaseAsset
  localSha256: string
}

export function releaseSelector(options: GitHubReleaseOptions): string {
  return options.assetName ? `name:${options.assetName}` : `pattern:${String(options.assetPattern ?? /\.jar$/i)}`
}

export async function latestReleaseAsset(
  http: HttpClient,
  options: GitHubReleaseOptions,
  cached?: GitHubReleaseCache
): Promise<{ asset: GitHubReleaseAsset; etag?: string } | null> {
  const parts = options.repository.split('/')
  if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..'))
    throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid GitHub repository.')
  const response = await http.fetch(`https://api.github.com/repos/${options.repository}/releases/latest`, {
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Kintare-EML',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(cached?.etag ? { 'If-None-Match': cached.etag } : {})
    }
  })
  if (response.status === 304 && cached) return null
  if (!response.ok)
    throw new EMLLibError(
      response.status === 429 || response.status === 403 ? ErrorType.TOO_MANY_REQUESTS : ErrorType.FETCH_ERROR,
      `GitHub release unavailable: HTTP ${response.status}`,
      { status: response.status }
    )
  const release = await response.json()
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !Array.isArray(release.assets))
    throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid stable GitHub release.')
  const matches = release.assets.filter((asset: { name?: unknown; state?: string }) => {
    if (typeof asset.name !== 'string' || (asset.state && asset.state !== 'uploaded')) return false
    if (options.assetName) return asset.name === options.assetName
    const pattern = options.assetPattern ?? /\.jar$/i
    pattern.lastIndex = 0
    return pattern.test(asset.name)
  })
  if (matches.length !== 1) throw new EMLLibError(ErrorType.FETCH_ERROR, 'The release must contain exactly one matching auth-agent JAR.')
  const asset = matches[0]
  const url = new URL(asset.browser_download_url)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(`/${options.repository}/releases/download/`)
  )
    throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid GitHub release asset URL.')
  if (!Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size < 4 || asset.size > 64 * 1024 * 1024)
    throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid GitHub release asset metadata.')
  const digest = typeof asset.digest === 'string' ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest) : null
  if (asset.digest && !digest) throw new EMLLibError(ErrorType.FETCH_ERROR, 'Unsupported GitHub release asset digest.')
  return {
    asset: {
      id: asset.id,
      tag: release.tag_name,
      name: asset.name,
      url: url.href,
      size: asset.size,
      sha256: digest?.[1].toLowerCase()
    },
    etag: response.headers.get('etag') ?? undefined
  }
}

/** Electron net.fetch cancels manual redirects. Follow credential-free asset downloads, then validate the final CDN and digest. */
export async function fetchReleaseAsset(http: HttpClient, initialUrl: string): Promise<Response> {
  const allowed = (value: string) => {
    const target = new URL(value)
    return (
      target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)
    )
  }
  if (!allowed(initialUrl)) throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid GitHub asset URL.')
  const response = await http.fetch(initialUrl, {
    redirect: 'follow',
    headers: { Accept: 'application/octet-stream' }
  })
  // The asset request carries neither Kintare credentials nor a GitHub token.
  if (!allowed(response.url || initialUrl)) {
    await response.body?.cancel()
    throw new EMLLibError(ErrorType.FETCH_ERROR, 'Unexpected GitHub asset redirect.')
  }
  return response
}
