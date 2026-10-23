// WP1a guard: every right-click menu on the desk canvas, a work widget (header
// and body), the section handle, the multi-selection, the focus dock, the
// columns view and the desk jump list holds to the menu contract (SPEC
// §9.3–§9.5). Each menu is built the way the app builds it: the same builder
// or context function the component calls, or the real component mounted and
// right-clicked.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Widget, WidgetKind } from '../../src/shared/types'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import { expectMenuContract, groupsOf } from './_menuContract'
import '../../src/renderer/src/lib/contextMenu/providers'
import { resolveMenu, MENU_ROW_CEILING } from '../../src/renderer/src/lib/contextMenu/resolve'
import {
  buildContextForWidget,
  buildContextForMulti,
  sectionMenuContext,
  focusDockTileContext,
  jumpListRowContext,
  columnCardContext
} from '../../src/renderer/src/lib/contextMenu/buildContext'
import { addObjectItem, buildEmptyCanvasMenu } from '../../src/renderer/src/lib/contextMenu/emptyCanvas'
import { bodyMenuTarget } from '../../src/renderer/src/lib/contextMenu/bodyTarget'
import type { FrameCallbacks } from '../../src/renderer/src/lib/contextMenu/types'
import { WIDGET_CATALOG } from '../../src/renderer/src/lib/widgetCatalog'
import { isStandaloneWidgetKind } from '../../src/shared/widgetFiles'

const noop = (): void => {}

function widget(kind: WidgetKind, content = '', extra: Partial<Widget> = {}): Widget {
  return {
    id: `w-${kind}`, taskId: 't-1', kind, title: '', content, x: 0, y: 0, width: 240, height: 180, zIndex: 1,
    color: null, pinned: false, pinnedScreenX: null, pinnedScreenY: null, pinnedZone: null, parentSectionId: null,
    layout: null, sourceAppId: null, mode: null, livingQuery: null, livingGeneratedAt: null, livingPaused: false,
    createdAt: 0, updatedAt: 0, archived: false, syncGroupId: null, ...extra
  } as Widget
}

/** The frame WidgetFrame hands a canvas widget (WidgetFrame.tsx `frameCallbacks`), for a kind. */
function canvasFrame(w: Widget, opts: { snippets?: boolean } = {}): FrameCallbacks {
  const fileLinked = !!w.syncGroupId
  return {
    onMakeTask: noop,
    onShare: noop,
    onDuplicateSynced: noop,
    onDuplicateIndependent: noop,
    onRename: noop,
    onSaveAsSnippet: noop,
    onOpenFile: fileLinked ? noop : undefined,
    onSaveAsFile: !fileLinked && isStandaloneWidgetKind(w.kind) ? noop : undefined,
    onInsertSnippet: opts.snippets ? noop : undefined,
    onPaste: opts.snippets ? noop : undefined,
    removal: 'full'
  }
}

const at = { clientX: 10, clientY: 10 }
const ceilingRows = (items: CtxMenuItem[]): number => items.filter((i) => !i.separator && !i.danger).length

beforeAll(() => {
  // Hints render for macOS; window.api answers every call with an empty value
  // (the frame and the bodies only read).
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { platform: 'darwin' },
    {
      get: (t, k) =>
        k in t ? (t as Record<string | symbol, unknown>)[k] : new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) })
    }
  )
})

describe('empty canvas (§9.3 empty shape)', () => {
  it('Paste · Insert snippet… | Add object | Select all | view rows', () => {
    const items = buildEmptyCanvasMenu(
      {
        addObject: addObjectItem(noop),
        onPaste: noop,
        onInsertSnippet: noop,
        onSelectAll: noop,
        onFitAll: noop,
        onResetView: noop,
        onGroupByType: noop,
        onStackByType: noop,
        customLayout: true,
        onToggleCustomLayout: noop
      },
      'darwin'
    )
    // Catalog names are product names (Google Doc, Speed deck …), not menu prose.
    const catalog = WIDGET_CATALOG.map((e) => e.label)
    expectMenuContract(items, {
      allowCase: catalog,
      groups: [
        ['Paste', 'Insert snippet…'],
        ['Add object'],
        ['Select all'],
        ['Home — fit all to view', 'Reset view', 'Auto-arrange', "Customise this device's layout"]
      ]
    })
    expect(items.find((i) => i.label === 'Paste')?.shortcut).toBe('⌘V')
    expect(items.find((i) => i.label === 'Select all')?.shortcut).toBe('⌘A')
    // A toggle is a checked row (F-13), not two alternating labels.
    expect(items.find((i) => i.label === "Customise this device's layout")?.checked).toBe(true)
    // One route to the snippet library: no second copy inside Add object.
    const add = items.find((i) => i.label === 'Add object')
    expect(JSON.stringify(add)).not.toContain('saved snippet')
  })

  it('Select all is disabled with a reason on an empty desk', () => {
    const items = buildEmptyCanvasMenu(
      { addObject: addObjectItem(noop), onPaste: noop, onInsertSnippet: noop, onSelectAll: null, onFitAll: noop, onResetView: noop, onGroupByType: noop, onStackByType: noop, customLayout: false, onToggleCustomLayout: noop },
      'darwin'
    )
    const sa = items.find((i) => i.label === 'Select all')
    expect(sa?.disabled).toBe(true)
    expect(sa?.hint).toBeTruthy()
    expectMenuContract(items, { allowCase: WIDGET_CATALOG.map((e) => e.label) })
  })
})

describe('work widget header: every registered kind', () => {
  const kinds = [...new Set(WIDGET_CATALOG.map((e) => e.kind))]

  it('covers the whole registry', () => {
    expect(kinds.length).toBeGreaterThan(40)
  })

  for (const kind of kinds) {
    it(`${kind}: contract, Add to Focus… first, ceiling, E-2 rows`, () => {
      // Seed text kinds so AI Assist and Copy appear: the fullest menu.
      const w = widget(kind, ['sticky', 'note', 'markdown', 'page', 'card', 'living-doc'].includes(kind) ? 'Some words here' : '')
      for (const snippets of [false, true]) {
        const items = resolveMenu(buildContextForWidget(w, at, { frame: kind === 'section' ? { onShare: noop, onMakeTask: noop, onRename: noop, removal: 'archive-only' } : canvasFrame(w, { snippets }) }))
        expectMenuContract(items)
        // E-1: Add to Focus… leads unless the object has an Open row (none without content or a file).
        expect(items[0]?.label, `${kind}: first row`).toBe('Add to Focus…')
        expect(ceilingRows(items), `${kind}: rows above the destructive group`).toBeLessThanOrEqual(MENU_ROW_CEILING)
        const danger = items.filter((i) => i.danger).map((i) => i.label)
        expect(danger, `${kind}: removal rows`).toEqual(kind === 'section' ? ['Archive'] : ['Archive', 'Delete'])
      }
      // The same kind as a widget file's desk instance: the three explicit rows.
      if (kind !== 'section') {
        const filed = widget(kind, '', { syncGroupId: 'wf:file-1' })
        const items = resolveMenu(buildContextForWidget(filed, at, { frame: canvasFrame(filed) }))
        expect(items.filter((i) => i.danger).map((i) => i.label)).toEqual(['Remove from this desk', 'Archive', 'Move to Trash'])
      }
    })
  }

  it('E-1: an Open row leads, Add to Focus… second (link kinds and widget files)', () => {
    for (const kind of ['file', 'image', 'video', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email', 'webview'] as WidgetKind[]) {
      const w = widget(kind, 'https://example.com/x')
      const items = resolveMenu(buildContextForWidget(w, at, { frame: canvasFrame(w) }))
      expectMenuContract(items)
      expect(groupsOf(items)[0]?.slice(0, 2), kind).toEqual(['Open in browser', 'Add to Focus…'])
    }
    const filed = widget('timer', '', { syncGroupId: 'wf:file-1' })
    expect(groupsOf(resolveMenu(buildContextForWidget(filed, at, { frame: canvasFrame(filed) })))[0]?.slice(0, 2)).toEqual(['Open file', 'Add to Focus…'])
  })

  it('sticky, exactly: §9.3 groups with Paste and the kind row counted', () => {
    const w = widget('sticky', 'Buy milk', { syncGroupId: 'wf:file-1' })
    const items = resolveMenu(buildContextForWidget(w, at, { frame: canvasFrame(w, { snippets: true }) }))
    expectMenuContract(items, {
      groups: [
        // E-1 (owner ruling): Open first, Add to Focus… second.
        ['Open file', 'Add to Focus…', 'Build with AI'],
        ['Copy all text', 'Paste'],
        ['Ask PlexiiAssist', 'AI Assist'],
        ['More actions'],
        ['Remove from this desk', 'Archive', 'Move to Trash']
      ]
    })
    const more = items.find((i) => i.label === 'More actions')!
    const inMore = (more.children ?? []).map((c) => c.label)
    // Nothing the old menu offered is lost: it moved into More actions.
    for (const l of ['Duplicate', 'Make a checklist', 'Rename', 'Share…', 'Insert snippet…', 'Duplicate, keep synced', 'Bring to front', 'Save selection as snippet…', 'Create & link', 'Make this a desk…', 'Pin to corner', 'Recolor', 'Flag as a decision']) {
      expect(inMore, l).toContain(l)
    }
    expect(items.find((i) => i.label === 'Paste')?.shortcut).toBe('⌘V')
  })

  it('a text selection: Copy ⌘C and Ask PlexiiAssist about this', () => {
    const w = widget('note', 'alpha beta gamma')
    const items = resolveMenu(buildContextForWidget(w, at, { frame: canvasFrame(w), selectionText: 'beta' }))
    expectMenuContract(items)
    const copy = items.find((i) => i.label === 'Copy')
    expect(copy?.shortcut).toBe('⌘C')
    expect(items.map((i) => i.label)).toContain('Ask PlexiiAssist about this')
  })
})

describe('a table row handle (the cell provider with an empty column)', () => {
  it('row actions, no empty Copy or AI rows, Delete row in the destructive group', () => {
    const w = widget('table', 'tbl_1')
    const items = resolveMenu(
      buildContextForWidget(w, at, { frame: canvasFrame(w, { snippets: true }), granularity: 'cell', payload: { rowId: 'r1', columnLabel: '', tableId: '' }, selectionText: '' })
    )
    expectMenuContract(items)
    const all = JSON.stringify(items)
    expect(all).toContain('Duplicate row')
    expect(items.filter((i) => i.danger).map((i) => i.label)[0]).toBe('Delete row')
    expect(items.map((i) => i.label)).not.toContain('Copy')
    expect(all).not.toContain('AI Assist')
  })
})

describe('the multi-selection', () => {
  it('Add N to Focus… | Copy all text | Bring all to front | Automate N | Remove or delete N…', () => {
    const items = resolveMenu(buildContextForMulti([widget('sticky', 'a'), { ...widget('note', 'b'), id: 'w-2' }], at))
    expectMenuContract(items, {
      groups: [['Add 2 to Focus…'], ['Copy all text'], ['Bring all to front'], ['Automate 2 with an agent'], ['Remove or delete 2 work widgets…']]
    })
  })
})

describe('the section handle (S1 → the resolver)', () => {
  it('layout, rename, share | an empty duplicate | bring to front | make a desk | Archive', () => {
    const items = resolveMenu(sectionMenuContext(widget('section', '', { layout: 'grid' }), at, { onShare: noop, onMakeTask: noop, onRename: noop }))
    expectMenuContract(items, {
      groups: [
        ['Add to Focus…', 'Section layout', 'Rename', 'Share…'],
        ['Duplicate, empty'],
        ['Bring to front'],
        ['Make this a desk…'],
        ['Archive']
      ]
    })
    // The current layout is checked by the kit (F-13), not a " ✓" label suffix.
    const layout = items.find((i) => i.label === 'Section layout')!
    expect(layout.children?.find((c) => c.label === 'Grid')?.checked).toBe(true)
    expect(layout.children?.find((c) => c.label === 'Free')?.checked).toBe(false)
  })
})

describe('the focus dock tile', () => {
  it('Show in full view joins the object group; the dock hosts Share…, Make this a desk… and snippets', () => {
    const w = widget('timer')
    const items = resolveMenu(focusDockTileContext(w, at, { onShowInFullView: noop, onShare: noop, onMakeTask: noop, onSaveAsSnippet: noop }))
    expectMenuContract(items, {
      groups: [
        ['Show in full view', 'Add to Focus…', 'Share…'],
        ['Duplicate'],
        ['Bring to front'],
        ['Save selection as snippet…'],
        ['More actions'],
        ['Archive', 'Delete']
      ]
    })
  })
})

describe('the desk jump list row (E-11)', () => {
  it('a standard menu with Rename first', () => {
    const items = resolveMenu(jumpListRowContext(widget('gallery'), at, { onRename: noop, onJump: noop }))
    expectMenuContract(items)
    expect(groupsOf(items)[0]?.slice(0, 3)).toEqual(['Rename', 'Show on the canvas', 'Add to Focus…'])
  })
})

describe('the columns view card', () => {
  it('open, find on the canvas and move, in the object group', () => {
    const items = resolveMenu(
      columnCardContext(widget('timer'), at, { onOpen: noop, onReveal: noop, moveTo: [{ title: 'Doing', onMove: noop }] })
    )
    expectMenuContract(items, { allowCase: ['Doing'] })
    expect(groupsOf(items)[0]?.slice(0, 3)).toEqual(['Show in full view', 'Add to Focus…', 'Show on the canvas'])
  })
})

// ── Body right-clicks, on the mounted frame ─────────────────────────────────

let host: HTMLDivElement | null = null
let root: Root | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  host = null
  root = null
})

/** Close the open menu the way a person does: Escape. */
async function closeMenu(): Promise<void> {
  const menu = document.querySelector('[data-canvas-ctx-menu]')
  await act(async () => {
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

async function mountWidget(w: Widget): Promise<HTMLDivElement> {
  const { renderWidget } = await import('../../src/renderer/src/components/widgets/renderWidget')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(renderWidget(w as never))
  })
  return host
}

/** The open menu as the kit drew it: groups of labels, split at separators. */
function renderedGroups(): string[][] {
  const menu = document.querySelector('[data-canvas-ctx-menu]')
  if (!menu) return []
  const out: string[][] = [[]]
  for (const el of Array.from(menu.children)) {
    if (el.getAttribute('role') === 'separator') out.push([])
    else {
      const b = el.querySelector('[role^="menuitem"]')
      if (b) out[out.length - 1]!.push((b.querySelector('span.flex-1')?.firstChild?.textContent ?? '').trim())
    }
  }
  return out.filter((g) => g.length)
}

describe('a previously silent body (AUDIT §1.3): right-click opens the widget menu', () => {
  for (const kind of ['gallery', 'image', 'timer'] as WidgetKind[]) {
    it(`${kind}: body right-click = header right-click`, async () => {
      const el = await mountWidget(widget(kind, '', { id: `body-${kind}` }))
      const body = el.querySelector('[data-widget-body]')
      expect(body, 'the frame rendered its body').not.toBeNull()
      const target = (body!.querySelector('div') ?? body) as HTMLElement
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
      await act(async () => {
        target.dispatchEvent(ev)
      })
      expect(ev.defaultPrevented, 'the body claimed the right-click').toBe(true)
      const bodyGroups = renderedGroups()
      expect(bodyGroups[0]?.[0]).toBe('Add to Focus…')
      expect(bodyGroups.at(-1)).toContain('Archive')
      // The header's menu, for comparison: the same rows.
      await closeMenu()
      expect(document.querySelector('[data-canvas-ctx-menu]'), 'Escape closed it').toBeNull()
      await act(async () => {
        el.querySelector('[data-widget-header]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
      })
      expect(renderedGroups()).toEqual(bodyGroups)
    })
  }

  it('an editable field inside a body keeps the native text menu (not preventDefault)', async () => {
    const el = await mountWidget(widget('timer', '', { id: 'body-field' }))
    const body = el.querySelector('[data-widget-body]')!
    const input = document.createElement('input')
    body.appendChild(input)
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => {
      input.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-canvas-ctx-menu]')).toBeNull()
  })
})

describe('bodyMenuTarget: the one precedence rule', () => {
  const at = (el: Element, prevented = false): string => bodyMenuTarget({ defaultPrevented: prevented, target: el })
  it('own menu, web, text, then the widget menu', () => {
    const div = document.createElement('div')
    const ta = document.createElement('textarea')
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox' })
    const wv = document.createElement('webview')
    const ce = document.createElement('div')
    ce.setAttribute('contenteditable', 'true')
    const opt = document.createElement('span')
    opt.setAttribute('data-native-context-menu', '')
    expect(at(div, true)).toBe('handled')
    expect(at(wv)).toBe('web')
    expect(at(ta)).toBe('text')
    expect(at(ce)).toBe('text')
    expect(at(opt)).toBe('text')
    expect(at(cb)).toBe('widget')
    expect(at(div)).toBe('widget')
  })
})
