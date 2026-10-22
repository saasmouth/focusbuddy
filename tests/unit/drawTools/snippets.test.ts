// PlexiiDraw as a saved-snippet surface (docs/saved-snippets.md, "Adding a
// snippet target"): capture is pure, insertion makes an independent copy with
// fresh ids where a paste would land and never touches the snippet, a
// read-only drawing declines, and the target claims exactly the link modes it
// honours. Driven through the real editor, commands and menus.

import { describe, expect, it } from 'vitest'
import { linkModesFor, snippetBodyIsEmpty, snippetSummary, type DrawSnippetBody, type Snippet } from '../../../src/shared/snippets'
import { assetIdFor } from '../../../src/shared/draw/assets'
import type { DrawDoc, DrawGroupNode, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode } from '../../../src/shared/draw/model'
import { nodeBounds, nodesBounds, translateNode } from '../../../src/shared/draw/ops'
import { allNodes } from '../../../src/shared/draw/tree'
import {
  DRAW_SNIPPET_LINKS,
  drawBodyFromSelection,
  drawSnippetTarget,
  drawSnippetTargetId,
  emptyDrawBody,
  insertSnippetIntoDrawing,
  suggestedDrawSnippetName
} from '../../../src/renderer/src/components/documents/draw/editor/drawSnippets'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import { canvasMenuEntries } from '../../../src/renderer/src/components/documents/draw/render/CanvasContextMenu'
import { blank, harness, rect, withOlderPeer, type Harness } from './harness'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_ID = assetIdFor(PNG)

function v2(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  }
}

/** A compound path: two closed subpaths in one path (a ring). */
function ring(id: string, x: number, y: number): Record<string, unknown> {
  const sq = (a: number, b: number, s: number) => ({ closed: true, nodes: [{ x: a, y: b }, { x: a + s, y: b }, { x: a + s, y: b + s }, { x: a, y: b + s }] })
  return { id, type: 'path', path: { subpaths: [sq(x, y, 40), sq(x + 10, y + 10, 20)], fillRule: 'evenodd' }, fill: { type: 'solid', color: '#123456' } }
}

/**
 * A drawing with everything a snippet must carry faithfully: a group holding a
 * swatch-painted rect and an image (asset ref), a clipping group, a compound
 * path, a text object, and things that must NOT travel (an unused swatch, an
 * unused asset, an unselected object).
 */
function richDoc(): Record<string, unknown> {
  const img = { id: 'img', type: 'image', x: 150, y: 60, w: 20, h: 10, assetId: PNG_ID }
  const group = {
    id: 'g',
    type: 'group',
    name: 'Logo lockup',
    children: [rect('gr', 100, 50, 30, 30, { fill: { type: 'swatch', id: 'sw1' }, stroke: { paint: { type: 'swatch', id: 'sw1', tint: 0.5 }, width: 2 } }), img]
  }
  const clip = {
    id: 'clip',
    type: 'group',
    clip: true,
    children: [rect('inside', 200, 100, 80, 80, { fill: { type: 'solid', color: '#ff00ff' } }), rect('mask', 210, 110, 40, 40)]
  }
  const text = { id: 't', type: 'text', x: 120, y: 200, w: 120, text: 'Hello snippet', fontSize: 18, fill: { type: 'solid', color: '#000000' } }
  return v2([group, clip, ring('ring', 300, 20), text, rect('other', 380, 280, 10, 10)], {
    assets: { [PNG_ID]: { mime: 'image/png', dataUrl: PNG, w: 1, h: 1 }, 'asset-unused': { mime: 'image/png', dataUrl: PNG.replace('AAAAAE', 'AAAAAF'), w: 1, h: 1 } },
    swatches: [
      { id: 'sw1', name: 'Brand', color: '#ff0000', global: true },
      { id: 'unused', name: 'Unused', color: '#00ff00' }
    ]
  })
}

const SELECTED = ['g', 'clip', 'ring', 't']

function snippetOf(body: unknown, extra: Partial<Snippet> = {}): Snippet {
  // Through JSON, as the store keeps it, so nothing in the test leans on shared references.
  return {
    id: 'snip-1',
    kind: 'draw',
    name: 'Logo block',
    description: '',
    body: JSON.parse(JSON.stringify(body)),
    tags: [],
    scope: 'personal',
    orgId: 'personal',
    authorId: null,
    revision: 1,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...extra
  }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

const idsDeep = (nodes: DrawNode[]): string[] => nodes.flatMap((n) => (n.type === 'group' ? [n.id, ...idsDeep(n.children)] : [n.id]))
const nodesIn = (doc: DrawDoc): DrawNode[] => allNodes(doc).map((e) => e.node)
const allIds = (doc: DrawDoc): string[] => nodesIn(doc).map((n) => n.id)

/** A node's shape with its ids and its position taken out: what "identical geometry" means. */
function shapeOf(nodes: DrawNode[]): unknown {
  const b = nodesBounds(nodes)
  const strip = (n: DrawNode): unknown => {
    const { id: _id, ...rest } = n as DrawNode & Record<string, unknown>
    if (n.type === 'group') return { ...rest, children: n.children.map(strip) }
    return rest
  }
  const atOrigin = nodes.map((n) => translateNode(n, -b.x, -b.y))
  return { w: b.w, h: b.h, nodes: JSON.parse(JSON.stringify(atOrigin.map(strip)), (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)) }
}

describe('capture: a selection becomes a draw body', () => {
  it('is pure: the document is not changed, and the body shares nothing with it', () => {
    const h = harness(richDoc())
    const doc = deepFreeze(h.doc())
    const snapshot = JSON.stringify(doc)
    const body = drawBodyFromSelection(doc, SELECTED)!
    expect(body).not.toBeNull()
    expect(JSON.stringify(doc)).toBe(snapshot)
    // Mutating the body cannot reach the document (frozen above, so a shared
    // object would throw here).
    ;(body.objects[0] as { name?: string }).name = 'changed'
    ;(body.assets![PNG_ID] as { mime: string }).mime = 'changed'
    expect(JSON.stringify(doc)).toBe(snapshot)
  })

  it('returns null for an empty selection, or one with nothing savable in it', () => {
    const h = harness(richDoc())
    expect(drawBodyFromSelection(h.doc(), [])).toBeNull()
    expect(drawBodyFromSelection(h.doc(), ['no-such-object'])).toBeNull()
  })

  it('makes positions relative to the selection top-left and keeps every object in order', () => {
    const h = harness(richDoc())
    const before = nodesBounds(SELECTED.map((id) => nodesIn(h.doc()).find((n) => n.id === id)!))
    const body = drawBodyFromSelection(h.doc(), SELECTED)!
    const objects = body.objects as DrawNode[]
    const after = nodesBounds(objects)
    expect(after.x).toBeCloseTo(0, 6)
    expect(after.y).toBeCloseTo(0, 6)
    expect(after.w).toBeCloseTo(before.w, 6)
    expect(after.h).toBeCloseTo(before.h, 6)
    expect(objects.map((o) => o.id)).toEqual(SELECTED)
    // The text object moved by exactly the selection's offset.
    const t = objects.find((o) => o.id === 't') as DrawTextNode
    expect(t.x).toBeCloseTo(120 - before.x, 6)
    expect(t.y).toBeCloseTo(200 - before.y, 6)
  })

  it('keeps groups, clipping masks, compound paths, text and image references, with exactly the assets and swatches they use', () => {
    const h = harness(richDoc())
    const body = drawBodyFromSelection(h.doc(), SELECTED)!
    const [g, clip, ringNode, t] = body.objects as [DrawGroupNode, DrawGroupNode, DrawPathNode, DrawTextNode]
    expect(g.type).toBe('group')
    expect(g.name).toBe('Logo lockup')
    expect(g.children.map((c) => c.type)).toEqual(['path', 'image'])
    expect((g.children[0] as DrawPathNode).fill).toEqual({ type: 'swatch', id: 'sw1' })
    expect((g.children[1] as DrawImageNode).assetId).toBe(PNG_ID)
    expect(clip.clip).toBe(true)
    expect(clip.children.map((c) => c.id)).toEqual(['inside', 'mask'])
    expect(ringNode.path.subpaths).toHaveLength(2)
    expect(t.text).toBe('Hello snippet')
    expect(Object.keys(body.assets!)).toEqual([PNG_ID])
    expect((body.assets![PNG_ID] as { dataUrl: string }).dataUrl).toBe(PNG)
    expect((body.swatches as Array<{ id: string }>).map((s) => s.id)).toEqual(['sw1'])
    expect(snippetBodyIsEmpty(body)).toBe(false)
    expect(snippetSummary(snippetOf(body))).toBe('4 object(s)')
  })

  it('a member picked out of a transformed group keeps where it was seen', () => {
    const g = { id: 'tg', type: 'group', transform: [1, 0, 0, 1, 100, 50], children: [rect('m', 0, 0, 20, 10)] }
    const h = harness(v2([g]))
    const seen = nodeBounds(nodesIn(h.doc()).find((n) => n.id === 'tg')!)
    const body = drawBodyFromSelection(h.doc(), ['m'])!
    const m = (body.objects as DrawNode[])[0]
    expect(nodeBounds(m)).toEqual({ x: 0, y: 0, w: seen.w, h: seen.h })
  })

  it('suggests a name from what the person called an object or from its words, never an invented one', () => {
    const h = harness(richDoc())
    expect(suggestedDrawSnippetName(drawBodyFromSelection(h.doc(), SELECTED)!)).toBe('Logo lockup')
    expect(suggestedDrawSnippetName(drawBodyFromSelection(h.doc(), ['t'])!)).toBe('Hello snippet')
    expect(suggestedDrawSnippetName(drawBodyFromSelection(h.doc(), ['ring'])!)).toBe('')
    expect(snippetBodyIsEmpty(emptyDrawBody())).toBe(true)
  })
})

describe('insertion: a duplicate, where a paste would land', () => {
  function captured(): DrawSnippetBody {
    const h = harness(richDoc())
    return drawBodyFromSelection(h.doc(), SELECTED)!
  }

  it('inserts an independent copy: fresh ids everywhere, identical geometry, selected, one undo step, snippet untouched', () => {
    const snippet = deepFreeze(snippetOf(captured()))
    const snapshot = JSON.stringify(snippet)
    const h = harness(v2([rect('existing', 10, 10, 20, 20)]))
    const existing = allIds(h.doc())

    expect(insertSnippetIntoDrawing(h.ed.ctx, snippet, 'duplicate')).toBe(true)
    expect(JSON.stringify(snippet)).toBe(snapshot)

    const added = h.objects().filter((o) => !existing.includes(o.id))
    expect(added).toHaveLength(4)
    // Every node and every group member has an id that is neither the
    // snippet's nor one already in the drawing.
    const snippetIds = idsDeep(snippet.body.kind === 'draw' ? (snippet.body.objects as DrawNode[]) : [])
    const fresh = idsDeep(added)
    expect(fresh).toHaveLength(snippetIds.length)
    for (const id of fresh) {
      expect(snippetIds).not.toContain(id)
      expect(existing).not.toContain(id)
    }
    expect(new Set(fresh).size).toBe(fresh.length)
    // Same shapes, same styles, same structure; only position and ids differ.
    expect(shapeOf(added)).toEqual(shapeOf(snippet.body.kind === 'draw' ? (snippet.body.objects as DrawNode[]) : []))
    // Selected, as a paste is; one undo step that takes it back.
    expect(h.state().selection).toEqual(added.map((o) => o.id))
    expect(h.state().past.map((p) => p.label)).toEqual(['Insert snippet'])
    expect(h.state().status).toBe('Inserted "Logo block".')
    h.run('edit.undo')
    expect(allIds(h.doc())).toEqual(existing)
  })

  it('lands where Paste would: centred on the artboard (no window known), at the front of the active layer', () => {
    const h = harness(v2([rect('existing', 10, 10, 20, 20)]))
    const snippet = snippetOf(captured())
    insertSnippetIntoDrawing(h.ed.ctx, snippet, 'duplicate')
    const added = h.objects().slice(1)
    const b = nodesBounds(added)
    expect(Math.abs(b.x + b.w / 2 - 200)).toBeLessThanOrEqual(1)
    expect(Math.abs(b.y + b.h / 2 - 150)).toBeLessThanOrEqual(1)
    expect(h.objects()[0].id).toBe('existing')
  })

  it('brings the image bytes and the swatch it uses, so the picture and the colour resolve', () => {
    const h = harness(v2([]))
    insertSnippetIntoDrawing(h.ed.ctx, snippetOf(captured()), 'duplicate')
    const g = h.objects()[0] as DrawGroupNode
    const img = g.children[1] as DrawImageNode
    expect(h.doc().assets[img.assetId].dataUrl).toBe(PNG)
    expect(h.doc().swatches).toEqual([{ id: 'sw1', name: 'Brand', color: '#ff0000', global: true }])
    expect(Object.keys(h.doc().assets)).toEqual([PNG_ID])
  })

  it('inserting twice makes two copies with distinct ids', () => {
    const h = harness(v2([]))
    const snippet = snippetOf(captured())
    insertSnippetIntoDrawing(h.ed.ctx, snippet, 'duplicate')
    insertSnippetIntoDrawing(h.ed.ctx, snippet, 'duplicate')
    const ids = allIds(h.doc())
    expect(h.objects()).toHaveLength(8)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declines on a read-only drawing, and says why', () => {
    const h = harness({ ...blank([rect('a', 50, 50, 40, 40)]), schemaVersion: 3 })
    expect(h.state().readOnly).toBe(true)
    const before = h.doc()
    expect(insertSnippetIntoDrawing(h.ed.ctx, snippetOf(captured()), 'duplicate')).toBe(false)
    expect(h.doc()).toBe(before)
    expect(h.state().status).toMatch(/read-only/)
    expect(drawSnippetTarget(h.ed.ctx, 'X').insert(snippetOf(captured()), 'duplicate')).toBe(false)
  })

  it('declines a live insert, a body of another kind, an empty body and a hidden target layer, changing nothing', () => {
    const h = harness(v2([]))
    const before = h.doc()
    expect(insertSnippetIntoDrawing(h.ed.ctx, snippetOf(captured()), 'live')).toBe(false)
    expect(insertSnippetIntoDrawing(h.ed.ctx, snippetOf({ kind: 'doc', content: [], text: '' }, { kind: 'doc' }), 'duplicate')).toBe(false)
    expect(insertSnippetIntoDrawing(h.ed.ctx, snippetOf(emptyDrawBody()), 'duplicate')).toBe(false)
    expect(h.doc()).toBe(before)

    const hidden = harness(v2([], { layers: [{ id: 'L1', kind: 'vector', name: 'Hidden', visible: false, locked: false, opacity: 1, blend: 'normal', objects: [] }] }))
    const hb = hidden.doc()
    expect(insertSnippetIntoDrawing(hidden.ed.ctx, snippetOf(captured()), 'duplicate')).toBe(false)
    expect(hidden.doc()).toBe(hb)
    expect(hidden.state().status).toMatch(/hidden/)
  })

  it('declines v2-only art (a group) in a drawing that must stay in the older format, and says why', () => {
    const h = withOlderPeer(harness(blank([])))
    const before = h.doc()
    expect(insertSnippetIntoDrawing(h.ed.ctx, snippetOf(captured()), 'duplicate')).toBe(false)
    expect(h.doc()).toBe(before)
    expect(h.state().status).toMatch(/older format/)
    // A plain path is fine there.
    const plain = drawBodyFromSelection(harness(richDoc()).doc(), ['ring'])!
    expect(insertSnippetIntoDrawing(h.ed.ctx, snippetOf(plain), 'duplicate')).toBe(true)
  })

  it('leaves out what a newer PlexiiDraw made, and says so', () => {
    const h = harness(v2([]))
    const body = { kind: 'draw', objects: [{ id: 'z', type: 'hologram', x: 0, y: 0 }, JSON.parse(JSON.stringify(rect('r', 0, 0, 10, 10)))], assets: {}, swatches: [] }
    expect(insertSnippetIntoDrawing(h.ed.ctx, snippetOf(body), 'duplicate')).toBe(true)
    expect(h.objects().map((o) => o.type)).toEqual(['path'])
    expect(h.state().status).toMatch(/newer PlexiiDraw/)
  })
})

describe('the target and the menus', () => {
  it('claims Duplicate only, for draw snippets only', () => {
    const h = harness(v2([]))
    const target = drawSnippetTarget(h.ed.ctx, 'Poster')
    expect(DRAW_SNIPPET_LINKS).toEqual(['duplicate'])
    expect(linkModesFor(target, 'draw')).toEqual(['duplicate'])
    expect(linkModesFor(target, 'design')).toEqual([])
    expect(linkModesFor(target, 'doc')).toEqual([])
    expect(target.label).toBe('“Poster”')
    expect(drawSnippetTarget(h.ed.ctx, '').label).toBe('This drawing')
  })

  it('identifies the mounted editor, not the drawing: one id per editor, stable', () => {
    const a = harness(v2([]))
    const b = harness(v2([]))
    expect(drawSnippetTargetId(a.ed.ctx)).toBe(drawSnippetTargetId(a.ed.ctx))
    expect(drawSnippetTargetId(a.ed.ctx)).not.toBe(drawSnippetTargetId(b.ed.ctx))
    expect(drawSnippetTargetId(a.ed.ctx)).toMatch(/^draw:/)
  })

  it('Edit › Save selection as snippet… is off with nothing selected, and opens the save dialog with the captured body', () => {
    const h = harness(richDoc())
    const item = (): { disabled?: boolean; hint?: string } => buildMenu(h.ed.ctx, 'edit').find((i) => i.kind === 'item' && i.label === 'Save selection as snippet…') as { disabled?: boolean; hint?: string }
    expect(item()).toBeTruthy()
    expect(item().disabled).toBe(true)
    h.ed.ctx.select(['ring', 't'])
    expect(item().disabled).toBe(false)
    h.run('edit.saveAsSnippet')
    const dialog = h.state().dialog!
    expect(dialog.id).toBe('save-snippet')
    const body = dialog.props!.body as DrawSnippetBody
    expect(body).toEqual(drawBodyFromSelection(h.doc(), ['ring', 't']))
    expect(dialog.props!.suggestedName).toBe('Hello snippet')
  })

  it('Edit › Insert snippet… opens the library aimed at this editor, and is off on a read-only drawing', () => {
    const h = harness(v2([]))
    h.run('edit.insertSnippet')
    expect(h.state().dialog).toEqual({ id: 'snippet-library', props: { targetId: drawSnippetTargetId(h.ed.ctx) } })
    const ro = harness({ ...blank([]), schemaVersion: 3 })
    const item = buildMenu(ro.ed.ctx, 'edit').find((i) => i.kind === 'item' && i.label === 'Insert snippet…') as { disabled?: boolean }
    expect(item.disabled).toBe(true)
  })

  it('both sit in the canvas context menu', () => {
    const h = harness(richDoc())
    h.ed.ctx.select(['ring'])
    const ids = canvasMenuEntries(h.ed.ctx).filter((e) => e !== 'sep').map((e) => (e as { id: string }).id)
    expect(ids).toContain('edit.saveAsSnippet')
    expect(ids).toContain('edit.insertSnippet')
  })
})
