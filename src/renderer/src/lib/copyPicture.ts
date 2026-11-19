// The picture itself onto the clipboard (the Image work widget's ⌘C). Other
// apps take a PNG, so a picture stored as JPEG, WebP, GIF or SVG is drawn into
// a canvas and written as PNG.
//
// The bytes come from where the picture lives, not from fetch(): the app's
// content security policy refuses a fetch of a data: URL, which made ⌘C copy
// nothing in silence. A stored file is read through Files (window.api.files.read);
// a web address is fetched, and if the page or the policy refuses it, the
// person is told rather than left with an empty clipboard.

type FilesRead = (id: string) => Promise<{ mimeType: string; buffer: ArrayBuffer } | null>

function fromDataUrl(url: string): Blob | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (!m) return null
  const type = m[1] || 'application/octet-stream'
  if (m[2]) {
    const bin = atob(m[3])
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type })
  }
  return new Blob([decodeURIComponent(m[3])], { type })
}

/** The picture's bytes, from the widget's content (data:, fb-file://<id>, or a web address). */
export async function pictureBlob(content: string, read?: FilesRead): Promise<Blob> {
  const raw = content.trim()
  if (raw.startsWith('data:')) {
    const b = fromDataUrl(raw)
    if (b) return b
  }
  const local = /^fb-file:\/\/([\w-]+)/.exec(raw)
  const files = read ?? (globalThis as unknown as { api?: { files?: { read?: FilesRead } } }).api?.files?.read
  if (local && files) {
    const got = await files(local[1])
    if (got) return new Blob([got.buffer], { type: got.mimeType })
    throw new Error('The picture is no longer in Files, so it could not be copied.')
  }
  if (/^https?:/i.test(raw)) {
    const res = await fetch(raw).catch(() => null)
    if (res?.ok) return res.blob()
    throw new Error('That website does not let its picture be copied from here. Open it in the browser to copy it.')
  }
  throw new Error('The picture could not be read, so nothing was copied.')
}

export async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be copied.'))), 'image/png'))
}

export async function copyPicture(content: string): Promise<void> {
  const png = await asPng(await pictureBlob(content))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
