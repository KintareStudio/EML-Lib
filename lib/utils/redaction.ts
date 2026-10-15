import type { ResolvedConfig } from '../../types/config.js'

const key =
  '(?:access[_-]?token|refresh[_-]?token|client[_-]?(?:token|secret)|session[_-]?id|password|secret|token|authorization|api[_-]?key|signature|sig|credential)'
const sensitiveKey = new RegExp(`(?:[\\w-]+[._-])*${key}$`, 'i')
const assignment = new RegExp(String.raw`((?:--|-D)?(?:[\w-]+[._-])*${key}["']?\s*(?:=|:|\s)\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s"'&,;<>]+)`, 'gi')

/** Share credential masking between diagnostic events, stored logs and crash reports. */
export function redactSecrets(
  text: string,
  config?: Partial<Pick<ResolvedConfig, 'account' | 'profile' | 'java' | 'minecraft'>>,
  args: string[] = []
): string {
  const arguments_ = [...args, ...(config?.java?.args ?? []), ...(config?.minecraft?.args ?? [])]
  const secrets = [
    config?.account?.accessToken,
    config?.account?.refreshToken,
    config?.account?.clientToken,
    config?.account?.sessionId,
    config?.profile?.token
  ]
  arguments_.forEach((arg, i) => {
    if (i && sensitiveKey.test(arguments_[i - 1])) secrets.push(arg)
    const equal = arg.indexOf('=')
    if (equal > 0 && sensitiveKey.test(arg.slice(0, equal))) secrets.push(arg.slice(equal + 1))
  })
  const values = secrets.filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)
  for (const secret of values) {
    for (const value of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      text = text.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<TOKEN>')
    }
  }
  return text
    .replace(/\bBearer\s+[^\s"'&,;<>]+/gi, 'Bearer <TOKEN>')
    .replace(
      assignment,
      (_match, prefix: string, value: string) => `${prefix}${value.startsWith('"') ? '"<TOKEN>"' : value.startsWith("'") ? "'<TOKEN>'" : '<TOKEN>'}`
    )
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1<TOKEN>@')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '<JWT>')
}
