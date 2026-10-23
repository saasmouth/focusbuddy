// The host state every office app keeps for its shell, in ONE place (SPEC
// §3.9), so the six apps behave the same:
//  - the tab: every editor opens on Home (owner ruling A1, 4.3.41-local.2). A
//    remembered tab made a document open on whatever tab the last one was
//    left on — Layout, or a contextual tab — which surprised people and made
//    specs pass or fail by history (SPEC §5a.12);
//  - collapse (D5): persisted per user, per app, under the key each app
//    already used, so nobody's choice is lost;
//  - the rail flyouts' last-used member, persisted per app.
// Draw keeps its own store (plexii.draw.shell) for the same three things.

import { useCallback, useState } from 'react'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, v: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(v))
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

export interface ShellChrome {
  tab: string
  setTab: (id: string) => void
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  lastUsed: Record<string, string>
  onFlyoutPick: (flyout: string, id: string) => void
}

/**
 * @param app the app's storage prefix as it already exists: 'doc', 'sheet',
 *   'slides', 'diagram', 'design'. Collapse lives at plexii.<app>.ribbonCollapsed
 *   (unchanged keys), the flyouts at plexii.<app>.railLastUsed.
 * @param defaults the flyouts' members before anything is picked.
 */
export function useShellChrome(app: string, defaults: Record<string, string> = {}): ShellChrome {
  const collapseKey = `plexii.${app}.ribbonCollapsed`
  const lastKey = `plexii.${app}.railLastUsed`
  const [tab, setTab] = useState('home')
  const [collapsed, setCollapsedState] = useState<boolean>(() => read<boolean>(collapseKey, false) === true)
  const [lastUsed, setLastUsed] = useState<Record<string, string>>(() => {
    const v = read<unknown>(lastKey, {})
    const ok = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    const out = { ...defaults }
    for (const [k, id] of Object.entries(ok)) if (typeof id === 'string') out[k] = id
    return out
  })
  const setCollapsed = useCallback(
    (v: boolean) => {
      setCollapsedState(v)
      write(collapseKey, v)
    },
    [collapseKey]
  )
  const onFlyoutPick = useCallback(
    (flyout: string, id: string) =>
      setLastUsed((cur) => {
        if (cur[flyout] === id) return cur
        const next = { ...cur, [flyout]: id }
        write(lastKey, next)
        return next
      }),
    [lastKey]
  )
  return { tab, setTab, collapsed, setCollapsed, lastUsed, onFlyoutPick }
}

/**
 * What Esc means on the canvas, the same in every canvas app (SPEC §3.2): an
 * armed tool goes back to Select; otherwise a selection is cleared. `armed`
 * says which tools count as armed (Draw's selection tools — Direct, Group
 * selection, Lasso — are not: Esc there deselects, as with Select).
 */
export function escapeIntent(tool: string, hasSelection: boolean, armed: (t: string) => boolean = (t) => t !== 'select'): 'disarm' | 'deselect' | null {
  if (armed(tool)) return 'disarm'
  return hasSelection ? 'deselect' : null
}
