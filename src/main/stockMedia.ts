// Stock media + background removal for PlexiDesign.
//
// Honest by construction, like the AI image path: stock search and background
// removal only work when the user has the relevant provider key (a free Pexels
// key for photos, a remove.bg key for cutouts). Without a key we return
// needsKey:true so the studio shows an "add a key" affordance, never fabricated
// results. Inserted photos are fetched to a data URL so the design stays
// self-contained (works offline and in export).

import { resolvePexelsKey, resolveRemoveBgKey } from './settingsStore'
import { askCloudForNonLocalFeature, withCloudGrant } from './ai/local/providerRouter'

export interface StockPhoto {
  id: string
  thumb: string
  full: string
  alt: string
  photographer: string
}
export interface StockSearchResult {
  ok: boolean
  photos?: StockPhoto[]
  error?: string
  needsKey?: boolean
}

export async function searchStockPhotos(input: { query: string; perPage?: number }): Promise<StockSearchResult> {
  const q = (input.query || '').trim()
  if (!q) return { ok: false, error: 'Type something to search for.' }
  const key = resolvePexelsKey()
  if (!key) return { ok: false, needsKey: true, error: 'Add a free Pexels API key in Settings → AI · API keys to search stock photos.' }
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${Math.min(input.perPage ?? 24, 80)}`, {
      headers: { Authorization: key }
    })
    if (!res.ok) {
      if (res.status === 401) return { ok: false, needsKey: true, error: 'Your Pexels key was rejected. Check it in Settings → AI · API keys.' }
      return { ok: false, error: `Stock search failed (${res.status}).` }
    }
    const json = (await res.json()) as { photos?: Array<Record<string, unknown>> }
    const photos: StockPhoto[] = (json.photos ?? []).map((p) => {
      const src = (p.src ?? {}) as Record<string, string>
      return {
        id: String(p.id ?? ''),
        thumb: src.medium || src.small || src.tiny || '',
        full: src.large2x || src.large || src.original || src.medium || '',
        alt: typeof p.alt === 'string' ? p.alt : '',
        photographer: typeof p.photographer === 'string' ? p.photographer : ''
      }
    })
    return { ok: true, photos }
  } catch (e) {
    return { ok: false, error: `Could not reach the stock service: ${(e as Error).message}` }
  }
}

// Download a remote image and return it as a data URL, so an inserted stock photo
// is embedded in the design rather than a fragile remote link.
export async function fetchImageDataUrl(input: { url: string }): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  try {
    const res = await fetch(input.url)
    if (!res.ok) return { ok: false, error: `Could not download the image (${res.status}).` }
    const buf = Buffer.from(await res.arrayBuffer())
    const mime = res.headers.get('content-type') || 'image/jpeg'
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function removeBackground(input: { dataUrl: string }): Promise<{ ok: boolean; dataUrl?: string; error?: string; needsKey?: boolean }> {
  const key = resolveRemoveBgKey()
  if (!key) return { ok: false, needsKey: true, error: 'Add a remove.bg API key in Settings → AI · API keys to remove image backgrounds.' }
  const b64 = input.dataUrl.replace(/^data:[^;]+;base64,/, '')
  if (!b64 || b64 === input.dataUrl) return { ok: false, error: 'Background removal needs an embedded image (insert it first).' }
  // AI set to run on this device: there is no on-device background remover, so
  // the image goes to remove.bg only if the person agrees, for this one request.
  const route = await askCloudForNonLocalFeature('media', 'remove.bg', true)
  if (route === 'declined') {
    return {
      ok: false,
      error: 'Background removal has no on-device model, and AI is set to run on this device, so the image was not sent to remove.bg.'
    }
  }
  try {
    const body = new URLSearchParams({ image_file_b64: b64, size: 'auto' })
    const send = (): Promise<Response> =>
      fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      })
    const res = route === 'allowed' ? await withCloudGrant({ reason: 'consent', feature: 'media' }, send) : await send()
    if (!res.ok) {
      if (res.status === 403) return { ok: false, needsKey: true, error: 'Your remove.bg key was rejected or is out of credits.' }
      const t = await res.text().catch(() => '')
      return { ok: false, error: `Background removal failed (${res.status}). ${t.slice(0, 120)}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, dataUrl: `data:image/png;base64,${buf.toString('base64')}` }
  } catch (e) {
    return { ok: false, error: `Could not reach the background remover: ${(e as Error).message}` }
  }
}
