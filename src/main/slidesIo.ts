// Slides Office interop. Export to native .pptx via pptxgenjs (elements map to
// pptx text/shape/image/line), export to PDF by rendering each slide to an
// offscreen page and printing, and a best-effort .pptx import that extracts text
// (PowerPoint's full feature set does not round-trip; this is honest about that).

import { dialog, BrowserWindow } from 'electron'
import { basename } from 'path'
import { readFile, writeFile } from 'fs/promises'
// pptxgenjs and fflate are imported lazily inside the functions that use them,
// so they stay out of the app's startup require path; a packaging gap can only
// degrade pptx export/import to an error, never crash launch.
import type { DeckTheme, Slide, SlidesBody, SlideTextElement, SlideImageElement, SlideTableElement, SlideChartElement, SlideShapeElement, SlideFill, SlideBorder, SlideTextParagraph, SlideTextRun } from '@shared/types'
import type { ChartType } from '@shared/chart'
import { resolveTheme, SLIDE_W, SLIDE_H } from '@shared/slideThemes'
import { migrateSlidesBody } from '@shared/slidesMigrate'
import { chartToSvg } from '@shared/chart'

export interface SlidesExportResult {
  ok: boolean
  path?: string
  error?: string
}
export interface SlidesImportResult {
  ok: boolean
  body?: SlidesBody
  name?: string
  error?: string
  // Shapes whose pptx geometry has no honest equivalent in our four shapes
  // (stars, arrows, callouts). Reported rather than squared off into
  // rectangles, so the user is told what is missing instead of shown a lie.
  skippedShapes?: number
}

function win(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}
const hex = (c: string | undefined, fallback = '000000'): string => (c ? c.replace('#', '') : fallback)
const IN_W = 13.333
const IN_H = 7.5
const px2inX = (px: number): number => (px / SLIDE_W) * IN_W
const px2inY = (px: number): number => (px / SLIDE_H) * IN_H
const px2pt = (px: number): number => px * 0.75

// ── PPTX export ───────────────────────────────────────────────────────────────
export async function exportPptx(body: SlidesBody, _title: string, outPath: string): Promise<SlidesExportResult> {
  try {
    const PptxGenJS = (await import('pptxgenjs')).default
    const deck = migrateSlidesBody(body)
    const theme = resolveTheme(deck.theme)
    const pptx = new PptxGenJS()
    pptx.defineLayout({ name: 'WIDE', width: IN_W, height: IN_H })
    pptx.layout = 'WIDE'

    for (const slide of deck.slides) {
      const s = pptx.addSlide()
      const bg = slide.background?.type === 'solid' ? slide.background.color : theme.background
      s.background = { color: hex(bg, 'FFFFFF') }
      for (const el of (slide.elements ?? []).slice().sort((a, b) => a.z - b.z)) {
        const pos = { x: px2inX(el.x), y: px2inY(el.y), w: px2inX(el.w), h: px2inY(el.h) }
        // Framing shared by every element type: rotation and a drop-shadow preset,
        // so a rotated or shadowed element survives into PowerPoint.
        const frame: Record<string, unknown> = {}
        if (el.rotation) frame.rotate = Math.round(el.rotation)
        if (el.shadow) {
          const blur = el.shadow === 'sm' ? 3 : el.shadow === 'md' ? 6 : 10
          const offset = el.shadow === 'sm' ? 2 : el.shadow === 'md' ? 4 : 7
          frame.shadow = { type: 'outer', blur, offset, angle: 45, color: '000000', opacity: 0.4 }
        }
        if (el.type === 'text') {
          const runs = el.paragraphs.flatMap((p, pi) =>
            p.runs.map((r) => ({
              text: r.text + (pi < el.paragraphs.length - 1 ? '\n' : ''),
              options: {
                bold: r.bold,
                italic: r.italic,
                underline: r.underline ? { style: 'sng' as const } : undefined,
                color: hex(r.color, hex(theme.textColor)),
                fontSize: px2pt(r.fontSize ?? theme.bodyStyle.fontSize),
                align: p.align ?? 'left',
                bullet: p.listStyle === 'bullet' ? true : p.listStyle === 'number' ? { type: 'number' as const } : undefined,
                fontFace: el.fontFamily?.split(',')[0]?.replace(/["']/g, '')
              }
            }))
          )
          s.addText(runs.length ? runs : [{ text: '', options: {} }], { ...pos, ...frame, valign: el.vAlign ?? 'top' })
        } else if (el.type === 'image') {
          s.addImage({ ...pos, ...frame, data: el.src, rounding: !!el.cornerRadius })
        } else if (el.type === 'shape') {
          const isRound = el.shape === 'roundRect' || (el.shape === 'rect' && !!el.cornerRadius)
          const map: Record<string, string> = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle' }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          s.addShape((isRound ? 'roundRect' : (map[el.shape] ?? 'rect')) as any, {
            ...pos,
            ...frame,
            // Corner radius as a fraction of the shorter side (pptxgenjs convention).
            rectRadius: isRound && el.cornerRadius ? Math.min(0.5, el.cornerRadius / Math.min(el.w, el.h)) : undefined,
            fill: el.fill?.type === 'solid' ? { color: hex(el.fill.color, hex(theme.accent)) } : { type: 'none' },
            line: el.border ? { color: hex(el.border.color), width: el.border.width } : undefined
          })
        } else if (el.type === 'line') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          s.addShape('line' as any, {
            ...pos,
            ...frame,
            line: { color: hex(el.stroke, hex(theme.accent)), width: el.strokeWidth, endArrowType: el.arrowEnd ? 'triangle' : 'none' }
          })
        } else if (el.type === 'widget') {
          // A live desk-widget embed has no static form here; keep the frame in
          // the layout with an honest label rather than fake widget content.
          s.addText('Embedded desk widget', {
            ...pos,
            ...frame,
            fontSize: 10,
            color: 'A8A29E',
            align: 'center',
            valign: 'middle',
            line: { color: 'D6D3D1', width: 1 }
          })
        } else if (el.type === 'chart') {
          // A real, editable PowerPoint chart from the snapshot data. Scatter
          // maps to line (pptx scatter needs paired-axis data we don't carry).
          const c = el.chart
          const chartData = c.data.series.map((sr) => ({
            name: sr.name || 'Series',
            labels: c.data.categories,
            values: sr.values.map((v) => (Number.isFinite(v) ? v : 0))
          }))
          const t = c.type === 'pie' ? 'pie' : c.type === 'area' ? 'area' : c.type === 'line' || c.type === 'scatter' ? 'line' : 'bar'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const opts: any = { ...pos, ...frame, showLegend: true, legendPos: 'b' }
          if (c.title) {
            opts.showTitle = true
            opts.title = c.title
          }
          if (t === 'bar') opts.barDir = 'col'
          if (c.stacked && (t === 'bar' || t === 'area')) opts.barGrouping = 'stacked'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          s.addChart(t as any, chartData, opts)
        } else if (el.type === 'table') {
          // A real, editable PowerPoint table.
          const accent = hex(el.accent, 'E2E8F0')
          const rows = el.cells.map((row, r) =>
            row.map((text) => ({
              text: text ?? '',
              options: el.headerRow && r === 0 ? { bold: true, fill: { color: accent } } : {}
            }))
          )
          s.addTable(rows, { ...pos, ...frame, border: { type: 'solid', pt: 1, color: accent }, fontSize: (el.fontSize ?? 16) * 0.6, valign: 'middle' })
        }
      }
      if (slide.notes) s.addNotes(slide.notes)
    }

    const buf = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
    await writeFile(outPath, buf)
    return { ok: true, path: outPath }
  } catch (e) {
    return { ok: false, error: `Could not export: ${(e as Error).message}` }
  }
}

// ── PDF export (render each slide to an offscreen page and print) ──────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function textElHtml(el: SlideTextElement, theme: DeckTheme): string {
  const justify = el.vAlign === 'middle' ? 'center' : el.vAlign === 'bottom' ? 'flex-end' : 'flex-start'
  const paras = el.paragraphs
    .map((p) => {
      const runs = p.runs
        .map(
          (r) =>
            `<span style="font-weight:${r.bold ? 700 : 400};font-style:${r.italic ? 'italic' : 'normal'};text-decoration:${r.underline ? 'underline' : 'none'};color:${r.color ?? theme.textColor};font-size:${r.fontSize ?? theme.bodyStyle.fontSize}px">${esc(r.text)}</span>`
        )
        .join('')
      const bullet = p.listStyle === 'bullet' ? '• ' : ''
      return `<div style="text-align:${p.align ?? 'left'}">${bullet}${runs}</div>`
    })
    .join('')
  return `<div style="position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;display:flex;flex-direction:column;justify-content:${justify};font-family:${el.fontFamily ?? theme.fontBody}">${paras}</div>`
}
function slideHtml(slide: Slide, theme: DeckTheme): string {
  const bg = slide.background?.type === 'solid' ? slide.background.color : theme.background
  const els = (slide.elements ?? [])
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((el) => {
      if (el.type === 'text') return textElHtml(el, theme)
      if (el.type === 'image') return `<img src="${el.src}" style="position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;object-fit:${el.fit ?? 'contain'}"/>`
      if (el.type === 'shape') {
        const radius = el.shape === 'ellipse' ? '50%' : el.shape === 'roundRect' ? '16px' : '0'
        const clip = el.shape === 'triangle' ? 'clip-path:polygon(50% 0,0 100%,100% 100%);' : ''
        return `<div style="position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;background:${el.fill?.type === 'solid' ? el.fill.color : 'transparent'};border-radius:${radius};${clip}${el.border ? `border:${el.border.width}px ${el.border.style ?? 'solid'} ${el.border.color}` : ''}"></div>`
      }
      if (el.type === 'line')
        return `<svg style="position:absolute;left:${el.x}px;top:${el.y}px" width="${el.w}" height="${el.h}"><line x1="0" y1="0" x2="${el.w}" y2="${el.h}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"/></svg>`
      if (el.type === 'chart')
        return `<div style="position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px">${chartToSvg(el.chart, el.w, el.h)}</div>`
      if (el.type === 'table') {
        const accent = el.accent ?? '#e2e8f0'
        const rows = el.cells
          .map(
            (row, r) =>
              `<tr>${row
                .map((cell) => `<td style="border:1px solid ${accent};padding:4px 8px;${el.headerRow && r === 0 ? `font-weight:700;background:${accent};` : ''}">${esc(cell)}</td>`)
                .join('')}</tr>`
          )
          .join('')
        return `<div style="position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px"><table style="width:100%;height:100%;border-collapse:collapse;table-layout:fixed;font-size:${el.fontSize ?? 16}px">${rows}</table></div>`
      }
      // widget: a live desk-widget embed cannot be rendered in a static export
      // (it resolves via renderer IPC), so print an honest labelled frame.
      return `<div style="position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;border:1px solid #d6d3d1;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#a8a29e;font-size:14px">Embedded desk widget</div>`
    })
    .join('')
  return `<div class="page" style="position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;background:${bg};overflow:hidden;color:${theme.textColor}">${els}</div>`
}

export async function exportSlidesPdf(body: SlidesBody, outPath: string): Promise<SlidesExportResult> {
  const deck = migrateSlidesBody(body)
  const theme = resolveTheme(deck.theme)
  const pages = deck.slides.map((s) => slideHtml(s, theme)).join('')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .page { page-break-after: always; }
  </style></head><body>${pages}</body></html>`
  const offscreen = new BrowserWindow({ show: false, width: SLIDE_W, height: SLIDE_H, webPreferences: { offscreen: true } })
  try {
    await offscreen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await offscreen.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, landscape: true })
    await writeFile(outPath, pdf)
    return { ok: true, path: outPath }
  } catch (e) {
    return { ok: false, error: `Could not export PDF: ${(e as Error).message}` }
  } finally {
    offscreen.destroy()
  }
}

// ── PPTX import (best-effort: text + speaker notes) ────────────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// Every run of text in a slide/notes XML sits in <a:t>…</a:t>, grouped by
// paragraph <a:p>. Returns one string per non-empty paragraph.
function paragraphs(xml: string): string[] {
  return xml
    .split(/<a:p[ >]/)
    .slice(1)
    .map((chunk) => [...chunk.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(''))
    .filter((t) => t.trim() !== '')
}

// The speaker notes for a slide: follow the slide's .rels to its notesSlide part
// and read the body text, skipping the slide-number / date / footer placeholders
// (which PowerPoint stamps into every notes page and are not real notes).
function notesForSlide(
  files: Record<string, Uint8Array>,
  slideName: string,
  strFromU8: (u: Uint8Array) => string
): string {
  const n = slideName.match(/slide(\d+)\.xml$/)?.[1]
  if (!n) return ''
  const rels = files[`ppt/slides/_rels/slide${n}.xml.rels`]
  if (!rels) return ''
  const target = /Target="([^"]*notesSlide\d+\.xml)"/.exec(strFromU8(rels))?.[1]
  if (!target) return ''
  const key = target.replace(/^\.\.\//, 'ppt/').replace(/^\//, '')
  const notesXml = files[key]
  if (!notesXml) return ''
  const lines: string[] = []
  for (const sp of strFromU8(notesXml).split(/<p:sp>/).slice(1)) {
    const body = sp.split(/<\/p:sp>/)[0]
    if (/type="(sldNum|dt|ftr)"/.test(body)) continue // placeholder, not notes
    lines.push(...paragraphs(body))
  }
  return lines.join('\n')
}

// The MIME type for an embedded media part by extension. Only browser-renderable
// raster formats are imported; vector metafiles (emf/wmf) are skipped honestly
// rather than embedded as something that would not display.
function imageMime(path: string): string | null {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'svg') return 'image/svg+xml'
  return null
}

// The picture shapes on a slide, as positioned image elements in our 1280x720
// logical space. Reads the slide rels to resolve each <a:blip r:embed> to its
// media part and inlines it as a data URI so the deck is self-contained.
function slideImages(
  files: Record<string, Uint8Array>,
  slideName: string,
  strFromU8: (u: Uint8Array) => string,
  sldCx: number,
  sldCy: number
): SlideImageElement[] {
  const n = slideName.match(/slide(\d+)\.xml$/)?.[1]
  if (!n) return []
  const relsBuf = files[`ppt/slides/_rels/slide${n}.xml.rels`]
  if (!relsBuf) return []
  // relId -> media file key.
  const rels = new Map<string, string>()
  for (const rel of strFromU8(relsBuf).match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /Id="([^"]+)"/.exec(rel)?.[1]
    const target = /Target="([^"]+)"/.exec(rel)?.[1]
    if (id && target && /media\//i.test(target)) rels.set(id, target.replace(/^\.\.\//, 'ppt/').replace(/^\//, ''))
  }
  if (!rels.size) return []

  const xml = strFromU8(files[slideName])
  const out: SlideImageElement[] = []
  const pics = xml.split(/<p:pic\b/).slice(1)
  for (let i = 0; i < pics.length; i++) {
    const pic = pics[i].split(/<\/p:pic>/)[0]
    const embed = /<a:blip[^>]*r:embed="([^"]+)"/.exec(pic)?.[1]
    if (!embed) continue
    const key = rels.get(embed)
    if (!key) continue
    const mediaBuf = files[key]
    const mime = mediaBuf ? imageMime(key) : null
    if (!mediaBuf || !mime) continue // unresolved or non-raster: skip, don't fake
    const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(pic)
    const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(pic)
    // EMU → logical units; fall back to a sensible centred box when the shape has
    // no explicit transform (inherited from a layout, which we do not resolve).
    const emuX = off ? Number(off[1]) : sldCx * 0.15
    const emuY = off ? Number(off[2]) : sldCy * 0.15
    const emuW = ext ? Number(ext[1]) : sldCx * 0.3
    const emuH = ext ? Number(ext[2]) : sldCy * 0.3
    const b64 = Buffer.from(mediaBuf).toString('base64')
    out.push({
      id: `img-${n}-${i}`,
      type: 'image',
      x: Math.round((emuX / sldCx) * SLIDE_W),
      y: Math.round((emuY / sldCy) * SLIDE_H),
      w: Math.round((emuW / sldCx) * SLIDE_W),
      h: Math.round((emuH / sldCy) * SLIDE_H),
      z: 100 + i,
      src: `data:${mime};base64,${b64}`,
      fit: 'contain'
    })
  }
  return out
}

// ── Theme colours ─────────────────────────────────────────────────────────────
//
// Most colours in a real deck are not literal: they are <a:schemeClr val="accent1">
// pointing into ppt/theme/theme1.xml. Until this existed we read only explicit
// srgbClr values and dropped the rest, which meant a deck built from its theme
// (most of them) imported almost colourless.
export type ThemeColors = Map<string, string>

// The clrScheme slot names, in the order PowerPoint writes them, mapped to the
// aliases that appear in slide XML. dk1/lt1 are referenced as tx1/bg1.
const SCHEME_ALIAS: Record<string, string[]> = {
  dk1: ['dk1', 'tx1'],
  lt1: ['lt1', 'bg1'],
  dk2: ['dk2', 'tx2'],
  lt2: ['lt2', 'bg2'],
  accent1: ['accent1'],
  accent2: ['accent2'],
  accent3: ['accent3'],
  accent4: ['accent4'],
  accent5: ['accent5'],
  accent6: ['accent6'],
  hlink: ['hlink'],
  folHlink: ['folHlink']
}

export function parseTheme(files: Record<string, Uint8Array>, strFromU8: (u: Uint8Array) => string): ThemeColors {
  const out: ThemeColors = new Map()
  // Decks name the part theme1.xml by convention, but take whichever is there.
  const key = Object.keys(files).find((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k))
  if (!key) return out
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(strFromU8(files[key]))?.[0]
  if (!scheme) return out
  for (const [slot, aliases] of Object.entries(SCHEME_ALIAS)) {
    const frag = new RegExp(`<a:${slot}>([\\s\\S]*?)</a:${slot}>`).exec(scheme)?.[1]
    if (!frag) continue
    // A slot holds either an explicit srgbClr or a sysClr carrying lastClr.
    const hex = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(frag)?.[1]
      ?? /<a:sysClr\b[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(frag)?.[1]
    if (!hex) continue
    for (const a of aliases) out.set(a, `#${hex.toLowerCase()}`)
  }
  return out
}

// Apply the lumMod/lumOff tint PowerPoint layers on a scheme colour, so
// "accent1 at 40% luminance" is not imported as flat accent1.
function applyLum(hex: string, frag: string): string {
  const mod = /<a:lumMod\s+val="(\d+)"/.exec(frag)?.[1]
  const off = /<a:lumOff\s+val="(\d+)"/.exec(frag)?.[1]
  if (!mod && !off) return hex
  const m = mod ? Number(mod) / 100000 : 1
  const o = off ? Number(off) / 100000 : 0
  const ch = (i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return Math.max(0, Math.min(255, Math.round((v * m + o) * 255)))
  }
  return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`
}

// A colour from any fragment that may hold srgbClr or a theme reference.
// Returns undefined rather than a guess when neither is present.
function colorIn(fragment: string | undefined, theme: ThemeColors): string | undefined {
  if (!fragment) return undefined
  const lit = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"([\s\S]*?)(?:\/>|<\/a:srgbClr>)/.exec(fragment)
  if (lit) return applyLum(`#${lit[1].toLowerCase()}`, lit[2])
  const sch = /<a:schemeClr\s+val="([A-Za-z0-9]+)"([\s\S]*?)(?:\/>|<\/a:schemeClr>)/.exec(fragment)
  if (sch) {
    const base = theme.get(sch[1])
    if (base) return applyLum(base, sch[2])
  }
  return undefined
}

// ── Autoshapes ────────────────────────────────────────────────────────────────
//
// A pptx autoshape is a <p:sp> carrying <a:prstGeom prst="…">. Our model has
// four shapes, so only the preset families that genuinely correspond are mapped.
// A star, arrow or callout is NOT squared off into a rectangle: a flowchart
// whose arrows silently became boxes is worse than one honestly missing them,
// and the caller is told how many were skipped.
const PRST_SHAPE: Array<[RegExp, SlideShapeElement['shape']]> = [
  [/^(roundRect|round1Rect|round2SameRect|round2DiagRect|snip\w*Rect)$/, 'roundRect'],
  [/^(rect|flowChartProcess|flowChartPredefinedProcess|plaque)$/, 'rect'],
  [/^(ellipse|flowChartConnector|donut)$/, 'ellipse'],
  [/^(triangle|rtTriangle|flowChartExtract|flowChartMerge)$/, 'triangle']
]

function shapeForPreset(prst: string): SlideShapeElement['shape'] | null {
  for (const [re, shape] of PRST_SHAPE) if (re.test(prst)) return shape
  return null
}

// An <a:srgbClr val="RRGGBB"> inside the given fragment, as a CSS colour.
// Theme colours (<a:schemeClr>) are not resolved: we do not read theme1.xml, so
// returning a guess would be inventing the deck's palette.
function srgb(fragment: string | undefined, theme: ThemeColors): string | undefined {
  return colorIn(fragment, theme)
}

// Outside-in: the first <a:…Fill> that belongs to the shape itself, not to a
// child run's text properties.
function shapeFill(spPr: string, theme: ThemeColors): SlideFill | undefined {
  if (/<a:noFill\s*\/>/.test(spPr)) return { type: 'none' }
  const solid = /<a:solidFill>([\s\S]*?)<\/a:solidFill>/.exec(spPr)?.[1]
  const color = srgb(solid, theme)
  if (color) return { type: 'solid', color }
  const grad = /<a:gradFill[\s\S]*?<\/a:gradFill>/.exec(spPr)?.[0]
  if (grad) {
    const stops = [...grad.matchAll(/<a:gs\b[\s\S]*?<\/a:gs>/g)]
      .map((m) => colorIn(m[0], theme))
      .filter((c): c is string => !!c)
    if (stops.length >= 2) return { type: 'gradient', color: stops[0], color2: stops[stops.length - 1] }
    if (stops.length === 1) return { type: 'solid', color: stops[0] }
  }
  return undefined
}

function shapeBorder(spPr: string, theme: ThemeColors): SlideBorder | undefined {
  const ln = /<a:ln\b[^>]*>([\s\S]*?)<\/a:ln>/.exec(spPr)
  if (!ln) return undefined
  if (/<a:noFill\s*\/>/.test(ln[1])) return undefined
  const color = srgb(ln[1], theme)
  if (!color) return undefined
  // EMU width (12700 per point); default to a hairline when absent.
  const w = /<a:ln\b[^>]*\bw="(\d+)"/.exec(ln[0])?.[1]
  const width = w ? Math.max(1, Math.round(Number(w) / 12700)) : 1
  const dashed = /<a:prstDash\s+val="(dash|sysDash|lgDash|dashDot)"/.test(ln[1])
  return { color, width, ...(dashed ? { style: 'dashed' as const } : {}) }
}

// The autoshapes on a slide, positioned in our logical space. Placeholder
// shapes are skipped: their text is already read as the slide's title and
// bullets, so emitting them again would duplicate every line.
function slideShapes(
  slideXml: string,
  slideIndex: number,
  sldCx: number,
  sldCy: number,
  theme: ThemeColors
): { shapes: SlideShapeElement[]; skipped: number } {
  const shapes: SlideShapeElement[] = []
  let skipped = 0
  let idx = 0
  for (const chunk of stripGraphicFrames(slideXml).split(/<p:sp>/).slice(1)) {
    const sp = chunk.split(/<\/p:sp>/)[0]
    if (/<p:ph\b/.test(sp)) continue // placeholder: already read as title/bullets
    const prst = /<a:prstGeom\s+prst="([A-Za-z0-9]+)"/.exec(sp)?.[1]
    if (!prst) continue
    const shape = shapeForPreset(prst)
    if (!shape) {
      skipped++
      continue
    }
    const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(sp)?.[1] ?? sp
    const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(spPr)
    const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(spPr)
    if (!off || !ext) continue // no transform of its own; we do not resolve layouts
    const fill = shapeFill(spPr, theme)
    const border = shapeBorder(spPr, theme)
    shapes.push({
      id: `shp-${slideIndex}-${idx++}`,
      type: 'shape',
      shape,
      x: Math.round((Number(off[1]) / sldCx) * SLIDE_W),
      y: Math.round((Number(off[2]) / sldCy) * SLIDE_H),
      w: Math.round((Number(ext[1]) / sldCx) * SLIDE_W),
      h: Math.round((Number(ext[2]) / sldCy) * SLIDE_H),
      z: 50 + idx,
      ...(fill ? { fill } : {}),
      ...(border ? { border } : {})
    })
  }
  return { shapes, skipped }
}

// ── Rich text boxes ───────────────────────────────────────────────────────────
//
// Until this existed, slide text was flattened to a title string and a list of
// bullet strings, which threw away position, alignment, bold, italic, colour
// and size. Placeholders still become title/bullets, because that carries the
// layout's meaning; every other text shape now arrives as a positioned element
// with its runs intact.

const ALIGN: Record<string, 'left' | 'center' | 'right'> = {
  l: 'left', ctr: 'center', r: 'right', just: 'left', dist: 'left'
}

/** One <a:p> to a paragraph, keeping each <a:r>'s own formatting. */
function richParagraph(pXml: string, theme: ThemeColors, ptToLogical: number): SlideTextParagraph | null {
  const runs: SlideTextRun[] = []
  for (const rChunk of pXml.split(/<a:r>/).slice(1)) {
    const r = rChunk.split(/<\/a:r>/)[0]
    const text = decodeXml([...r.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(''))
    if (text === '') continue
    const rPr = /<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>|<a:rPr\b[^>]*\/>/.exec(r)?.[0] ?? ''
    const sz = /\bsz="(\d+)"/.exec(rPr)?.[1]
    const color = colorIn(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/.exec(rPr)?.[1], theme)
    runs.push({
      text,
      ...(/\bb="1"/.test(rPr) ? { bold: true } : {}),
      ...(/\bi="1"/.test(rPr) ? { italic: true } : {}),
      ...(/\bu="(?!none)[a-zA-Z]+"/.test(rPr) ? { underline: true } : {}),
      ...(color ? { color } : {}),
      ...(sz ? { fontSize: Math.max(1, Math.round((Number(sz) / 100) * ptToLogical)) } : {})
    })
  }
  if (!runs.length) return null
  const pPr = /<a:pPr\b[^>]*>/.exec(pXml)?.[0] ?? ''
  const algn = /\balgn="(\w+)"/.exec(pPr)?.[1]
  const lvl = /\blvl="(\d+)"/.exec(pPr)?.[1]
  // A paragraph is a list item unless it explicitly opts out with <a:buNone/>.
  const listStyle: SlideTextParagraph['listStyle'] = /<a:buNone\s*\/>/.test(pXml)
    ? 'none'
    : /<a:buAutoNum\b/.test(pXml)
      ? 'number'
      : /<a:buChar\b/.test(pXml)
        ? 'bullet'
        : undefined
  return {
    runs,
    ...(algn && ALIGN[algn] ? { align: ALIGN[algn] } : {}),
    ...(lvl ? { bulletLevel: Number(lvl) } : {}),
    ...(listStyle ? { listStyle } : {})
  }
}

function richParagraphs(xml: string, theme: ThemeColors, ptToLogical: number): SlideTextParagraph[] {
  return xml
    .split(/<a:p>|<a:p\s[^>]*>/)
    .slice(1)
    .map((chunk) => richParagraph(chunk.split(/<\/a:p>/)[0], theme, ptToLogical))
    .filter((p): p is SlideTextParagraph => p !== null)
}

/** Non-placeholder text shapes, positioned, with formatting preserved. */
function slideTextBoxes(
  slideXml: string,
  slideIndex: number,
  sldCx: number,
  sldCy: number,
  theme: ThemeColors,
  ptToLogical: number
): SlideTextElement[] {
  const out: SlideTextElement[] = []
  let idx = 0
  for (const chunk of stripGraphicFrames(slideXml).split(/<p:sp>/).slice(1)) {
    const shape = chunk.split(/<\/p:sp>/)[0]
    if (/<p:ph\b/.test(shape)) continue // placeholder: already the title/bullets
    const tx = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(shape)?.[1]
    if (!tx) continue
    const paragraphs = richParagraphs(tx, theme, ptToLogical)
    if (!paragraphs.length) continue
    const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(shape)?.[1] ?? shape
    const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(spPr)
    const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(spPr)
    if (!off || !ext) continue // no transform of its own; layouts are not resolved
    const anchor = /\banchor="(t|ctr|b)"/.exec(tx)?.[1]
    out.push({
      id: `txt-${slideIndex}-${idx++}`,
      type: 'text',
      x: Math.round((Number(off[1]) / sldCx) * SLIDE_W),
      y: Math.round((Number(off[2]) / sldCy) * SLIDE_H),
      w: Math.round((Number(ext[1]) / sldCx) * SLIDE_W),
      h: Math.round((Number(ext[2]) / sldCy) * SLIDE_H),
      z: 70 + idx,
      paragraphs,
      ...(anchor === 'ctr' ? { vAlign: 'middle' as const } : anchor === 'b' ? { vAlign: 'bottom' as const } : {})
    })
  }
  return out
}

// The tables on a slide, as SlideTableElements. A pptx table is an <a:tbl> inside
// an <a:graphicFrame>; rows are <a:tr>, cells <a:tc>. Positioned from the frame's
// transform (EMU → logical units).
function slideTables(slideXml: string, slideIndex: number, sldCx: number, sldCy: number): SlideTableElement[] {
  const out: SlideTableElement[] = []
  const frames = slideXml.split(/<p:graphicFrame\b/).slice(1)
  let idx = 0
  for (const chunk of frames) {
    const frame = chunk.split(/<\/p:graphicFrame>/)[0]
    const tblMatch = /<a:tbl>[\s\S]*?<\/a:tbl>/.exec(frame)
    if (!tblMatch) continue
    const tbl = tblMatch[0]
    const cells: string[][] = []
    for (const trChunk of tbl.split(/<a:tr\b/).slice(1)) {
      const tr = trChunk.split(/<\/a:tr>/)[0]
      const row: string[] = []
      for (const tcChunk of tr.split(/<a:tc\b/).slice(1)) {
        const tc = tcChunk.split(/<\/a:tc>/)[0]
        row.push(paragraphs(tc).join('\n'))
      }
      if (row.length) cells.push(row)
    }
    if (!cells.length) continue
    const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(frame)
    const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(frame)
    const emuX = off ? Number(off[1]) : sldCx * 0.1
    const emuY = off ? Number(off[2]) : sldCy * 0.1
    const emuW = ext ? Number(ext[1]) : sldCx * 0.8
    const emuH = ext ? Number(ext[2]) : sldCy * 0.4
    const headerRow = /<a:tblPr[^>]*\bfirstRow="1"/.test(tbl)
    out.push({
      id: `tbl-${slideIndex}-${idx++}`,
      type: 'table',
      x: Math.round((emuX / sldCx) * SLIDE_W),
      y: Math.round((emuY / sldCy) * SLIDE_H),
      w: Math.round((emuW / sldCx) * SLIDE_W),
      h: Math.round((emuH / sldCy) * SLIDE_H),
      z: 90 + idx,
      cells,
      ...(headerRow ? { headerRow: true } : {})
    })
  }
  return out
}

// Keep only placeholder shapes before reading the slide's title and bullets.
//
// Non-placeholder text boxes now arrive as positioned elements of their own
// (slideTextBoxes). Without this, their text would ALSO be read here and the
// same sentence would appear twice on the imported slide: once as a bullet and
// once in the box it actually came from.
function placeholdersOnly(xml: string): string {
  const head = xml.split(/<p:sp>/)[0]
  const kept = xml
    .split(/<p:sp>/)
    .slice(1)
    .filter((chunk) => /<p:ph\b/.test(chunk.split(/<\/p:sp>/)[0]))
    .map((chunk) => `<p:sp>${chunk}`)
  return head + kept.join('')
}

// Strip table/chart frames before pulling title/body text, so a table's cell text
// does not also leak into the slide's bullets.
function stripGraphicFrames(xml: string): string {
  return xml.replace(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g, '')
}

// The <c:v> values inside a container element (a category or value cache).
function cacheValues(xml: string): string[] {
  return [...xml.matchAll(/<c:v>([\s\S]*?)<\/c:v>/g)].map((m) =>
    m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
  )
}

const CHART_TAG_TYPE: Array<[RegExp, ChartType]> = [
  [/<c:barChart>/, 'bar'],
  [/<c:lineChart>/, 'line'],
  [/<c:pie3DChart>|<c:pieChart>|<c:doughnutChart>/, 'pie'],
  [/<c:areaChart>/, 'area'],
  [/<c:scatterChart>/, 'scatter']
]

// The charts on a slide, as SlideChartElements carrying a data snapshot read from
// the chart part's caches (so the deck stays self-contained). A pptx chart is a
// <c:chart> referenced from an <a:graphicFrame> through the slide rels.
function slideCharts(
  files: Record<string, Uint8Array>,
  slideName: string,
  strFromU8: (u: Uint8Array) => string,
  slideIndex: number,
  sldCx: number,
  sldCy: number
): SlideChartElement[] {
  const n = slideName.match(/slide(\d+)\.xml$/)?.[1]
  if (!n) return []
  const relsBuf = files[`ppt/slides/_rels/slide${n}.xml.rels`]
  if (!relsBuf) return []
  const rels = new Map<string, string>()
  for (const rel of strFromU8(relsBuf).match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /Id="([^"]+)"/.exec(rel)?.[1]
    const target = /Target="([^"]+)"/.exec(rel)?.[1]
    if (id && target && /chart/i.test(target)) rels.set(id, target.replace(/^\.\.\//, 'ppt/').replace(/^\//, ''))
  }
  if (!rels.size) return []

  const out: SlideChartElement[] = []
  const frames = strFromU8(files[slideName]).split(/<p:graphicFrame\b/).slice(1)
  let idx = 0
  for (const chunk of frames) {
    const frame = chunk.split(/<\/p:graphicFrame>/)[0]
    const rId = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(frame)?.[1]
    if (!rId) continue
    const key = rels.get(rId)
    if (!key || !files[key]) continue
    const chartXml = strFromU8(files[key])
    const type = CHART_TAG_TYPE.find(([re]) => re.test(chartXml))?.[1] ?? 'bar'
    const stacked = /<c:grouping\s+val="stacked"/.test(chartXml)
    const titleBlock = /<c:title>[\s\S]*?<\/c:title>/.exec(chartXml)?.[0] ?? ''
    const title = [...titleBlock.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('').trim()

    let categories: string[] = []
    const series: Array<{ name: string; values: number[] }> = []
    for (const serChunk of chartXml.split(/<c:ser>/).slice(1)) {
      const ser = serChunk.split(/<\/c:ser>/)[0]
      const txBlock = /<c:tx>[\s\S]*?<\/c:tx>/.exec(ser)?.[0] ?? ''
      const name = cacheValues(txBlock)[0] ?? `Series ${series.length + 1}`
      const catBlock = /<c:cat>[\s\S]*?<\/c:cat>/.exec(ser)?.[0] ?? ''
      const valBlock = /<c:val>[\s\S]*?<\/c:val>/.exec(ser)?.[0] ?? ''
      const cats = cacheValues(catBlock)
      if (cats.length > categories.length) categories = cats
      const values = cacheValues(valBlock).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0))
      series.push({ name, values })
    }
    if (!series.length) continue

    const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(frame)
    const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(frame)
    const emuX = off ? Number(off[1]) : sldCx * 0.1
    const emuY = off ? Number(off[2]) : sldCy * 0.1
    const emuW = ext ? Number(ext[1]) : sldCx * 0.6
    const emuH = ext ? Number(ext[2]) : sldCy * 0.5
    out.push({
      id: `chart-${slideIndex}-${idx++}`,
      type: 'chart',
      x: Math.round((emuX / sldCx) * SLIDE_W),
      y: Math.round((emuY / sldCy) * SLIDE_H),
      w: Math.round((emuW / sldCx) * SLIDE_W),
      h: Math.round((emuH / sldCy) * SLIDE_H),
      z: 80 + idx,
      chart: { type, ...(title ? { title } : {}), data: { categories, series }, ...(stacked ? { stacked: true } : {}) }
    })
  }
  return out
}

// Pure .pptx → SlidesImportResult. Extracted so it can be unit-tested against a
// real (pptxgenjs-generated) buffer without a file dialog.
export async function parsePptx(data: Uint8Array, name: string): Promise<SlidesImportResult> {
  try {
    const { unzipSync, strFromU8 } = await import('fflate')
    const files = unzipSync(data) as Record<string, Uint8Array>
    const slideNames = Object.keys(files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)/)![1], 10) - parseInt(b.match(/(\d+)/)![1], 10))
    if (!slideNames.length) return { ok: false, error: 'No slides found in that file.' }

    // Slide size in EMU (default widescreen 13.333x7.5in) for the EMU→logical map.
    const pres = files['ppt/presentation.xml'] ? strFromU8(files['ppt/presentation.xml']) : ''
    const sz = /<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(pres)
    const sldCx = sz ? Number(sz[1]) : 12192000
    const sldCy = sz ? Number(sz[2]) : 6858000

    const slides: Slide[] = slideNames.map((sn, i) => {
      // Exclude table/chart frames from the title/body text so their cell text is
      // not double-counted as bullets.
      const paras = paragraphs(placeholdersOnly(stripGraphicFrames(strFromU8(files[sn]))))
      const title = paras[0] ?? `Slide ${i + 1}`
      const bullets = paras.slice(1)
      const notes = notesForSlide(files, sn, strFromU8)
      return { id: `imp-${i}`, title, bullets, notes, layout: bullets.length ? 'title-content' : 'title' }
    })

    // Autoshapes whose geometry has no honest equivalent in our four shapes.
    let skippedShapes = 0
    const theme = parseTheme(files, strFromU8)
    // pptx font sizes are hundredths of a point; our space is SLIDE_W logical
    // units across whatever the deck's real width is, so derive the conversion
    // rather than assuming a 13.333in slide.
    const ptToLogical = SLIDE_W / (sldCx / 914400) / 72
    const body = migrateSlidesBody({ slides })
    // Attach imported pictures and tables onto each migrated slide's element list
    // so they render alongside the title/body text rather than being dropped.
    body.slides.forEach((slide, i) => {
      const shapeResult = slideShapes(strFromU8(files[slideNames[i]]), i, sldCx, sldCy, theme)
      skippedShapes += shapeResult.skipped
      const extras = [
        ...shapeResult.shapes,
        ...slideTextBoxes(strFromU8(files[slideNames[i]]), i, sldCx, sldCy, theme, ptToLogical),
        ...slideImages(files, slideNames[i], strFromU8, sldCx, sldCy),
        ...slideTables(strFromU8(files[slideNames[i]]), i, sldCx, sldCy),
        ...slideCharts(files, slideNames[i], strFromU8, i, sldCx, sldCy)
      ]
      if (extras.length) slide.elements = [...(slide.elements ?? []), ...extras]
    })

    return { ok: true, name, body, ...(skippedShapes ? { skippedShapes } : {}) }
  } catch (e) {
    return { ok: false, error: `Could not read that file: ${(e as Error).message}` }
  }
}

export async function importPptx(): Promise<SlidesImportResult> {
  const res = await dialog.showOpenDialog(win()!, {
    title: 'Import PowerPoint',
    properties: ['openFile'],
    filters: [{ name: 'PowerPoint', extensions: ['pptx'] }]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false }
  const path = res.filePaths[0]
  const buf = await readFile(path)
  return await parsePptx(new Uint8Array(buf), basename(path))
}

// Save-dialog wrappers used by IPC.
export async function exportSlides(input: { body: SlidesBody; title: string; format: 'pptx' | 'pdf' }): Promise<SlidesExportResult> {
  const safe = (input.title || 'presentation').replace(/[/\\?%*:|"<>]/g, '-')
  const res = await dialog.showSaveDialog(win()!, {
    title: `Export as ${input.format.toUpperCase()}`,
    defaultPath: `${safe}.${input.format}`,
    filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }
  return input.format === 'pptx' ? exportPptx(input.body, input.title, res.filePath) : exportSlidesPdf(input.body, res.filePath)
}
