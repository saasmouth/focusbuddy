// The scene a model returns when asked for vector art, and the validation that
// stands between it and someone's drawing.
//
// WHY A SCHEMA AND NOT SVG. Models write SVG better than they write anything
// we could invent — it is all over their training data, and PlexiiDraw already
// has a hardened importer for it (draw/import/svg). But SVG cannot be
// grammar-constrained, and the on-device model has to produce something
// structured or honestly decline; unconstrained it produces broken XML we
// could only refuse. So the contract is JSON, every field NAMED (node-llama-
// cpp's schema grammar ignores additionalProperties and garbles unnamed
// fields), and a `d` string is still accepted for anything the primitives
// cannot express — parsed by the same parsePathData an imported file goes
// through.
//
// EVERYTHING HERE IS UNTRUSTED. It came from a language model, and a model
// under-specifies, hallucinates fields, emits NaN as a bare word, repeats an
// id, nests groups forever, or returns ten thousand points. Validation is
// therefore total: every value is checked, anything unrecognised is dropped
// rather than carried, and a scene that cannot be drawn is REFUSED with a
// reason rather than half-applied. The budgets below are what keeps a bad
// reply from becoming a hung renderer.

/** A paint the model may ask for: a solid colour, or nothing. */
export type ScenePaint = string | 'none'

export interface SceneStroke {
  color: ScenePaint
  width: number
}

/** The shapes a model can name, each with its own named numeric fields. */
export type SceneShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; radius?: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; cx: number; cy: number; r: number; sides: number }
  | { kind: 'star'; cx: number; cy: number; r: number; points: number; innerRatio?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'path'; d: string }

export interface SceneNode {
  shape: SceneShape
  name?: string
  fill?: ScenePaint
  stroke?: SceneStroke
  opacity?: number
}

export interface SceneGroup {
  name?: string
  children: SceneNode[]
}

export interface Scene {
  name: string
  items: Array<SceneNode | SceneGroup>
}

/** What a scene may contain before we refuse it. Generous for art, finite for safety. */
export const SCENE_LIMITS = {
  items: 200,
  childrenPerGroup: 200,
  /** Total leaf nodes, groups flattened. */
  nodes: 400,
  /** Path nodes per `d` string, passed to parsePathData as its own cap. */
  pathNodes: 2000,
  /** Document-space coordinates outside this are a hallucination, not a drawing. */
  coord: 100_000,
  strokeWidth: 500,
  nameLength: 80,
  /** The JSON text itself; anything larger is not art, it is a runaway. */
  jsonBytes: 400_000
} as const

export interface SceneProblem {
  /** A path like "items[3].shape.w", so a reader can find it. */
  at: string
  /** What was wrong, phrased for the model's retry as well as for a log. */
  why: string
}

export interface SceneResult {
  scene: Scene | null
  /** Everything dropped or refused, in order. Never swallowed silently. */
  problems: SceneProblem[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A finite number inside the coordinate budget. NaN and Infinity are rejected, not clamped. */
function num(v: unknown, at: string, problems: SceneProblem[], opts: { min?: number; max?: number } = {}): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    problems.push({ at, why: 'must be a finite number' })
    return null
  }
  const min = opts.min ?? -SCENE_LIMITS.coord
  const max = opts.max ?? SCENE_LIMITS.coord
  if (v < min || v > max) {
    problems.push({ at, why: `must be between ${min} and ${max}` })
    return null
  }
  return v
}

/**
 * A colour, as #rgb, #rrggbb, #rrggbbaa or the word "none".
 *
 * Deliberately narrow: named CSS colours and rgb() would each need their own
 * parser, and the prompt asks for hex. An unparseable colour is a dropped
 * property, not a dropped shape — the art survives with the default fill.
 */
export function scenePaint(v: unknown, at: string, problems: SceneProblem[]): ScenePaint | null {
  if (v === 'none') return 'none'
  if (typeof v !== 'string') {
    problems.push({ at, why: 'must be a hex colour such as #2563eb, or "none"' })
    return null
  }
  const s = v.trim().toLowerCase()
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) {
    problems.push({ at, why: `"${s.slice(0, 20)}" is not a hex colour` })
    return null
  }
  return s
}

function sceneName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, ' ').trim().slice(0, SCENE_LIMITS.nameLength)
  return s || undefined
}

function shapeOf(raw: unknown, at: string, problems: SceneProblem[]): SceneShape | null {
  if (!isObj(raw)) {
    problems.push({ at, why: 'must be an object with a "kind"' })
    return null
  }
  const n = (k: string, opts?: { min?: number; max?: number }): number | null => num(raw[k], `${at}.${k}`, problems, opts)
  switch (raw.kind) {
    case 'rect': {
      const x = n('x'), y = n('y')
      const w = n('w', { min: 0, max: SCENE_LIMITS.coord }), h = n('h', { min: 0, max: SCENE_LIMITS.coord })
      if (x === null || y === null || w === null || h === null) return null
      if (w === 0 || h === 0) {
        problems.push({ at, why: 'a rectangle with no width or height would be invisible' })
        return null
      }
      const radius = raw.radius === undefined ? undefined : num(raw.radius, `${at}.radius`, problems, { min: 0, max: Math.min(w, h) / 2 })
      return { kind: 'rect', x, y, w, h, ...(radius !== null && radius !== undefined ? { radius } : {}) }
    }
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy')
      const rx = n('rx', { min: 0 }), ry = n('ry', { min: 0 })
      if (cx === null || cy === null || rx === null || ry === null) return null
      if (rx === 0 || ry === 0) {
        problems.push({ at, why: 'an ellipse with no radius would be invisible' })
        return null
      }
      return { kind: 'ellipse', cx, cy, rx, ry }
    }
    case 'polygon': {
      const cx = n('cx'), cy = n('cy'), r = n('r', { min: 0 })
      const sides = n('sides', { min: 3, max: 200 })
      if (cx === null || cy === null || r === null || sides === null || r === 0) return null
      return { kind: 'polygon', cx, cy, r, sides: Math.round(sides) }
    }
    case 'star': {
      const cx = n('cx'), cy = n('cy'), r = n('r', { min: 0 })
      const points = n('points', { min: 3, max: 200 })
      if (cx === null || cy === null || r === null || points === null || r === 0) return null
      const inner = raw.innerRatio === undefined ? undefined : num(raw.innerRatio, `${at}.innerRatio`, problems, { min: 0.05, max: 0.95 })
      return { kind: 'star', cx, cy, r, points: Math.round(points), ...(inner !== null && inner !== undefined ? { innerRatio: inner } : {}) }
    }
    case 'line': {
      const x1 = n('x1'), y1 = n('y1'), x2 = n('x2'), y2 = n('y2')
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null
      if (x1 === x2 && y1 === y2) {
        problems.push({ at, why: 'a line from a point to itself would be invisible' })
        return null
      }
      return { kind: 'line', x1, y1, x2, y2 }
    }
    case 'path': {
      if (typeof raw.d !== 'string' || !raw.d.trim()) {
        problems.push({ at: `${at}.d`, why: 'must be SVG path data' })
        return null
      }
      // Only the cheap checks here; parsePathData does the real parse at
      // compile time, where its own node cap applies.
      if (!/^[\s,.\-+0-9eE]*[MmZzLlHhVvCcSsQqTtAa]/.test(raw.d)) {
        problems.push({ at: `${at}.d`, why: 'does not start with a path command' })
        return null
      }
      return { kind: 'path', d: raw.d }
    }
    default:
      problems.push({ at: `${at}.kind`, why: `"${String(raw.kind).slice(0, 20)}" is not a shape this app draws` })
      return null
  }
}

function nodeOf(raw: unknown, at: string, problems: SceneProblem[]): SceneNode | null {
  if (!isObj(raw)) {
    problems.push({ at, why: 'must be an object' })
    return null
  }
  const shape = shapeOf(raw.shape, `${at}.shape`, problems)
  if (!shape) return null
  const fill = raw.fill === undefined ? null : scenePaint(raw.fill, `${at}.fill`, problems)
  const opacity = raw.opacity === undefined ? null : num(raw.opacity, `${at}.opacity`, problems, { min: 0, max: 1 })
  let stroke: SceneStroke | undefined
  if (isObj(raw.stroke)) {
    const color = scenePaint(raw.stroke.color, `${at}.stroke.color`, problems)
    const width = num(raw.stroke.width, `${at}.stroke.width`, problems, { min: 0, max: SCENE_LIMITS.strokeWidth })
    if (color && color !== 'none' && width !== null && width > 0) stroke = { color, width }
  } else if (raw.stroke !== undefined) {
    problems.push({ at: `${at}.stroke`, why: 'must be an object with a colour and a width' })
  }
  return {
    shape,
    ...(sceneName(raw.name) ? { name: sceneName(raw.name) } : {}),
    ...(fill ? { fill } : {}),
    ...(stroke ? { stroke } : {}),
    ...(opacity !== null ? { opacity } : {})
  }
}

/**
 * Validate a parsed reply into a scene, or refuse it.
 *
 * A node that cannot be drawn is DROPPED and recorded; a scene with nothing
 * left is refused, because "generated" with an empty layer is the fake success
 * this app does not do. Groups are one level deep by design: a model given
 * arbitrary nesting produces arbitrary nesting, and Draw's own grouping is
 * better applied afterwards by the person.
 */
export function validateScene(raw: unknown): SceneResult {
  const problems: SceneProblem[] = []
  if (!isObj(raw)) return { scene: null, problems: [{ at: '', why: 'the reply was not a JSON object' }] }
  if (!Array.isArray(raw.items)) return { scene: null, problems: [{ at: 'items', why: 'the reply has no "items" array' }] }
  if (raw.items.length > SCENE_LIMITS.items) {
    problems.push({ at: 'items', why: `more than ${SCENE_LIMITS.items} items; the rest were dropped` })
  }

  const items: Array<SceneNode | SceneGroup> = []
  let leaves = 0
  for (const [i, rawItem] of (raw.items as unknown[]).slice(0, SCENE_LIMITS.items).entries()) {
    const at = `items[${i}]`
    if (isObj(rawItem) && Array.isArray(rawItem.children)) {
      const children: SceneNode[] = []
      for (const [j, rawChild] of rawItem.children.slice(0, SCENE_LIMITS.childrenPerGroup).entries()) {
        if (leaves >= SCENE_LIMITS.nodes) break
        const child = nodeOf(rawChild, `${at}.children[${j}]`, problems)
        if (child) {
          children.push(child)
          leaves++
        }
      }
      // An empty group is not art; it is a group the model described and then
      // failed to fill. Dropping it beats leaving an empty folder in Layers.
      if (children.length) items.push({ ...(sceneName(rawItem.name) ? { name: sceneName(rawItem.name) } : {}), children })
      else problems.push({ at, why: 'a group with nothing drawable in it' })
      continue
    }
    if (leaves >= SCENE_LIMITS.nodes) {
      problems.push({ at, why: `more than ${SCENE_LIMITS.nodes} shapes; the rest were dropped` })
      break
    }
    const node = nodeOf(rawItem, at, problems)
    if (node) {
      items.push(node)
      leaves++
    }
  }

  if (!items.length) {
    return { scene: null, problems: problems.length ? problems : [{ at: 'items', why: 'nothing in the reply could be drawn' }] }
  }
  return { scene: { name: sceneName(raw.name) ?? 'Generated art', items }, problems }
}

/** The one-line reason to show when a scene is refused, built from the problems. */
export function refusalReason(problems: SceneProblem[]): string {
  if (!problems.length) return 'The model returned nothing that could be drawn.'
  const first = problems[0]!
  const where = first.at ? `${first.at}: ` : ''
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''
  return `${where}${first.why}${more}`
}
