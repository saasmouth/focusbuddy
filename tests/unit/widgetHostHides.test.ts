// What the widget host hides, it hides ONLY in the host (lib/widgetHost).
//
// Every gate added for the host reads one flag that only the host's entry
// sets. These pin both halves: outside the host the desktop keeps every AI
// item, snippet, comment and export it had; inside, exactly those are gone.
import { describe, it, expect, afterEach } from 'vitest'
import { enterWidgetHost, inWidgetHost, offeredHere } from '../../src/renderer/src/lib/widgetHost'
import { railSlots, type RailItem } from '../../src/renderer/src/components/office/shell/ToolRail'
import { paletteEntries, type OfficeCommand } from '../../src/renderer/src/lib/menus/officeCommand'
import { canvasMenu, objectMenu } from '../../src/renderer/src/lib/menus/officeContextMenu'
import { mindMapNodeMenuItems } from '../../src/renderer/src/components/widgets/bodyMenus'

const leave = (): void => void delete (globalThis as Record<string, unknown>).__PLEXII_WIDGET_HOST__
afterEach(leave)

const rail: RailItem<null>[] = [
  { id: 'select', label: 'Select', icon: 'x', kind: 'tool', role: 'select', group: 0, order: 0, onSelect: () => {} } as RailItem<null>,
  { id: 'draft', label: 'Ask AI', icon: 'x', kind: 'action', role: 'ai', group: 9, order: 0, pinned: 'bottom', onSelect: () => {} } as RailItem<null>
]
const cmd = (id: string): OfficeCommand => ({ id, label: id, run: () => {} })
const fn = (): void => {}
const labels = (items: Array<{ label?: string }>): string[] => items.map((i) => i.label ?? '').filter(Boolean)

describe('outside the widget host nothing changes', () => {
  it('the flag is off, and everything is offered', () => {
    expect(inWidgetHost()).toBe(false)
    for (const id of ['insertSnippet', 'doc-ai-draft', 'doc-comments', 'md-export', 'sheet-export-csv']) expect(offeredHere(id)).toBe(true)
  })

  it('AI rail items, AI and snippet commands, snippet and assistant menu rows, Expand with AI: all there', () => {
    expect(railSlots(rail, null).map((s) => s.shown.id)).toEqual(['select', 'draft'])
    expect(paletteEntries([cmd('doc-ai-draft'), cmd('doc-insert-snippet'), cmd('doc-bold')]).map((e) => e.id)).toEqual(['doc-ai-draft', 'doc-insert-snippet', 'doc-bold'])
    expect(labels(objectMenu({ copy: fn, saveAsSnippet: fn, askAssist: fn } as never))).toEqual(expect.arrayContaining([expect.stringMatching(/snippet/i)]))
    expect(labels(canvasMenu({ paste: fn, insertSnippet: fn }))).toEqual(expect.arrayContaining([expect.stringMatching(/snippet/i)]))
    expect(labels(mindMapNodeMenuItems({ isRoot: false, pending: false, isViewRoot: false, busy: false }, { addChild: fn, addSibling: fn, drillIn: fn, expand: fn, accept: fn, reject: fn, remove: fn }))).toContain('Expand with AI')
  })
})

describe('inside the widget host', () => {
  it('exactly what needs Plexii is gone; the rest stays', () => {
    enterWidgetHost({ readOnly: false })
    expect(inWidgetHost()).toBe(true)
    expect(railSlots(rail, null).map((s) => s.shown.id)).toEqual(['select'])
    expect(paletteEntries([cmd('doc-ai-draft'), cmd('doc-insert-snippet'), cmd('doc-bold')]).map((e) => e.id)).toEqual(['doc-bold'])
    const obj = labels(objectMenu({ copy: fn, saveAsSnippet: fn, askAssist: fn } as never))
    expect(obj.filter((l) => /snippet|assist/i.test(l))).toEqual([])
    expect(obj.length).toBeGreaterThan(0)
    expect(labels(canvasMenu({ paste: fn, insertSnippet: fn })).filter((l) => /snippet/i.test(l))).toEqual([])
    const mind = labels(mindMapNodeMenuItems({ isRoot: false, pending: false, isViewRoot: false, busy: false }, { addChild: fn, addSibling: fn, drillIn: fn, expand: fn, accept: fn, reject: fn, remove: fn }))
    expect(mind).not.toContain('Expand with AI')
    expect(mind).toContain('Add child')
    for (const id of ['doc-insert-snippet', 'edit.saveAsSnippet', 'sheet-ai-fill', 'doc-comments', 'md-export', 'sheet-import']) expect(offeredHere(id)).toBe(false)
    for (const id of ['doc-bold', 'dg-import-drawio', 'paste']) expect(offeredHere(id)).toBe(true)
  })
})
