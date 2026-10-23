import { useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import type { MenuActionId } from '@shared/menus/lexicon'
import { menuAction } from '../../../lib/menus/menuAction'

// Shared presentation for the Google-Docs-style menu bars used across the office
// editors (documents, sheets, slides). It owns only the dropdown chrome and
// open/close behaviour; each editor supplies its own menu definitions whose items
// are wired to that editor's real commands. Nothing here invents an action.

export type MenuItem =
  | { kind: 'item'; label: string; shortcut?: string; icon?: string; run: () => void; disabled?: boolean; active?: boolean; hint?: string }
  | { kind: 'sep' }
  | { kind: 'submenu'; label: string; icon?: string; items: MenuItem[] }

export interface MenuDef {
  id: string
  label: string
  build: () => MenuItem[]
}

/** The bar's item with this label, wherever the app put it, if it has one and it is live. */
export function findBarItem(menus: MenuDef[], label: string): (MenuItem & { kind: 'item' }) | null {
  const walk = (items: MenuItem[]): (MenuItem & { kind: 'item' }) | null => {
    for (const it of items) {
      if (it.kind === 'item' && it.label === label && !it.disabled) return it
      if (it.kind === 'submenu') {
        const hit = walk(it.items)
        if (hit) return hit
      }
    }
    return null
  }
  for (const m of menus) {
    const hit = walk(m.build())
    if (hit) return hit
  }
  return null
}

export function MenuBarShell({
  menus,
  testid,
  itemTestid
}: {
  menus: MenuDef[]
  testid: string
  /**
   * Prefix for the per-menu button and list testids. Defaults to `testid`.
   * PlexiiWrite needs them to differ: its bar is `doc-menubar` while its menus
   * are `doc-menu-file`, `doc-menu-file-list` and so on.
   */
  itemTestid?: string
}): JSX.Element {
  const itemId = itemTestid ?? testid
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const menusRef = useRef(menus)
  menusRef.current = menus

  // The keys the shared items advertise (SPEC §9.2), bound here once for every
  // bar so an item's hint is always true, and only while the bar is on screen
  // (a hidden editor's bar must not answer for the visible one).
  //  - ⌘/ opens this app's shortcut sheet. App's global ⌘/ reference listens on
  //    the same window, so the bar claims the press in the capture phase.
  //  - ⌘F opens this app's Find… and ⇧⌘H its Find and replace… (E-14), unless
  //    the editor already handled the press (Write's text editor does) or the
  //    caret is in a form field.
  useEffect(() => {
    const onScreen = (): boolean => {
      const bar = barRef.current
      return !!bar && bar.isConnected && bar.getClientRects().length > 0
    }
    // Only a key the item itself shows: PlexiiDraw's shortcuts item keeps
    // Illustrator's ⌥⇧⌘K because ⌘/ is Add new fill there, so ⌘/ stays Draw's.
    function run(e: KeyboardEvent, id: MenuActionId): boolean {
      if (!onScreen()) return false
      const a = menuAction(id)
      const item = findBarItem(menusRef.current, a.label)
      if (!item || item.shortcut !== a.shortcut) return false
      e.preventDefault()
      setOpenMenu(null)
      item.run()
      return true
    }
    function onCapture(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '/' && run(e, 'keyboardShortcuts')) e.stopPropagation()
    }
    function onBubble(e: KeyboardEvent): void {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      const id: MenuActionId | null = k === 'f' && !e.shiftKey ? 'find' : k === 'h' && e.shiftKey ? 'findAndReplace' : null
      if (!id) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      run(e, id)
    }
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onBubble)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onBubble)
    }
  }, [])

  useEffect(() => {
    if (!openMenu) return
    function onDoc(e: MouseEvent): void {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  function runItem(run: () => void): void {
    setOpenMenu(null)
    run()
  }

  return (
    <div ref={barRef} className="relative flex items-center gap-0.5 select-none" data-testid={testid}>
      {menus.map((menu) => (
        <div key={menu.id} className="relative">
          <button
            onClick={() => setOpenMenu((cur) => (cur === menu.id ? null : menu.id))}
            onMouseEnter={() => setOpenMenu((cur) => (cur ? menu.id : cur))}
            data-testid={`${itemId}-${menu.id}`}
            className={`px-2 py-0.5 rounded text-[13px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] ${
              openMenu === menu.id ? 'bg-[var(--surface-sunken)]' : ''
            }`}
          >
            {menu.label}
          </button>
          {openMenu === menu.id && (
            <MenuDropdown items={menu.build()} onRun={runItem} testid={`${itemId}-${menu.id}-list`} />
          )}
        </div>
      ))}
    </div>
  )
}

function MenuDropdown({
  items,
  onRun,
  testid
}: {
  items: MenuItem[]
  onRun: (run: () => void) => void
  testid?: string
}): JSX.Element {
  return (
    <div
      className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 top-full mt-0.5 z-40 min-w-[230px] py-1"
      data-testid={testid}
    >
      {items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="my-1 border-t border-[var(--edge-soft)]" />
        if (it.kind === 'submenu') return <SubmenuRow key={i} label={it.label} icon={it.icon} items={it.items} onRun={onRun} />
        return (
          <button
            key={i}
            onClick={() => !it.disabled && onRun(it.run)}
            disabled={it.disabled}
            title={it.hint}
            className={`flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left ${
              it.disabled
                ? 'text-[var(--ink-30)] cursor-default'
                : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <span className="w-4 shrink-0 text-[var(--ink-50)]">
              {it.active ? <Icon name="check" size={15} /> : it.icon ? <Icon name={it.icon} size={15} /> : null}
            </span>
            <span className="flex-1 min-w-0 truncate">
              {it.label}
              {it.hint && <span className="block text-[11px] text-[var(--ink-40)] truncate">{it.hint}</span>}
            </span>
            {it.shortcut && <span className="text-[11px] text-[var(--ink-40)] fb-tabular">{it.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )
}

function SubmenuRow({
  label,
  icon,
  items,
  onRun
}: {
  label: string
  icon?: string
  items: MenuItem[]
  onRun: (run: () => void) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]">
        <span className="w-4 shrink-0 text-[var(--ink-50)]">{icon ? <Icon name={icon} size={15} /> : null}</span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        <Icon name="chevron_right" size={15} className="text-[var(--ink-40)] shrink-0" />
      </button>
      {open && (
        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-full top-0 -mt-1 ml-0.5 z-50 min-w-[210px] py-1 max-h-[70vh] overflow-y-auto">
          {items.map((it, i) => {
            if (it.kind !== 'item') return null
            return (
              <button
                key={i}
                onClick={() => !it.disabled && onRun(it.run)}
                disabled={it.disabled}
                title={it.hint}
                className={`flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left ${
                  it.disabled
                    ? 'text-[var(--ink-30)] cursor-default'
                    : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <span className="w-4 shrink-0 text-[var(--ink-50)]">{it.active ? <Icon name="check" size={15} /> : null}</span>
                <span className="flex-1 min-w-0 truncate">
                  {it.label}
                  {/* Why a submenu item is off, as for top-level items (it was dropped here). */}
                  {it.hint && <span className="block text-[11px] text-[var(--ink-40)] truncate">{it.hint}</span>}
                </span>
                {it.shortcut && <span className="text-[11px] text-[var(--ink-40)] fb-tabular">{it.shortcut}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MenuModal({
  title,
  children,
  onClose,
  width
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  /** Width in px; 340 when not given. */
  width?: number
}): JSX.Element {
  return (
    <div className="fb-scrim fixed inset-0 z-[60] flex items-center justify-center" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fb-card p-4 ${width ? 'max-w-[calc(100vw-32px)]' : 'w-[340px]'}`}
        style={width ? { width } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[14px] font-semibold text-[var(--ink-90)]">{title}</h3>
          <button onClick={onClose} className="icon-btn" title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
