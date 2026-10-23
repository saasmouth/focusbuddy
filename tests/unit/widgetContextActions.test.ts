import { describe, it, expect } from 'vitest'
// Registers the real core providers.
import '../../src/renderer/src/lib/contextMenu/providers'
import { resolveMenu } from '../../src/renderer/src/lib/contextMenu/resolve'
import type { MenuContext } from '../../src/renderer/src/lib/contextMenu/types'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import type { Widget, WidgetKind } from '../../src/shared/types'

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

function ctxOf(w: Widget): MenuContext {
  return {
    object: { type: 'widget', widget: w },
    taskId: 't-1',
    canvasPoint: { x: 0, y: 0 },
    clientPoint: { x: 10, y: 10 }
  }
}

function labels(items: CtxMenuItem[]): string[] {
  const out: string[] = []
  for (const it of items) {
    if (it.label) out.push(it.label)
    if (it.children) out.push(...labels(it.children))
  }
  return out
}

function menuLabels(w: Widget): string[] {
  return labels(resolveMenu(ctxOf(w)))
}

describe('per-widget context actions — the menu is genuinely contextual', () => {
  it('color offers Copy hex', () => {
    expect(menuLabels(widget('color', '#ff8800'))).toContain('Copy #ff8800')
  })

  it('a file/link widget offers Open in browser and Copy link', () => {
    const ls = menuLabels(widget('file', 'https://example.com/report.pdf'))
    expect(ls).toContain('Open in browser')
    expect(ls).toContain('Copy link')
  })

  it('an image widget with a path offers Open and Copy path', () => {
    const ls = menuLabels(widget('image', '/Users/me/pic.png'))
    expect(ls).toContain('Open')
    expect(ls).toContain('Copy path')
  })

  it('a section offers a layout submenu', () => {
    const ls = menuLabels(widget('section'))
    expect(ls).toContain('Section layout')
    expect(ls).toContain('Grid')
    expect(ls).toContain('Stacks')
  })

  it('a table offers Add row', () => {
    expect(menuLabels(widget('table', 'tbl_1'))).toContain('Add row')
  })

  it('a sticky offers its own actions (Build with AI, checklist)', () => {
    const ls = menuLabels(widget('sticky', 'note'))
    expect(ls).toContain('Build with AI')
    expect(ls).toContain('Make a checklist')
  })

  it('different widget kinds produce different menus', () => {
    const color = menuLabels(widget('color', '#fff'))
    const table = menuLabels(widget('table', 't'))
    const section = menuLabels(widget('section'))
    // Each has a signature action the others do not.
    expect(color.some((l) => l.startsWith('Copy #'))).toBe(true)
    expect(table).toContain('Add row')
    expect(section).toContain('Section layout')
    expect(table).not.toContain('Section layout')
    expect(color).not.toContain('Add row')
  })
})
