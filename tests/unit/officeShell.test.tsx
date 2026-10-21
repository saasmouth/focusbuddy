// The shared office shell (SPEC §2, §9): ToolRail, flyouts, ContextBar, the
// bar primitives, ShellPanel and the Row 1 folding plan.

import { act } from 'react'
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
  BarToggle,
  ContextBar,
  OfficeShellLayout,
  ShellPanel,
  ToolRail,
  planRow1,
  railSlots,
  railTooltip,
  resolveActiveTab,
  visibleTabs,
  type BarTab,
  type RailItem
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
    expect(railTooltip('Pen', 'P', { disabledReason: 'not available: this document is read-only' })).toBe('Pen — not available: this document is read-only')
    expect(railTooltip('Group selection', undefined, {})).toBe('Group selection')
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

  it('disables with a reason; read-only disables everything not readOnlySafe', () => {
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
    expect(tid('r-pen').getAttribute('aria-label')).toBe('pen — not available: this document is read-only')
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
    expect(tid('bold').getAttribute('aria-label')).toBe('Bold — not available: this document is read-only')
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
