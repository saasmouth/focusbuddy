// Pictures arriving in a work widget are STORED, not carried inline.
//
// A converted picture comes out of the pure core as a data: URL (an SVG of a
// drawing, a diagram or a slide; a PNG off the clipboard). Left inline it would
// ride inside the widget's synced content on every save, and a markdown widget
// could not hold it at all: markdown-it refuses data:image/svg+xml links, so
// `![](data:image/svg+xml,…)` would silently come back as text. So every data:
// picture is put in the file store (files:ingestBuffer) and referenced as
// fb-file://<id>, which every widget already resolves (lib/fileUrl.ts).
//
// Honest failure: without a file store (a runtime with no ingestBuffer) a page
// keeps the data: URL, which it can hold, and a markdown widget gets a PNG
// rasterised by PlexiiDraw's own rasteriser (lib/snippetRaster.ts), which
// markdown accepts. When neither is possible the caller is told, never handed
// a picture that will not show.

import type { Picture } from '@shared/snippetWidgets'
import { snippetSvgToPng } from './snippetRaster'

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

/** The bytes and type a data: URL holds, base64 or percent-encoded. Null when it is not one. */
export function dataUrlBytes(src: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(src)
  if (!m) return null
  const mime = (m[1] || 'text/plain').toLowerCase()
  const params = m[2].toLowerCase()
  const data = m[3]
  try {
    if (params.includes(';base64')) {
      const bin = atob(data.replace(/\s+/g, ''))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return { bytes, mime }
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(data)), mime }
  } catch {
    return null
  }
}

/** Is this a data: URL markdown-it refuses as a link (anything but png/jpeg/gif/webp)? */
export function markdownRefusesSrc(src: string): boolean {
  return /^data:/i.test(src) && !/^data:image\/(gif|png|jpeg|webp);/i.test(src)
}

function canStore(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.files?.ingestBuffer === 'function'
}

/**
 * Store a data: URL picture in the file store and return its fb-file:// src.
 * Anything that is not a data: URL is returned unchanged (an http(s) or file
 * link is already a reference). Returns null when it could not be stored.
 */
export async function storeDataPicture(src: string, name: string): Promise<string | null> {
  if (!/^data:/i.test(src)) return src
  const parsed = dataUrlBytes(src)
  if (!parsed || !parsed.mime.startsWith('image/')) return null
  if (!canStore()) return null
  try {
    const buffer = parsed.bytes.buffer.slice(parsed.bytes.byteOffset, parsed.bytes.byteOffset + parsed.bytes.byteLength) as ArrayBuffer
    const file = await window.api.files.ingestBuffer({
      buffer,
      originalName: `${name}.${EXT[parsed.mime] ?? 'img'}`,
      mimeType: parsed.mime
    })
    return file?.id ? `fb-file://${file.id}` : null
  } catch {
    return null
  }
}

/** A safe file name from a picture's alt text. */
function nameFrom(alt: string | undefined): string {
  const s = (alt ?? '').replace(/[^\w .-]+/g, ' ').trim().slice(0, 60)
  return s || 'Picture'
}

/**
 * Resolve a picture to the src a widget stores. `bitmapIfUnstored` asks for a
 * PNG when the picture is an SVG and cannot be stored (a markdown widget).
 */
export async function pictureSrc(
  picture: Picture,
  opts: { bitmapIfUnstored?: boolean } = {}
): Promise<{ src: string; alt: string } | null> {
  const alt = 'svg' in picture ? `Picture from ${picture.svg.app}` : picture.alt ?? ''
  const src =
    'svg' in picture
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(picture.svg.svg)}`
      : picture.src
  const stored = await storeDataPicture(src, nameFrom(alt))
  if (stored) return { src: stored, alt }
  if (!/^data:/i.test(src)) return { src, alt }
  if (!opts.bitmapIfUnstored) return { src, alt }
  if (!markdownRefusesSrc(src)) return { src, alt }
  const svg = 'svg' in picture ? picture.svg : null
  if (!svg) return null
  const png = await snippetSvgToPng(svg)
  return png ? { src: png, alt } : null
}

type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[] }

/**
 * Store every data: picture in a list of TipTap nodes. Returns a new list (the
 * input is not touched) and how many pictures could not be stored, which then
 * stay inline: a page can show them.
 */
export async function storeNodePictures(nodes: unknown[]): Promise<{ nodes: unknown[]; unstored: number }> {
  let unstored = 0
  const walk = async (n: Node): Promise<Node> => {
    if (!n || typeof n !== 'object') return n
    const out: Node = { ...n }
    if (n.type === 'image' && typeof n.attrs?.src === 'string' && /^data:/i.test(n.attrs.src)) {
      const stored = await storeDataPicture(n.attrs.src, nameFrom(typeof n.attrs.alt === 'string' ? n.attrs.alt : ''))
      if (stored) out.attrs = { ...n.attrs, src: stored }
      else unstored++
    }
    if (Array.isArray(n.content)) out.content = await Promise.all(n.content.map(walk))
    return out
  }
  const next = await Promise.all((nodes as Node[]).map(walk))
  return { nodes: next, unstored }
}

const MD_IMAGE = /!\[([^\]]*)\]\((data:[^)\s]+)\)/g

/**
 * Store every data: picture in markdown text. A picture that cannot be stored
 * and that markdown would refuse is reported in `failed`, so the caller can
 * decline instead of inserting a picture that would come back as text.
 */
export async function storeMarkdownPictures(markdown: string): Promise<{ markdown: string; failed: number }> {
  const hits = [...markdown.matchAll(MD_IMAGE)]
  if (!hits.length) return { markdown, failed: 0 }
  let failed = 0
  const replaced = new Map<string, string>()
  for (const h of hits) {
    const raw = h[2]
    if (replaced.has(raw)) continue
    const src = decodeMdSrc(raw)
    const stored = await storeDataPicture(src, nameFrom(h[1]))
    if (stored) replaced.set(raw, stored)
    else if (markdownRefusesSrc(src)) {
      const svg = /^data:image\/svg\+xml/i.test(src) ? dataUrlBytes(src) : null
      const png = svg ? await svgTextToPng(new TextDecoder().decode(svg.bytes)) : null
      if (png) replaced.set(raw, png)
      else failed++
    }
  }
  const out = markdown.replace(MD_IMAGE, (whole, alt: string, raw: string) => (replaced.has(raw) ? `![${alt}](${replaced.get(raw)})` : whole))
  return { markdown: out, failed }
}

/** tiptapToMarkdown percent-encodes ( ) and spaces in a src; undo exactly that. */
function decodeMdSrc(raw: string): string {
  return raw.replace(/%28/gi, '(').replace(/%29/gi, ')').replace(/%20/g, ' ')
}

async function svgTextToPng(svg: string): Promise<string | null> {
  const w = Number(/\bwidth="([\d.]+)/.exec(svg)?.[1] ?? 0)
  const h = Number(/\bheight="([\d.]+)/.exec(svg)?.[1] ?? 0)
  if (!(w > 0 && h > 0)) return null
  return snippetSvgToPng({ svg, width: w, height: h })
}
