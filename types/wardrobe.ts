export type WardrobeTexture = { id: string; url: string }
export type WardrobeSlot = {
  id: string
  name: string
  skin: WardrobeTexture | null
  model: 'classic' | 'slim'
  cape: WardrobeTexture | null
  createdAt: string
  updatedAt: string
}
export type WardrobeData = {
  profile: { id: string; name: string }
  current: { skin: WardrobeTexture | null; model: 'classic' | 'slim'; cape: WardrobeTexture | null }
  slots: WardrobeSlot[]
  skins: WardrobeTexture[]
  capes: WardrobeTexture[]
}
export type WardrobeSlotInput = {
  name: string
  skinTextureId: string
  skinModel: 'classic' | 'slim'
  capeTextureId: string | null
}
