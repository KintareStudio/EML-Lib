import type { Account } from '../../types/account.js'
import type { WardrobeData, WardrobeSlot, WardrobeSlotInput, WardrobeTexture } from '../../types/wardrobe.js'
import { EMLLibError, ErrorType } from '../../types/errors.js'
import { HttpClient } from '../http/http.js'
import { kintareEndpoints, KintareOptions, KintareEndpointResolver } from './endpoints.js'

export class WardrobeRequestError extends EMLLibError {
  constructor(message: string, status: number) {
    super(status >= 500 || status === 408 ? ErrorType.FETCH_ERROR : status === 429 ? ErrorType.TOO_MANY_REQUESTS : ErrorType.AUTH_ERROR, message, {
      status
    })
  }
}

export class KintareWardrobes {
  private readonly http: HttpClient
  private readonly endpoints: ReturnType<typeof kintareEndpoints>
  constructor(options: KintareOptions = {}, endpoints?: KintareEndpointResolver) {
    this.http = new HttpClient({ timeoutMs: 20_000, ...options })
    this.endpoints = endpoints ?? kintareEndpoints(options)
  }
  async request<T>(account: Account, profileId: string, suffix = '', method = 'GET', body?: object | FormData): Promise<T> {
    if (!/^[a-f0-9]{32}$/.test(profileId) || !/^\/(?:[a-zA-Z0-9/-]*)$/.test(suffix || '/'))
      throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid wardrobe request')
    const form = body instanceof FormData
    const response = await this.http.fetch(await this.endpoints.servicesUrl(`/minecraft/kintare/profiles/${profileId}/wardrobes${suffix}`), {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        ...(body && !form ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: form ? (body as FormData) : JSON.stringify(body) } : {})
    })
    if (response.status === 204 && response.ok) return undefined as T
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new WardrobeRequestError(data?.errorMessage || data?.message || `Wardrobe: HTTP ${response.status}`, response.status)
    if (!data)
      throw new EMLLibError(ErrorType.FETCH_ERROR, 'Invalid wardrobe response', {
        status: response.status
      })
    return data as T
  }
  get(account: Account, profileId: string): Promise<WardrobeData> {
    return this.request(account, profileId)
  }
  save(account: Account, profileId: string, input: WardrobeSlotInput, slotId?: string): Promise<WardrobeSlot> {
    if (slotId) this.slotId(slotId)
    return this.request(account, profileId, slotId ? `/${slotId}` : '', slotId ? 'PUT' : 'POST', input)
  }
  delete(account: Account, profileId: string, slotId: string): Promise<void> {
    this.slotId(slotId)
    return this.request(account, profileId, `/${slotId}`, 'DELETE')
  }
  duplicate(account: Account, profileId: string, slotId: string): Promise<WardrobeSlot> {
    this.slotId(slotId)
    return this.request(account, profileId, `/${slotId}/duplicate`, 'POST')
  }
  activate(account: Account, profileId: string, slotId: string): Promise<void> {
    this.slotId(slotId)
    return this.request(account, profileId, `/${slotId}/activate`, 'POST')
  }
  upload(account: Account, profileId: string, type: 'skin' | 'cape', file: Uint8Array, name = `${type}.png`): Promise<WardrobeTexture> {
    validateTexture(file, type)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(file)], { type: 'image/png' }), name)
    return this.request(account, profileId, `/textures/${type}`, 'POST', form)
  }
  private slotId(id: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid wardrobe slot')
  }
}

/** Cheap preflight validation; the server remains responsible for fully decoding the image. */
export function validateTexture(file: Uint8Array, type: 'skin' | 'cape'): { width: number; height: number } {
  if (type !== 'skin' && type !== 'cape') throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid texture type')
  if (file.byteLength > 5 * 1024 * 1024) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'PNG exceeds 5 MB')
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (file.byteLength < 33 || signature.some((byte, i) => file[i] !== byte)) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid PNG image')
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  if (view.getUint32(8) !== 13 || String.fromCharCode(...file.subarray(12, 16)) !== 'IHDR')
    throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid PNG image')
  const width = view.getUint32(16),
    height = view.getUint32(20)
  if (!width || !height || width > 4096 || height > 4096) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Invalid PNG dimensions')
  if (type === 'cape' && (width !== 64 || height !== 32)) throw new EMLLibError(ErrorType.CONFIG_ERROR, 'Cape PNG must be 64x32')
  return { width, height }
}
