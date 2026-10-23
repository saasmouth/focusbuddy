// SPEC §9.5 for PlexiiDraw's menus: a greyed item always says why, and an
// enabled one always does something. Every Draw command that can be off takes
// its `enabled` and its `disabledReason` from ONE predicate (commands/gate.ts),
// so the two cannot disagree; this sweeps the menu through the states a
// person meets and holds that, then pins the commands whose `enabled` was
// wrong (on while they could do nothing, or while they edited locked art).

import { describe, expect, it, vi } from 'vitest'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import type { MenuItem } from '../../../src/renderer/src/components/documents/editor/menuBarKit'
import { commandById, drawCommands, drawMenus } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { READ_ONLY_REASON } from '../../../src/renderer/src/components/documents/draw/commands/gate'
import { selectAnchors } from '../../../src/renderer/src/components/documents/draw/editor/anchorSelection'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { blank, harness, rect, withDocument, withOlderPeer, type Harness } from './harness'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

const MENU_COMMANDS = drawCommands().filter((c) => c.menu)
const TWO = (): unknown[] => [rect('a', 10, 10, 50, 50), rect('b', 100, 10, 50, 50)]
const THREE = (): unknown[] => [...TWO(), rect('c', 200, 10, 50, 50)]

/** The states the sweep visits, each a fresh editor. */
const STATES: Array<[string, () => Harness]> = [
  ['blank', () => withDocument(harness(blank()))],
  ['blank, read-only', () => withDocument(harness(blank(), { readOnly: true }))],
  ['blank, no document host', () => harness(blank())],
  ['three shapes, none selected', () => withDocument(harness(blank(THREE())))],
  [
    'one shape selected',
    () => {
      const h = withDocument(harness(blank(THREE())))
      h.ed.ctx.select(['a'])
      return h
    }
  ],
  [
    'three shapes selected',
    () => {
      const h = withDocument(harness(blank(THREE())))
      h.ed.ctx.select(['a', 'b', 'c'])
      return h
    }
  ],
  [
    'three selected, read-only',
    () => {
      const h = withDocument(harness(blank(THREE()), { readOnly: true }))
      h.ed.ctx.select(['a', 'b', 'c'])
      return h
    }
  ],
  [
    'two selected on a locked layer',
    () => {
      const h = withDocument(harness(blank(TWO())))
      h.ed.ctx.select(['a', 'b'])
      h.run('layer.patch', { id: h.doc().layers[0].id, patch: { locked: true } })
      return h
    }
  ],
  [
    'two selected, older peer in a live session',
    () => {
      const h = withOlderPeer(withDocument(harness(blank(TWO()))))
      h.ed.ctx.select(['a', 'b'])
      return h
    }
  ],
  [
    'anchors picked with Direct Selection',
    () => {
      const h = withDocument(harness(blank(TWO())))
      selectAnchors(h.ed.ctx, [
        { id: 'a', si: 0, ni: 0 },
        { id: 'a', si: 0, ni: 1 }
      ])
      return h
    }
  ]
]

/** Every item of every menu, submenus flattened, as the menu bar builds them. */
function allItems(h: Harness): Array<{ path: string; label: string; disabled: boolean; hint?: string }> {
  const out: Array<{ path: string; label: string; disabled: boolean; hint?: string }> = []
  const walk = (path: string, items: MenuItem[]): void => {
    for (const i of items) {
      if (i.kind === 'item') out.push({ path, label: i.label, disabled: !!i.disabled, hint: i.hint })
      else if (i.kind === 'submenu') walk(`${path} › ${i.label}`, i.items)
    }
  }
  for (const m of drawMenus().filter((m) => !m.path.includes('/'))) walk(m.label, buildMenu(h.ed.ctx, m.path))
  return out
}

describe('every greyed Draw menu item says why', () => {
  it.each(STATES)('%s', (_name, make) => {
    const h = make()
    const silent = allItems(h).filter((i) => i.disabled && !i.hint?.trim())
    expect(silent.map((i) => `${i.path} › ${i.label}`)).toEqual([])
  })

  it.each(STATES)('%s: the reason is there exactly when the command is off', (_name, make) => {
    const h = make()
    const disagree = MENU_COMMANDS.filter((c) => c.enabled && !c.pending).flatMap((c) => {
      const on = c.enabled!(h.ed.ctx)
      const why = c.disabledReason?.(h.ed.ctx) ?? null
      return on === (why === null) ? [] : [`${c.id}: enabled=${on}, reason=${JSON.stringify(why)}`]
    })
    expect(disagree).toEqual([])
  })

  it('reasons are sentences in the owner’s spelling (centre, colour)', () => {
    const reasons = new Set<string>()
    for (const [, make] of STATES) {
      const h = make()
      for (const c of MENU_COMMANDS) {
        const why = c.disabledReason?.(h.ed.ctx)
        if (why) reasons.add(why)
      }
    }
    const bad = [...reasons].filter((r) => !/^[A-Z]/.test(r) || !/[.]$/.test(r) || /\b(color|center)/i.test(r))
    expect(bad).toEqual([])
    expect(reasons.size).toBeGreaterThan(30)
  })
})

describe('commands whose `enabled` was wrong', () => {
  const pathOf = (h: Harness, id: string): DrawPathNode => h.objects().find((o) => o.id === id) as DrawPathNode

  // Pathfinder was on with nothing selected (and with one path), where it does nothing.
  it.each(['object.unite', 'object.minusFront', 'object.intersect', 'object.exclude'])('%s: off below two paths, on with two, and then it combines them', (id) => {
    const h = harness(blank(TWO()))
    const c = commandById(id)!
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe('Select two or more paths to combine them.')
    h.ed.ctx.select(['a'])
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    h.ed.ctx.select(['a', 'b'])
    expect(c.enabled!(h.ed.ctx)).toBe(true)
    expect(c.disabledReason!(h.ed.ctx)).toBeNull()
    h.run(id)
    expect(h.state().past.length).toBe(1)
  })

  it('Pathfinder is off for paths on a locked layer', () => {
    const h = harness(blank(TWO()))
    h.ed.ctx.select(['a', 'b'])
    h.run('layer.patch', { id: h.doc().layers[0].id, patch: { locked: true } })
    expect(commandById('object.unite')!.enabled!(h.ed.ctx)).toBe(false)
  })

  // Close, Open and Reverse counted every selected path, locked ones
  // included, and changed them: a path on a locked layer was edited.
  it.each([
    ['object.closePath', 'Select a path to close it.'],
    ['object.openPath', 'Select a path to open it.'],
    ['object.reverse', 'Select a path to reverse it.']
  ])('%s is off for paths on a locked layer, and running it anyway leaves them alone', (id, reason) => {
    const h = harness(blank(TWO()))
    h.ed.ctx.select(['a', 'b'])
    h.run('layer.patch', { id: h.doc().layers[0].id, patch: { locked: true } })
    const c = commandById(id)!
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe(reason)
    const before = JSON.stringify(h.doc().layers)
    h.run(id)
    expect(JSON.stringify(h.doc().layers)).toBe(before)
  })

  it('Open path still opens an unlocked path, and leaves a locked one beside it closed', () => {
    const h = harness(blank([rect('a', 10, 10, 50, 50), rect('b', 100, 10, 50, 50, { locked: true })]))
    h.ed.ctx.select(['a', 'b'])
    expect(commandById('object.openPath')!.enabled!(h.ed.ctx)).toBe(true)
    h.run('object.openPath')
    expect(pathOf(h, 'a').path.subpaths[0].closed).toBe(false)
    expect(pathOf(h, 'b').path.subpaths[0].closed).toBe(true)
  })

  // Duplicate and Delete were on for a selection of only locked art, and did nothing.
  it.each([
    ['edit.duplicate', 'Locked or hidden objects cannot be duplicated.'],
    ['edit.delete', 'Locked or hidden objects cannot be deleted.']
  ])('%s is off, with its reason, when everything selected is locked', (id, reason) => {
    const h = harness(blank(TWO()))
    h.ed.ctx.select(['a', 'b'])
    h.run('layer.patch', { id: h.doc().layers[0].id, patch: { locked: true } })
    const c = commandById(id)!
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe(reason)
  })

  it('Delete stays on for anchors picked with Direct Selection', () => {
    const h = harness(blank(TWO()))
    selectAnchors(h.ed.ctx, [{ id: 'a', si: 0, ni: 0 }])
    expect(commandById('edit.delete')!.enabled!(h.ed.ctx)).toBe(true)
  })

  // Edit mask / Edit contents were on in a read-only drawing, where their run refuses.
  it.each(['object.clip.editMask', 'object.clip.editContents'])('%s is off, saying read-only, in a read-only drawing', (id) => {
    const h = harness(blank(TWO()))
    h.ed.ctx.select(['a', 'b'])
    h.run('object.clip.make')
    const clip = h.objects()[0]
    expect(clip.type).toBe('group')
    h.ed.ctx.select([clip.id])
    const c = commandById(id)!
    expect(c.enabled!(h.ed.ctx)).toBe(true)
    h.ed.store.setState({ readOnly: true })
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe(READ_ONLY_REASON)
  })
})

// The anchor commands (Object › Path and the Anchor points tab) counted every
// selected anchor, those on locked art included: with the layer locked after
// picking anchors they stayed on, and did nothing.
describe('anchor commands are off for anchors on locked art, saying so', () => {
  const LOCKED = 'Those anchor points are on a locked or hidden path.'
  const line = (id: string, x: number): Record<string, unknown> => ({
    id,
    type: 'path',
    shapeKind: 'path',
    path: { subpaths: [{ closed: false, nodes: [{ x, y: 10 }, { x: x + 50, y: 60 }] }] },
    stroke: { paint: { type: 'solid', color: '#000000' }, width: 2 }
  })
  const ANCHOR_COMMANDS = [
    'path.average',
    'path.averageApply',
    'path.removeAnchors',
    'path.cutAtAnchors',
    'path.convertCorner',
    'path.convertSmooth',
    'path.alignAnchors.left',
    'path.alignAnchors.hcenter',
    'path.alignAnchors.right',
    'path.alignAnchors.top',
    'path.alignAnchors.vcenter',
    'path.alignAnchors.bottom',
    'path.cornerRadius'
  ]

  it.each(ANCHOR_COMMANDS)('%s: on with anchors picked, off with their layer locked', (id) => {
    const h = harness(blank(TWO()))
    selectAnchors(h.ed.ctx, [
      { id: 'a', si: 0, ni: 0 },
      { id: 'a', si: 0, ni: 1 }
    ])
    const c = commandById(id)!
    expect(c.enabled!(h.ed.ctx)).toBe(true)
    h.run('layer.patch', { id: h.doc().layers[0].id, patch: { locked: true } })
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe(LOCKED)
  })

  it('a locked path alone (its layer unlocked) is excluded the same way', () => {
    const h = harness(blank([rect('a', 10, 10, 50, 50, { locked: true }), rect('b', 100, 10, 50, 50)]))
    selectAnchors(h.ed.ctx, [
      { id: 'a', si: 0, ni: 0 },
      { id: 'a', si: 0, ni: 2 }
    ])
    expect(commandById('path.average')!.enabled!(h.ed.ctx)).toBe(false)
    expect(commandById('path.average')!.disabledReason!(h.ed.ctx)).toBe(LOCKED)
  })

  it.each(['path.join', 'path.averageJoin'])('%s with two picked end points: on, then off with their layer locked', (id) => {
    const h = harness(blank([line('l1', 10), line('l2', 200)]))
    selectAnchors(h.ed.ctx, [
      { id: 'l1', si: 0, ni: 1 },
      { id: 'l2', si: 0, ni: 0 }
    ])
    const c = commandById(id)!
    expect(c.enabled!(h.ed.ctx)).toBe(true)
    h.run('layer.patch', { id: h.doc().layers[0].id, patch: { locked: true } })
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe(LOCKED)
  })
})
