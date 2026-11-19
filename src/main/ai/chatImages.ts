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
