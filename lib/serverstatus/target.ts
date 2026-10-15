export type ServerTarget = {
  instanceKey: string
  host: string
  port: number
  protocol: 'modern' | '1.6' | '1.4-1.5' | 'beta1.8-1.3'
}
export type MinecraftServerStatus = {
  ping: number
  version: string
  motd: string
  players: { online: number; max: number }
}
export type ServerStatusReply = { target: ServerTarget; status: MinecraftServerStatus | null }

/** Empty/invalid configuration is not a server to probe. Supports host:port and IPv6. */
export function serverTarget(instance: Record<string, unknown> | null): ServerTarget | null {
  if (!instance) return null
  const address = [instance.ip, instance.server, instance.address, instance.host].find((value) => typeof value === 'string' && value.trim())
  if (typeof address !== 'string') return null
  let host = address.trim()
  let port: unknown = instance.port ?? instance.server_port ?? 25565
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host)
  const named = /^([^:]+):(\d+)$/.exec(host)
  if (bracketed) {
    host = bracketed[1]
    if (bracketed[2]) port = bracketed[2]
  } else if (named) {
    host = named[1]
    port = named[2]
  }
  if (/[\s/\\?#@]/.test(host) || !host || (host.includes(':') && !/^[\da-f:.]+$/i.test(host))) return null
  const number = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 65535) return null
  const protocols = ['modern', '1.6', '1.4-1.5', 'beta1.8-1.3'] as const
  const protocol = protocols.find((value) => value === instance.tcpProtocol) ?? 'modern'
  return { instanceKey: String(instance.slug ?? instance.id ?? ''), host, port: number, protocol }
}
export const sameServerTarget = (a: ServerTarget | null, b: ServerTarget | null) =>
  a?.instanceKey === b?.instanceKey && a?.host === b?.host && a?.port === b?.port && a?.protocol === b?.protocol
