// Pictures attached in the assistant's composer, as model input.
//
// They go on the LAST user message, as image blocks before its text (the order
// Anthropic recommends: the picture, then the question about it). The same
// Anthropic-shaped request reaches every cloud source: an Anthropic key and
// Plexii credits send it as is; an OpenAI key's client turns image blocks into
// image_url parts (local/openaiClient.ts). Local cannot read pictures and
// refuses the request (LocalUnsupportedError('images')), which the router turns
// into the existing "Use cloud AI for this request?" prompt, or an error that
// says nothing was sent. Nothing here drops a picture without saying so: a
// picture that is not acceptable is refused by name.
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatImage } from '../../shared/types'

export const CHAT_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Anthropic's per-image limit is 5 MB; the composer scales pictures well under it. */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
/** More pictures than this in one message are refused, not trimmed. */
export const MAX_CHAT_IMAGES = 5

export class ChatImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatImageError'
  }
}

const decodedBytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

/** The pictures as image blocks; throws ChatImageError naming the first one that cannot go. */
export function imageBlocks(images: readonly ChatImage[] | undefined): Anthropic.ImageBlockParam[] {
  if (!images?.length) return []
  if (images.length > MAX_CHAT_IMAGES) throw new ChatImageError(`At most ${MAX_CHAT_IMAGES} pictures can go with one message; this one has ${images.length}.`)
  return images.map((img, i) => {
    const name = img.name ? `“${img.name}”` : `Picture ${i + 1}`
    if (!img || typeof img.data !== 'string' || !CHAT_IMAGE_TYPES.has(img.mediaType)) throw new ChatImageError(`${name} is not a picture the assistant can read (PNG, JPEG, GIF or WebP).`)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) throw new ChatImageError(`${name} could not be read.`)
    if (decodedBytes(img.data) > MAX_CHAT_IMAGE_BYTES) throw new ChatImageError(`${name} is larger than 5 MB.`)
    return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }
  })
}

/** The messages with the pictures on the last user message, before its text. Unchanged when there are none. */
export function withImagesOnLastUser(msgs: Anthropic.MessageParam[], blocks: Anthropic.ImageBlockParam[]): Anthropic.MessageParam[] {
  if (!blocks.length) return msgs
  let last = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      last = i
      break
    }
  }
  if (last < 0) return msgs
  const m = msgs[last]
  const text: Exclude<Anthropic.MessageParam['content'], string> =
    typeof m.content === 'string' ? (m.content ? [{ type: 'text', text: m.content }] : []) : [...m.content]
  const out = [...msgs]
  out[last] = { role: 'user', content: [...blocks, ...text] }
  return out
}

// ── What a picture costs ────────────────────────────────────────────────────
//
// Anthropic reads a picture in 28×28-pixel patches: ⌈w/28⌉ × ⌈h/28⌉ tokens,
// after shrinking it to the model's limit. Claude 4.7 and later read at high
// resolution (long edge up to 2,576 px, up to 4,784 tokens a picture); older
// models stop at a 1,568 px edge and 1,568 tokens (Anthropic's Vision docs,
// "Resolution and token cost"). The ceiling per model is the signal server's
// aiGate.imageTokenCeiling, the same rule, so the app and the server price a
// picture alike.

export const HIGH_RES_IMAGE_TOKENS = 4784
export const STANDARD_IMAGE_TOKENS = 1568
const HIGH_RES_EDGE = 2576
const STANDARD_EDGE = 1568

/** Whether this model reads pictures at high resolution: Claude 4.7 and later, and any model it cannot place. */
function highResModel(model: string): boolean {
  const m = /^claude-(?:haiku|sonnet|opus)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model)
  if (!m) return true
  const major = Number(m[1])
  const minor = m[2] === undefined ? 0 : Number(m[2])
  return major > 4 || (major === 4 && minor >= 7)
}

/** The most tokens one picture can cost on this model (signal aiGate.imageTokenCeiling). */
export function imageTokenCeiling(model: string): number {
  return highResModel(model) ? HIGH_RES_IMAGE_TOKENS : STANDARD_IMAGE_TOKENS
}

/** A picture's tokens on this model, from its size in pixels. */
export function imageTokens(width: number, height: number, model: string): number {
  const ceiling = imageTokenCeiling(model)
  if (!(width > 0 && height > 0)) return ceiling
  const scale = Math.min(1, (highResModel(model) ? HIGH_RES_EDGE : STANDARD_EDGE) / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  return Math.min(ceiling, Math.ceil(w / 28) * Math.ceil(h / 28))
}

/** A picture's size in pixels, read from its header (PNG, JPEG, GIF, WebP); null when it cannot be read. */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes
  const u16be = (i: number): number => (b[i] << 8) | b[i + 1]
  const u16le = (i: number): number => b[i] | (b[i + 1] << 8)
  const u24le = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const u32be = (i: number): number => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
  const ascii = (i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n))
  const ok = (s: { width: number; height: number }): { width: number; height: number } | null => (s.width > 0 && s.height > 0 ? s : null)
  // PNG: IHDR is the first chunk.
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return ok({ width: u32be(16), height: u32be(20) })
  // GIF: the logical screen.
  if (b.length >= 10 && ascii(0, 3) === 'GIF') return ok({ width: u16le(6), height: u16le(8) })
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4)
    if (kind === 'VP8 ') return ok({ width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff })
    if (kind === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return ok({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 })
    }
    if (kind === 'VP8X') return ok({ width: u24le(24) + 1, height: u24le(27) + 1 })
    return null
  }
  // JPEG: the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      if (marker === 0xff) {
        i++
        continue
      }
      const len = u16be(i + 2)
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (sof) return ok({ width: u16be(i + 7), height: u16be(i + 5) })
      i += 2 + len
    }
  }
  return null
}

/** The first bytes of a base64 string, enough for any header pictureSize reads. */
function headBytes(b64: string, n = 64 * 1024): Uint8Array {
  const take = b64.slice(0, Math.ceil(n / 3) * 4)
  return new Uint8Array(Buffer.from(take, 'base64'))
}

/**
 * The tokens every picture in a request will cost on its model: each `image`
 * block, wherever it sits, at its size in pixels, or at the model's ceiling
 * when its size cannot be read (a picture the model could not read either).
 */
export function requestImageTokens(body: Record<string, unknown>): number {
  const model = typeof body.model === 'string' ? body.model : ''
  let tokens = 0
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (!v || typeof v !== 'object') return
    const o = v as { type?: unknown; source?: { type?: unknown; data?: unknown } }
    if (o.type === 'image') {
      const data = o.source?.type === 'base64' && typeof o.source.data === 'string' ? o.source.data : null
      // JPEG markers can sit past the first bytes (EXIF); read the whole picture then.
      const size = data ? (pictureSize(headBytes(data)) ?? pictureSize(new Uint8Array(Buffer.from(data, 'base64')))) : null
      tokens += size ? imageTokens(size.width, size.height, model) : imageTokenCeiling(model)
      return
    }
    for (const x of Object.values(v)) visit(x)
  }
  visit(body.system)
  visit(body.messages)
  return tokens
}
