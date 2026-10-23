// The selected objects, described back to the model in the same scene language
// it answers in.
//
// "Make these icons rounder" only means something if the model can see the
// icons. This walks the selection and writes each object as the scene schema's
// own shapes, so the reply can be validated by exactly the same code that
// validates a fresh generation — one contract, one validator, in both
// directions.
//
// What cannot be expressed is LEFT OUT rather than approximated: text, images,
// widgets and gradients have no place in the schema, and a square standing in
// for a photograph would have the model confidently rewriting something that
// is not there. The pane says how many objects are going, so a selection that
// is mostly images does not look like it was all sent.

import type { DrawDoc, DrawNode, DrawPathNode } from '@shared/draw/model'
import type { Scene, SceneNode } from '@shared/draw/generate/scene'
import { SCENE_LIMITS } from '@shared/draw/generate/scene'

/** A solid colour as hex, or undefined when the paint is something else. */
function hexOf(paint: { type: string; color?: string } | undefined): string | undefined {
  if (!paint) return undefined
  if (paint.type === 'none') return 'none'
  if (paint.type === 'solid' && typeof paint.color === 'string') return paint.color
  return undefined
}

/** One path node as scene `d` data, in document coordinates. */
function pathNodeToScene(n: DrawPathNode): SceneNode | null {
  const parts: string[] = []
  let points = 0
  for (const sp of n.path.subpaths) {
    if (sp.nodes.length < 2) continue
    const first = sp.nodes[0]!
    parts.push(`M${round(first.x)} ${round(first.y)}`)
    for (let i = 1; i < sp.nodes.length; i++) {
      const p = sp.nodes[i]!
      const prev = sp.nodes[i - 1]!
      // Cubic when either side carries a handle, a straight line otherwise:
      // the same two cases the renderer draws.
      if (prev.outX !== undefined || p.inX !== undefined) {
        const c1x = prev.outX ?? prev.x
        const c1y = prev.outY ?? prev.y
        const c2x = p.inX ?? p.x
        const c2y = p.inY ?? p.y
        parts.push(`C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p.x)} ${round(p.y)}`)
      } else {
        parts.push(`L${round(p.x)} ${round(p.y)}`)
      }
      points++
    }
    if (sp.closed) parts.push('Z')
    points++
  }
  if (!parts.length || points > SCENE_LIMITS.pathNodes) return null
  const fill = hexOf(n.fill as { type: string; color?: string })
  const strokeColour = hexOf(n.stroke?.paint as { type: string; color?: string } | undefined)
  return {
    shape: { kind: 'path', d: parts.join(' ') },
    ...(n.name ? { name: n.name } : {}),
    ...(fill ? { fill } : {}),
    ...(strokeColour && strokeColour !== 'none' && n.stroke ? { stroke: { color: strokeColour, width: n.stroke.width } } : {}),
    ...(typeof n.opacity === 'number' ? { opacity: n.opacity } : {})
  }
}

const round = (v: number): number => Math.round(v * 100) / 100

/** Every selected object the schema can express, with the ones it cannot left out. */
export function sceneForSelection(doc: DrawDoc, ids: string[]): Scene | undefined {
  const wanted = new Set(ids)
  const items: SceneNode[] = []
  const visit = (nodes: DrawNode[], selectedParent: boolean): void => {
    for (const n of nodes) {
      const picked = selectedParent || wanted.has(n.id)
      if (n.type === 'group') {
        visit(n.children, picked)
        continue
      }
      if (!picked || n.type !== 'path') continue
      if (items.length >= SCENE_LIMITS.nodes) return
      const scene = pathNodeToScene(n)
      if (scene) items.push(scene)
    }
  }
  for (const layer of doc.layers) if (layer.kind === 'vector') visit(layer.objects, false)
  if (!items.length) return undefined
  return { name: 'Current selection', items }
}
