// The system clipboard as our apps see it, read in the main process for ⌘V
// and right-click › Paste across PlexiiWrite, Cells, Deck, Design, Diagrams
// and Draw (renderer/src/lib/clipboardForms.ts turns this into conversion
// forms).
//
// Everything PlexiiDraw's own paste reads comes from readDrawClipboard, so the
// two never disagree: Draw's native JSON, SVG through its RAW OS flavour (never
// getType('image/svg+xml'), which never settles on macOS and leaves the main
// process waiting), PNG/JPEG bytes, text, and files copied in Finder.
//
// On top of that, two things only a cross-app paste needs:
//   - HTML (a web page, Pages, Word), for PlexiiWrite and tables;
//   - Chromium's "web custom data": the private types PlexiiDeck/Design
//     (application/x-plexii-elements) and PlexiiDiagrams
//     (application/x-plexii-diagram) set on a DataTransfer in their copy
//     events. Chromium stores them as one pickled blob under a raw OS flavour
//     (org.chromium.web-custom-data on macOS, measured on Electron 44), which
//     Electron's clipboard.read() lists like any other raw type. Only our own
//     types (application/x-plexii-*) are handed back; anything another site
//     wrote there is not ours to read.

import { clipboard } from 'electron'
import { CLIPBOARD_LIMITS, readDrawClipboard } from './drawClipboard'
import type { AppClipboardRead } from '../shared/appClipboard'

export type { AppClipboardRead }

/** The raw flavour Chromium keeps a DataTransfer's custom types under, on every platform. */
export function webCustomDataTypeIn(types: string[]): string | undefined {
  return types.find((t) =>
    /^electron application\/osclipboard;format="(org\.chromium\.web-custom-data|Chromium Web Custom MIME Data Format|chromium\/x-web-custom-data)"$/i.test(t)
  )
}

/**
 * Parse Chromium's pickled custom data: a base::Pickle whose payload is a
 * uint32 count, then that many (type, data) pairs, each a String16 (uint32
 * length in UTF-16 code units, the units little-endian, padded to 4 bytes).
 * Pure, bounds-checked at every read: a short or corrupt blob gives what was
 * read cleanly before the fault, never a throw.
 */
export function parseWebCustomData(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.byteLength < 8) return out
  const payload = view.getUint32(0, true)
  const end = Math.min(buf.byteLength, 4 + payload)
  let at = 4
  const u32 = (): number | null => {
    if (at + 4 > end) return null
    const v = view.getUint32(at, true)
    at += 4
    return v
  }
  const str16 = (): string | null => {
    const n = u32()
    if (n === null || n > (end - at) / 2) return null
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(view.getUint16(at + i * 2, true))
    at += (n * 2 + 3) & ~3
    return s
  }
  const count = u32()
  if (count === null) return out
  for (let i = 0; i < count; i++) {
    const type = str16()
    if (type === null) break
    const data = str16()
    if (data === null) break
    out[type] = data
  }
  return out
}

/** Only our own private types leave this module. */
export function ourCustomTypes(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(all)) if (/^application\/x-plexii-[a-z0-9.+-]+$/i.test(k)) out[k] = v
  return out
}

/** One flavour's bytes; null when it is too big or the platform will not hand it over. */
async function readType(item: Electron.ClipboardItem, type: string, limit: number): Promise<Buffer | null> {
  try {
    const b = (await item.getType(type)) as Blob
    if (!b || b.size > limit) return null
    return Buffer.from(await b.arrayBuffer())
  } catch {
    return null
  }
}

const IMAGE_FILE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

export async function readAppClipboard(): Promise<AppClipboardRead> {
  const out: AppClipboardRead = {}
  const draw = await readDrawClipboard()
  if (draw.error) return { error: draw.error }
  if (draw.native !== undefined) out.drawNative = draw.native
  if (draw.svg !== undefined) out.svg = draw.svg
  if (draw.image) out.image = draw.image
  if (draw.text !== undefined) out.text = draw.text
  // A picture copied in Finder pastes as that picture (its name and icon on
  // the clipboard are not what copying a file meant). Other files are not
  // content any of the office apps can paste, so they give nothing.
  for (const f of draw.files ?? []) {
    const ext = f.name.toLowerCase().split('.').pop() ?? ''
    if (ext === 'svg' && out.svg === undefined && f.bytes.byteLength <= CLIPBOARD_LIMITS.svg) out.svg = Buffer.from(f.bytes).toString('utf8')
    else if (IMAGE_FILE[ext] && !out.image && f.bytes.byteLength <= CLIPBOARD_LIMITS.image) {
      out.image = { dataUrl: `data:${IMAGE_FILE[ext]};base64,${Buffer.from(f.bytes).toString('base64')}`, w: 0, h: 0 }
    }
  }
  if (draw.files?.length) return out
  try {
    for (const item of await clipboard.read()) {
      const types = item.types
      if (out.html === undefined && types.includes('text/html')) {
        const b = await readType(item, 'text/html', CLIPBOARD_LIMITS.text)
        if (b) out.html = b.toString('utf8')
      }
      const custom = webCustomDataTypeIn(types)
      if (custom && out.custom === undefined) {
        const b = await readType(item, custom, CLIPBOARD_LIMITS.native)
        if (b) {
          const ours = ourCustomTypes(parseWebCustomData(b))
          if (Object.keys(ours).length) out.custom = ours
        }
      }
    }
  } catch (err) {
    // What Draw's reader found still stands; say what could not be read.
    out.error = err instanceof Error ? err.message : String(err)
  }
  return out
}
