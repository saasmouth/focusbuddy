import { describe, it, expect, beforeEach } from 'vitest'
import type { Widget, WidgetKind } from '../../src/shared/types'
import { resolveMenu } from '../../src/renderer/src/lib/contextMenu/resolve'
import {
  registerWidgetContextActions,
  clearWidgetContextActions
} from '../../src/renderer/src/lib/contextMenu/registry'
import type { MenuContext } from '../../src/renderer/src/lib/contextMenu/types'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import { MENU_ROW_CEILING } from '../../src/renderer/src/lib/contextMenu/resolve'
import { AI_ACTION_SET } from '../../src/renderer/src/lib/contextMenu/aiAssist'
import { AI_DIRECT_ACTIONS, AI_READ_ACTIONS } from '../../src/shared/aiTextActions'
// 4.3.32 lexicon standard: user-facing text says “work widget”. The string pins in
// this file that read “widget” were rewritten to the new wording (owner ruling).

function widget(kind: WidgetKind, content = ''): Widget {
  return {
    id: `w-${kind}`,
    taskId: 't-1',
    kind,
    title: '',
    content,
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    zIndex: 1,
    color: null,
    pinned: false,
    pinnedScreenX: null,
    pinnedScreenY: null,
    pinnedZone: null,
    parentSectionId: null,
    layout: null,
    sourceAppId: null,
    mode: null,
    livingQuery: null,
    livingGeneratedAt: null,
    livingPaused: false,
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    syncGroupId: null
  }
}

function widgetCtx(w: Widget, selectionText?: string): MenuContext {
  return {
    object: { type: 'widget', widget: w },
    selection: selectionText
      ? { text: selectionText, sourceWidgetId: w.id, sourceKind: w.kind }
      : undefined,
    taskId: 't-1',
    canvasPoint: { x: 0, y: 0 },
    clientPoint: { x: 10, y: 10 }
  }
}

// Rows above the destructive group: what the eight-row ceiling counts (E-6).
// Separators do not count; More actions does.
function ceilingRows(items: CtxMenuItem[]): CtxMenuItem[] {
  return items.filter((i) => !i.separator && !i.danger)
}
function topLevel(items: CtxMenuItem[]): CtxMenuItem[] {
  return items.filter((i) => !i.separator)
}

function maxDepth(items: CtxMenuItem[]): number {
  let d = 1
  for (const it of items) {
    if (it.children?.length) d = Math.max(d, 1 + maxDepth(it.children))
  }
  return d
}

function labels(items: CtxMenuItem[]): string[] {
  return topLevel(items).map((i) => i.label ?? '')
}

function allLabels(items: CtxMenuItem[]): string[] {
  const out: string[] = []
  for (const it of items) {
    if (it.label) out.push(it.label)
    if (it.children) out.push(...allLabels(it.children))
  }
  return out
}

const find = (items: CtxMenuItem[], label: string): CtxMenuItem | undefined => {
  for (const it of items) {
    if (it.label === label) return it
    const k = it.children && find(it.children, label)
    if (k) return k
  }
  return undefined
}

function frameCtx(w: Widget, frame: Partial<NonNullable<MenuContext['frame']>> = {}): MenuContext {
  return {
    object: { type: 'widget', widget: w },
    taskId: 't-1',
    canvasPoint: { x: 0, y: 0 },
    clientPoint: { x: 10, y: 10 },
    frame: {
      onMakeTask: () => {},
      onShare: () => {},
      onDuplicateSynced: () => {},
      onDuplicateIndependent: () => {},
      ...frame
    }
  }
}

describe('resolveMenu — the eight-row ceiling (E-6) counts Paste and kind rows', () => {
  beforeEach(() => clearWidgetContextActions())

  // F-9: Paste and header extras used to be spliced in outside the slot
  // arithmetic (9 rows on a sticky, 10 on a table header, 15+ on a custom).
  it('never exceeds the ceiling with Paste, snippets, three provider rows and nine header extras', () => {
    registerWidgetContextActions('sticky', () => ({
      context: [
        { id: 'a', group: 'object', priority: 0, label: 'Action a' },
        { id: 'b', group: 'object', priority: 1, label: 'Action b' },
        { id: 'c', group: 'object', priority: 2, label: 'Action c' }
      ]
    }))
    const ctx = frameCtx(widget('sticky', 'hello world'), {
      onPaste: () => {},
      onInsertSnippet: () => {},
      onSaveAsSnippet: () => {},
      onRename: () => {},
      onSaveAsFile: () => {}
    })
    ctx.headerExtras = Array.from({ length: 9 }, (_, i) => ({ label: `Extra ${i}`, onClick: () => {} }))
    ctx.selection = { text: 'hello', sourceWidgetId: 'w-sticky', sourceKind: 'sticky' }
    const items = resolveMenu(ctx)
    expect(MENU_ROW_CEILING).toBe(8)
    expect(ceilingRows(items).length).toBeLessThanOrEqual(8)
    // Nothing was lost: every extra and provider row is reachable under More actions.
    const all = allLabels(items)
    for (let i = 0; i < 9; i++) expect(all).toContain(`Extra ${i}`)
    expect(all).toEqual(expect.arrayContaining(['Action a', 'Action b', 'Action c', 'Paste', 'Insert snippet…']))
    // Paste is never the row that folds.
    expect(labels(items)).toContain('Paste')
  })

  it('folds the overflow into More actions and keeps Add to Focus… first', () => {
    registerWidgetContextActions('sticky', () => ({
      context: [
        { id: 'a', group: 'object', priority: 0, label: 'Action a' },
        { id: 'b', group: 'object', priority: 1, label: 'Action b' },
        { id: 'c', group: 'object', priority: 2, label: 'Action c' }
      ]
    }))
    const items = resolveMenu(frameCtx(widget('sticky', 'x'), { onSaveAsSnippet: () => {}, onPaste: () => {} }))
    const ls = labels(items)
    expect(ls[0]).toBe('Add to Focus…')
    // The first kind row keeps its place; the later ones fold.
    expect(ls[1]).toBe('Action a')
    const more = topLevel(items).find((i) => i.label === 'More actions')
    expect(more?.children?.map((c) => c.label)).toEqual(expect.arrayContaining(['Action b', 'Action c']))
  })
})

describe('resolveMenu — §9.3 group order', () => {
  beforeEach(() => clearWidgetContextActions())

  it('object, clipboard, arrange, Plexii, More actions, then destructive behind its own separator', () => {
    const items = resolveMenu(frameCtx(widget('timer', ''), { onSaveAsSnippet: () => {}, onRename: () => {} }))
    const ls = labels(items)
    const at = (l: string): number => ls.indexOf(l)
    expect(at('Add to Focus…')).toBe(0)
    expect(at('Duplicate')).toBeGreaterThan(at('Share…'))
    expect(at('Bring to front')).toBeGreaterThan(at('Duplicate'))
    expect(at('Save selection as snippet…')).toBeGreaterThan(at('Bring to front'))
    expect(at('More actions')).toBeGreaterThan(at('Save selection as snippet…'))
    const firstDanger = items.findIndex((i) => i.danger)
    expect(items[firstDanger - 1]?.separator).toBe(true)
    expect(items.slice(firstDanger).every((i) => i.danger)).toBe(true)
  })

  it('AI assist reaches three levels at the top; More actions › Create & link stays within three', () => {
    const items = resolveMenu(widgetCtx(widget('note', 'some text')))
    const ai = topLevel(items).find((i) => i.label === 'AI assist')
    expect(maxDepth([ai as CtxMenuItem])).toBe(3)
    const more = topLevel(items).find((i) => i.label === 'More actions')
    expect(maxDepth([more as CtxMenuItem])).toBe(3)
  })
})

describe('resolveMenu — Create & link carries the Copy into rows', () => {
  beforeEach(() => clearWidgetContextActions())

  it('puts the create offerings and the copy targets under one Create & link', () => {
    const items = resolveMenu(widgetCtx(widget('note', 'convert me')))
    expect(allLabels(items).filter((l) => l === 'Create & link')).toHaveLength(1)
    const create = find(items, 'Create & link')
    const childLabels = create?.children?.map((c) => c.label) ?? []
    expect(childLabels).toContain('Copy into sticky')
    // A disabled "Copy into" heading is gone: it was a dead row without a reason.
    expect(childLabels).not.toContain('Copy into')
  })
})

describe('resolveMenu — AI assist (E-12)', () => {
  beforeEach(() => clearWidgetContextActions())

  it('offers the one set of eight from @shared/aiTextActions, in sentence case', () => {
    expect(AI_ACTION_SET).toEqual([...AI_DIRECT_ACTIONS, ...AI_READ_ACTIONS])
    expect(AI_ACTION_SET).toHaveLength(8)
    const items = resolveMenu(widgetCtx(widget('note', 'some text')))
    const ai = topLevel(items).find((i) => i.label === 'AI assist')
    const rows = (ai?.children ?? []).filter((c) => !c.separator && !c.children).map((c) => c.label)
    expect(rows.slice(0, 8)).toEqual([
      'Expand', 'Simplify', 'Summarise', 'Rewrite', 'Fix grammar', 'Improve clarity', 'Continue writing', 'Explain'
    ])
    expect(allLabels([ai as CtxMenuItem]).some((l) => l.includes('...'))).toBe(false)
  })

  it('omits AI assist when there is no workable text', () => {
    const items = resolveMenu(widgetCtx(widget('timer', '')))
    expect(allLabels(items)).not.toContain('AI assist')
  })

  it('lets a widget suppress AI assist via the provider', () => {
    registerWidgetContextActions('living-doc', () => ({ context: [], suppress: { 'ai-assist': true } }))
    const items = resolveMenu(widgetCtx(widget('living-doc', 'living body text')))
    expect(allLabels(items)).not.toContain('AI assist')
  })
})

describe('resolveMenu — frame actions', () => {
  beforeEach(() => clearWidgetContextActions())

  it('surfaces Make this a desk…, Share…, Duplicate and Duplicate, keep synced; E-7 drops the duplicate route', () => {
    const items = resolveMenu(frameCtx(widget('timer', '')))
    const ls = allLabels(items)
    expect(ls).toContain('Make this a desk…')
    expect(ls).toContain('Share…')
    expect(ls).toContain('Duplicate')
    expect(ls).toContain('Duplicate, keep synced')
    expect(ls.some((l) => /another Room/i.test(l))).toBe(false)
    expect(ceilingRows(items).length).toBeLessThanOrEqual(8)
  })

  it('only shows eject and unlink when the widget is in a section or synced', () => {
    const plain = allLabels(resolveMenu(frameCtx(widget('note', 'x'))))
    expect(plain).not.toContain('Move out of section')
    expect(plain).not.toContain('Unlink from synced copies')
    const sectioned: Widget = { ...widget('note', 'x'), parentSectionId: 'sec-1', syncGroupId: 'g-1' }
    const rich = allLabels(resolveMenu(frameCtx(sectioned, { onEjectFromSection: () => {}, onUnlinkSynced: () => {} })))
    expect(rich).toContain('Move out of section')
    expect(rich).toContain('Unlink from synced copies')
  })

  it('puts header extras in the object group, right after Add to Focus…', () => {
    const ctx = frameCtx(widget('webview', ''))
    ctx.headerExtras = [{ label: 'Pin to Apps', icon: 'push_pin', onClick: () => {} }, { separator: true }]
    const items = resolveMenu(ctx)
    expect(topLevel(items)[0]?.label).toBe('Add to Focus…')
    expect(topLevel(items)[1]?.label).toBe('Pin to Apps')
    // The extras' own separator is dropped: groups draw their own.
    expect(items[1]?.separator).not.toBe(true)
  })
})

describe('resolveMenu — removal rows (E-2)', () => {
  beforeEach(() => clearWidgetContextActions())
  const danger = (items: CtxMenuItem[]): string[] => items.filter((i) => i.danger).map((i) => i.label ?? '')

  it('a work widget file: Archive · Remove from this desk · Move to Trash, no Remove ▸ chooser', () => {
    const items = resolveMenu(frameCtx({ ...widget('sticky', 'x'), syncGroupId: 'wf:file-1' }))
    expect(danger(items)).toEqual(['Archive', 'Remove from this desk', 'Move to Trash'])
    expect(allLabels(items)).not.toContain('Remove')
  })

  it('a desk-only kind (no file, no Trash entry): Archive · Delete', () => {
    expect(danger(resolveMenu(frameCtx(widget('timer', ''))))).toEqual(['Archive', 'Delete'])
  })

  it('the full-pane file view: only Move to Trash', () => {
    expect(danger(resolveMenu(frameCtx({ ...widget('sticky', 'x'), id: 'wf:file-1' })))).toEqual(['Move to Trash'])
  })

  it('a host that owns removal (a document embed): none', () => {
    expect(danger(resolveMenu(frameCtx(widget('sticky', 'x'), { removal: 'none' })))).toEqual([])
  })

  it('honours danger: a provider row marked danger joins the destructive group', () => {
    registerWidgetContextActions('table', 'cell', () => ({
      context: [{ id: 'del', group: 'object', priority: 0, label: 'Delete row', danger: true }]
    }))
    const ctx = frameCtx(widget('table', 't'))
    ctx.sub = { granularity: 'cell', payload: {} }
    const items = resolveMenu(ctx)
    expect(danger(items)).toContain('Delete row')
    expect(labels(items).slice(0, 3)).not.toContain('Delete row')
  })
})

describe('resolveMenu — multi-selection', () => {
  it('exposes bulk actions on the contract, the one remove-or-delete question last', () => {
    const ctx: MenuContext = {
      object: { type: 'multi', widgets: [widget('sticky', 'one'), widget('note', 'two')] },
      taskId: 't-1',
      canvasPoint: { x: 0, y: 0 },
      clientPoint: { x: 10, y: 10 }
    }
    const items = resolveMenu(ctx)
    const flat = allLabels(items)
    expect(flat).toContain('Add 2 to Focus…')
    expect(flat).toContain('Copy all text')
    expect(flat).toContain('Bring all to front')
    expect(flat).toContain('Automate 2 with an agent')
    expect(flat).not.toContain('AI assist')
    expect(flat).not.toContain('Create & link')
    const last = topLevel(items).at(-1)
    expect(last?.label).toBe('Remove or delete 2 work widgets…')
    expect(last?.danger).toBe(true)
  })
})

describe('DEC-041 — the menu only offers what it can actually do', () => {
  beforeEach(() => clearWidgetContextActions())

  it('hides the Copy into rows when the source has no text to copy', () => {
    const items = resolveMenu(widgetCtx(widget('webview')))
    const create = find(items, 'Create & link')
    const childLabels = create?.children?.map((c) => c.label ?? '') ?? []
    expect(childLabels.some((l) => l.startsWith('Copy into'))).toBe(false)
    // …but Create & link is still offered: spawning a wired widget is real.
    expect(childLabels.length).toBeGreaterThan(0)
  })

  it('only offers copy targets that can RECEIVE text', () => {
    const create = find(resolveMenu(widgetCtx(widget('note', 'some real text'))), 'Create & link')
    const childLabels = create?.children?.map((c) => c.label ?? '') ?? []
    expect(childLabels).toContain('Copy into sticky')
    expect(childLabels).not.toContain('Copy into table')
    expect(childLabels).not.toContain('Copy into mind map')
    expect(childLabels).not.toContain('Copy into diagram')
  })

  it('no longer offers the broken Task link', () => {
    const create = find(resolveMenu(widgetCtx(widget('note', 'text'))), 'Create & link')
    expect(create?.children?.map((c) => c.label)).not.toContain('Task link')
  })
})
