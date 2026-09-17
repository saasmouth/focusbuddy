// PlexiDraw brush engine — the marks the tools actually make.
//
// A brush is a STAMP repeated along the stroke. Everything that distinguishes a
// pencil from an airbrush from a bristle brush comes out of six ideas:
//
//   shape     round, a flat chisel nib, a spray of dots, or a rake of bristles
//   spacing   how far apart the stamps sit, as a fraction of the diameter
//   hardness  how quickly the stamp fades from solid centre to nothing
//   jitter    scatter in position, size and angle, which is what makes a mark
//             read as charcoal or chalk rather than as a machine-drawn tube
//   dynamics  what pressure and speed do to size and opacity
//   grain     a deterministic per-stamp alpha wobble that gives dry media tooth
//
// Two things make the result look like paint rather than like a series of discs:
//
//  1. A stroke is painted on a SCRATCH canvas at full strength and composited
//     onto the layer once, on pointer-up. Without that, every overlapping stamp
//     darkens the one beneath it and a 50%-opacity stroke comes out blotchy.
//  2. The randomness is seeded from the stamp's own position, so a stroke looks
//     identical every time it is re-rendered and a test can assert on it.

export type BrushShape = 'round' | 'chisel' | 'spray' | 'bristle'

export interface BrushPreset {
  id: string
  name: string
  /** What it is for, shown as the control's tooltip. */
  blurb: string
  icon: string
  shape: BrushShape
  /** 0 = fully feathered edge, 1 = a hard edge. */
  hardness: number
  /** Stamp spacing as a fraction of the diameter. Smaller is smoother and slower. */
  spacing: number
  /** Stamp width as a fraction of its height. 1 is circular. */
  roundness: number
  /** Nib angle in degrees, for chisel and flattened round stamps. */
  angle: number
  /** Nib angle follows the direction of travel — what makes calligraphy swell. */
  angleFollowsStroke: boolean
  /** Positional scatter, as a fraction of the diameter. */
  jitter: number
  /** Random size variation per stamp, 0..1. */
  sizeJitter: number
  /** Random angle variation per stamp, in degrees. */
  angleJitter: number
  /** Stamps laid per step. Above 1 gives spray and charcoal their broken texture. */
  scatter: number
  /** How much of the colour each stamp lays down, 0..1. */
  flow: number
  /** Per-stamp alpha wobble, 0..1 — the tooth of dry media. */
  grain: number
  /** Bristle count and spread, for rake-like marks. */
  bristles: number
  bristleSpread: number
  /** Pressure drives the stamp size. */
  pressureSize: boolean
  /** Pressure drives the stamp opacity. */
  pressureFlow: boolean
  /** A fast stroke thins, the way a real nib does. 0 disables it. */
  speedTaper: number
  /** How the whole stroke composites onto the layer. */
  blend: 'source-over' | 'multiply' | 'darken' | 'screen' | 'overlay'
  /** Default diameter in document px. */
  size: number
  /** Default stroke opacity, 0..1. */
  opacity: number
}

function preset(p: Partial<BrushPreset> & Pick<BrushPreset, 'id' | 'name' | 'blurb' | 'icon'>): BrushPreset {
  return {
    shape: 'round',
    hardness: 0.85,
    spacing: 0.14,
    roundness: 1,
    angle: 0,
    angleFollowsStroke: false,
    jitter: 0,
    sizeJitter: 0,
    angleJitter: 0,
    scatter: 1,
    flow: 1,
    grain: 0,
    bristles: 0,
    bristleSpread: 0,
    pressureSize: true,
    pressureFlow: false,
    speedTaper: 0,
    blend: 'source-over',
    size: 24,
    opacity: 1,
    ...p
  }
}

export const BRUSH_PRESETS: BrushPreset[] = [
  preset({
    id: 'round-hard',
    name: 'Hard round',
    blurb: 'A crisp, fully opaque round brush. The everyday mark.',
    icon: 'circle',
    hardness: 1,
    spacing: 0.1
  }),
  preset({
    id: 'round-soft',
    name: 'Soft round',
    blurb: 'A feathered round brush for blending, shading and glows.',
    icon: 'blur_on',
    hardness: 0.12,
    spacing: 0.06,
    flow: 0.85
  }),
  preset({
    id: 'airbrush',
    name: 'Airbrush',
    blurb: 'Very soft and low flow — colour builds up as you work over it.',
    icon: 'cloud',
    hardness: 0,
    spacing: 0.04,
    flow: 0.12,
    pressureFlow: true,
    size: 60,
    opacity: 0.85
  }),
  preset({
    id: 'pencil',
    name: 'Pencil',
    blurb: 'Hard, fine and grainy. For sketching and hatching.',
    icon: 'edit',
    hardness: 0.95,
    spacing: 0.07,
    size: 5,
    grain: 0.45,
    jitter: 0.12,
    pressureFlow: true,
    opacity: 0.9,
    blend: 'multiply'
  }),
  preset({
    id: 'ink',
    name: 'Ink pen',
    blurb: 'Solid black-line work that tapers as the stroke speeds up.',
    icon: 'draw',
    hardness: 1,
    spacing: 0.05,
    size: 10,
    speedTaper: 0.55,
    pressureSize: true
  }),
  preset({
    id: 'calligraphy',
    name: 'Calligraphy',
    blurb: 'A flat nib held at an angle — the stroke swells and thins with direction.',
    icon: 'stylus_note',
    shape: 'chisel',
    hardness: 0.95,
    roundness: 0.16,
    angle: -40,
    spacing: 0.04,
    size: 28
  }),
  preset({
    id: 'marker',
    name: 'Marker',
    blurb: 'A flat chisel tip that darkens where strokes cross.',
    icon: 'ink_highlighter',
    shape: 'chisel',
    hardness: 0.8,
    roundness: 0.45,
    angle: -30,
    spacing: 0.05,
    size: 34,
    flow: 0.55,
    opacity: 0.75,
    blend: 'multiply',
    pressureSize: false
  }),
  preset({
    id: 'charcoal',
    name: 'Charcoal',
    blurb: 'Broken, scattered and dry. Good for tone and rough sketching.',
    icon: 'grain',
    hardness: 0.35,
    spacing: 0.1,
    size: 40,
    scatter: 4,
    jitter: 0.42,
    sizeJitter: 0.55,
    grain: 0.6,
    flow: 0.42,
    opacity: 0.9,
    blend: 'multiply'
  }),
  preset({
    id: 'chalk',
    name: 'Chalk',
    blurb: 'Dusty and textured, with a soft edge that catches the tooth.',
    icon: 'texture',
    hardness: 0.5,
    spacing: 0.09,
    size: 30,
    scatter: 3,
    jitter: 0.3,
    sizeJitter: 0.4,
    grain: 0.5,
    flow: 0.5
  }),
  preset({
    id: 'spray',
    name: 'Spray',
    blurb: 'A cone of fine dots — stipple, texture and soft gradients.',
    icon: 'sprinkler',
    shape: 'spray',
    hardness: 0.9,
    spacing: 0.12,
    size: 70,
    scatter: 16,
    jitter: 1,
    sizeJitter: 0.6,
    flow: 0.3,
    opacity: 0.9
  }),
  preset({
    id: 'watercolour',
    name: 'Watercolour',
    blurb: 'Translucent washes that deepen where they overlap.',
    icon: 'water_drop',
    hardness: 0.05,
    spacing: 0.05,
    size: 64,
    flow: 0.1,
    sizeJitter: 0.25,
    jitter: 0.12,
    opacity: 0.7,
    blend: 'multiply',
    pressureFlow: true
  }),
  preset({
    id: 'oil',
    name: 'Oil bristle',
    blurb: 'A rake of bristles that leaves visible brush hair in the paint.',
    icon: 'brush',
    shape: 'bristle',
    hardness: 0.7,
    spacing: 0.035,
    size: 46,
    bristles: 9,
    bristleSpread: 0.9,
    flow: 0.55,
    grain: 0.25,
    angleFollowsStroke: true
  })
]

export function findBrushPreset(id: string): BrushPreset {
  return BRUSH_PRESETS.find((b) => b.id === id) ?? BRUSH_PRESETS[0]
}

/** The live settings of the brush tool: a preset plus the author's overrides. */
export interface BrushSettings extends BrushPreset {
  color: string
}

export function brushFromPreset(p: BrushPreset, color = '#1c1917'): BrushSettings {
  return { ...p, color }
}

export const DEFAULT_BRUSH: BrushSettings = brushFromPreset(BRUSH_PRESETS[0])

// ── Stamp placement ──────────────────────────────────────────────────────────

export interface StrokePoint {
  x: number
  y: number
  /** 0..1. A mouse reports 0.5; a stylus reports the real thing. */
  pressure: number
}

export interface Stamp {
  x: number
  y: number
  /** Radius along the nib's long axis. */
  rx: number
  /** Radius across it. */
  ry: number
  /** Degrees. */
  angle: number
  /** 0..1, the alpha this single stamp lays down. */
  alpha: number
}

/**
 * A deterministic pseudo-random value in [0,1) from a position and a salt.
 * Seeding from the stamp's own coordinates (rather than a running counter) is
 * what makes a stroke reproducible: re-rendering the same stroke gives the same
 * grain, so nothing shimmers and a test can assert on the result.
 */
export function noiseAt(x: number, y: number, salt: number): number {
  let h = Math.imul(Math.round(x * 16) ^ Math.imul(Math.round(y * 16), 0x9e3779b1), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(salt + 1, 0xc2b2ae35), 0x27d4eb2f)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * The stamps one segment of a stroke lays down. Pure, so the whole feel of every
 * brush is testable without a canvas.
 */
export function stampsForSegment(from: StrokePoint, to: StrokePoint, brush: BrushSettings): Stamp[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  const baseR = Math.max(0.5, brush.size / 2)
  const spacing = Math.max(0.5, baseR * 2 * Math.max(0.02, brush.spacing))
  const steps = Math.max(1, Math.ceil(dist / spacing))
  const dirDeg = (Math.atan2(dy, dx) * 180) / Math.PI

  // A fast stroke thins, the way ink does when the nib outruns the flow. Speed
  // is how far the POINTER travelled in one move event — dividing by the step
  // count would just give back the spacing, which is constant, and the taper
  // would never vary at all.
  const taper = brush.speedTaper > 0 ? 1 - Math.min(0.75, (dist / (baseR * 8)) * brush.speedTaper) : 1

  const out: Stamp[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const px = from.x + dx * t
    const py = from.y + dy * t
    const pressure = clamp01(from.pressure + (to.pressure - from.pressure) * t)

    const sizeScale = (brush.pressureSize ? 0.35 + 0.65 * pressure : 1) * taper
    const flow = brush.flow * (brush.pressureFlow ? 0.25 + 0.75 * pressure : 1)

    for (let s = 0; s < Math.max(1, Math.round(brush.scatter)); s++) {
      const n1 = noiseAt(px, py, s * 3 + 1)
      const n2 = noiseAt(px, py, s * 3 + 2)
      const n3 = noiseAt(px, py, s * 3 + 3)

      // A spray throws its dots across a disc; everything else jitters slightly
      // around the path.
      const spread = brush.shape === 'spray' ? baseR : baseR * brush.jitter
      const ang = n1 * Math.PI * 2
      const rad = brush.shape === 'spray' ? Math.sqrt(n2) * spread : (n2 - 0.5) * 2 * spread
      const jx = Math.cos(ang) * rad
      const jy = Math.sin(ang) * rad

      const stampR =
        brush.shape === 'spray'
          ? Math.max(0.5, baseR * 0.06 * (1 + n3 * 2))
          : Math.max(0.3, baseR * sizeScale * (1 - brush.sizeJitter * n3))

      const grainAlpha = brush.grain > 0 ? 1 - brush.grain * noiseAt(px + jx, py + jy, 7 + s) : 1
      const alpha = clamp01(flow * grainAlpha)
      if (alpha <= 0.002) continue

      const angle =
        (brush.angleFollowsStroke ? dirDeg : brush.angle) + (brush.angleJitter ? (noiseAt(px, py, 11 + s) - 0.5) * 2 * brush.angleJitter : 0)

      if (brush.shape === 'bristle' && brush.bristles > 1) {
        // Bristles rake ACROSS the direction of travel, which is what leaves the
        // parallel hair marks a loaded brush does.
        const across = ((dirDeg + 90) * Math.PI) / 180
        const half = (brush.bristles - 1) / 2
        for (let b = 0; b < brush.bristles; b++) {
          const off = ((b - half) / Math.max(1, half)) * baseR * brush.bristleSpread
          const bn = noiseAt(px + b * 13, py, 17 + b)
          out.push({
            x: px + jx + Math.cos(across) * off,
            y: py + jy + Math.sin(across) * off,
            rx: Math.max(0.3, (baseR / brush.bristles) * 1.5 * sizeScale * (0.6 + bn * 0.8)),
            ry: Math.max(0.3, (baseR / brush.bristles) * 1.5 * sizeScale * (0.6 + bn * 0.8)),
            angle,
            alpha: clamp01(alpha * (0.55 + bn * 0.6))
          })
        }
        continue
      }

      out.push({
        x: px + jx,
        y: py + jy,
        rx: stampR,
        ry: Math.max(0.3, stampR * (brush.shape === 'chisel' || brush.roundness < 1 ? brush.roundness : 1)),
        angle,
        alpha
      })
    }
  }
  return out
}

/** The single stamp a click (with no drag) lays down, so a dot is still a mark. */
export function stampsForDot(p: StrokePoint, brush: BrushSettings): Stamp[] {
  return stampsForSegment({ ...p, x: p.x - 0.01, y: p.y }, p, brush)
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
