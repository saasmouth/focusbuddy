// Files and pictures attached in the assistant's composer (pasted, or dropped on
// it): what each becomes before it is sent.
//
//   - A picture (PNG, JPEG, GIF, WebP, and anything else the browser can draw,
//     such as HEIC) is scaled so its long edge is at most 1568 px (the size the
//     model reads without scaling it again) and sent as an image block
//     (ChatRequest.images, main/ai/chatImages.ts). A JPEG stays JPEG; anything
//     else becomes PNG.
//   - A document (PDF, Word, a spreadsheet, text, Markdown, CSV, JSON, HTML) is
//     kept in Files, as every dropped file is, and its TEXT goes with the message
//     through the attachments path (Files' own extraction, PDF OCR included).
//     Its text is what every source can read, OpenAI and Local too.
//   - Anything else is refused by name, never dropped in silence.
import type { ChatAttachment, ChatImage } from '@shared/types'

export const MODEL_IMAGE_EDGE = 1568
export const MAX_COMPOSER_IMAGES = 5
export const MAX_COMPOSER_FILES = 5
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/**
 * All the pictures of one message together, as sent (base64 characters). Plexii
 * AI credits take a request of up to 16 MiB (signal AI_PROXY_BODY_LIMIT), and
 * the rest of the request needs room; past this a picture is refused in words.
 */
export const MAX_TOTAL_IMAGE_CHARS = 12 * 1024 * 1024

/** Whether one more picture fits with those already attached, by what they weigh as sent. */
export function picturesFit(current: readonly ComposerAttachment[], adding: ChatImage): boolean {
  const used = current.reduce((n, a) => n + (a.kind === 'image' && a.status === 'ready' ? a.image.data.length : 0), 0)
  return used + adding.data.length <= MAX_TOTAL_IMAGE_CHARS
}

export type AttachKind = 'image' | 'file'

export type ComposerAttachment =
  | { id: string; kind: AttachKind; name: string; status: 'reading' }
  | { id: string; kind: AttachKind; name: string; status: 'error'; error: string }
  | { id: string; kind: 'image'; name: string; status: 'ready'; image: ChatImage; thumb: string }
  | { id: string; kind: 'file'; name: string; status: 'ready'; attachment: ChatAttachment; fileId: string }

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i
const DOC_EXT = /\.(pdf|docx|xlsx|xlsm|csv|tsv|txt|md|markdown|json|html?|xml|ya?ml|log|rtf)$/i

/** What a dropped or pasted file is, for the composer. */
export function classifyFile(f: { name: string; type: string }): AttachKind | 'unsupported' {
  if (f.type.startsWith('image/') || IMAGE_EXT.test(f.name)) return 'image'
  if (DOC_EXT.test(f.name) || f.type === 'application/pdf' || f.type.startsWith('text/')) return 'file'
  return 'unsupported'
}

/** Why a file cannot be attached now, if it cannot: an unknown kind, or past the per-message limit. */
export function refusalFor(f: { name: string; type: string }, current: readonly ComposerAttachment[]): string | null {
  const kind = classifyFile(f)
  if (kind === 'unsupported') return `The assistant cannot read “${f.name}”: attach a picture, a PDF, a Word or Excel file, or text.`
  const same = current.filter((a) => a.kind === kind && a.status !== 'error').length
  if (kind === 'image' && same >= MAX_COMPOSER_IMAGES) return `At most ${MAX_COMPOSER_IMAGES} pictures can go with one message.`
  if (kind === 'file' && same >= MAX_COMPOSER_FILES) return `At most ${MAX_COMPOSER_FILES} documents can go with one message.`
  return null
}

/** The note a sent message carries in its text, so the conversation says what went with it. */
export function attachedNote(names: readonly string[]): string {
  return names.length ? `(Attached: ${names.join(', ')})` : ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality))
}

/** A picture, scaled for the model, with a small thumbnail for the tray. Throws with words when it cannot be read. */
export async function readPicture(file: File): Promise<{ image: ChatImage; thumb: string }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`“${file.name}” is not a picture Plexii can read.`)
  }
  const scale = Math.min(1, MODEL_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  let mediaType: ChatImage['mediaType'] = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  let blob = await canvasBlob(canvas, mediaType, 0.9)
  if (blob.size > MAX_IMAGE_BYTES) {
    mediaType = 'image/jpeg'
    blob = await canvasBlob(canvas, mediaType, 0.82)
  }
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(`“${file.name}” is too detailed to send (over 5 MB even scaled down).`)
  const t = document.createElement('canvas')
  const ts = Math.min(1, 96 / Math.max(bitmap.width, bitmap.height))
  t.width = Math.max(1, Math.round(bitmap.width * ts))
  t.height = Math.max(1, Math.round(bitmap.height * ts))
  t.getContext('2d')?.drawImage(bitmap, 0, 0, t.width, t.height)
  bitmap.close()
  return { image: { mediaType, data: await blobToBase64(blob), name: file.name }, thumb: t.toDataURL('image/png') }
}

interface FilesApi {
  ingestBuffer: (input: { buffer: ArrayBuffer; originalName: string; mimeType: string }) => Promise<{ id: string }>
  extractText: (id: string) => Promise<string | null>
}

/** A document: kept in Files, its text read for the message. Throws with words when there is no text. */
export async function readDocument(file: File, files: FilesApi): Promise<{ attachment: ChatAttachment; fileId: string }> {
  const stored = await files.ingestBuffer({ buffer: await file.arrayBuffer(), originalName: file.name, mimeType: file.type || 'application/octet-stream' })
  const text = (await files.extractText(stored.id))?.trim() ?? ''
  if (!text) throw new Error(`Plexii found no text it could read in “${file.name}”.`)
  return { fileId: stored.id, attachment: { widgetId: `composer-file:${stored.id}`, kind: 'file', title: file.name, source: file.name, text } }
}
