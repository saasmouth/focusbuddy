import { stampsForDot, stampsForSegment, type BrushSettings, type Stamp, type StrokePoint } from './brushes'

// PlexiDraw raster engine — the Photoshop half of the studio.
//
// A raster layer is one <canvas> the size of the artboard. Every painting tool
// writes into that canvas's 2D context immediately (so the stroke appears under
// the cursor with no round trip), and only on pointer-up is the result read back
// as a PNG data URL and committed to the document. That split is what keeps
// painting at 60fps while still leaving ONE undoable change per stroke rather
// than one per pointermove.

export type { BrushSettings, BrushPreset, StrokePoint } from './brushes'
export { BRUSH_PRESETS, DEFAULT_BRUSH, brushFromPreset, findBrushPreset } from './brushes'

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

export function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // willReadFrequently keeps the flood fill and the eyedropper off the GPU
  // round-trip path, which is otherwise a very visible stall on a large canvas.
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('This device could not provide a 2D drawing surface.')
  return ctx
}

/** Paint a stored PNG into a canvas, replacing whatever was there. Empty src clears it. */
export async function loadIntoCanvas(canvas: HTMLCanvasElement, src: string): Promise<void> {
  const ctx = context(canvas)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!src) return
  await new Promise<void>((resolve) => {
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve()
    }
    // A layer whose pixels cannot be decoded resolves as empty rather than
    // hanging the editor — the layer then reads as blank, which is the truth.
    img.onerror = () => resolve()
    img.src = src
  })
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png')
}

export function isCanvasEmpty(canvas: HTMLCanvasElement): boolean {
  const data = context(canvas).getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false
  return true
}

// ── Brush ────────────────────────────────────────────────────────────────────

/**
 * Draw one stamp. A hardness below 1 is a radial gradient that is solid out to
 * `hardness` of the radius and fades to nothing at the rim — the construction a
 * soft round brush uses, and the reason strokes blend instead of showing a hard
 * disc edge.
 */
function drawStamp(ctx: CanvasRenderingContext2D, stamp: Stamp, color: string, hardness: number): void {
  if (stamp.rx <= 0 || stamp.ry <= 0) return
  ctx.save()
  ctx.globalAlpha = stamp.alpha
  ctx.translate(stamp.x, stamp.y)
  if (stamp.angle) ctx.rotate((stamp.angle * Math.PI) / 180)
  if (hardness >= 0.999) {
    ctx.fillStyle = color
  } else {
    const g = ctx.createRadialGradient(0, 0, Math.max(0, stamp.rx * hardness), 0, 0, stamp.rx)
    g.addColorStop(0, color)
    g.addColorStop(1, 'transparent')
    ctx.fillStyle = g
  }
  ctx.beginPath()
  ctx.ellipse(0, 0, stamp.rx, stamp.ry, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Paint one segment of a stroke onto the SCRATCH canvas. Strokes are built at
 * full strength on scratch and composited once, on pointer-up — without that,
 * every overlapping stamp darkens the last and a half-opacity stroke comes out
 * blotchy instead of even.
 */
export function paintSegment(ctx: CanvasRenderingContext2D, from: StrokePoint, to: StrokePoint, brush: BrushSettings): void {
  for (const stamp of stampsForSegment(from, to, brush)) drawStamp(ctx, stamp, brush.color, brush.hardness)
}

/** The mark a click with no drag leaves, so a dot is still a dot. */
export function paintDot(ctx: CanvasRenderingContext2D, p: StrokePoint, brush: BrushSettings): void {
  for (const stamp of stampsForDot(p, brush)) drawStamp(ctx, stamp, brush.color, brush.hardness)
}

/**
 * Lay a finished scratch stroke onto its layer, once, at the stroke's opacity
 * and blend mode. Erasing punches the scratch shape out of the layer instead.
 */
export function compositeStroke(layer: HTMLCanvasElement, scratch: HTMLCanvasElement, opacity: number, blend: string, erase: boolean): void {
  const ctx = context(layer)
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.globalCompositeOperation = erase ? 'destination-out' : blend === 'source-over' ? 'source-over' : (blend as GlobalCompositeOperation)
  ctx.drawImage(scratch, 0, 0)
  ctx.restore()
}

// ── Colour ───────────────────────────────────────────────────────────────────

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1]
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
}

export function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The colour at a point, or null where the pixel is transparent — the
 * eyedropper reports "nothing here" rather than inventing a black sample from
 * an empty layer.
 */
export function samplePixel(canvas: HTMLCanvasElement, x: number, y: number): string | null {
  const px = Math.floor(x)
  const py = Math.floor(y)
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null
  const d = context(canvas).getImageData(px, py, 1, 1).data
  if (d[3] === 0) return null
  return toHex(d[0], d[1], d[2])
}

// ── Flood fill ───────────────────────────────────────────────────────────────

/**
 * Scanline flood fill. Tolerance is 0..1 over the maximum possible RGBA
 * distance, so 0 fills only exactly-matching pixels and 1 fills the whole layer.
 *
 * Returns false when nothing changed (the click landed on a pixel that already
 * holds the fill colour), so the caller can skip an empty undo entry.
 */
export function floodFill(canvas: HTMLCanvasElement, x: number, y: number, color: string, tolerance = 0.12): boolean {
  const ctx = context(canvas)
  const rgb = parseHex(color)
  if (!rgb) return false
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const painted = floodFillPixels(img.data, canvas.width, canvas.height, Math.floor(x), Math.floor(y), [rgb.r, rgb.g, rgb.b, 255], tolerance)
  if (painted) ctx.putImageData(img, 0, 0)
  return painted
}

/**
 * The fill itself, over a raw RGBA buffer so it can be reasoned about and tested
 * without a canvas. Mutates `d` in place and reports whether anything changed.
 */
export function floodFillPixels(
  d: Uint8ClampedArray | number[],
  w: number,
  h: number,
  sx: number,
  sy: number,
  fill: [number, number, number, number],
  tolerance = 0.12
): boolean {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false
  const start = (sy * w + sx) * 4
  const target = [d[start], d[start + 1], d[start + 2], d[start + 3]]
  if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) return false

  // 4 channels x 255 max distance, squared, is the worst case we scale against.
  const maxDist2 = 4 * 255 * 255
  const tol2 = tolerance * tolerance * maxDist2
  const matches = (i: number): boolean => {
    const dr = d[i] - target[0]
    const dg = d[i + 1] - target[1]
    const db = d[i + 2] - target[2]
    const da = d[i + 3] - target[3]
    return dr * dr + dg * dg + db * db + da * da <= tol2
  }

  const seen = new Uint8Array(w * h)
  const stack: number[] = [sx, sy]
  let painted = false

  while (stack.length) {
    const py = stack.pop()!
    let px = stack.pop()!
    let i = (py * w + px) * 4
    // Walk left to the start of this run.
    while (px >= 0 && !seen[py * w + px] && matches(i)) {
      px--
      i -= 4
    }
    px++
    i += 4
    let spanUp = false
    let spanDown = false
    while (px < w && !seen[py * w + px] && matches(i)) {
      seen[py * w + px] = 1
      d[i] = fill[0]
      d[i + 1] = fill[1]
      d[i + 2] = fill[2]
      d[i + 3] = fill[3]
      painted = true
      if (py > 0) {
        const up = ((py - 1) * w + px) * 4
        const inUp = !seen[(py - 1) * w + px] && matches(up)
        if (inUp && !spanUp) {
          stack.push(px, py - 1)
          spanUp = true
        } else if (!inUp) spanUp = false
      }
      if (py < h - 1) {
        const dn = ((py + 1) * w + px) * 4
        const inDn = !seen[(py + 1) * w + px] && matches(dn)
        if (inDn && !spanDown) {
          stack.push(px, py + 1)
          spanDown = true
        } else if (!inDn) spanDown = false
      }
      px++
      i += 4
    }
  }
  return painted
}

// ── Compositing ──────────────────────────────────────────────────────────────

/**
 * Flatten `upper` onto `lower`, honouring the upper layer's opacity and blend
 * mode. Used by merge-down and by flatten-image, which is why it has to respect
 * the same compositing the on-screen stack shows — a merge that changed the
 * picture would be a lie.
 */
export function compositeOnto(lower: HTMLCanvasElement, upper: HTMLCanvasElement, opacity: number, blend: string): void {
  const ctx = context(lower)
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.globalCompositeOperation = blend === 'normal' ? 'source-over' : (blend as GlobalCompositeOperation)
  ctx.drawImage(upper, 0, 0, lower.width, lower.height)
  ctx.restore()
}

export function clearCanvas(canvas: HTMLCanvasElement): void {
  context(canvas).clearRect(0, 0, canvas.width, canvas.height)
}

/**
 * Rasterize an SVG string into a canvas — how a vector layer is flattened into
 * a paint layer, and how the PNG thumbnail of a vector layer is produced.
 */
export async function svgToCanvas(svg: string, w: number, h: number): Promise<HTMLCanvasElement> {
  const canvas = createCanvas(w, h)
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await new Promise<void>((resolve) => {
    const img = new Image()
    img.onload = () => {
      context(canvas).drawImage(img, 0, 0, w, h)
      resolve()
    }
    img.onerror = () => resolve()
    img.src = url
  })
  return canvas
}
