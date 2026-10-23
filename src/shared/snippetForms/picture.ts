// Pictures of content, in SVG. The pure core never rasterises (that is async
// and needs a DOM, see renderer/src/lib/snippetRaster.ts); it draws SVG and
// embeds it as a data: URL, which every destination already accepts:
// PlexiiWrite's sanitiser allows data:image/*, Deck and Design image elements
// take a data: URI, a diagram image shape takes one, and PlexiiDraw's asset
// store holds data:image/svg+xml bytes.

import type { SlideElement, SlideTextElement, SlideTextParagraph } from '../types'
import { elementHtml, isSafeImageSrc } from '../design'
import type { SnippetAppName, SvgValue } from '../snippetForms'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** UTF-8 bytes of a string as base64. Pure: no Buffer, no btoa (which is Latin-1 only). */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

export const SVG_DATA_PREFIX = 'data:image/svg+xml;base64,'

/** Standalone SVG markup as a data: URL. */
export function svgDataUrl(svg: string): string {
  return SVG_DATA_PREFIX + utf8ToBase64(svg)
}

/** What a picture of something loses, naming where its editable original lives. */
export function pictureLossy(app: SnippetAppName): string {
  return `It becomes a picture: edit it in ${app}.`
}

const XHTML = 'http://www.w3.org/1999/xhtml'
const SVGNS = 'http://www.w3.org/2000/svg'

/**
 * Make an element safe to render inside XML. elementHtml writes HTML for an
 * HTML page; inside an SVG's foreignObject the same markup is parsed as XML,
 * where a double quote in a font name ends the style attribute and a bare `&`
 * in a URL is a fatal error. Both are rewritten on a copy.
 */
function xmlSafe(el: SlideElement): SlideElement {
  const e = structuredClone(el) as SlideElement & { fontFamily?: string; src?: string }
  if (typeof e.fontFamily === 'string') e.fontFamily = e.fontFamily.replace(/"/g, "'")
  if (e.type === 'image' && typeof e.src === 'string') e.src = e.src.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/"/g, '%22')
  return e
}

function shiftEl(el: SlideElement, dx: number, dy: number): SlideElement {
  if (dx === 0 && dy === 0) return el
  const out = { ...el, x: el.x + dx, y: el.y + dy } as SlideElement & { x2?: number; y2?: number }
  if (el.type === 'line') {
    if (Number.isFinite(out.x2)) out.x2 = (out.x2 as number) + dx
    if (Number.isFinite(out.y2)) out.y2 = (out.y2 as number) + dy
  }
  return out as SlideElement
}

/** The bounding box of elements (lines by both ends), never smaller than 1×1. */
export function elementsBox(elements: SlideElement[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const e of elements) {
    minX = Math.min(minX, e.x)
    minY = Math.min(minY, e.y)
    maxX = Math.max(maxX, e.x + Math.max(0, e.w))
    maxY = Math.max(maxY, e.y + Math.max(0, e.h))
    if (e.type === 'line') {
      maxX = Math.max(maxX, e.x2 ?? e.x)
      maxY = Math.max(maxY, e.y2 ?? e.y)
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 }
  return { x: minX, y: minY, w: Math.max(1, Math.ceil(maxX - minX)), h: Math.max(1, Math.ceil(maxY - minY)) }
}

/** Which image addresses a reader of slide/design elements keeps. */
export type ImageSrcCheck = (src: unknown) => boolean

/**
 * The elements of a slide or design body a conversion may read: drawable ones,
 * with every image whose address is not usable left out (Design's own rule,
 * isSafeImageSrc: embedded bytes or https, nothing that could break out of an
 * attribute). `dropped` counts the images left out, so the conversion says so.
 * PlexiiDraw passes its stricter isDrawImageSrc (embedded bytes only).
 */
export function usableElements(raw: unknown, srcOk: ImageSrcCheck = isSafeImageSrc): { elements: SlideElement[]; dropped: number } {
  const all = (Array.isArray(raw) ? raw : []).filter(isDrawableElement) as SlideElement[]
  const elements = all.filter((e) => e.type !== 'image' || srcOk((e as { src?: unknown }).src))
  return { elements, dropped: all.length - elements.length }
}

/** Is this something elementHtml can draw? (The element model, loosely checked.) */
export function isDrawableElement(v: unknown): v is SlideElement {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.type === 'string' && ['x', 'y', 'w', 'h'].every((k) => typeof e[k] === 'number' && Number.isFinite(e[k] as number))
}

/**
 * Slide or design elements as one SVG picture: the elements' own HTML
 * (shared/design.ts elementHtml, the exporter's markup) in a foreignObject
 * sized to the block. `vector` is false: HTML inside a foreignObject can be
 * shown, never imported back as shapes.
 */
export function elementsToSvg(elements: SlideElement[], app: SnippetAppName): SvgValue {
  const box = elementsBox(elements)
  const html = [...elements]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.z ?? 0) - (b.e.z ?? 0) || a.i - b.i)
    .map(({ e }) => elementHtml(xmlSafe(shiftEl(e, -box.x, -box.y))))
    .join('')
    // A nested <svg> (a line, a chart) needs its own namespace inside XHTML or
    // it is an unknown HTML element and draws nothing.
    .replace(/<svg(?![^>]*\sxmlns=)/g, `<svg xmlns="${SVGNS}"`)
  const { w, h } = box
  const svg =
    `<svg xmlns="${SVGNS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="${XHTML}" style="position:relative;width:${w}px;height:${h}px;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827">${html}</div>` +
    `</foreignObject></svg>`
  return { svg, width: w, height: h, vector: false, app }
}

/** What a picture of these elements does not show, beyond being a picture. */
export function elementsPictureLossy(elements: SlideElement[]): string[] {
  const out: string[] = []
  if (elements.some((e) => e.type === 'image' && typeof e.src === 'string' && !e.src.startsWith('data:'))) {
    out.push('Pictures linked from files do not show in it.')
  }
  if (elements.some((e) => e.type === 'widget')) out.push('Embedded work widgets show as a labelled frame.')
  return out
}

// ── Text in elements ─────────────────────────────────────────────────────────

/** A text element's own words, one line per paragraph. */
export function paragraphsText(paragraphs: SlideTextParagraph[] | undefined): string {
  return (paragraphs ?? []).map((p) => (p.runs ?? []).map((r) => r.text ?? '').join('')).join('\n')
}

/** The words in a block of elements, top to bottom then left to right, frames separated by a blank line. */
export function elementsText(elements: SlideElement[], textOf: (e: SlideTextElement) => string = (e) => paragraphsText(e.paragraphs)): string {
  const parts: string[] = []
  for (const e of [...elements].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (e.type === 'text') {
      const t = textOf(e).trim()
      if (t) parts.push(t)
    } else if (e.type === 'table') {
      const t = (e.cells ?? []).map((r) => r.join('\t')).join('\n').trim()
      if (t) parts.push(t)
    }
  }
  return parts.join('\n\n')
}
