// The link mark in a work widget's header — docs/widget-files.md, "The link
// mark".
//
// Since 4.3.32 every own-desk work widget is an instance of its file, so it is
// in a sync group: a mark shown "whenever there is a sync group" sat on nearly
// every header and said nothing. It now shows only when there is something
// worth knowing:
//
//   an instance of a work widget file   only when the same file is ALSO placed
//                                       on another desk: "Also on N other
//                                       desks", because an edit here changes
//                                       them too
//   a plain linked duplicate (a desk    as before: it really is a synced copy
//   shared with you, an older build)    of something elsewhere
//   the full-pane view of a file        never: its header says "On N desks"
//
// Pure, so it is unit-tested; the desk lookups live in useFileDesks below.

import { useEffect, useSyncExternalStore } from 'react'
import type { Widget, WidgetFileDesk } from '@shared/types'
import { isWidgetFilePaneId, widgetFileIdFromGroup } from '@shared/widgetFiles'

export const PLAIN_SYNC_TITLE =
  'Synced copy — content, title and colour mirror across all linked copies (even in other tasks). Right-click → ‘Unlink from synced copies’ to make this one independent.'

/** "Also on 1 other desk" / "Also on 3 other desks". */
export function alsoOnTitle(others: number): string {
  return `Also on ${others} other desk${others === 1 ? '' : 's'} — a change here shows there too.`
}

/**
 * What the header mark says, or null for no mark. `desks` is where the file is
 * placed (undefined while unknown: no mark rather than a guess).
 */
export function linkBadge(
  w: Pick<Widget, 'id' | 'taskId' | 'syncGroupId'>,
  desks: readonly WidgetFileDesk[] | undefined
): { title: string; others: number | null } | null {
  if (!w.syncGroupId || isWidgetFilePaneId(w.id)) return null
  const fileId = widgetFileIdFromGroup(w.syncGroupId)
  if (!fileId) return { title: PLAIN_SYNC_TITLE, others: null }
  if (!desks) return null
  const others = new Set(desks.map((d) => d.deskId).filter((d) => d !== w.taskId)).size
  return others > 0 ? { title: alsoOnTitle(others), others } : null
}

// ── Where each file is placed, batched across every header on screen ──────

const cache = new Map<string, WidgetFileDesk[]>()
const wanted = new Map<string, number>() // file id → mounted headers asking
const listeners = new Set<() => void>()
let pending = new Set<string>()
let scheduled = false
let version = 0

function emit(): void {
  version++
  for (const l of listeners) l()
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const ids = [...pending]
    pending = new Set()
    if (ids.length === 0) return
    void window.api.widgetFiles
      .placements(ids)
      .then((m) => {
        for (const id of ids) cache.set(id, m?.[id] ?? [])
        emit()
      })
      .catch(() => {
        /* unknown: no mark */
      })
  })
}

/**
 * Re-read every file a header is showing. Called after anything that places,
 * removes or trashes an instance, so "Also on N other desks" never goes stale.
 */
export function refreshFileDesks(): void {
  for (const id of wanted.keys()) pending.add(id)
  schedule()
}

/** The desks a file sits on, for a header; undefined until known. */
export function useFileDesks(fileId: string | null): WidgetFileDesk[] | undefined {
  useEffect(() => {
    if (!fileId) return
    wanted.set(fileId, (wanted.get(fileId) ?? 0) + 1)
    // Fresh on every mount: opening a desk re-reads its files.
    pending.add(fileId)
    schedule()
    return () => {
      const n = (wanted.get(fileId) ?? 1) - 1
      if (n <= 0) wanted.delete(fileId)
      else wanted.set(fileId, n)
    }
  }, [fileId])
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version
  )
  return fileId ? cache.get(fileId) : undefined
}
