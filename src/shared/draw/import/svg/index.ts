// SVG import, end to end and still pure: text in, drawing nodes (or a whole
// new drawing) out. The caller supplies two things that need a runtime --
// an XML parser (the browser's DOMParser in the app) and, for elements kept as
// images, a rasteriser -- so the same code runs in the renderer and the tests.

import { isDrawImageSrc } from '../../../draw'
import { putAsset } from '../../assets'
import type { DrawDoc, DrawDocPaint, DrawDocVectorLayer, DrawGroupNode, DrawNode } from '../../model'
import { V1_ARTBOARD_ID, V1_ARTBOARD_NAME } from '../../migrate'
import { normalizeDrawDoc } from '../../normalize'
import { importSvgDocument, SvgImportError, type SvgImportOptions, type SvgImportOutput, type XmlDocument } from './importer'
import { SvgImportReport } from './report'
import { sanitizeSvgText, SvgRefused } from './sanitize'
import { gradientToV1 } from './paint'
import { lowerToV1 } from './v1'

export { SvgImportError, type SvgFallback, type SvgImportOutput, type XmlDocument } from './importer'
export { SvgImportReport } from './report'
export { SvgRefused, decodeSvgBytes, sanitizeSvgText } from './sanitize'
export { arcToCubics, parsePathData } from './pathData'

export interface SvgTextImportOptions extends SvgImportOptions {
  /** 'v2' keeps groups, clipping groups, frame matrices and gradient geometry; 'v1' lowers to the older format. */
  structure: 'v1' | 'v2'
}

/**
 * Import SVG text. Throws SvgRefused (hostile or oversized input) or
 * SvgImportError (not SVG); otherwise returns what could be imported and a
 * report of the rest. Fallback images are still unrasterised: see
 * resolveFallbacks.
 */
export function importSvgText(text: string, parseXml: (s: string) => XmlDocument, opts: SvgTextImportOptions): SvgImportOutput {
  const clean = sanitizeSvgText(text)
  const doc = parseXml(clean.text)
  const out = importSvgDocument(doc, opts)
  for (const n of clean.notes) out.report.note(`sanitize:${n}`, `${n[0].toUpperCase()}${n.slice(1)}.`, '', false)
  if (opts.structure === 'v1') {
    out.layers = out.layers.map((l) => ({ ...l, nodes: lowerToV1(l.nodes, out.report) }))
    if (out.background)
      out.background = gradientToV1(out.background, () =>
        out.report.note('v1bg', 'The page gradient was approximated to fit the older drawing format.', '', true)
      )
  }
  return out
}

/** Every node, groups included, depth first. */
function eachNode(nodes: DrawNode[], fn: (n: DrawNode) => void): void {
  for (const n of nodes) {
    fn(n)
    if (n.type === 'group') eachNode(n.children, fn)
  }
}

function removeIds(nodes: DrawNode[], ids: Set<string>): DrawNode[] {
  return nodes
    .filter((n) => !ids.has(n.id))
    .map((n) => (n.type === 'group' ? ({ ...n, children: removeIds(n.children, ids) } as DrawGroupNode) : n))
    .filter((n) => n.type !== 'group' || n.children.length > 0)
}

/** Pixels per document unit for fallback images: sharp on a 2x screen, capped. */
export const FALLBACK_SCALE = 2
export const FALLBACK_MAX_SIDE = 4096

/**
 * Rasterise every fallback (an element kept as an image of itself) with
 * `rasterize`, which receives standalone SVG markup and a pixel size and
 * returns a PNG data URL, or null when it cannot. A fallback that cannot be
 * rasterised is removed and reported -- never left as an empty frame.
 */
export async function resolveFallbacks(out: SvgImportOutput, rasterize: (markup: string, w: number, h: number) => Promise<string | null>): Promise<void> {
  if (!out.fallbacks.length) return
  const byId = new Map<string, DrawNode>()
  for (const l of out.layers) eachNode(l.nodes, (n) => byId.set(n.id, n))
  const failed = new Set<string>()
  for (const f of out.fallbacks) {
    const node = byId.get(f.nodeId)
    if (!node || node.type !== 'image') continue
    const k = Math.min(FALLBACK_SCALE, FALLBACK_MAX_SIDE / Math.max(f.box.w, f.box.h))
    const w = Math.max(1, Math.round(f.box.w * k))
    const h = Math.max(1, Math.round(f.box.h * k))
    let url: string | null = null
    try {
      url = await rasterize(f.markup, w, h)
    } catch {
      url = null
    }
    if (url && isDrawImageSrc(url)) {
      const put = putAsset(out.assets, url, { w, h })
      out.assets = put.assets
      ;(node as { assetId: string }).assetId = put.id
    } else {
      failed.add(node.id)
      out.report.note('rasterfail', `1 element (${f.reasons.join(', ')}) could not be rasterised and was left out.`, '{n} elements could not be rasterised and were left out.')
    }
  }
  if (failed.size) out.layers = out.layers.map((l) => ({ ...l, nodes: removeIds(l.nodes, failed) }))
}

/** All imported nodes, in paint order, across the file's layers (for Import and Place). */
export function importedNodes(out: SvgImportOutput): DrawNode[] {
  return out.layers.filter((l) => l.visible).flatMap((l) => l.nodes)
}

const MIN_BOARD = 16
const MAX_BOARD = 12000

/**
 * A new drawing from an SVG imported in 'open' mode: one artboard the file's
 * size, its layers, its page colour. Everything passes through normalize, as
 * any stored drawing does.
 */
export function svgToDrawDoc(out: SvgImportOutput, newId: (prefix: string) => string): DrawDoc {
  const w = Math.round(out.width)
  const h = Math.round(out.height)
  const W = Math.max(MIN_BOARD, Math.min(MAX_BOARD, w))
  const H = Math.max(MIN_BOARD, Math.min(MAX_BOARD, h))
  if (W !== w || H !== h) out.report.note('board', `The artboard was resized to ${W} × ${H} (PlexiiDraw artboards are ${MIN_BOARD} to ${MAX_BOARD} pixels a side); the art keeps its size.`, '', true)
  const layers: DrawDocVectorLayer[] = (out.layers.length ? out.layers : [{ name: 'Layer 1', nodes: [], opacity: 1, blend: 'normal' as const, visible: true }]).map((l) => ({
    id: newId('lyr'),
    kind: 'vector',
    name: l.name,
    visible: l.visible,
    locked: false,
    opacity: l.opacity,
    blend: l.blend,
    objects: l.nodes
  }))
  const background: DrawDocPaint = out.background ?? { type: 'none' }
  const raw = {
    schemaVersion: 2,
    minWriterVersion: 2,
    // The same artboard identity a migrated v1 drawing has, so a drawing that
    // holds nothing v2-only can still be written in the older format.
    artboards: [{ id: V1_ARTBOARD_ID, name: V1_ARTBOARD_NAME, x: 0, y: 0, w: W, h: H, background }],
    activeArtboardId: V1_ARTBOARD_ID,
    layers,
    activeLayerId: layers[layers.length - 1].id,
    assets: out.assets,
    swatches: [],
    guides: [],
    settings: {}
  }
  return normalizeDrawDoc(raw)
}

/** A short user-facing account: the summary line, then each remark. */
export function reportLines(report: SvgImportReport): string[] {
  return [report.summary(), ...report.lines()]
}

/** Is this error one to show the user as-is (a refusal or "not SVG"), rather than a crash? */
export function isUserFacingImportError(e: unknown): e is Error {
  return e instanceof SvgRefused || e instanceof SvgImportError
}
