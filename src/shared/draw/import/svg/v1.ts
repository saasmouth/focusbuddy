// Imported art lowered to what an OLDER-FORMAT drawing can hold.
//
// While v2 writes are gated (DRAW_V2_WRITES, see draw/README.md), a drawing
// that is still v1 must stay v1: older PlexiiDraw builds must keep being able
// to edit it. The importer always builds the full v2 structure; this pass then
// takes it down to v1's vocabulary, as faithfully as v1 allows, and says
// exactly what that cost:
//
//   - groups are released into their members (group opacity is applied to
//     each member, which differs only where members overlap);
//   - clipping groups are applied to the clipped shapes' geometry (curves are
//     flattened; strokes follow the new outline; an open path, text or image
//     inside a clip is left unclipped);
//   - gradients convert exactly to v1's angle / centred-circle forms when
//     they fit them (every gradient PlexiiDraw made does), otherwise as
//     closely as those forms allow;
//   - a skew or reflection on an image or text is approximated by the nearest
//     rotation and scale.
// When the drawing can be v2, none of this runs and nothing is lost.

import { booleanPath, pathBounds, type DrawPath } from '../../../drawGeometry'
import type { DrawDocPaint, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode, Matrix } from '../../model'
import { gradientToV1 } from './paint'
import { placeFrame } from './importer'
import type { SvgImportReport } from './report'
import { decompose } from './transform'

function isAxisRect(p: DrawPath): boolean {
  if (p.subpaths.length !== 1) return false
  const sp = p.subpaths[0]
  if (!sp.closed || sp.nodes.length !== 4) return false
  if (sp.nodes.some((n) => n.inX !== undefined || n.outX !== undefined)) return false
  const xs = new Set(sp.nodes.map((n) => Math.round(n.x * 1e6)))
  const ys = new Set(sp.nodes.map((n) => Math.round(n.y * 1e6)))
  return xs.size === 2 && ys.size === 2
}

function inside(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x >= b.x - 1e-6 && a.y >= b.y - 1e-6 && a.x + a.w <= b.x + b.w + 1e-6 && a.y + a.h <= b.y + b.h + 1e-6
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function lowerToV1(nodes: DrawNode[], report: SvgImportReport): DrawNode[] {
  const approxGradient = (): void =>
    report.note('v1grad', '1 gradient was approximated to fit the older drawing format.', '{n} gradients were approximated to fit the older drawing format.')
  const paint = (p: DrawDocPaint): DrawDocPaint => gradientToV1(p, approxGradient)

  const leaf = (n: DrawNode): DrawNode => {
    if (n.type === 'path') {
      const out: DrawPathNode = { ...n, fill: paint(n.fill), ...(n.stroke ? { stroke: { ...n.stroke, paint: paint(n.stroke.paint) } } : {}) }
      return out
    }
    if (n.type === 'text' || n.type === 'image') {
      let f: DrawTextNode | DrawImageNode = n
      if (f.transform) {
        // Nearest rotation + (uniform, for text) scale.
        const m = f.transform
        const q = decompose(m)
        const sx = Math.abs(q.sx)
        const sy = Math.abs(q.sy)
        const s = Math.sqrt(sx * sy)
        const r = (q.theta * Math.PI) / 180
        const kx = f.type === 'text' ? s : sx
        const ky = f.type === 'text' ? s : sy
        const approx: Matrix = [Math.cos(r) * kx, Math.sin(r) * kx, -Math.sin(r) * ky, Math.cos(r) * ky, 0, 0]
        // Keep the frame's centre where the full matrix put it.
        const c = f.type === 'image' ? { x: f.x + f.w / 2, y: f.y + f.h / 2 } : { x: f.x + f.w / 2, y: f.y }
        const target = { x: m[0] * c.x + m[2] * c.y + m[4], y: m[1] * c.x + m[3] * c.y + m[5] }
        approx[4] = target.x - (approx[0] * c.x + approx[2] * c.y)
        approx[5] = target.y - (approx[1] * c.x + approx[3] * c.y)
        const { transform: _drop, ...rest } = f
        void _drop
        f = placeFrame(rest as DrawTextNode | DrawImageNode, approx, f.type === 'text')
        report.note('v1skew', `1 ${n.type === 'text' ? 'text object' : 'image'} was skewed or mirrored, which the older drawing format cannot hold; the nearest rotation and scale were used.`, '{n} skewed or mirrored objects were approximated with the nearest rotation and scale for the older drawing format.')
      }
      if (f.type === 'text') return { ...f, fill: paint(f.fill), ...(f.stroke ? { stroke: { ...f.stroke, paint: paint(f.stroke.paint) } } : {}) }
      return f
    }
    return n
  }

  const multiplyOpacity = (n: DrawNode, k: number): DrawNode => {
    if (k >= 1) return n
    const o = (n.opacity ?? 1) * k
    return { ...n, opacity: Math.round(o * 10000) / 10000 }
  }

  const clipTo = (n: DrawNode, clip: DrawPath): DrawNode | null => {
    if (n.type !== 'path') {
      if (n.type === 'text' || n.type === 'image')
        report.note('v1clipframe', `1 ${n.type === 'text' ? 'text object' : 'image'} inside a clipping mask was left unclipped (the older drawing format has no clipping masks).`, '{n} texts or images inside clipping masks were left unclipped (the older drawing format has no clipping masks).')
      return n
    }
    const cb = pathBounds(clip)
    const pb = pathBounds(n.path)
    if (!overlaps(pb, cb)) return null
    if (isAxisRect(clip) && inside(pb, cb)) return n
    if (n.path.subpaths.some((s) => !s.closed)) {
      report.note('v1clipopen', '1 open path inside a clipping mask was left unclipped (the older drawing format has no clipping masks).', '{n} open paths inside clipping masks were left unclipped (the older drawing format has no clipping masks).')
      return n
    }
    const cut = booleanPath(n.path, clip, 'intersect')
    if (!cut.subpaths.length) return null
    report.note('v1clip', '1 shape was cut to its clipping mask, because the older drawing format has no clipping masks.', '{n} shapes were cut to their clipping masks, because the older drawing format has no clipping masks.')
    const { shapeKind: _k, cornerRadius: _r, ...rest } = n
    void _k
    void _r
    return { ...rest, path: cut }
  }

  const visit = (list: DrawNode[]): DrawNode[] => {
    const out: DrawNode[] = []
    for (const n of list) {
      if (n.type !== 'group') {
        out.push(leaf(n))
        continue
      }
      let kids = n.children
      let clip: DrawPath | null = null
      if (n.clip && kids.length) {
        const top = kids[kids.length - 1]
        if (top.type === 'path') clip = top.path
        kids = kids.slice(0, -1)
      }
      let flat = visit(kids)
      if (clip) flat = flat.map((k) => clipTo(k, clip!)).filter((k): k is DrawNode => k !== null)
      const k = n.opacity ?? 1
      if (k < 1 && flat.length > 1) report.note('v1groupop', '1 group had its opacity applied to each of its objects (the older drawing format has no groups), which differs where they overlap.', '{n} groups had their opacity applied to each of their objects (the older drawing format has no groups), which differs where they overlap.')
      if (n.blend && n.blend !== 'normal' && flat.length > 1) report.note('v1groupblend', "1 group's blend mode was applied to each of its objects (the older drawing format has no groups).", "{n} groups' blend modes were applied to each of their objects (the older drawing format has no groups).")
      for (const c of flat) {
        let m = multiplyOpacity(c, k)
        if (n.blend && n.blend !== 'normal' && !m.blend) m = { ...m, blend: n.blend }
        out.push(m)
      }
    }
    return out
  }
  const out = visit(nodes)
  const groups = countGroups(nodes)
  if (groups) {
    const why = 'because this drawing is still in the older format (it keeps working in older PlexiiDraw builds)'
    report.note('v1groups', groups === 1 ? `1 group was released into its objects, ${why}.` : `${groups} groups were released into their objects, ${why}.`, '', false)
  }
  return out
}

function countGroups(nodes: DrawNode[]): number {
  let n = 0
  for (const c of nodes) if (c.type === 'group') n += 1 + countGroups(c.children)
  return n
}
