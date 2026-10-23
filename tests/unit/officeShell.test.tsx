// The shared office shell (SPEC §2, §10): ToolRail, flyouts, ContextBar, the
// bar primitives, ShellPanel, ShellSidePane and the Row 1 folding plan.

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
// Tooltip: render the content as a data attribute so tests can read it without hovering.
vi.mock('../../src/renderer/src/components/Tooltip', () => ({
  default: ({ content, children }: { content: string; children: React.ReactNode }) => <span data-tip={content}>{children}</span>
}))

import {
  BarButton,
  BarDialogButton,
  BarMenu,
  BarNumber,
  BarToggle,
  ContextBar,
  OfficeShellLayout,
  ShellPanel,
  ShellSidePane,
  SIDE_PANE_DOM_ID,
  ToolRail,
  planRow1,
  railSlots,
  railTooltip,
  resolveActiveTab,
  visibleTabs,
  type BarTab,
  type RailItem,
  type SidePane
} from '../../src/renderer/src/components/office/shell'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})
const render = (el: React.ReactElement): void => act(() => root.render(el))
const $ = (sel: string): HTMLElement | null => document.querySelector(sel)
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)]
const tid = (id: string): HTMLElement => {
  const el = $(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}
const key = (el: Element, k: string, extra: KeyboardEventInit = {}): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }))
  })
}

type Ctx = { sel: string }
const noop = (): void => {}
const item = (p: Partial<RailItem<Ctx>> & { id: string }): RailItem<Ctx> => ({ label: p.id, icon: 'x', kind: 'tool', group: 0, order: 0, onSelect: noop, ...p })

describe('railSlots / railTooltip (pure)', () => {
  const items: RailItem<Ctx>[] = [
    item({ id: 'ai', group: 9, order: 0, pinned: 'bottom', kind: 'panel' }),
    item({ id: 'text', group: 1, order: 0 }),
    item({ id: 'select', group: 0, order: 0 }),
    item({ id: 'ellipse', group: 1, order: 2, flyout: 'shapes' }),
    item({ id: 'rect', group: 1, order: 1, flyout: 'shapes' }),
    item({ id: 'secret', group: 0, order: 5, hidden: true }),
    item({ id: 'hand', group: 0, order: 1, hidden: (c) => c.sel === 'no-pan' })
  ]
  it('sorts by group then order, pins bottom items last, drops hidden ones', () => {
    expect(railSlots(items, { sel: '' }).map((s) => s.shown.id)).toEqual(['select', 'hand', 'text', 'rect', 'ai'])
    expect(railSlots(items, { sel: 'no-pan' }).map((s) => s.shown.id)).not.toContain('hand')
  })
  it('folds a flyout group into one slot showing the last-used member', () => {
    const slots = railSlots(items, { sel: '' }, { shapes: 'ellipse' })
    const shapes = slots.find((s) => s.key === 'flyout:shapes')!
    expect(shapes.members.map((m) => m.id)).toEqual(['rect', 'ellipse'])
    expect(shapes.shown.id).toBe('ellipse')
  })
  it('formats tooltips: key, options suffix, disabled reason, no key when keyless', () => {
    expect(railTooltip('Select', 'V', {})).toBe('Select (V)')
    expect(railTooltip('Rotate', 'R', { options: true })).toBe('Rotate (R) — double-click for options')
    expect(railTooltip('Pen', 'P', { disabledReason: 'This document is read-only.' })).toBe('Pen — This document is read-only.')
    expect(railTooltip('Group selection', undefined, {})).toBe('Group selection')
    expect(railTooltip('Rectangle', 'M', { options: true, optionsHint: 'double-click to keep it selected' })).toBe('Rectangle (M) — double-click to keep it selected')
  })
})

describe('ToolRail', () => {
  it('renders a vertical toolbar with separators between groups, testids and pressed states', () => {
    render(
      <ToolRail<Ctx>
        testid="x-rail"
        ctx={{ sel: '' }}
        activeId="select"
        openPanels={['layers']}
        items={[
          item({ id: 'select', shortcut: 'V' }),
          item({ id: 'image', kind: 'action', group: 2 }),
          item({ id: 'layers', kind: 'panel', group: 9, pinned: 'bottom', testid: 'custom-layers' })
        ]}
      />
    )
    const rail = tid('x-rail')
    expect(rail.getAttribute('role')).toBe('toolbar')
    expect(rail.getAttribute('aria-orientation')).toBe('vertical')
    expect(tid('x-rail-select').getAttribute('aria-pressed')).toBe('true')
    expect(tid('x-rail-image').hasAttribute('aria-pressed')).toBe(false) // actions never stay pressed
    expect(tid('custom-layers').getAttribute('aria-pressed')).toBe('true') // open panel shows pressed
    expect($$('[data-testid="x-rail"] [role="separator"]')).toHaveLength(2)
    expect(tid('x-rail-select').closest('[data-tip]')!.getAttribute('data-tip')).toBe('select (V)')
  })

  it('disables with a reason; read-only disables everything not readOnlySafe, keeping an item\'s own reason', () => {
    render(
      <ToolRail<Ctx>
        testid="r"
        ctx={{ sel: 'none' }}
        readOnly
        items={[item({ id: 'hand', readOnlySafe: true }), item({ id: 'pen' }), item({ id: 'join', disabled: (c) => c.sel === 'none', disabledReason: 'select two paths' })]}
      />
    )
    expect((tid('r-hand') as HTMLButtonElement).disabled).toBe(false)
    expect((tid('r-pen') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('r-pen').getAttribute('aria-label')).toBe('pen — This document is read-only.')
    // An item that is off for a reason of its own says that reason, read-only or not (the bar's rule too).
    expect((tid('r-join') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('r-join').getAttribute('aria-label')).toBe('join — select two paths')
    render(<ToolRail<Ctx> testid="r" ctx={{ sel: 'none' }} items={[item({ id: 'join', disabled: (c) => c.sel === 'none', disabledReason: 'select two paths' })]} />)
    expect(tid('r-join').getAttribute('aria-label')).toBe('join — select two paths')
  })

  it('click selects, double-click opens options, and nothing fires while disabled', () => {
    const onSelect = vi.fn()
    const onOptions = vi.fn()
    render(<ToolRail<Ctx> testid="r" ctx={{ sel: 'a' }} items={[item({ id: 'rotate', onSelect, onOptions })]} />)
    act(() => tid('r-rotate').click())
    expect(onSelect).toHaveBeenCalledWith({ sel: 'a' })
    act(() => {
      tid('r-rotate').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onOptions).toHaveBeenCalledTimes(1)
  })

  it('roving focus: one tab stop, arrows and Home/End move between items', () => {
    render(<ToolRail<Ctx> testid="r" ctx={{ sel: '' }} items={[item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 }), item({ id: 'c', order: 2 })]} />)
    expect($$('[data-testid="r"] button').map((b) => b.tabIndex)).toEqual([0, -1, -1])
    act(() => tid('r-a').focus())
    key(tid('r-a'), 'ArrowDown')
    expect(document.activeElement).toBe(tid('r-b'))
    key(tid('r-b'), 'End')
    expect(document.activeElement).toBe(tid('r-c'))
    key(tid('r-c'), 'ArrowDown')
    expect(document.activeElement).toBe(tid('r-a'))
  })

  it('flyout: the corner opens the group, picking reports last-used then selects', () => {
    const onFlyoutPick = vi.fn()
    const onSelect = vi.fn()
    render(
      <ToolRail<Ctx>
        testid="r"
        ctx={{ sel: '' }}
        onFlyoutPick={onFlyoutPick}
        items={[item({ id: 'rect', flyout: 'shapes', order: 1, shortcut: 'M', onSelect }), item({ id: 'ellipse', flyout: 'shapes', order: 2, shortcut: 'L', onSelect })]}
      />
    )
    expect(tid('r-rect').getAttribute('aria-haspopup')).toBe('menu')
    act(() => tid('r-flyout-shapes').click())
    const menu = tid('r-flyout-menu')
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.textContent).toContain('ellipse')
    act(() => tid('r-ellipse-flyout').click())
    expect(onFlyoutPick).toHaveBeenCalledWith('shapes', 'ellipse')
    expect(onSelect).toHaveBeenCalled()
    expect($('[data-testid="r-flyout-menu"]')).toBeNull()
  })

  it('shows badges', () => {
    render(<ToolRail<Ctx> testid="r" ctx={{ sel: '' }} items={[item({ id: 'pen', badge: 'dot' }), item({ id: 'swatches', badge: '3', order: 1 })]} />)
    expect(tid('r-pen').querySelector('.rounded-full')).not.toBeNull()
    expect(tid('r-swatches').textContent).toContain('3')
  })
})

describe('ContextBar', () => {
  const tabs: BarTab<Ctx>[] = [
    { id: 'home', label: 'Home', render: () => <BarButton label="Bold" icon="format_bold" onClick={noop} testid="bold" shortcut="⌘B" /> },
    { id: 'insert', label: 'Insert', render: () => <BarDialogButton label="Templates" icon="dashboard" onOpen={noop} testid="tpl" /> },
    { id: 'line', label: 'Line', contextual: true, when: (c) => c.sel === 'edge', render: () => <BarToggle label="Animated" pressed={false} onChange={noop} testid="anim" readOnlySafe /> }
  ]

  it('visibleTabs and resolveActiveTab follow the selection, falling back to Home', () => {
    expect(visibleTabs(tabs, { sel: 'node' }).map((t) => t.id)).toEqual(['home', 'insert'])
    expect(visibleTabs(tabs, { sel: 'edge' }).map((t) => t.id)).toEqual(['home', 'insert', 'line'])
    expect(resolveActiveTab(tabs, { sel: 'node' }, 'line')).toBe('home')
    expect(resolveActiveTab(tabs, { sel: 'edge' }, 'line')).toBe('line')
  })

  it('renders the menu bar and tabs on Row 1, the active tab’s controls on Row 2, plus pinned and right slots', () => {
    render(
      <ContextBar<Ctx>
        testid="x-toolbar"
        tabs={tabs}
        ctx={{ sel: 'node' }}
        activeTab="home"
        onTabChange={noop}
        menuBar={<nav data-testid="x-menubar">File Edit</nav>}
        pinnedStart={<button data-testid="x-undo">Undo</button>}
        rightSlot={<span data-testid="x-zoom">100%</span>}
      />
    )
    expect(tid('x-menubar')).toBeTruthy()
    expect($$('[data-testid="x-menubar"]')).toHaveLength(1) // never duplicated by measuring
    expect(tid('x-toolbar-tab-home').getAttribute('aria-selected')).toBe('true')
    expect($('[data-testid="x-toolbar-tab-line"]')).toBeNull() // contextual, not applicable
    expect(tid('x-undo')).toBeTruthy()
    expect(tid('x-zoom')).toBeTruthy()
    expect(tid('bold').closest('[data-tip]')!.getAttribute('data-tip')).toBe('Bold (⌘B)')
  })

  it('a contextual tab appears with the selection, does not steal focus, and falls back to Home when it goes', () => {
    const onTabChange = vi.fn()
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'edge' }} activeTab="home" onTabChange={onTabChange} menuBar={null} />)
    expect(tid('b-tab-line').getAttribute('data-contextual')).toBe('true')
    expect(onTabChange).not.toHaveBeenCalled() // D3: no auto-switch
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'node' }} activeTab="line" onTabChange={onTabChange} menuBar={null} />)
    expect(onTabChange).toHaveBeenCalledWith('home')
  })

  it('arrow keys move between tabs only while a tab is focused', () => {
    const onTabChange = vi.fn()
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'node' }} activeTab="home" onTabChange={onTabChange} menuBar={null} />)
    act(() => tid('b-tab-home').focus())
    key(tid('b-tab-home'), 'ArrowRight')
    expect(onTabChange).toHaveBeenCalledWith('insert')
  })

  it('double-clicking the active tab toggles collapse (D5); collapsed hides Row 2', () => {
    const onCollapsedChange = vi.fn()
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'node' }} activeTab="home" onTabChange={noop} onCollapsedChange={onCollapsedChange} menuBar={null} />)
    act(() => {
      tid('b-tab-home').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'node' }} activeTab="home" onTabChange={noop} collapsed menuBar={null} />)
    expect($('[data-testid="b-panel"]')).toBeNull()
    expect(tid('b-tab-home')).toBeTruthy()
  })

  it('read-only greys out controls that are not readOnlySafe, with a reason', () => {
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'edge' }} activeTab="home" onTabChange={noop} readOnly menuBar={null} />)
    expect((tid('bold') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('bold').getAttribute('aria-label')).toBe('Bold — This document is read-only.')
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'edge' }} activeTab="line" onTabChange={noop} readOnly menuBar={null} />)
    expect((tid('anim') as HTMLButtonElement).disabled).toBe(false)
  })

  it('dialog buttons announce a dialog and always show their label with an ellipsis', () => {
    render(<ContextBar<Ctx> testid="b" tabs={tabs} ctx={{ sel: 'node' }} activeTab="insert" onTabChange={noop} menuBar={null} />)
    expect(tid('tpl').getAttribute('aria-haspopup')).toBe('dialog')
    expect(tid('tpl').textContent).toContain('Templates…')
  })
})

describe('planRow1: one narrow behaviour (SPEC §2.6)', () => {
  const tabs = [
    { id: 'home', width: 60, keep: true },
    { id: 'insert', width: 60, keep: false },
    { id: 'arrange', width: 70, keep: false },
    { id: 'view', width: 50, keep: false },
    { id: 'line', width: 50, keep: true }
  ]
  it('fits as is when there is room', () => {
    expect(planRow1({ available: 1000, menuWidth: 300, tabs, chrome: 48 })).toEqual({ foldMenus: false, folded: [] })
  })
  it('folds the menus into "≡" first', () => {
    expect(planRow1({ available: 400, menuWidth: 300, tabs, chrome: 48 })).toEqual({ foldMenus: true, folded: [] })
  })
  it('then folds trailing tabs into More, never the active or contextual ones', () => {
    const p = planRow1({ available: 250, menuWidth: 300, tabs, chrome: 48 })
    expect(p.foldMenus).toBe(true)
    expect(p.folded).not.toContain('home')
    expect(p.folded).not.toContain('line')
    expect(p.folded[p.folded.length - 1]).toBe('view') // trailing first
  })
})

describe('ShellPanel', () => {
  it('Esc closes an unpinned panel and returns focus; a pinned one stays', () => {
    const onClose = vi.fn()
    const returnFocus = vi.fn()
    render(
      <OfficeShellLayout testid="s" bar={null} rail={null} panels={<ShellPanel id="layers" title="Layers" open onClose={onClose} returnFocus={returnFocus} testid="p-layers"><input data-testid="in" /></ShellPanel>}>
        <div />
      </OfficeShellLayout>
    )
    key(tid('in'), 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(returnFocus).toHaveBeenCalledTimes(1)
    onClose.mockClear()
    render(
      <OfficeShellLayout testid="s" bar={null} rail={null} panels={<ShellPanel id="layers" title="Layers" open pinned pinnable onClose={onClose} testid="p-layers"><input data-testid="in" /></ShellPanel>}>
        <div />
      </OfficeShellLayout>
    )
    key(tid('in'), 'Escape')
    expect(onClose).not.toHaveBeenCalled()
    expect(tid('p-layers').getAttribute('data-pinned')).toBe('true')
  })

  it('reports its rect only while pinned (so Fit can inset the viewport)', () => {
    const onRectChange = vi.fn()
    render(<ShellPanel id="l" title="L" open pinned onClose={noop} onRectChange={onRectChange} testid="p"><div /></ShellPanel>)
    expect(onRectChange.mock.calls.at(-1)![0]).not.toBeNull()
    render(<ShellPanel id="l" title="L" open pinned={false} onClose={noop} onRectChange={onRectChange} testid="p"><div /></ShellPanel>)
    expect(onRectChange.mock.calls.at(-1)![0]).toBeNull()
  })

  it('an unpinned panel closes on a pointer press outside; a press inside does not', () => {
    const onClose = vi.fn()
    render(<ShellPanel id="l" title="L" open onClose={onClose} testid="p"><button data-testid="inside" /></ShellPanel>)
    act(() => {
      tid('inside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('panel toggles', () => {
  it('a press on the panel\u2019s own toggle (aria-controls) is not "outside": the toggle\u2019s click decides', () => {
    const onClose = vi.fn()
    render(
      <>
        <button data-testid="toggle" aria-controls="shell-panel-layers" />
        <ShellPanel id="layers" title="Layers" open onClose={onClose} testid="p"><div /></ShellPanel>
      </>
    )
    expect(tid('p').id).toBe('shell-panel-layers')
    act(() => {
      tid('toggle').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })
  it('rail panel items declare which panel they control', () => {
    render(<ToolRail<Ctx> testid="r" ctx={{ sel: '' }} items={[item({ id: 'layers', kind: 'panel' }), item({ id: 'lib', kind: 'panel', controls: 'library', order: 1 })]} />)
    expect(tid('r-layers').getAttribute('aria-controls')).toBe('shell-panel-layers')
    expect(tid('r-lib').getAttribute('aria-controls')).toBe('shell-panel-library')
  })
})

describe('ShellSidePane: the one right content pane (SPEC §2.5a)', () => {
  const panes: SidePane[] = [
    { id: 'comments', title: 'Comments', icon: 'chat', badge: '3', testid: 'doc-side-panel-comments', render: () => <p data-testid="comments-body">c</p> },
    { id: 'ai', title: 'AI', icon: 'auto_awesome', testid: 'doc-side-panel-ai', render: () => <p data-testid="ai-body">a</p> }
  ]

  it('collapsed: a slim edge tab with one opener per pane, and no content mounted', () => {
    const onChange = vi.fn()
    render(<ShellSidePane testid="sp" panes={panes} activeId={null} onChange={onChange} />)
    expect(tid('sp-edge').id).toBe(SIDE_PANE_DOM_ID)
    expect($$('[data-testid^="sp-open-"]').map((b) => b.dataset.testid)).toEqual(['sp-open-comments', 'sp-open-ai'])
    expect($('[data-testid="comments-body"]')).toBeNull()
    expect(tid('sp-open-comments').textContent).toContain('3') // the badge survives collapse
    act(() => tid('sp-open-ai').click())
    expect(onChange).toHaveBeenCalledWith('ai')
  })

  it('open: one pane at a time, its content keeps the app’s testid, the switcher and collapse report to the host', () => {
    const onChange = vi.fn()
    render(<ShellSidePane testid="sp" panes={panes} activeId="comments" onChange={onChange} />)
    expect(tid('sp').id).toBe(SIDE_PANE_DOM_ID)
    expect(tid('sp').dataset.pane).toBe('comments')
    expect(tid('doc-side-panel-comments').contains(tid('comments-body'))).toBe(true)
    expect($('[data-testid="ai-body"]')).toBeNull()
    expect(tid('sp-tab-comments').getAttribute('aria-selected')).toBe('true')
    expect(tid('sp-tab-ai').getAttribute('aria-selected')).toBe('false')
    act(() => tid('sp-tab-ai').click())
    expect(onChange).toHaveBeenLastCalledWith('ai')
    act(() => tid('sp-collapse').click())
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('the edge’s expand chevron reopens the pane you last had open (first pane before any)', () => {
    const onChange = vi.fn()
    render(<ShellSidePane testid="sp" panes={panes} activeId={null} onChange={onChange} />)
    act(() => tid('sp-expand').click())
    expect(onChange).toHaveBeenLastCalledWith('comments')
    render(<ShellSidePane testid="sp" panes={panes} activeId="ai" onChange={onChange} />)
    render(<ShellSidePane testid="sp" panes={panes} activeId={null} onChange={onChange} />)
    act(() => tid('sp-expand').click())
    expect(onChange).toHaveBeenLastCalledWith('ai')
  })

  it('existing ids survive conversion: tab and collapse ids can be kept', () => {
    const kept: SidePane[] = panes.map((p) => ({ ...p, tabTestid: `doc-tab-${p.id}` }))
    render(<ShellSidePane testid="doc-side-panel" collapseTestid="sheet-ai-collapse" panes={kept} activeId="ai" onChange={noop} />)
    expect(tid('doc-tab-comments').getAttribute('role')).toBe('tab')
    expect(tid('doc-tab-ai').getAttribute('aria-selected')).toBe('true')
    expect($('[data-testid="sheet-ai-collapse"]')).not.toBeNull()
    expect(tid('doc-side-panel').tagName).toBe('ASIDE')
  })

  it('a single pane shows its title instead of a switcher', () => {
    render(<ShellSidePane testid="sp" panes={[panes[1]!]} activeId="ai" onChange={noop} />)
    expect($('[data-testid^="sp-tab-"]')).toBeNull()
    expect(tid('sp').textContent).toContain('AI')
  })

  it('an unknown active id collapses to the edge tab; no panes renders nothing', () => {
    render(<ShellSidePane testid="sp" panes={panes} activeId="gone" onChange={noop} />)
    expect($('[data-testid="sp-edge"]')).not.toBeNull()
    render(<ShellSidePane testid="sp" panes={[]} activeId={null} onChange={noop} />)
    expect($('[data-testid^="sp"]')).toBeNull()
  })

  it('sits at the right of the frame, after the canvas, not inside it', () => {
    render(
      <OfficeShellLayout testid="s" bar={<div />} rail={<div data-testid="rail" />} rightPane={<ShellSidePane testid="sp" panes={panes} activeId="ai" onChange={noop} />}>
        <div />
      </OfficeShellLayout>
    )
    const main = tid('s-main')
    expect(main.contains(tid('sp'))).toBe(false)
    expect(main.nextElementSibling).toBe(tid('sp'))
  })

  it('below the narrow breakpoint it opens as a sheet over the canvas and Esc inside it collapses it', () => {
    const Orig = globalThis.ResizeObserver
    class RO {
      constructor(private cb: ResizeObserverCallback) {}
      observe(): void {
        this.cb([{ contentRect: { width: 400, height: 300 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver
    try {
      const onChange = vi.fn()
      render(
        <OfficeShellLayout testid="s" bar={<div />} rail={<div />} rightPane={<ShellSidePane testid="sp" panes={panes} activeId="ai" onChange={onChange} />}>
          <div />
        </OfficeShellLayout>
      )
      expect(tid('sp').dataset.sheet).toBe('true')
      expect(tid('sp').className).toContain('absolute')
      key(tid('ai-body'), 'Escape')
      expect(onChange).toHaveBeenCalledWith(null)
    } finally {
      globalThis.ResizeObserver = Orig
    }
  })

  it('in the window’s bottom-right corner (a full editor) the bottom strip and the pane keep clear of the Plexii pill', () => {
    const Orig = globalThis.ResizeObserver
    class RO {
      constructor(private cb: ResizeObserverCallback) {}
      observe(): void {
        this.cb([{ contentRect: { width: 900, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 600, right: window.innerWidth, bottom: window.innerHeight, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    try {
      render(
        <OfficeShellLayout testid="s" bar={<div />} rail={<div />} bottom={<div data-testid="strip" />} rightPane={<ShellSidePane testid="sp" panes={panes} activeId="ai" onChange={noop} />}>
          <div />
        </OfficeShellLayout>
      )
      // (happy-dom drops var() from inline styles, so the reservation is read from its marker; the e2e guard checks the real padding.)
      expect(tid('strip').parentElement!.dataset.pillClear).toBe('true')
      expect(tid('doc-side-panel-ai').dataset.pillClear).toBe('true')
    } finally {
      rect.mockRestore()
      globalThis.ResizeObserver = Orig
    }
    // Not in the corner (a desk widget, or no ResizeObserver): no reservation.
    render(
      <OfficeShellLayout key="fresh" testid="s" bar={<div />} rail={<div />} bottom={<div data-testid="strip" />} rightPane={<ShellSidePane testid="sp" panes={panes} activeId="ai" onChange={noop} />}>
        <div />
      </OfficeShellLayout>
    )
    expect(tid('doc-side-panel-ai').dataset.pillClear).toBeUndefined()
    expect(tid('strip').parentElement!.dataset.pillClear).toBeUndefined()
  })

  it('docked (wide) it is a column, and Esc is left to the app', () => {
    const onChange = vi.fn()
    render(<ShellSidePane testid="sp" panes={panes} activeId="ai" onChange={onChange} />)
    expect(tid('sp').dataset.sheet).toBeUndefined()
    expect(tid('sp').style.width).toBe('320px')
    key(tid('ai-body'), 'Escape')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rail and bar toggles point aria-controls at the side pane, and a rail pane item shows pressed while its pane is open', () => {
    render(
      <>
        <ToolRail<Ctx> testid="r" ctx={{ sel: '' }} openPanels={['ai']} items={[item({ id: 'ai', kind: 'panel', sidePane: true }), item({ id: 'lib', kind: 'panel', order: 1 })]} />
        <BarToggle label="Side pane" pressed onChange={noop} controls={SIDE_PANE_DOM_ID} testid="t" />
      </>
    )
    expect(tid('r-ai').getAttribute('aria-controls')).toBe(SIDE_PANE_DOM_ID)
    expect(tid('r-ai').getAttribute('aria-pressed')).toBe('true')
    expect(tid('r-lib').getAttribute('aria-pressed')).toBe('false')
    expect(tid('t').getAttribute('aria-controls')).toBe(SIDE_PANE_DOM_ID)
  })
})

describe('keyboard scope (binding): the shell adds no document or window key listener', () => {
  it('mounting the rail, bar, layout and an open panel registers no keydown/keyup/keypress anywhere global', () => {
    const calls: string[] = []
    const wrap = (target: Document | Window, name: string): (() => void) => {
      const orig = target.addEventListener.bind(target)
      const spy = vi.spyOn(target, 'addEventListener').mockImplementation((type: string, ...rest: unknown[]) => {
        calls.push(`${name}:${type}`)
        return (orig as (...a: unknown[]) => void)(type, ...rest)
      })
      return () => spy.mockRestore()
    }
    const undoDoc = wrap(document, 'document')
    const undoWin = wrap(window, 'window')
    try {
      render(
        <OfficeShellLayout
          testid="s"
          bar={<ContextBar<Ctx> testid="b" tabs={[{ id: 'home', label: 'Home', render: () => <BarButton label="B" onClick={noop} /> }]} ctx={{ sel: '' }} activeTab="home" onTabChange={noop} menuBar={null} />}
          rail={<ToolRail<Ctx> testid="r" ctx={{ sel: '' }} items={[item({ id: 'select', shortcut: 'V' }), item({ id: 'rect', flyout: 's', order: 1 }), item({ id: 'ell', flyout: 's', order: 2 })]} />}
          panels={<ShellPanel id="l" title="L" open onClose={noop} testid="p"><div /></ShellPanel>}
          rightPane={<ShellSidePane testid="sp" panes={[{ id: 'a', title: 'A', icon: 'x', render: () => <div /> }]} activeId="a" onChange={noop} />}
        >
          <div />
        </OfficeShellLayout>
      )
      act(() => tid('r-flyout-s').click()) // open a flyout too
    } finally {
      undoDoc()
      undoWin()
    }
    expect(calls.filter((c) => /key(down|up|press)$/.test(c))).toEqual([])
  })
})

describe('bar primitives: BarNumber reports only real changes', () => {
  // A field focused and left unchanged must not report a change: every blur
  // used to add an empty undo step in each app, so Undo seemed to do nothing.
  it('blur and Enter with the value unchanged do not call onChange; a real edit calls it once', () => {
    const onChange = vi.fn()
    render(<BarNumber label="Opacity" value={50} onChange={onChange} testid="n" />)
    const input = host.querySelector('[data-testid="n"]') as HTMLInputElement
    act(() => {
      input.focus()
      input.blur()
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '60')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(60)
  })
})

describe('BarMenu: the current choice is announced, not only bolded', () => {
  it('items with an active value are menuitemradio with aria-checked; plain items stay menuitem; a check shows beside an icon', () => {
    render(
      <BarMenu
        label="Layout"
        testid="m"
        items={[
          { label: 'Title', icon: 'title', run: noop, active: true, testid: 'm-title' },
          { label: 'Blank', icon: 'crop_square', run: noop, active: false, testid: 'm-blank' },
          'sep',
          { label: 'Reset', run: noop, testid: 'm-reset' }
        ]}
      />
    )
    act(() => tid('m').click())
    expect(tid('m-title').getAttribute('role')).toBe('menuitemradio')
    expect(tid('m-title').getAttribute('aria-checked')).toBe('true')
    expect(tid('m-blank').getAttribute('aria-checked')).toBe('false')
    expect(tid('m-reset').getAttribute('role')).toBe('menuitem')
    expect(tid('m-reset').hasAttribute('aria-checked')).toBe(false)
    // The icon takes the leading slot, so the check is drawn at the end.
    expect(tid('m-title').querySelectorAll('[data-icon="check"]').length).toBe(1)
    expect(tid('m-blank').querySelectorAll('[data-icon="check"]').length).toBe(0)
  })
})

describe('ShellPanel onRectChange: a host keeping the inset in state does not loop', () => {
  it('an inline callback that sets state settles (no null/rect ping-pong per render)', () => {
    const calls: (DOMRect | null)[] = []
    function Host(): JSX.Element {
      const [inset, setInset] = useState(0)
      return (
        <>
          <span data-testid="inset">{inset}</span>
          <ShellPanel
            id="l"
            title="L"
            open
            pinned
            onClose={noop}
            onRectChange={(r) => {
              calls.push(r)
              setInset(r ? Math.round(r.right) + 1 : 0) // a new value each time it reports
            }}
            testid="p"
          >
            <div />
          </ShellPanel>
        </>
      )
    }
    render(<Host />)
    // One report on mount; re-renders caused by the host's own state do not re-run it.
    expect(calls.length).toBeLessThanOrEqual(2)
    expect(calls.every((c) => c !== null)).toBe(true)
    expect(tid('inset').textContent).toBe('1')
  })
})

describe('sheets: whichever of a panel and the side pane opened last is on top (SPEC §2.6)', () => {
  const narrow = (): (() => void) => {
    const Orig = globalThis.ResizeObserver
    class RO {
      constructor(private cb: ResizeObserverCallback) {}
      observe(): void {
        this.cb([{ contentRect: { width: 420, height: 380 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver
    return () => {
      globalThis.ResizeObserver = Orig
    }
  }
  const panes = [{ id: 'ai', title: 'AI', icon: 'x', render: () => <p /> }]
  const frame = (panelOpen: boolean, paneOpen: boolean): JSX.Element => (
    <OfficeShellLayout
      testid="s"
      bar={<div />}
      rail={<div />}
      panels={<ShellPanel id="lib" title="Library" open={panelOpen} onClose={noop} testid="p"><div /></ShellPanel>}
      rightPane={<ShellSidePane testid="sp" panes={panes} activeId={paneOpen ? 'ai' : null} onChange={noop} />}
    >
      <div />
    </OfficeShellLayout>
  )
  it('a panel opened after the side pane rises above it; reopening the pane puts the pane back on top', () => {
    const restore = narrow()
    try {
      render(frame(false, true)) // side pane first
      expect(tid('s-panels').dataset.front).toBeUndefined()
      render(frame(true, true)) // then a panel
      expect(tid('s-panels').dataset.front).toBe('true')
      expect(tid('s-panels').className).toContain('z-50')
      render(frame(true, false))
      render(frame(true, true)) // the pane opened again, last
      expect(tid('s-panels').dataset.front).toBeUndefined()
      expect(tid('s-panels').className).toContain('z-30')
    } finally {
      restore()
    }
  })
  it('wide, nothing is raised: panels stay in their column below the side pane', () => {
    render(frame(true, true))
    expect(tid('s-panels').dataset.front).toBeUndefined()
  })
  it('the collapse control carries the structural hook whatever its test id (collapseTestid keeps legacy ids)', () => {
    render(<ShellSidePane testid="sheet-ai-panel" collapseTestid="sheet-ai-collapse" panes={panes} activeId="ai" onChange={noop} />)
    expect(tid('sheet-ai-collapse').getAttribute('data-shell-role')).toBe('sidepane-collapse')
  })
})
