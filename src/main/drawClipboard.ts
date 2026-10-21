// PlexiiDraw's system clipboard, in the main process.
//
// Copy writes ONE atomic clipboard entry (Electron 44's clipboard.write takes
// W3C-style ClipboardItems and commits every type in a call together; separate
// writes would each replace the last) holding:
//
//   - PlexiiDraw's native JSON as a web custom format. Chromium registers it
//     per platform, so another PlexiiDraw window -- or the browser build, via
//     navigator.clipboard -- reads it back exactly;
//   - the SVG markup as text/plain (Figma, code editors, chat) and under the
//     platform's SVG flavour (public.svg-image on macOS, the registered
//     "image/svg+xml" format elsewhere), so vector apps get vectors. Writing
//     the plain 'image/svg+xml' type does NOT do that on macOS: Chromium files
//     it as text only (verified on Electron 44.7.2);
//   - a PNG picture for Office, Keynote, Slack and the like. On macOS it goes in
//     as raw public.png so the bytes are kept as written -- 'image/png' is
//     re-encoded, which drops the pHYs chunk -- and the pHYs chunk declares the
//     2x picture's real size (144 dpi = 72 pt per point), so it pastes at the
//     art's size and stays sharp on a Retina screen. Elsewhere the 2x picture
//     is scaled to 1x, as no resolution survives Chromium's re-encode.
//
// Paste reads the same flavours back. One trap, found by measurement:
// ClipboardItem.getType('image/svg+xml') never settles on macOS (the main
// process is left waiting), so SVG is read through its raw OS flavour, never
// through that MIME type.

import { clipboard, ClipboardItem, nativeImage } from 'electron'
import { pngWithDpi } from './drawExport'

/** The native PlexiiDraw format: a web custom format, so the browser build can read it too. */
export const DRAW_CLIPBOARD_NATIVE = 'web application/vnd.plexii.draw+json'

/** Raw (OS-level) clipboard flavour name for SVG on this platform. */
export function svgFlavour(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'public.svg-image' : 'image/svg+xml'
}

const raw = (flavour: string): string => `electron application/osclipboard;format="${flavour}"`

/** A raw type in a read item's list that carries SVG, whatever the platform calls it. */
export function svgTypeIn(types: string[]): string | undefined {
  return types.find((t) => /^electron application\/osclipboard;format="(public\.svg-image|image\/svg\+xml|CorePasteboardFlavorType 0x73766720)"$/i.test(t))
}

/** A raw type carrying JPEG bytes, so a pasted photo keeps its own (smaller) encoding. */
export function jpegTypeIn(types: string[]): string | undefined {
  return types.find((t) => /^electron application\/osclipboard;format="(public\.jpeg|image\/jpeg|JFIF|CorePasteboardFlavorType 0x4A504547)"$/i.test(t))
}

/** Upper bounds on what one paste will carry across IPC. */
export const CLIPBOARD_LIMITS = { native: 64 * 1024 * 1024, svg: 32 * 1024 * 1024, text: 4 * 1024 * 1024, image: 48 * 1024 * 1024 }

export interface DrawClipboardWriteInput {
  json: string
  svg: string
  png?: string
  pngScale: number
}

export interface DrawClipboardReadResult {
  native?: string
  svg?: string
  image?: { dataUrl: string; w: number; h: number }
  text?: string
  error?: string
}

function pngBytes(dataUrl: string | undefined): Buffer | null {
  if (typeof dataUrl !== 'string') return null
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!m) return null
  const buf = Buffer.from(m[1], 'base64')
  return buf.length > 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? buf : null
}

/** The clipboard entry for a copy, as plain data (exported so it can be checked without a clipboard). */
export function clipboardEntry(input: DrawClipboardWriteInput, platform: NodeJS.Platform = process.platform): Record<string, string | Blob> {
  const entry: Record<string, string | Blob> = {
    [DRAW_CLIPBOARD_NATIVE]: new Blob([input.json], { type: 'application/json' }),
    'text/plain': input.svg,
    [raw(svgFlavour(platform))]: new Blob([input.svg], { type: 'image/svg+xml' })
  }
  const png = pngBytes(input.png)
  const scale = typeof input.pngScale === 'number' && input.pngScale >= 1 && input.pngScale <= 8 ? input.pngScale : 1
  if (png) {
    if (platform === 'darwin') entry[raw('public.png')] = new Blob([new Uint8Array(pngWithDpi(png, 72 * scale))], { type: 'image/png' })
    else {
      let img = nativeImage.createFromBuffer(png)
      if (!img.isEmpty() && scale !== 1) {
        const { width, height } = img.getSize()
        img = img.resize({ width: Math.max(1, Math.round(width / scale)), height: Math.max(1, Math.round(height / scale)), quality: 'best' })
      }
      if (!img.isEmpty()) entry['image/png'] = new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' })
    }
  }
  return entry
}

export async function writeDrawClipboard(input: DrawClipboardWriteInput): Promise<{ ok: boolean; error?: string }> {
  if (!input || typeof input.json !== 'string' || typeof input.svg !== 'string') return { ok: false, error: 'Nothing to copy.' }
  try {
    await clipboard.write([new ClipboardItem(clipboardEntry(input))])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** One flavour's bytes; null when it is too big or the platform will not hand it over (the others may still be fine). */
async function readType(item: Electron.ClipboardItem, type: string, limit: number): Promise<Buffer | null> {
  try {
    const b = (await item.getType(type)) as Blob
    if (!b || b.size > limit) return null
    return Buffer.from(await b.arrayBuffer())
  } catch {
    return null
  }
}

export async function readDrawClipboard(): Promise<DrawClipboardReadResult> {
  try {
    const out: DrawClipboardReadResult = {}
    for (const item of await clipboard.read()) {
      const types = item.types
      if (out.native === undefined && types.includes(DRAW_CLIPBOARD_NATIVE)) {
        const b = await readType(item, DRAW_CLIPBOARD_NATIVE, CLIPBOARD_LIMITS.native)
        if (b) out.native = b.toString('utf8')
      }
      const svgType = svgTypeIn(types)
      if (out.svg === undefined && svgType) {
        const b = await readType(item, svgType, CLIPBOARD_LIMITS.svg)
        if (b) out.svg = b.toString('utf8')
      }
      if (out.text === undefined && types.includes('text/plain')) {
        const b = await readType(item, 'text/plain', CLIPBOARD_LIMITS.text)
        if (b) out.text = b.toString('utf8')
      }
      if (out.image === undefined) {
        const jpeg = jpegTypeIn(types)
        const [type, mime] = jpeg ? [jpeg, 'image/jpeg'] : types.includes('image/png') ? ['image/png', 'image/png'] : [undefined, undefined]
        if (type && mime) {
          const b = await readType(item, type, CLIPBOARD_LIMITS.image)
          const img = b ? nativeImage.createFromBuffer(b) : null
          if (b && img && !img.isEmpty()) {
            const { width, height } = img.getSize()
            out.image = { dataUrl: `data:${mime};base64,${b.toString('base64')}`, w: width, h: height }
          }
        }
      }
    }
    return out
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
