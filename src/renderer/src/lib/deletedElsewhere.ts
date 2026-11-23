// "Deleted on another device": the notice and the Trash dot (4.3.55).
//
// A delete made elsewhere (on another device, or by someone you share a desk
// with) lands in this device's Trash, labelled, and kept 30 days (main:
// syncTrash.ts). Most of the time nobody needs telling: it is in the Trash. The
// one moment that deserves a word is when it takes something off the desk you are
// looking at, because then the thing vanishes in front of you. So, owner's rule
// via d0 (24 Nov 2026): subtle, house style, and only for the desk you have open.
//
//   - one thing:   the house notice (stores/notice.ts), "“Budget” was deleted on
//                  another device.", with Restore;
//   - several:     one line, "3 things on this desk were deleted on another
//                  device.", with Open Trash;
//   - and the Trash in the side menu gets a dot until the Trash is opened. It is
//     kept across a restart (localStorage), because a dot that forgets is a dot
//     that lied.
//
// Callers (the poll in workspaceSync.ts, the CRDT appliers in crdtSync.ts) pass
// what a delete is about to take away, BEFORE the stores drop it: the stores are
// what say whether it is on the open desk, and what it was called.
import { create } from 'zustand'
import type { WidgetKind } from '@shared/types'
import type { DeletedElsewhereKind } from '@shared/syncTrash'
import { useViewStore } from '../stores/view'
import { useWidgetStore } from '../stores/widgets'
import { useTablesStore } from '../stores/tables'
import { useNodeStore } from '../stores/nodes'
import { useNoticeStore } from '../stores/notice'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'
import { widgetDisplayName } from './widgetDisplayName'
import { crdtEmitWidgetRestore, crdtEmitNodeRestore } from './crdtBridge'

export interface DeletedHere {
  kind: DeletedElsewhereKind
  id: string
  title: string
}

const DOT_KEY = 'fb.trash.deletedElsewhereDot'
const readDot = (): boolean => {
  try {
    return localStorage.getItem(DOT_KEY) === '1'
  } catch {
    return false
  }
}
const writeDot = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(DOT_KEY, '1')
    else localStorage.removeItem(DOT_KEY)
  } catch {
    /* the dot still shows for this session */
  }
}

/** The Trash's dot: something on the open desk was deleted elsewhere since the Trash was last opened. */
export const useTrashDot = create<{ on: boolean }>(() => ({ on: readDot() }))

/** The Trash was opened: the dot has done its job. */
export function clearTrashDot(): void {
  writeDot(false)
  useTrashDot.setState({ on: false })
}

function rowTitle(cells: Record<string, unknown> | undefined): string {
  for (const v of Object.values(cells ?? {})) if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60)
  return 'A row'
}

/** What a delete from elsewhere takes off the desk on screen, if anything. Call it before the stores drop it. */
export function onOpenDesk(items: ReadonlyArray<{ itemType: string; id: string }>): DeletedHere[] {
  const view = useViewStore.getState().view
  if (view.kind !== 'task') return []
  const deskId = view.taskId
  const { widgets } = useWidgetStore.getState()
  const { tables, rows } = useTablesStore.getState()
  const out: DeletedHere[] = []
  for (const it of items) {
    if (it.itemType === 'widget') {
      const w = widgets.find((x) => x.id === it.id && x.taskId === deskId)
      if (w) out.push({ kind: 'widget', id: w.id, title: widgetDisplayName({ kind: w.kind as WidgetKind, content: w.content ?? '', title: w.title }) })
    } else if (it.itemType === 'node') {
      if (it.id !== deskId) continue
      const n = useNodeStore.getState().nodes.find((x) => x.id === deskId)
      out.push({ kind: 'node', id: deskId, title: n?.title?.trim() || 'This desk' })
    } else if (it.itemType === 'table') {
      const t = tables[it.id]
      if (t && t.taskId === deskId) out.push({ kind: 'table', id: t.id, title: t.title?.trim() || 'A table' })
    } else if (it.itemType === 'row') {
      for (const [tableId, list] of Object.entries(rows)) {
        if (tables[tableId]?.taskId !== deskId) continue
        const r = list.find((x) => x.id === it.id)
        if (r) out.push({ kind: 'row', id: r.id, title: rowTitle(r.cells) })
      }
    }
  }
  return out
}

// On a shared desk, or in an org workspace, someone else may have deleted it: then
// "on another device" alone would not be the whole truth.
function othersCanDelete(): boolean {
  const view = useViewStore.getState().view
  const org = useOrgStore.getState().activeOrgId
  if (org && org !== PERSONAL_ORG_ID) return true
  if (view.kind !== 'task') return false
  return !!useNodeStore.getState().nodes.find((x) => x.id === view.taskId)?.sharedRootId
}

// Put it back where it was, on every device (the push answers the delete: see
// restoreAnswersDelete in workspaceSync.ts), and show it here at once.
async function restoreFromNotice(hit: DeletedHere): Promise<void> {
  const r = await window.api.trash.restoreDeletedElsewhere(hit.kind, hit.id)
  if (!r.restored) return
  if (hit.kind === 'widget') crdtEmitWidgetRestore(hit.id)
  if (hit.kind === 'node') crdtEmitNodeRestore(r.ids)
  const view = useViewStore.getState().view
  if (hit.kind === 'node') await useNodeStore.getState().refresh()
  if (view.kind === 'task') {
    if (hit.kind === 'widget' || hit.kind === 'node') await useWidgetStore.getState().loadForTask(view.taskId, { refresh: true })
    if (hit.kind === 'table' || hit.kind === 'row') {
      // The cached copies are the ones the delete emptied: read them again.
      useTablesStore.setState((s) => {
        const tables = { ...s.tables }
        const rows = { ...s.rows }
        for (const id of r.ids) {
          delete tables[id]
          delete rows[id]
        }
        for (const [tableId, list] of Object.entries(s.rows)) if (list.length === 0 || hit.kind === 'row') delete rows[tableId]
        return { tables, rows }
      })
    }
  }
}

/** Say so, once, if a delete from elsewhere took something off the open desk. */
export function announceDeletedElsewhere(hits: DeletedHere[]): void {
  if (!hits.length) return
  writeDot(true)
  useTrashDot.setState({ on: true })
  const by = othersCanDelete() ? 'on another device or by someone you work with' : 'on another device'
  const one = hits.length === 1 ? hits[0] : null
  useNoticeStore.getState().show({
    text: one ? `“${one.title}” was deleted ${by}.` : `${hits.length} things on this desk were deleted ${by}.`,
    icon: 'trash',
    action: one
      ? { label: 'Restore', run: () => void restoreFromNotice(one) }
      : { label: 'Open Trash', run: () => useViewStore.getState().goTrash() }
  })
}

// The CRDT channel delivers a delete as one event at a time, and a desk cleared on
// another device is a burst of them. Each is read against the open desk as it
// arrives (before its store update), and the burst is said once.
let pending: DeletedHere[] = []
let flushQueued = false
export function noteDeletedElsewhere(items: ReadonlyArray<{ itemType: string; id: string }>): void {
  const hits = onOpenDesk(items)
  if (!hits.length) return
  for (const h of hits) if (!pending.some((p) => p.kind === h.kind && p.id === h.id)) pending.push(h)
  if (flushQueued) return
  flushQueued = true
  setTimeout(() => {
    flushQueued = false
    const all = pending
    pending = []
    announceDeletedElsewhere(all)
  }, 0)
}
