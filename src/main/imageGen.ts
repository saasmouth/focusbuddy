// AI image generation for PlexiDesign, via OpenAI's gpt-image-1.
//
// Honest by construction: image generation only happens when the user has a real
// OpenAI key set (the same encrypted key the transcription pipeline uses). With
// no key we return needsKey:true so the editor shows an "add a key" affordance,
// never a fake or placeholder image. A real generated image comes back as a PNG
// data URI, ready to drop onto the canvas as an image element.

import { resolveOpenAIKey } from './settingsStore'
import { ingestFromBuffer } from './db/files'

export interface ImageGenResult {
  ok: boolean
  dataUrl?: string
  error?: string
  // True when the only thing missing is an API key, so the UI can prompt for one
  // rather than showing a generic failure.
  needsKey?: boolean
}

// gpt-image-1 supports a fixed set of sizes. Pick the one whose aspect ratio is
// closest to the design canvas so the generated image fills the frame well.
function pickSize(w: number, h: number): '1024x1024' | '1024x1536' | '1536x1024' {
  const ratio = w / h
  if (ratio > 1.2) return '1536x1024' // landscape
  if (ratio < 0.83) return '1024x1536' // portrait
  return '1024x1024' // square-ish
}

function shorten(s: string, n = 200): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

export async function generateImage(input: { prompt: string; width?: number; height?: number }): Promise<ImageGenResult> {
  const prompt = (input.prompt || '').trim()
  if (!prompt) return { ok: false, error: 'Describe the image you want before generating.' }

  const key = resolveOpenAIKey()
  if (!key) {
    return {
      ok: false,
      needsKey: true,
      error: 'Add your OpenAI API key in Settings → API Keys to generate images.'
    }
  }

  const size = pickSize(input.width ?? 1024, input.height ?? 1024)
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, size, n: 1 })
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      // 401 means the key is present but rejected; surface that clearly.
      if (res.status === 401) return { ok: false, needsKey: true, error: 'Your OpenAI key was rejected. Check it in Settings → API Keys.' }
      return { ok: false, error: `Image generation failed (${res.status}): ${shorten(txt)}` }
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
    const item = json.data?.[0]
    if (item?.b64_json) return { ok: true, dataUrl: `data:image/png;base64,${item.b64_json}` }
    if (item?.url) return { ok: true, dataUrl: item.url }
    return { ok: false, error: 'The image service returned no image.' }
  } catch (e) {
    return { ok: false, error: `Could not reach the image service: ${(e as Error).message}` }
  }
}

export interface ImageGenFileResult {
  ok: boolean
  fileId?: string
  originalName?: string
  error?: string
  needsKey?: boolean
}

/**
 * Generate an image and store it as a real file, returning its id.
 *
 * The design editor keeps the data-URI form because it drops the bytes straight
 * into a design document. A DESK widget must not: a 1024x1024 PNG is roughly two
 * megabytes of base64, and widget content is synced and CRDT-merged, so holding
 * images there would bloat the database and every sync payload with binary that
 * has a perfectly good home already. Storing it in the files store means the
 * widget carries a short id and renders through the existing fb-file:// pipeline,
 * exactly like any other image on a desk.
 */
export async function generateImageToFile(input: {
  prompt: string
  width?: number
  height?: number
}): Promise<ImageGenFileResult> {
  const r = await generateImage(input)
  if (!r.ok || !r.dataUrl) return { ok: false, error: r.error, needsKey: r.needsKey }

  try {
    let bytes: Buffer
    let mimeType = 'image/png'
    const m = /^data:([^;]+);base64,(.*)$/s.exec(r.dataUrl)
    if (m) {
      mimeType = m[1] || 'image/png'
      bytes = Buffer.from(m[2], 'base64')
    } else {
      // The API can answer with a URL instead of inline base64; fetch it so the
      // image is on disk and keeps working after the link expires.
      const res = await fetch(r.dataUrl)
      if (!res.ok) return { ok: false, error: `Could not download the generated image (${res.status}).` }
      mimeType = res.headers.get('content-type') ?? 'image/png'
      bytes = Buffer.from(await res.arrayBuffer())
    }
    if (bytes.length === 0) return { ok: false, error: 'The image service returned an empty image.' }

    // A readable name, since this file shows up in Files like any other.
    const slug =
      input.prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'generated-image'
    const ext = mimeType.includes('jpeg') ? '.jpg' : mimeType.includes('webp') ? '.webp' : '.png'
    const file = await ingestFromBuffer({
      buffer: bytes,
      originalName: `${slug}${ext}`,
      mimeType
    })
    return { ok: true, fileId: file.id, originalName: file.originalName }
  } catch (e) {
    return { ok: false, error: `Could not save the generated image: ${(e as Error).message}` }
  }
}
