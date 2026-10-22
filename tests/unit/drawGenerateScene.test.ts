// The scene a model returns, validated and compiled into PlexiiDraw objects.
//
// Everything here treats the input as hostile, because it is: a language
// model's reply is not a contract, it is a suggestion. The cases below are the
// ways a reply actually goes wrong — a missing field, a word where a number
// should be, NaN, a colour that is a sentence, ten thousand points, a group
// with nothing in it, a path that stops halfway — and each has to end as a
// dropped item with a reason or a refusal with a reason, never as a half-built
// drawing and never as a crash.

import { describe, expect, it } from 'vitest'
import { compileScene, sceneBounds } from '../../src/shared/draw/generate/compile'
import { SCENE_LIMITS, refusalReason, validateScene } from '../../src/shared/draw/generate/scene'
import type { DrawNode, DrawPathNode } from '../../src/shared/draw/model'

let n = 0
const opts = { newId: () => `nd-${++n}` }

const rect = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  shape: { kind: 'rect', x: 0, y: 0, w: 100, h: 50 },
  fill: '#2563eb',
  ...extra
})

describe('validateScene: what a model sends and what gets through', () => {
  it('accepts the shapes the prompt asks for, with their named fields', () => {
    const { scene, problems } = validateScene({
      name: 'A logo',
      items: [
        { shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10, radius: 2 }, fill: '#fff' },
        { shape: { kind: 'ellipse', cx: 5, cy: 5, rx: 4, ry: 3 }, fill: '#000' },
        { shape: { kind: 'polygon', cx: 0, cy: 0, r: 8, sides: 6 }, fill: '#2563eb' },
        { shape: { kind: 'star', cx: 0, cy: 0, r: 8, points: 5, innerRatio: 0.4 }, fill: '#2563eb' },
        { shape: { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }, stroke: { color: '#111', width: 2 } },
        { shape: { kind: 'path', d: 'M0 0 L10 0 L10 10 Z' }, fill: '#999' }
      ]
    })
    expect(problems).toEqual([])
    expect(scene?.items).toHaveLength(6)
    expect(scene?.name).toBe('A logo')
  })

  it('refuses a reply that is not an object, or has no items', () => {
    expect(validateScene('sorry, I cannot do that').scene).toBeNull()
    expect(validateScene(null).scene).toBeNull()
    expect(validateScene({ name: 'x' }).scene).toBeNull()
    expect(refusalReason(validateScene({ name: 'x' }).problems)).toContain('items')
  })

  it('drops a shape with a non-finite number rather than drawing at NaN', () => {
    const { scene, problems } = validateScene({
      items: [rect(), { shape: { kind: 'rect', x: 0, y: 0, w: Number.NaN, h: 10 }, fill: '#fff' }]
    })
    expect(scene?.items).toHaveLength(1)
    expect(problems[0]?.why).toContain('finite')
  })

  it('drops a shape whose coordinates are a hallucination, not a drawing', () => {
    const { scene } = validateScene({ items: [rect(), { shape: { kind: 'rect', x: 1e9, y: 0, w: 10, h: 10 } }] })
    expect(scene?.items).toHaveLength(1)
  })

  it('drops an invisible shape: no width, no radius, or a line to the same point', () => {
    const { scene, problems } = validateScene({
      items: [
        rect(),
        { shape: { kind: 'rect', x: 0, y: 0, w: 0, h: 10 } },
        { shape: { kind: 'ellipse', cx: 0, cy: 0, rx: 0, ry: 5 } },
        { shape: { kind: 'line', x1: 3, y1: 3, x2: 3, y2: 3 } }
      ]
    })
    expect(scene?.items).toHaveLength(1)
    expect(problems.map((p) => p.why).join(' ')).toContain('invisible')
  })

  it('keeps the shape but drops a colour it cannot read', () => {
    const { scene, problems } = validateScene({ items: [{ shape: { kind: 'rect', x: 0, y: 0, w: 5, h: 5 }, fill: 'a nice warm blue' }] })
    expect(scene?.items).toHaveLength(1)
    expect((scene?.items[0] as { fill?: string }).fill).toBeUndefined()
    expect(problems[0]?.why).toContain('not a hex colour')
  })

  it('accepts "none" as a fill, which is how a model says outline-only', () => {
    const { scene } = validateScene({ items: [{ shape: { kind: 'rect', x: 0, y: 0, w: 5, h: 5 }, fill: 'none', stroke: { color: '#111', width: 1 } }] })
    expect((scene?.items[0] as { fill?: string }).fill).toBe('none')
  })

  it('takes one level of grouping and drops a group with nothing drawable in it', () => {
    const { scene, problems } = validateScene({
      items: [{ name: 'Wheels', children: [rect(), rect()] }, { name: 'Empty', children: [{ shape: { kind: 'blob' } }] }]
    })
    expect(scene?.items).toHaveLength(1)
    expect((scene?.items[0] as { children: unknown[] }).children).toHaveLength(2)
    expect(problems.map((p) => p.why).join(' ')).toContain('nothing drawable')
  })

  it('caps a runaway reply instead of handing the renderer 10,000 shapes', () => {
    const { scene, problems } = validateScene({ items: Array.from({ length: 10_000 }, () => rect()) })
    expect(scene!.items.length).toBeLessThanOrEqual(SCENE_LIMITS.items)
    expect(problems.some((p) => p.why.includes('more than'))).toBe(true)
  })

  it('refuses a reply where nothing at all could be drawn, with the first reason', () => {
    const { scene, problems } = validateScene({ items: [{ shape: { kind: 'wormhole' } }, 'nonsense', 42] })
    expect(scene).toBeNull()
    expect(refusalReason(problems)).toContain('wormhole')
  })

  it('does not trust a name: it is trimmed, collapsed and capped', () => {
    const { scene } = validateScene({ name: `  ${'x'.repeat(500)}  `, items: [rect({ name: 'a\n\n  b' })] })
    expect(scene!.name.length).toBeLessThanOrEqual(SCENE_LIMITS.nameLength)
    expect((scene!.items[0] as { name?: string }).name).toBe('a b')
  })
})

describe('compileScene: real Draw objects, and nothing shared between them', () => {
  const collect = (nodes: DrawNode[], out: DrawNode[] = []): DrawNode[] => {
    for (const nd of nodes) {
      out.push(nd)
      if (nd.type === 'group') collect(nd.children, out)
    }
    return out
  }

  it('builds editable paths, not images: every shape has anchor points', () => {
    const { scene } = validateScene({
      items: [
        { shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 }, fill: '#2563eb' },
        { shape: { kind: 'ellipse', cx: 5, cy: 5, rx: 4, ry: 3 }, fill: '#2563eb' },
        { shape: { kind: 'star', cx: 0, cy: 0, r: 8, points: 5 }, fill: '#2563eb' }
      ]
    })
    const { nodes } = compileScene(scene!, opts)
    expect(nodes).toHaveLength(3)
    for (const nd of nodes as DrawPathNode[]) {
      expect(nd.type).toBe('path')
      expect(nd.path.subpaths[0]!.nodes.length).toBeGreaterThan(1)
    }
  })

  it('NEVER shares a fill, a stroke or a path between two nodes', () => {
    // The duplicate-save "cyclic data" bug, and the one where editing one
    // shape's colour changed another's. Identity, not equality: two nodes may
    // be the same blue, but they may not be the same OBJECT.
    const { scene } = validateScene({
      items: [
        rect({ stroke: { color: '#111', width: 2 } }),
        rect({ stroke: { color: '#111', width: 2 } }),
        { name: 'g', children: [rect({ stroke: { color: '#111', width: 2 } }), rect()] }
      ]
    })
    const { nodes } = compileScene(scene!, opts)
    const all = collect(nodes).filter((nd): nd is DrawPathNode => nd.type === 'path')
    expect(all.length).toBe(4)
    const seen = new Set<unknown>()
    for (const nd of all) {
      for (const ref of [nd.fill, nd.stroke, nd.stroke?.paint, nd.path, nd.path.subpaths]) {
        if (!ref) continue
        expect(seen.has(ref), 'two nodes share one object').toBe(false)
        seen.add(ref)
      }
    }
  })

  it('gives every node its own id', () => {
    const { scene } = validateScene({ items: [rect(), rect(), { name: 'g', children: [rect()] }] })
    const { nodes } = compileScene(scene!, opts)
    const ids = collect(nodes).map((nd) => nd.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps paint order: the first item is at the bottom, as layers already work', () => {
    const { scene } = validateScene({ items: [rect({ name: 'back' }), rect({ name: 'front' })] })
    const { nodes } = compileScene(scene!, opts)
    expect(nodes.map((nd) => nd.name)).toEqual(['back', 'front'])
  })

  it('refuses a malformed path rather than keeping the half of it that parsed', () => {
    const { scene } = validateScene({ items: [rect(), { shape: { kind: 'path', d: 'M0 0 L10 10 C5' }, fill: '#111' }] })
    const { nodes, problems } = compileScene(scene!, opts)
    expect(nodes).toHaveLength(1)
    expect(problems.map((p) => p.why).join(' ')).toContain('malformed')
  })

  it('drops a shape that would be invisible, and keeps a line that only has a colour', () => {
    const { scene } = validateScene({
      items: [
        { shape: { kind: 'rect', x: 0, y: 0, w: 5, h: 5 }, fill: 'none' },
        { shape: { kind: 'line', x1: 0, y1: 0, x2: 9, y2: 0 }, fill: '#111' }
      ]
    })
    const { nodes } = compileScene(scene!, opts)
    expect(nodes).toHaveLength(1)
    const line = nodes[0] as DrawPathNode
    expect(line.fill).toEqual({ type: 'none' })
    expect(line.stroke?.width).toBeGreaterThan(0)
  })

  it('measures what it drew, for the preview and for centring', () => {
    const { scene } = validateScene({
      items: [{ shape: { kind: 'rect', x: 10, y: 20, w: 30, h: 40 }, fill: '#111' }, { shape: { kind: 'ellipse', cx: 100, cy: 100, rx: 10, ry: 10 }, fill: '#111' }]
    })
    expect(sceneBounds(scene!)).toEqual({ x: 10, y: 20, w: 100, h: 90 })
  })
})
