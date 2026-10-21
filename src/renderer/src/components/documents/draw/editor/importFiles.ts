// Files into PlexiiDraw: what Place, Open, Import, Replace and drag-and-drop
// all share. A file's bytes are classified by what they ARE (never by name),
// then made ready to place:
//
//   PNG, JPEG, GIF, WebP, BMP, AVIF  -> an embedded image at its actual size
//                                       (declared resolution honoured)
//   SVG, SVGZ                        -> editable vector art (the shared
//                                       importer), with anything it cannot
//                                       edit rasterised and reported
//   PDF, PDF-compatible .ai          -> an image of one page, at its size in
//                                       points
//
// The side effects (XML parsing, rasterising, gunzip, PDF rendering) come in
// through ImportDeps, so all of this runs headless in tests.

import { DRAW_V2_WRITES } from '@shared/draw/compat'
import { putAsset } from '@shared/draw/assets'
import {
  actualSize,
  isRasterKind,
  MAX_PLACE_BYTES,
  MAX_SVG_BYTES,
  rasterDataUrl,
  rasterInfo,
  sniffImportKind
} from '@shared/draw/import/imageInfo'
import {
  decodeSvgBytes,
  importedNodes,
  importSvgText,
  isUserFacingImportError,
  reportLines,
  resolveFallbacks,
  sanitizeSvgText,
  svgToDrawDoc,
  type SvgImportOutput,
  type XmlDocument
} from '@shared/draw/import/svg'
import { isV1Representable } from '@shared/draw/migrate'
import type { Box, DrawDoc, DrawGroupNode, DrawImageNode } from '@shared/draw/model'
import { scalePlaced, withFreshIds, type PlaceItem } from './place'
import type { EditorState } from './types'

export interface ImportFile {
  name: string
  bytes: Uint8Array
}

export interface ImportDeps {
  parseXml(text: string): XmlDocument
  /** Standalone SVG markup to a PNG data URL at w x h pixels; null when it cannot be drawn. */
  rasterize(markup: string, w: number, h: number): Promise<string | null>
  /** One PDF page as a PNG, with its size in points and the page count. */
  pdfPage(bytes: Uint8Array, page: number): Promise<{ ok: boolean; dataUrl?: string; w?: number; h?: number; pages?: number; error?: string }>
  /** Decompress gzip, refusing more than `max` bytes of output. */
  gunzip(bytes: Uint8Array, max: number): Promise<Uint8Array>
}

export interface PrepareOptions {
  structure: 'v1' | 'v2'
  /** The drawing's declared resolution (settings.dpi), for actual size. */
  docDpi?: number
  newId: (prefix: string) => string
  /** PDF page to place (1-based). */
  page?: number
}

/**
 * Whether imported art may use what only schema v2 can store (groups,
 * clipping groups, gradient geometry). While v2 writes are gated, only a
 * drawing that is already v2 -- stored as v2, or already holding v2-only
 * content -- may; a v1 drawing must stay writable by older builds.
 */
export function importStructure(s: Pick<EditorState, 'storedSchema' | 'doc'>): 'v1' | 'v2' {
  return DRAW_V2_WRITES || s.storedSchema >= 2 || !isV1Representable(s.doc) ? 'v2' : 'v1'
}

/** The structure a brand-new drawing from a file may use. */
export function newDocStructure(): 'v1' | 'v2' {
  return DRAW_V2_WRITES ? 'v2' : 'v1'
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Placed art'
}

/** SVG or SVGZ bytes as sanitised-ready text. */
async function svgText(file: ImportFile, kind: 'svg' | 'svgz', deps: ImportDeps): Promise<string> {
  const bytes = kind === 'svgz' ? await deps.gunzip(file.bytes, MAX_SVG_BYTES) : file.bytes
  return decodeSvgBytes(bytes)
}

/** Import an SVG file's text: the shared importer, then its fallbacks rasterised. */
export async function importSvgFile(text: string, deps: ImportDeps, opts: { mode: 'open' | 'import'; structure: 'v1' | 'v2'; newId: (prefix: string) => string }): Promise<SvgImportOutput> {
  const out = importSvgText(text, (s) => deps.parseXml(s), { mode: opts.mode, structure: opts.structure, newId: opts.newId })
  await resolveFallbacks(out, (m, w, h) => deps.rasterize(m, w, h))
  return out
}

function svgPreview(text: string): string | undefined {
  try {
    const clean = sanitizeSvgText(text).text
    // An <img> shows SVG as a still picture with scripting and loading off.
    return clean.length < 2_000_000 ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}` : undefined
  } catch {
    return undefined
  }
}

function imageItem(name: string, label: string, dataUrl: string, pixels: { w: number; h: number }, size: { w: number; h: number }, newId: (p: string) => string, report?: string[]): PlaceItem {
  return {
    name,
    label,
    size,
    preview: dataUrl,
    ...(report?.length ? { report } : {}),
    make(rect: Box) {
      const put = putAsset({}, dataUrl, pixels)
      const node: DrawImageNode = { id: newId('img'), type: 'image', x: rect.x, y: rect.y, w: rect.w, h: rect.h, assetId: put.id, name: stem(name), alt: stem(name) }
      return { nodes: [node], assets: put.assets }
    }
  }
}

/** One file, ready to place -- or the reason it cannot be. */
export async function prepareFile(file: ImportFile, deps: ImportDeps, opts: PrepareOptions): Promise<PlaceItem | { error: string }> {
  if (file.bytes.byteLength > MAX_PLACE_BYTES) return { error: `${file.name} is larger than ${Math.round(MAX_PLACE_BYTES / (1024 * 1024))} MB.` }
  const kind = sniffImportKind(file.bytes, file.name)
  if (!kind) {
    const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase()
    const why =
      ext === 'eps' || ext === 'ps'
        ? 'EPS needs a PostScript interpreter, which PlexiiDraw does not include; save it as PDF or SVG instead.'
        : ext === 'tif' || ext === 'tiff' || ext === 'psd' || ext === 'heic'
          ? `${ext.toUpperCase()} files cannot be shown here; save it as PNG or JPEG instead.`
          : ext === 'ai'
            ? 'this Illustrator file was saved without PDF compatibility, so nothing in it can be read.'
            : 'it is not an image, SVG or PDF file PlexiiDraw can place.'
    return { error: `${file.name}: ${why}` }
  }
  if (isRasterKind(kind)) {
    const info = rasterInfo(file.bytes, kind)
    if (!info) return { error: `${file.name}: the image header could not be read.` }
    const size = actualSize(info, opts.docDpi)
    return imageItem(file.name, 'image', rasterDataUrl(file.bytes, kind), { w: info.w, h: info.h }, size, opts.newId)
  }
  if (kind === 'pdf') {
    const page = opts.page ?? 1
    const r = await deps.pdfPage(file.bytes, page)
    if (!r.ok || !r.dataUrl || !r.w || !r.h) return { error: `${file.name}: ${r.error ?? 'the PDF could not be rendered.'}` }
    const k = (typeof opts.docDpi === 'number' && opts.docDpi > 0 ? opts.docDpi : 72) / 72
    const isAi = /\.ai$/i.test(file.name)
    const pages = r.pages ?? 1
    const report: string[] = []
    if (isAi) report.push(`${file.name} was placed as an image of its PDF-compatible content: Illustrator's own editing data is a private format that cannot be read.`)
    else report.push(`${file.name} was placed as an image of page ${page}; PDF artwork is not editable here yet.`)
    return imageItem(file.name, pages > 1 ? `PDF page ${page} of ${pages}` : isAi ? 'Illustrator file' : 'PDF page', r.dataUrl, { w: Math.round(r.w * 2), h: Math.round(r.h * 2) }, { w: r.w * k, h: r.h * k }, opts.newId, report)
  }
  // SVG / SVGZ: editable art.
  let text: string
  let out: SvgImportOutput
  try {
    text = await svgText(file, kind, deps)
    out = await importSvgFile(text, deps, { mode: 'import', structure: opts.structure, newId: opts.newId })
  } catch (e) {
    return { error: `${file.name}: ${isUserFacingImportError(e) ? e.message : e instanceof Error ? e.message : String(e)}` }
  }
  const nodes = importedNodes(out)
  if (!nodes.length) return { error: `${file.name}: ${reportLines(out.report).join(' ')}` }
  const W = out.width
  const H = out.height
  const lines = out.report.lines()
  const assets = out.assets
  return {
    name: file.name,
    label: 'SVG',
    size: { w: W, h: H },
    preview: svgPreview(text),
    ...(lines.length ? { report: [out.report.summary(), ...lines] } : {}),
    make(rect: Box) {
      const k = W > 0 ? rect.w / W : 1
      const placed = withFreshIds(nodes, opts.newId).map((n) => scalePlaced(n, k, rect.x, rect.y))
      if (opts.structure === 'v1') return { nodes: placed, assets }
      // As in Illustrator: placed art arrives as one group named after the file.
      const g: DrawGroupNode = { id: opts.newId('grp'), type: 'group', name: stem(file.name), children: placed }
      return { nodes: [g], assets }
    }
  }
}

/** Several files: the ones that can be placed, and why the others cannot. */
export async function prepareFiles(files: ImportFile[], deps: ImportDeps, opts: PrepareOptions): Promise<{ items: PlaceItem[]; errors: string[] }> {
  const items: PlaceItem[] = []
  const errors: string[] = []
  for (const f of files) {
    const r = await prepareFile(f, deps, opts)
    if ('error' in r) errors.push(r.error)
    else items.push(r)
  }
  return { items, errors }
}

/** File › Open of an SVG: a whole new drawing, and the report of what came in. */
export async function openSvgAsDoc(file: ImportFile, deps: ImportDeps, opts: { structure: 'v1' | 'v2'; newId: (prefix: string) => string }): Promise<{ doc: DrawDoc; report: string[]; hasLosses: boolean } | { error: string }> {
  const kind = sniffImportKind(file.bytes, file.name)
  if (kind !== 'svg' && kind !== 'svgz') return { error: `${file.name} is not an SVG file.` }
  try {
    const out = await importSvgFile(await svgText(file, kind, deps), deps, { mode: 'open', structure: opts.structure, newId: opts.newId })
    const doc = svgToDrawDoc(out, opts.newId)
    return { doc, report: reportLines(out.report), hasLosses: out.report.hasLosses() }
  } catch (e) {
    return { error: `${file.name}: ${isUserFacingImportError(e) ? e.message : e instanceof Error ? e.message : String(e)}` }
  }
}

// ── The real dependencies, in the renderer ───────────────────────────────────

async function rasterizeInDom(markup: string, w: number, h: number): Promise<string | null> {
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  try {
    await img.decode()
  } catch {
    return null
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')
  if (!c) return null
  c.drawImage(img, 0, 0, w, h)
  try {
    return canvas.toDataURL('image/png')
  } catch {
    // A picture the browser will not let us read back (it marks some SVG
    // content as tainting the canvas): reported as not rasterised.
    return null
  }
}

async function gunzipInDom(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error(`the compressed SVG expands to more than ${Math.round(max / (1024 * 1024))} MB`)
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

export function domImportDeps(): ImportDeps {
  return {
    parseXml: (text) => new DOMParser().parseFromString(text, 'image/svg+xml') as unknown as XmlDocument,
    rasterize: rasterizeInDom,
    pdfPage: (bytes, page) => window.api.draw.pdfPage({ bytes, page }),
    gunzip: gunzipInDom
  }
}
