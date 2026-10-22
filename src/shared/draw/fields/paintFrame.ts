// A paint layer's own frame (4.3.41): where its pixels lie in document space,
// written when the layer follows its artboard (see ops/artboards.ts). It
// reaches markup (the exported <image>'s x, y, width and height) and sizes a
// <canvas>, so only finite whole numbers within the artboard limits pass.

import { registerDrawField } from '../fieldHooks'

/** Same limit as an artboard side (ops/artboards.ts ARTBOARD_MAX): a paint layer is never larger than a page can be. */
const MAX_SIDE = 16384
/** Positions as far out as the pasteboard can grow, with room to spare. */
const MAX_POS = 1_000_000

export function normPaintFrame(v: unknown): { x: number; y: number; w: number; h: number } | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const f = v as Record<string, unknown>
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  if (!num(f.x) || !num(f.y) || !num(f.w) || !num(f.h)) return undefined
  const x = Math.round(f.x)
  const y = Math.round(f.y)
  const w = Math.round(f.w)
  const h = Math.round(f.h)
  if (Math.abs(x) > MAX_POS || Math.abs(y) > MAX_POS || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) return undefined
  return { x, y, w, h }
}

registerDrawField('layer', 'frame', normPaintFrame)
