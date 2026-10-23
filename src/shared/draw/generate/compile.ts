// A validated scene becomes PlexiiDraw's own objects.
//
// Everything a model asked for is built with the SAME geometry the drawing
// tools use — rectPath, ellipsePath, polygonPath, starPath and parsePathData
// — so generated art is ordinary editable art: anchor points you can drag, a
// fill you can change, a stroke you can restyle. That is the whole point of
// the vector route; a picture of a drawing would have been an image.
//
// TWO RULES THIS FILE EXISTS TO KEEP:
//
//   NOTHING IS SHARED. Every node gets its own fill object, its own stroke
//   object and its own path. Two nodes pointing at one fill looks right on
//   screen and then changes both when someone edits one, and a structure that
//   refers to itself breaks the save (the "cyclic data" duplicate-save bug).
//   freshPaint/freshStroke exist so there is no way to pass the same object
//   twice, and the no-aliasing test walks the output to prove it.
//
//   IT STAYS PURE. Text in, nodes out, no DOM and no ids from anywhere but
//   the caller's minter, so the same code runs in the renderer and in a test.

import { ellipsePath, polygonPath, rectPath, roundRectPath, starPath, type DrawPath } from '../../drawGeometry'
import { parsePathData } from '../import/svg/pathData'
import type { DrawDocPaint, DrawDocStroke, DrawGroupNode, DrawNode, DrawPathNode } from '../model'
import { SCENE_LIMITS, type Scene, type SceneNode, type SceneProblem, type ScenePaint, type SceneShape } from './scene'

export interface CompileOptions {
  /** A fresh node id, minted the way the editor mints them (drawId('nd')). */
  newId: () => string
  /** The fill for a node that asked for none. The app's default object fill. */
  defaultFill?: string
}

export interface CompileResult {
  nodes: DrawNode[]
  problems: SceneProblem[]
}

/** A brand-new paint object every time: never a shared reference. */
function freshPaint(colour: ScenePaint | undefined, fallback: string): DrawDocPaint {
  if (colour === 'none') return { type: 'none' }
  return { type: 'solid', color: colour ?? fallback }
}

/** Likewise for strokes, including the paint nested inside. */
function freshStroke(stroke: { color: ScenePaint; width: number } | undefined): DrawDocStroke | undefined {
  if (!stroke || stroke.color === 'none' || stroke.width <= 0) return undefined
  return { paint: { type: 'solid', color: stroke.color }, width: stroke.width, cap: 'butt', join: 'miter' }
}

/**
 * The geometry for one shape, or null when a path string will not parse.
 *
 * `line` is a path of two anchors rather than a zero-height rectangle, so the
 * anchor tools can grab both ends; a rectangle pretending to be a line is the
 * kind of thing that looks fine until someone tries to edit it.
 */
function geometryFor(shape: SceneShape, at: string, problems: SceneProblem[]): { path: DrawPath; extra: Partial<DrawPathNode> } | null {
  switch (shape.kind) {
    case 'rect':
      return shape.radius && shape.radius > 0
        ? { path: roundRectPath(shape.x, shape.y, shape.w, shape.h, shape.radius), extra: { shapeKind: 'rect', cornerRadius: shape.radius } }
        : { path: rectPath(shape.x, shape.y, shape.w, shape.h), extra: { shapeKind: 'rect' } }
    case 'ellipse':
      return { path: ellipsePath(shape.cx, shape.cy, shape.rx, shape.ry), extra: { shapeKind: 'ellipse' } }
    case 'polygon':
      return { path: polygonPath(shape.cx, shape.cy, shape.r, shape.sides), extra: { shapeKind: 'polygon', sides: shape.sides } }
    case 'star':
      return {
        path: starPath(shape.cx, shape.cy, shape.r, shape.points, shape.innerRatio ?? 0.5),
        extra: { shapeKind: 'star', sides: shape.points, innerRatio: shape.innerRatio ?? 0.5 }
      }
    case 'line':
      return {
        path: { subpaths: [{ closed: false, nodes: [{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }] }] },
        extra: {}
      }
    case 'path': {
      // The same parser an imported SVG goes through, with its own node cap:
      // a model that emits a hundred thousand points is refused here rather
      // than in the renderer.
      const parsed = parsePathData(shape.d, SCENE_LIMITS.pathNodes)
      // parsePathData keeps everything it read BEFORE an error, which is right
      // for importing a file someone already has and wrong for a model's
      // output: half a path is a mistake to refuse, not art to accept.
      if (parsed.error) {
        problems.push({ at: `${at}.d`, why: `the path data is malformed (${parsed.error})` })
        return null
      }
      const subpaths = parsed.path.subpaths.filter((sp) => sp.nodes.length > 1)
      if (!subpaths.length) {
        problems.push({ at: `${at}.d`, why: 'the path data drew nothing' })
        return null
      }
      return { path: { subpaths, ...(parsed.path.fillRule ? { fillRule: parsed.path.fillRule } : {}) }, extra: {} }
    }
  }
}

function compileNode(node: SceneNode, at: string, opts: CompileOptions, problems: SceneProblem[]): DrawPathNode | null {
  const geo = geometryFor(node.shape, at, problems)
  if (!geo) return null
  const fill = freshPaint(node.fill, opts.defaultFill ?? '#9ca3af')
  const stroke = freshStroke(node.stroke)
  // A shape with neither fill nor stroke is invisible. A line is the honest
  // exception: it carries no fill, so it gets a stroke if the model forgot.
  const isLine = node.shape.kind === 'line'
  if (isLine && !stroke) {
    return {
      id: opts.newId(),
      type: 'path',
      path: geo.path,
      fill: { type: 'none' },
      stroke: { paint: { type: 'solid', color: node.fill && node.fill !== 'none' ? node.fill : (opts.defaultFill ?? '#1c1917') }, width: 1, cap: 'butt', join: 'miter' },
      ...(node.name ? { name: node.name } : {}),
      ...(node.opacity !== undefined ? { opacity: node.opacity } : {})
    }
  }
  if (fill.type === 'none' && !stroke) {
    problems.push({ at, why: 'a shape with no fill and no stroke would be invisible' })
    return null
  }
  return {
    id: opts.newId(),
    type: 'path',
    path: geo.path,
    fill: isLine ? { type: 'none' } : fill,
    ...(stroke ? { stroke } : {}),
    ...geo.extra,
    ...(node.name ? { name: node.name } : {}),
    ...(node.opacity !== undefined ? { opacity: node.opacity } : {})
  }
}

/**
 * Compile a validated scene into nodes ready for a layer.
 *
 * Paint order follows the scene's order, which is the order the model
 * described: index 0 at the bottom, as layers and groups already work, so a
 * background rectangle written first stays behind the thing on top of it.
 */
export function compileScene(scene: Scene, opts: CompileOptions): CompileResult {
  const problems: SceneProblem[] = []
  const nodes: DrawNode[] = []
  for (const [i, item] of scene.items.entries()) {
    const at = `items[${i}]`
    if ('children' in item) {
      const children = item.children
        .map((c, j) => compileNode(c, `${at}.children[${j}]`, opts, problems))
        .filter((n): n is DrawPathNode => n !== null)
      if (!children.length) continue
      const group: DrawGroupNode = {
        id: opts.newId(),
        type: 'group',
        children,
        ...(item.name ? { name: item.name } : {})
      }
      nodes.push(group)
      continue
    }
    const node = compileNode(item, at, opts, problems)
    if (node) nodes.push(node)
  }
  return { nodes, problems }
}

/** The bounding box of compiled nodes, for the preview and for centring. */
export function sceneBounds(scene: Scene): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const see = (x: number, y: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const visit = (n: SceneNode): void => {
    const s = n.shape
    switch (s.kind) {
      case 'rect':
        see(s.x, s.y)
        see(s.x + s.w, s.y + s.h)
        break
      case 'ellipse':
        see(s.cx - s.rx, s.cy - s.ry)
        see(s.cx + s.rx, s.cy + s.ry)
        break
      case 'polygon':
      case 'star':
        see(s.cx - s.r, s.cy - s.r)
        see(s.cx + s.r, s.cy + s.r)
        break
      case 'line':
        see(s.x1, s.y1)
        see(s.x2, s.y2)
        break
      case 'path': {
        const parsed = parsePathData(s.d, SCENE_LIMITS.pathNodes)
        for (const sp of parsed.path.subpaths) for (const p of sp.nodes) see(p.x, p.y)
        break
      }
    }
  }
  for (const item of scene.items) {
    if ('children' in item) item.children.forEach(visit)
    else visit(item)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
