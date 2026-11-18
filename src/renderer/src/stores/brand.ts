import { create } from 'zustand'
import { DEFAULT_BRAND_KIT, type OrgBrandKit } from '@shared/brandKit'

// The organization Brand Kit, read by every surface that wants to present on
// brand (PlexiDesign today; Docs/Sheets/Slides/Projects as they adopt it). Until
// a brand is saved the store holds the default brand, exactly like a fresh Canva
// account, so callers always have a usable kit.

interface BrandState {
  kit: OrgBrandKit
  isSet: boolean
  loaded: boolean
  load: () => Promise<void>
  save: (kit: OrgBrandKit) => Promise<void>
}

/**
 * A reply brand.get can be trusted with: { kit, isSet } where the kit has the
 * three fields every reader relies on. PlexiiDesign reads kit.fontHeading on its
 * first render, so a kit of undefined is a crash rather than a missing colour.
 */
function wellFormed(r: unknown): r is { kit: OrgBrandKit; isSet: boolean } {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  const kit = (r as { kit?: unknown }).kit
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) return false
  const k = kit as Record<string, unknown>
  return typeof k.colorPrimary === 'string' && typeof k.fontHeading === 'string' && typeof k.fontBody === 'string'
}

export const useBrandStore = create<BrandState>((set) => ({
  kit: DEFAULT_BRAND_KIT,
  isSet: false,
  loaded: false,
  load: async () => {
    let r: unknown
    try {
      r = await window.api.brand.get()
    } catch (e) {
      // Keep the kit already held (the default until one has loaded).
      console.warn('[brand] brand.get failed; keeping the current brand kit', e)
      set({ loaded: true })
      return
    }
    if (!wellFormed(r)) {
      // A malformed reply must not replace the kit with nothing: keep what the
      // store has and say what came back.
      console.warn('[brand] brand.get returned a malformed reply; keeping the current brand kit', r)
      set({ loaded: true })
      return
    }
    set({ kit: r.kit, isSet: r.isSet === true, loaded: true })
  },
  save: async (kit) => {
    const saved = await window.api.brand.set(kit)
    set({ kit: saved, isSet: true })
  }
}))
