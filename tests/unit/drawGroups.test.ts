// WP-OBJ: groups, clipping masks, compound paths, Lock/Hide, Arrange inside
// groups, isolation mode and the Group Selection tool -- the pure operations,
// the SVG they export, hit-testing, and the real editor driven headlessly
// through the keymap (Illustrator's default keys) and the menu commands.

import { describe, expect, it } from 'vitest'
import { pointInPath, polygonArea, flattenSubpath, rotateAbout, type Box, type Matrix } from '../../src/shared/drawGeometry'
import type { DrawDoc, DrawGroupNode, DrawNode, DrawPathNode } from '../../src/shared/draw/model'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import { drawDocToSvg } from '../../src/shared/draw/svg'
import { drawDocForStorage } from '../../src/shared/draw/compat'
import {
  allPlaces,
  arrangeNodes,
  artworkAboveIds,
  clearFlagAll,
  clipGroupsFor,
  editContentsTargets,
  editMaskTarget,
  editableIds,
  fillRuleOf,
  flagNodes,
  getObject,
  groupNodes,
  hitNode,
  makeClipMask,
  makeClipProblem,
  makeCompoundPath,
  moveNodesWorld,
  nodeBounds,
  pickForGrouping,
  releaseClipMask,
  releaseCompoundPath,
  rotateNodesWorld,
  scaleNodesWorld,
  setFillRule,
  transformNode,
  ungroupNodes,
  worldBounds
} from '../../src/shared/draw/ops'
import { buildMenu } from '../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import { hitChainAt, isolationChain } from '../../src/renderer/src/components/documents/draw/editor/isolation'
import { keyBinding } from '../../src/renderer/src/components/documents/draw/commands/registry'
import { blank, harness, rect } from './drawTools/harness'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RED = { type: 'solid', color: '#ff0000' }

function sq(id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return rect(id, x, y, w, h, { fill: RED, ...extra })
}

/** A stored v2 drawing (so groups may be written) with layers of objects. */
function v2(layers: Array<Record<string, unknown>[]> | Record<string, unknown>[], w = 400, h = 300): Record<string, unknown> {
  const ls = (Array.isArray(layers[0]) ? layers : [layers]) as Array<Record<string, unknown>[]>
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w, h, background: { type: 'solid', color: '#ffffff' } }],
    activeArtboardId: 'artboard-1',
    layers: ls.map((objects, i) => ({ id: `L${i + 1}`, kind: 'vector', name: `Layer ${i + 1}`, visible: true, locked: false, opacity: 1, blend: 'normal', objects })),
    activeLayerId: 'L1',
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
}

const doc = (raw: unknown): DrawDoc => normalizeDrawDoc(raw)
const ids = (nodes: DrawNode[]): string[] => nodes.map((n) => n.id)
const top = (d: DrawDoc, layer = 0): DrawNode[] => (d.layers[layer] as { objects: DrawNode[] }).objects
const close = (a: Box | null, b: Box | null, eps = 1e-6): void => {
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(a![k] - b![k]), k).toBeLessThan(eps)
}
const pick = (d: DrawDoc, sel: string[]) => pickForGrouping(d, sel, editableIds)

/** A tiny seeded PRNG so the randomised tests are repeatable. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// ── Group and Ungroup ────────────────────────────────────────────────────────

describe('Group / Ungroup (pure)', () => {
  it('group goes where the TOPMOST picked object was, members keep order and ids; ungroup puts them back', () => {
    const d = doc(v2([sq('a', 0, 0, 10, 10), sq('b', 20, 0, 10, 10), sq('c', 40, 0, 10, 10), sq('d', 60, 0, 10, 10)]))
    const { doc: g, groupId } = groupNodes(d, pick(d, ['d', 'b']))
    expect(ids(top(g))).toEqual(['a', 'c', groupId])
    const grp = getObject(g, groupId!) as DrawGroupNode
    expect(ids(grp.children)).toEqual(['b', 'd'])
    // Same node objects: nothing about the members changed.
    expect(grp.children[0]).toBe(top(d)[1])
    const { doc: u, ids: back } = ungroupNodes(g, [groupId!])
    expect(ids(top(u))).toEqual(['a', 'c', 'b', 'd'])
    expect(back).toEqual(['b', 'd'])
    // Regroup gives the same members again.
    const again = groupNodes(u, pick(u, back))
    expect(ids((getObject(again.doc, again.groupId!) as DrawGroupNode).children)).toEqual(['b', 'd'])
  })

  it('grouping across layers lands on the topmost object’s layer', () => {
    const d = doc(v2([[sq('a', 0, 0, 10, 10)], [sq('b', 20, 0, 10, 10), sq('c', 40, 0, 10, 10)]]))
    const { doc: g, groupId } = groupNodes(d, pick(d, ['a', 'b']))
    expect(ids(top(g, 0))).toEqual([])
    expect(ids(top(g, 1))).toEqual([groupId, 'c'])
  })

  it('a single object can be grouped; locked, hidden and opaque ones are never picked', () => {
    const d = doc(v2([sq('a', 0, 0, 10, 10), sq('l', 0, 0, 10, 10, { locked: true }), sq('h', 0, 0, 10, 10, { hidden: true })]))
    expect(pick(d, ['a', 'l', 'h']).map((p) => p.node.id)).toEqual(['a'])
    expect(groupNodes(d, pick(d, ['a'])).groupId).not.toBeNull()
  })

  it('a selected group carries its members: picking both acts on the group once', () => {
    const d = doc(v2([{ id: 'g', type: 'group', children: [sq('a', 0, 0, 10, 10)] }]))
    expect(pick(d, ['g', 'a']).map((p) => p.node.id)).toEqual(['g'])
  })

  it('ungroup bakes the group’s matrix into members, keeps them in place on screen, multiplies opacity', () => {
    const m = rotateAbout(50, 50, 30)
    const d = doc(
      v2([
        {
          id: 'g',
          type: 'group',
          transform: m,
          opacity: 0.5,
          children: [sq('a', 10, 10, 30, 20, { opacity: 0.8 }), { id: 't', type: 'text', text: 'Hi', x: 40, y: 40, w: 60, fontSize: 12, fill: RED }]
        }
      ])
    )
    const before = { a: worldBounds(d, 'a'), t: worldBounds(d, 't') }
    const { doc: u } = ungroupNodes(d, ['g'])
    close(worldBounds(u, 'a'), before.a, 1e-6)
    close(worldBounds(u, 't'), before.t, 1e-6)
    expect(getObject(u, 'a')!.opacity).toBeCloseTo(0.4)
    // A pure turn keeps type as type with a rotation, not a matrix.
    const t = getObject(u, 't') as { rotation?: number; transform?: Matrix }
    expect(t.rotation).toBeCloseTo(30)
    expect(t.transform).toBeUndefined()
  })

  it('members coming out of a transformed group into a new group stay where they are', () => {
    const d = doc(v2([{ id: 'g', type: 'group', transform: [2, 0, 0, 2, 5, 5], children: [sq('a', 0, 0, 10, 10)] }, sq('b', 100, 100, 10, 10)]))
    const before = worldBounds(d, 'a')
    const { doc: g } = groupNodes(d, pick(d, ['a', 'b']))
    close(worldBounds(g, 'a'), before)
  })

  it('property: group then ungroup of objects inside randomly transformed groups never moves anything on screen', () => {
    const r = rng(7)
    for (let trial = 0; trial < 60; trial++) {
      const ang = r() * 360
      const m = rotateAbout(r() * 200, r() * 200, ang)
      const s: Matrix = [0.5 + r() * 2, 0, 0, 0.5 + r() * 2, r() * 50, r() * 50]
      const outer: Matrix = trial % 2 ? m : s
      const d = doc(
        v2([
          { id: 'g', type: 'group', transform: outer, children: [sq('a', r() * 100, r() * 100, 5 + r() * 40, 5 + r() * 40), sq('b', r() * 100, r() * 100, 5 + r() * 40, 5 + r() * 40)] },
          sq('c', r() * 300, r() * 200, 10, 10)
        ])
      )
      const before = ['a', 'b', 'c'].map((id) => worldBounds(d, id))
      const { doc: g, groupId } = groupNodes(d, pick(d, ['a', 'c']))
      ;['a', 'b', 'c'].forEach((id, i) => close(worldBounds(g, id), before[i], 1e-6))
      const { doc: u } = ungroupNodes(g, [groupId!, 'g'])
      ;['a', 'b', 'c'].forEach((id, i) => close(worldBounds(u, id), before[i], 1e-6))
      expect(allPlaces(u).every((p) => p.parents.length === 0)).toBe(true)
    }
  })
})

describe('moving, scaling and turning members of transformed groups', () => {
  it('property: moveNodesWorld moves a member by exactly (dx, dy) on screen, whatever the group matrix', () => {
    const r = rng(11)
    for (let i = 0; i < 80; i++) {
      const m: Matrix = i % 3 === 0 ? rotateAbout(r() * 100, r() * 100, r() * 360) : i % 3 === 1 ? [1, 0.3 * r(), -0.4 * r(), 1, 10, 20] : [-1, 0, 0, 2, 50, 0]
      const d = doc(v2([{ id: 'g', type: 'group', transform: m, children: [sq('a', 10, 10, 20, 30)] }]))
      const b = worldBounds(d, 'a')!
      const dx = r() * 100 - 50
      const dy = r() * 100 - 50
      const n = worldBounds(moveNodesWorld(d, ['a'], dx, dy), 'a')!
      expect(n.x - b.x).toBeCloseTo(dx, 6)
      expect(n.y - b.y).toBeCloseTo(dy, 6)
    }
  })

  it('scaling a member of a scaled group follows the handles on screen', () => {
    const d = doc(v2([{ id: 'g', type: 'group', transform: [2, 0, 0, 2, 10, 10], children: [sq('a', 0, 0, 10, 10)] }]))
    const from = worldBounds(d, 'a')!
    const to = { x: from.x, y: from.y, w: from.w * 3, h: from.h / 2 }
    close(worldBounds(scaleNodesWorld(d, ['a'], from, to), 'a'), to)
  })

  it('turning a member of a rotated group turns it about the screen centre', () => {
    const d = doc(v2([{ id: 'g', type: 'group', transform: rotateAbout(0, 0, 40), children: [sq('a', 50, 0, 20, 20)] }]))
    const b = worldBounds(d, 'a')!
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    const n = worldBounds(rotateNodesWorld(d, ['a'], rotateAbout(c.x, c.y, 90), 90), 'a')!
    expect(n.x + n.w / 2).toBeCloseTo(c.x, 6)
    expect(n.y + n.h / 2).toBeCloseTo(c.y, 6)
  })

  it('transformNode with a reflection gives a frame a matrix rather than inventing a negative size', () => {
    const img = { id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 5, assetId: 'x' } as unknown as DrawNode
    const out = transformNode(img, [-1, 0, 0, 1, 20, 0]) as { transform?: Matrix; w: number }
    expect(out.transform).toEqual([-1, 0, 0, 1, 20, 0])
    expect(out.w).toBe(10)
  })
})

// ── Clipping masks ───────────────────────────────────────────────────────────

const star = (id: string): Record<string, unknown> => ({
  id,
  type: 'path',
  shapeKind: 'star',
  path: { subpaths: [{ closed: true, nodes: [{ x: 50, y: 0 }, { x: 62, y: 38 }, { x: 100, y: 38 }, { x: 70, y: 62 }, { x: 80, y: 100 }, { x: 50, y: 76 }, { x: 20, y: 100 }, { x: 30, y: 62 }, { x: 0, y: 38 }, { x: 38, y: 38 }] }] },
  fill: { type: 'solid', color: '#00ff00' },
  stroke: { paint: { type: 'solid', color: '#000000' }, width: 2 }
})
const ellipse = (id: string): Record<string, unknown> => sq(id, -40, 20, 200, 60, { shapeKind: 'ellipse' })

describe('Clipping masks (pure)', () => {
  it('Make: the topmost object becomes the clip path with no fill and no stroke; bounds are the clip path’s', () => {
    const d = doc(v2([ellipse('e'), star('s')]))
    expect(makeClipProblem(d, ['e', 's'])).toBeNull()
    const { doc: m, groupId } = makeClipMask(d, ['e', 's'])
    const g = getObject(m, groupId!) as DrawGroupNode
    expect(g.clip).toBe(true)
    expect(ids(g.children)).toEqual(['e', 's'])
    const clip = g.children[1] as DrawPathNode
    expect(clip.fill).toEqual({ type: 'none' })
    expect(clip.stroke).toBeUndefined()
    // "Clip bounds equal the clip path's bounds" -- not the ellipse's wider box.
    close(nodeBounds(g), nodeBounds(clip))
    close(nodeBounds(g), { x: 0, y: 0, w: 100, h: 100 })
  })

  it('exports <clipPath> and clips the contents with it; the clip path is not painted', () => {
    const { doc: m, groupId } = makeClipMask(doc(v2([ellipse('e'), star('s')])), ['e', 's'])
    const svg = drawDocToSvg(m)
    expect(svg).toContain(`<clipPath id="clip-${groupId}"><path d="M 50 0 L 62 38`)
    expect(svg).toContain(`<g clip-path="url(#clip-${groupId})"><path d="M -40 20`)
    expect(svg.match(/<path /g)).toHaveLength(2) // one in the clipPath, one ellipse
  })

  it('a clip path given a fill and stroke afterwards (Edit Mask) paints them: fill under, stroke over and unclipped', () => {
    const { doc: m, groupId } = makeClipMask(doc(v2([ellipse('e'), star('s')])), ['e', 's'])
    const painted = { ...m, layers: m.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: l.objects.map((o) => (o.type === 'group' ? { ...o, children: [o.children[0], { ...(o.children[1] as DrawPathNode), fill: { type: 'solid' as const, color: '#0000ff' }, stroke: { paint: { type: 'solid' as const, color: '#ff00ff' }, width: 4 } }] } : o)) } : l)) }
    const svg = drawDocToSvg(painted)
    const clipped = svg.indexOf(`<g clip-path="url(#clip-${groupId})">`)
    const under = svg.indexOf('fill="#0000ff"')
    const contents = svg.indexOf('M -40 20')
    const over = svg.indexOf('stroke="#ff00ff"')
    expect(clipped).toBeGreaterThan(0)
    expect(clipped < under && under < contents).toBe(true)
    // The stroke comes after the clipped group closes.
    expect(svg.slice(clipped, over)).toContain('</g>')
  })

  it('type can be a clipping path, and is written as <text> inside <clipPath>', () => {
    const d = doc(v2([sq('bg', 0, 0, 200, 100), { id: 't', type: 'text', text: 'MASK', x: 10, y: 10, w: 180, fontSize: 60, fill: RED }]))
    const { doc: m, groupId } = makeClipMask(d, ['bg', 't'])
    const svg = drawDocToSvg(m)
    expect(svg).toMatch(new RegExp(`<clipPath id="clip-${groupId}"><text [^>]*>.*MASK.*</text></clipPath>`))
  })

  it('refuses honestly: one object, a top that cannot clip, a clip path picked again', () => {
    const d = doc(v2([sq('a', 0, 0, 10, 10), { id: 'w', type: 'widget', widgetId: 'wid', x: 0, y: 0, w: 10, h: 10 }]))
    expect(makeClipProblem(d, ['a'])).toBe('one-object')
    expect(makeClipProblem(d, ['a', 'w'])).toBe('top-not-a-shape')
    expect(makeClipMask(d, ['a', 'w']).doc).toBe(d)
    const { doc: m } = makeClipMask(doc(v2([ellipse('e'), star('s'), sq('x', 0, 0, 5, 5)])), ['e', 's'])
    expect(makeClipProblem(m, ['s', 'x'])).toBe('clip-path-picked')
  })

  it('a selected ordinary group becomes a clipping group in place', () => {
    const d = doc(v2([{ id: 'g', type: 'group', children: [ellipse('e'), star('s')] }]))
    const { doc: m, groupId } = makeClipMask(d, ['g'])
    expect(groupId).toBe('g')
    expect((getObject(m, 'g') as DrawGroupNode).clip).toBe(true)
  })

  it('Release leaves the objects grouped, the former clip path with no paint; selection inside the group finds it', () => {
    const { doc: m, groupId } = makeClipMask(doc(v2([ellipse('e'), star('s')])), ['e', 's'])
    expect(clipGroupsFor(m, ['e']).map((g) => g.id)).toEqual([groupId])
    const { doc: r, groupIds } = releaseClipMask(m, ['e'])
    expect(groupIds).toEqual([groupId])
    const g = getObject(r, groupId!) as DrawGroupNode
    expect(g.clip).toBeUndefined()
    expect(ids(g.children)).toEqual(['e', 's'])
    expect(drawDocToSvg(r)).not.toContain('clipPath')
  })

  it('Edit Mask selects the clip path; Edit Contents the masked objects', () => {
    const { doc: m, groupId } = makeClipMask(doc(v2([ellipse('e'), sq('f', 0, 0, 5, 5), star('s')])), ['e', 'f', 's'])
    expect(editMaskTarget(m, [groupId!])).toBe('s')
    expect(editContentsTargets(m, [groupId!])).toEqual(['e', 'f'])
    expect(editMaskTarget(m, ['e'])).toBe('s')
  })

  it('hit-testing: contents count only inside the mask; an unpainted clip path is hit on its outline only', () => {
    const { doc: m, groupId } = makeClipMask(doc(v2([ellipse('e'), star('s')])), ['e', 's'])
    const g = getObject(m, groupId!)!
    expect(hitNode(g, { x: 50, y: 50 }, 0)).toBe(true) // inside the star, on the ellipse
    expect(hitNode(g, { x: 150, y: 50 }, 0)).toBe(false) // on the ellipse, outside the star
    expect(hitNode(g, { x: 50, y: 10 }, 0)).toBe(false) // inside the star, no content there
    const s = { doc: m, isolation: [] }
    expect(ids(hitChainAt(s, { x: 50, y: 50 }, 1)!)).toEqual([groupId, 'e'])
    expect(ids(hitChainAt(s, { x: 50, y: 0.5 }, 2)!)).toEqual([groupId, 's'])
    expect(hitChainAt(s, { x: 150, y: 50 }, 1)).toBeNull()
  })

  it('injection: a hostile group id cannot break out of the clip-path id or url()', () => {
    const d = doc(v2([{ id: 'g', type: 'group', clip: true, children: [sq('a', 0, 0, 10, 10), sq('b', 0, 0, 5, 5)] }]))
    const evil = { ...d, layers: d.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: l.objects.map((o) => ({ ...o, id: 'x" onload="alert(1)' })) } : l)) }
    const svg = drawDocToSvg(evil as DrawDoc)
    expect(svg).not.toContain('onload=')
    for (const m of svg.matchAll(/ id="([^"]*)"/g)) expect(m[1]).toMatch(/^(grad|clip)-[A-Za-z0-9_-]+$/)
    expect(svg).toMatch(/clip-path="url\(#clip-[A-Za-z0-9_-]+\)"/)
  })

  it('injection: hostile text used as a clip path is escaped inside <clipPath>', () => {
    const d = doc(v2([sq('bg', 0, 0, 200, 100), { id: 't', type: 'text', text: '</text><script>alert(1)</script>', x: 0, y: 0, w: 100, fontSize: 20, fontFamily: '"><script>', fill: RED }]))
    const svg = drawDocToSvg(makeClipMask(d, ['bg', 't']).doc)
    expect(svg).not.toContain('<script')
  })

  it('groups and masks are v2-only: they are written as v2, never squeezed into v1', () => {
    const { doc: m } = makeClipMask(doc(v2([ellipse('e'), star('s')])), ['e', 's'])
    expect((drawDocForStorage(m, { stored: 2 }) as { schemaVersion: number }).schemaVersion).toBe(2)
  })
})

// ── Compound paths ───────────────────────────────────────────────────────────

describe('Compound paths (pure)', () => {
  it('Make: concentric shapes become a ring under non-zero, with the backmost paint, at the frontmost’s place', () => {
    const d = doc(v2([sq('outer', 0, 0, 100, 100, { fill: { type: 'solid', color: '#123456' } }), sq('mid', 300, 0, 10, 10), sq('inner', 25, 25, 50, 50, { fill: { type: 'solid', color: '#abcdef' } }), sq('z', 0, 0, 1, 1)]))
    const { doc: c, newId } = makeCompoundPath(d, ['outer', 'inner'])
    expect(ids(top(c))).toEqual(['mid', newId, 'z'])
    const p = getObject(c, newId!) as DrawPathNode
    expect(p.fill).toEqual({ type: 'solid', color: '#123456' })
    expect(p.path.subpaths).toHaveLength(2)
    expect(p.path.fillRule).toBeUndefined() // non-zero, the default
    const [a, b] = p.path.subpaths.map((sp) => Math.sign(polygonArea(flattenSubpath(sp, 1))))
    expect(a).toBe(-b)
    expect(pointInPath(p.path, { x: 50, y: 50 })).toBe(false) // the hole
    expect(pointInPath(p.path, { x: 10, y: 50 })).toBe(true) // the ring
    // Already a v1-representable object: compound paths need no v2.
    expect((drawDocForStorage(c, { stored: 1 }) as { schemaVersion: number }).schemaVersion).toBe(1)
  })

  it('groups of paths count; a group with type in it does not', () => {
    const d = doc(v2([{ id: 'g', type: 'group', children: [sq('a', 0, 0, 10, 10), sq('b', 20, 0, 10, 10)] }, sq('c', 40, 0, 10, 10)]))
    const { newId, doc: c } = makeCompoundPath(d, ['g', 'c'])
    expect((getObject(c, newId!) as DrawPathNode).path.subpaths).toHaveLength(3)
    const t = doc(v2([{ id: 'g', type: 'group', children: [sq('a', 0, 0, 10, 10), { id: 't', type: 'text', text: 'x', x: 0, y: 0, w: 10, fontSize: 10, fill: RED }] }, sq('c', 40, 0, 10, 10)]))
    expect(makeCompoundPath(t, ['g', 'c']).newId).toBeNull()
  })

  it('Release: one path per subpath, in order, with the compound’s paint; the first keeps the id', () => {
    const d = doc(v2([sq('outer', 0, 0, 100, 100), sq('inner', 25, 25, 50, 50)]))
    const { doc: c, newId } = makeCompoundPath(d, ['outer', 'inner'])
    const { doc: r, ids: out } = releaseCompoundPath(c, [newId!])
    expect(out[0]).toBe(newId)
    expect(out).toHaveLength(2)
    expect(ids(top(r))).toEqual(out)
    close(nodeBounds(getObject(r, out[1])!), { x: 25, y: 25, w: 50, h: 50 })
  })

  it('the fill-rule toggle sets even-odd and back; mixed selections say so', () => {
    const d = doc(v2([sq('a', 0, 0, 10, 10), sq('b', 0, 0, 10, 10)]))
    const e = setFillRule(d, ['a'], 'evenodd')
    expect(fillRuleOf(e, ['a'])).toBe('evenodd')
    expect(fillRuleOf(e, ['a', 'b'])).toBe('mixed')
    expect((getObject(setFillRule(e, ['a'], 'nonzero'), 'a') as DrawPathNode).path.fillRule).toBeUndefined()
    expect(setFillRule(d, ['a'], 'nonzero')).toBe(d) // nothing to change, nothing changed
  })
})

// ── Arrange, Lock, Hide ──────────────────────────────────────────────────────

describe('Arrange inside groups; Lock and Hide', () => {
  it('Arrange works within a group, and a clip path always stays on top', () => {
    const d = doc(v2([{ id: 'g', type: 'group', children: [sq('a', 0, 0, 10, 10), sq('b', 0, 0, 10, 10), sq('c', 0, 0, 10, 10)] }]))
    expect(ids((getObject(arrangeNodes(d, ['a'], 'front'), 'g') as DrawGroupNode).children)).toEqual(['b', 'c', 'a'])
    expect(ids((getObject(arrangeNodes(d, ['c'], 'backward'), 'g') as DrawGroupNode).children)).toEqual(['a', 'c', 'b'])
    const { doc: m, groupId } = makeClipMask(doc(v2([sq('a', 0, 0, 10, 10), sq('b', 0, 0, 10, 10), sq('clip', 0, 0, 10, 10)])), ['a', 'b', 'clip'])
    expect(ids((getObject(arrangeNodes(m, ['a'], 'front'), groupId!) as DrawGroupNode).children)).toEqual(['b', 'a', 'clip'])
    expect(arrangeNodes(m, ['clip'], 'back').layers[0]).toBe(m.layers[0])
  })

  it('Lock/Hide › All Artwork Above takes only what overlaps the selection from above', () => {
    const d = doc(v2([sq('a', 0, 0, 50, 50), sq('below', 0, 0, 50, 50), sq('over', 10, 10, 10, 10), sq('away', 200, 200, 10, 10)]))
    expect(artworkAboveIds(d, ['below'], 'locked')).toEqual(['over'])
  })

  it('Unlock All / Show All clear the flag at any depth (inside one group when isolated) and report what changed', () => {
    const d = flagNodes(doc(v2([sq('a', 0, 0, 5, 5), { id: 'g', type: 'group', children: [sq('b', 0, 0, 5, 5)] }])), ['a', 'b'], 'locked')
    expect(clearFlagAll(d, 'locked', 'g').ids).toEqual(['b'])
    const { doc: u, ids: all } = clearFlagAll(d, 'locked')
    expect(all).toEqual(['a', 'b'])
    expect(getObject(u, 'a')!.locked).toBeUndefined()
  })
})

// ── The editor: keys, menus, undo ────────────────────────────────────────────

const menuText = (h: ReturnType<typeof harness>, path: string): string => JSON.stringify(buildMenu(h.ed.ctx, path))

describe('the editor (Illustrator keys, one undo step each)', () => {
  it('⌘G groups, ⇧⌘G ungroups; each is one labelled undo step', () => {
    const h = harness(v2([sq('a', 0, 0, 10, 10), sq('b', 20, 0, 10, 10), sq('c', 40, 0, 10, 10)]))
    h.ed.ctx.select(['a', 'c'])
    expect(h.key('g', { meta: true, code: 'KeyG' }).prevented).toBe(true)
    const g = h.state().selection[0]
    expect(ids(h.objects())).toEqual(['b', g])
    expect(h.state().past.at(-1)?.label).toBe('Group')
    h.key('G', { meta: true, shift: true, code: 'KeyG' })
    expect(ids(h.objects())).toEqual(['b', 'a', 'c'])
    expect(h.state().selection).toEqual(['a', 'c'])
    h.key('z', { meta: true })
    expect(ids(h.objects())).toEqual(['b', g])
    h.key('z', { meta: true })
    expect(ids(h.objects())).toEqual(['a', 'b', 'c'])
  })

  it('a drawing still written as v1 cannot hold groups: Group is greyed and the key says why, changing nothing', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)]))
    h.ed.ctx.select(['a', 'b'])
    expect(menuText(h, 'object')).toMatch(/"label":"Group"[^}]*"disabled":true/)
    h.key('g', { meta: true, code: 'KeyG' })
    expect(ids(h.objects())).toEqual(['a', 'b'])
    expect(h.state().past).toHaveLength(0)
    expect(h.state().status).toMatch(/newer PlexiiDraw drawing format/)
    // Compound paths are v1 content, so they still work there.
    h.key('8', { meta: true, code: 'Digit8' })
    expect(h.objects()).toHaveLength(1)
  })

  it('⌘7 makes a clipping mask, ⌥⌘7 releases it (Option changes the key to ¶, the code is what counts)', () => {
    const h = harness(v2([ellipse('e'), star('s')]))
    h.ed.ctx.select(['e', 's'])
    h.key('7', { meta: true, code: 'Digit7' })
    const g = h.objects()[0] as DrawGroupNode
    expect(g.clip).toBe(true)
    expect(h.state().past.at(-1)?.label).toBe('Make clipping mask')
    h.key('¶', { meta: true, alt: true, code: 'Digit7' })
    expect((h.objects()[0] as DrawGroupNode).clip).toBeUndefined()
    expect(h.state().past.at(-1)?.label).toBe('Release clipping mask')
  })

  it('⌘8 makes a compound path, ⌥⇧⌘8 releases it', () => {
    const h = harness(blank([rect('a', 0, 0, 100, 100), rect('b', 25, 25, 50, 50)]))
    h.ed.ctx.select(['a', 'b'])
    h.key('8', { meta: true, code: 'Digit8' })
    expect(h.objects()).toHaveLength(1)
    h.key('•', { meta: true, alt: true, shift: true, code: 'Digit8' })
    expect(h.objects()).toHaveLength(2)
  })

  it('⌘2 locks, ⌥⌘2 unlocks all and selects them; ⌘3 hides, ⌥⌘3 shows all', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('2', { meta: true, code: 'Digit2' })
    expect(h.objects()[0].locked).toBe(true)
    expect(h.state().selection).toEqual([])
    h.key('™', { meta: true, alt: true, code: 'Digit2' })
    expect(h.objects()[0].locked).toBeUndefined()
    expect(h.state().selection).toEqual(['a'])
    h.key('3', { meta: true, code: 'Digit3' })
    expect(h.objects()[0].hidden).toBe(true)
    h.key('£', { meta: true, alt: true, code: 'Digit3' })
    expect(h.objects()[0].hidden).toBeUndefined()
    expect(h.state().selection).toEqual(['a'])
  })

  it('⇧⌘] / ⌘] / ⌘[ / ⇧⌘[ arrange -- Shift turns ] into }, the physical key still counts', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10), rect('c', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('}', { meta: true, shift: true, code: 'BracketRight' })
    expect(ids(h.objects())).toEqual(['b', 'c', 'a'])
    h.key('[', { meta: true, code: 'BracketLeft' })
    expect(ids(h.objects())).toEqual(['b', 'a', 'c'])
    h.key('{', { meta: true, shift: true, code: 'BracketLeft' })
    expect(ids(h.objects())).toEqual(['a', 'b', 'c'])
    h.key(']', { meta: true, code: 'BracketRight' })
    expect(ids(h.objects())).toEqual(['b', 'a', 'c'])
    // The menu shows Illustrator's keys and greys what cannot move.
    h.ed.ctx.select(['c'])
    expect(menuText(h, 'object')).toMatch(/"label":"Bring to front","shortcut":"⇧⌘]","disabled":true/)
  })

  it('Option and the physical key never leak onto bindings they do not name', () => {
    expect(keyBinding({ key: '©', code: 'KeyG', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true })).toBeNull()
    expect(keyBinding({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: false, ctrlKey: false, shiftKey: false, altKey: true })?.command).toBe('object.nudgeLeft')
    expect(keyBinding({ key: '{', code: 'BracketLeft', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false })).toBeNull()
  })

  it('Edit Contents then a drag moves the masked art inside the mask, not the mask', () => {
    const h = harness(v2([ellipse('e'), star('s')]))
    h.ed.ctx.select(['e', 's'])
    h.run('object.clip.make')
    h.run('object.clip.editContents')
    expect(h.state().selection).toEqual(['e'])
    h.ed.ctx.set({ snapOn: false })
    h.drag([50, 50], [60, 55])
    close(worldBounds(h.doc(), 'e'), { x: -30, y: 25, w: 200, h: 60 })
    close(worldBounds(h.doc(), 's'), { x: 0, y: 0, w: 100, h: 100 })
    expect(h.state().past.at(-1)?.label).toBe('Move')
    h.run('object.clip.editMask')
    expect(h.state().selection).toEqual(['s'])
  })

  it('a fill applied to a group colours its members, never a clipping group’s clip path', () => {
    const h = harness(v2([ellipse('e'), star('s')]))
    h.ed.ctx.select(['e', 's'])
    h.run('object.clip.make')
    h.run('object.fill', { type: 'solid', color: '#00aaff' })
    expect((getObject(h.doc(), 'e') as DrawPathNode).fill).toEqual({ type: 'solid', color: '#00aaff' })
    expect((getObject(h.doc(), 's') as DrawPathNode).fill).toEqual({ type: 'none' })
  })

  it('selecting and moving a group moves it as a unit; scale and rotate go through the group', () => {
    const h = harness(v2([{ id: 'g', type: 'group', children: [sq('a', 10, 10, 20, 20), sq('b', 50, 10, 20, 20)] }]))
    h.ed.ctx.set({ snapOn: false })
    h.click(20, 20)
    expect(h.state().selection).toEqual(['g'])
    h.drag([20, 20], [30, 40])
    close(worldBounds(h.doc(), 'a'), { x: 20, y: 30, w: 20, h: 20 })
    close(worldBounds(h.doc(), 'b'), { x: 60, y: 30, w: 20, h: 20 })
    expect(h.state().past).toHaveLength(1)
    // Rotate knob: the group takes the turn in its matrix; members stay members.
    const box = worldBounds(h.doc(), 'g')!
    h.drag([box.x + box.w / 2, box.y - 22], [box.x + box.w + 40, box.y + box.h / 2])
    expect((getObject(h.doc(), 'g') as DrawGroupNode).transform).toBeDefined()
    expect(ids((getObject(h.doc(), 'g') as DrawGroupNode).children)).toEqual(['a', 'b'])
  })

  it('read-only drawings: every WP-OBJ command is off', () => {
    const h = harness({ ...v2([sq('a', 0, 0, 10, 10), sq('b', 0, 0, 10, 10)]), schemaVersion: 3 })
    h.ed.ctx.select(['a', 'b'])
    const txt = menuText(h, 'object')
    for (const label of ['Group', 'Ungroup', 'Unlock all', 'Show all', 'Make', 'Release']) expect(txt).toMatch(new RegExp(`"label":"${label}"[^}]*"disabled":true`))
    h.key('g', { meta: true, code: 'KeyG' })
    expect(ids(h.objects())).toEqual(['a', 'b'])
  })
})

describe('tools that act on one object reach inside groups', () => {
  it('the eyedropper picks the colour of the object inside a group', () => {
    const h = harness(v2([{ id: 'g', type: 'group', children: [sq('a', 10, 10, 40, 40, { fill: { type: 'solid', color: '#12ab34' } })] }]))
    h.tool('eyedropper')
    h.click(30, 30)
    expect(h.state().fill).toEqual({ type: 'solid', color: '#12ab34' })
  })
})

describe('saving never sends a value that reaches one object twice', () => {
  /** Paths at which an object already seen is reached again (Electron IPC rejects these as "cyclic data"). */
  function repeated(o: unknown): string[] {
    const seen = new Set<object>()
    const out: string[] = []
    const walk = (v: unknown, path: string): void => {
      if (!v || typeof v !== 'object') return
      if (seen.has(v as object)) {
        out.push(path)
        return
      }
      seen.add(v as object)
      for (const [k, x] of Object.entries(v as object)) walk(x, `${path}.${k}`)
    }
    walk(o, '$')
    return out
  }

  it('three shapes drawn with the same fill, then grouped, are stored as a strict tree (v2 and v1)', () => {
    for (const start of [v2([]), blank([])]) {
      const h = harness(start)
      for (const x of [100, 250, 350]) {
        h.key('r')
        h.drag([x, 100], [x + 40, 140])
      }
      // In memory the shapes share the one paint object, which is fine...
      expect(top(h.doc()).map((o) => (o as DrawPathNode).fill).every((f, _i, all) => f === all[0])).toBe(true)
      // ...but what goes to storage must not.
      expect(repeated(h.emitted.at(-1))).toEqual([])
      if (start.schemaVersion === 2) {
        h.key('a', { meta: true })
        h.key('g', { meta: true, code: 'KeyG' })
        expect(repeated(h.emitted.at(-1))).toEqual([])
      }
    }
  })
})

describe('isolation mode', () => {
  const nested = (): Record<string, unknown> =>
    v2([
      sq('out', 300, 200, 20, 20),
      { id: 'g', type: 'group', children: [sq('a', 10, 10, 20, 20), { id: 'inner', type: 'group', children: [sq('b', 50, 10, 20, 20), sq('c', 80, 10, 20, 20)] }] }
    ])

  it('double-click a group to isolate it; clicks, ⌘A and the marquee then reach its members; Esc leaves', () => {
    const h = harness(nested())
    h.ed.doubleClick({ x: 15, y: 15 })
    expect(h.state().isolation).toEqual(['g'])
    h.click(15, 15)
    expect(h.state().selection).toEqual(['a'])
    h.key('a', { meta: true })
    expect(h.state().selection).toEqual(['a', 'inner'])
    h.drag([0, 0], [35, 35])
    expect(h.state().selection).toEqual(['a'])
    // Outside the group nothing is hit while isolated.
    h.click(310, 210)
    expect(h.state().selection).toEqual([])
    h.key('Escape')
    expect(h.state().isolation).toEqual([])
    expect(h.state().selection).toEqual(['g'])
  })

  it('nests, and a double-click on empty canvas goes up one level', () => {
    const h = harness(nested())
    h.ed.doubleClick({ x: 15, y: 15 })
    h.ed.doubleClick({ x: 55, y: 15 })
    expect(h.state().isolation).toEqual(['g', 'inner'])
    h.click(55, 15)
    expect(h.state().selection).toEqual(['b'])
    h.ed.doubleClick({ x: 200, y: 150 })
    expect(h.state().isolation).toEqual(['g'])
  })

  it('new artwork drawn while isolated lands inside the isolated group (in its space), in one undo step', () => {
    const h = harness(v2([{ id: 'g', type: 'group', transform: [1, 0, 0, 1, 100, 0], children: [sq('a', 0, 0, 20, 20)] }]))
    h.ed.doubleClick({ x: 110, y: 10 })
    expect(h.state().isolation).toEqual(['g'])
    h.tool('rect')
    h.drag([150, 50], [190, 90])
    const g = getObject(h.doc(), 'g') as DrawGroupNode
    expect(g.children).toHaveLength(2)
    expect(top(h.doc())).toHaveLength(1)
    close(worldBounds(h.doc(), g.children[1].id), { x: 150, y: 50, w: 40, h: 40 })
    h.key('z', { meta: true })
    expect((getObject(h.doc(), 'g') as DrawGroupNode).children).toHaveLength(1)
  })

  it('a stale isolation (the group was undone away) is simply not isolation', () => {
    const h = harness(nested())
    h.ed.doubleClick({ x: 15, y: 15 })
    h.ed.ctx.set({ isolation: ['nope'] })
    expect(isolationChain(h.state())).toEqual([])
    h.click(15, 15)
    expect(h.state().selection).toEqual(['g'])
  })

  it('locked groups cannot be isolated; the menu item follows the selection', () => {
    const h = harness(v2([{ id: 'g', type: 'group', locked: true, children: [sq('a', 10, 10, 20, 20)] }, { id: 'h', type: 'group', children: [sq('b', 100, 10, 20, 20)] }]))
    h.ed.doubleClick({ x: 15, y: 15 })
    expect(h.state().isolation).toEqual([])
    h.ed.ctx.select(['h'])
    h.run('object.isolate')
    expect(h.state().isolation).toEqual(['h'])
    h.run('object.exitIsolation')
    expect(h.state().isolation).toEqual([])
  })
})

describe('Duplicate inside groups', () => {
  it('⌘D on a member copies it inside its own group (under a clip path), offset on screen', () => {
    const h = harness(v2([{ id: 'g', type: 'group', transform: [2, 0, 0, 2, 0, 0], clip: true, children: [sq('a', 10, 10, 20, 20), sq('m', 0, 0, 100, 100, { fill: { type: 'none' } })] }]))
    h.ed.ctx.select(['g'])
    h.run('object.clip.editContents')
    h.key('d', { meta: true })
    const g = getObject(h.doc(), 'g') as DrawGroupNode
    expect(g.children).toHaveLength(3)
    expect(g.children[2].id).toBe('m')
    const copy = h.state().selection[0]
    expect(g.children[1].id).toBe(copy)
    const a = worldBounds(h.doc(), 'a')!
    const c = worldBounds(h.doc(), copy)!
    expect(c.x - a.x).toBeCloseTo(12)
    expect(c.y - a.y).toBeCloseTo(12)
  })
})

describe('the Group Selection tool', () => {
  const tree = (): Record<string, unknown> =>
    v2([{ id: 'g', type: 'group', children: [sq('a', 10, 10, 20, 20), { id: 'inner', type: 'group', children: [sq('b', 50, 10, 20, 20), sq('c', 80, 10, 20, 20)] }] }])

  it('click selects the object inside its groups; clicking again climbs one group at a time', () => {
    const h = harness(tree())
    h.tool('groupSelect')
    h.click(60, 20)
    expect(h.state().selection).toEqual(['b'])
    h.click(60, 20)
    expect(h.state().selection).toEqual(['inner'])
    h.click(60, 20)
    expect(h.state().selection).toEqual(['g'])
    expect(h.state().past).toHaveLength(0)
  })

  it('Shift adds and removes; a drag moves only what is selected, as one step', () => {
    const h = harness(tree())
    h.tool('groupSelect')
    h.click(60, 20)
    h.click(20, 20, { shift: true })
    expect(h.state().selection.sort()).toEqual(['a', 'b'])
    h.click(20, 20, { shift: true })
    expect(h.state().selection).toEqual(['b'])
    h.ed.ctx.set({ snapOn: false })
    h.drag([60, 20], [60, 120])
    close(worldBounds(h.doc(), 'b'), { x: 50, y: 110, w: 20, h: 20 })
    close(worldBounds(h.doc(), 'c'), { x: 80, y: 10, w: 20, h: 20 })
    expect(h.state().past).toHaveLength(1)
  })

  it('the marquee picks objects inside groups', () => {
    const h = harness(tree())
    h.tool('groupSelect')
    h.drag([45, 0], [105, 40])
    expect(h.state().selection).toEqual(['b', 'c'])
  })
})
