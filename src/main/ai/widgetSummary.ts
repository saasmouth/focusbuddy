import { getTable, listRows } from '../db/tables'
import { getDocument } from '../db/documents'
import { listContactsForNode } from '../db/contacts'
import { listWorkItems } from '../db/workItems'
import { getFile } from '../db/files'
import { getCachedMailItems } from '../db/search'
import type { Widget } from '@shared/types'
import {
  widgetToText,
  docBodyToText,
  type WidgetTextResolvers,
  type ResolvedFileRef
} from '@shared/widgetText'

// Main-process resolvers for the shared widget extractor: a table widget's rows
// come from the DB, an office widget's body is fetched and turned into text with
// the shared office-body extractor. This is what lets the desk agent and the
// assistant prompt finally read tables and office documents, not just their ids.
//
// The second group below covers the widgets whose items used to be invisible. A
// task-list and a calendar are still described rather than listed, because their
// rows genuinely do arrive by another route — the desk roster and the calendar
// block are already in the prompt, so listing them here would duplicate context
// rather than add any. An inbox, a contacts list, an attention view and a file
// list have no such other route: nothing else in any AI surface carried them, so
// asking Plexii about the emails on a desk got an answer about a filter rule.
export function mainWidgetResolvers(): WidgetTextResolvers {
  return {
    table: (id) => {
      const t = getTable(id)
      if (!t) return null
      return {
        title: t.title,
        columns: t.schema.columns.map((c) => ({ id: c.id, label: c.label, type: c.type })),
        rows: listRows(id).map((r) => r.cells)
      }
    },
    docText: (id) => {
      const d = getDocument(id)
      if (!d) return null
      return docBodyToText(d.docType, d.body)
    },

    // Headers only, and no snippet — getCachedMailItems strips it. Mail has no
    // local store, so this is the inbox page the app has actually fetched; null
    // when none has been, which the extractor reports as "not loaded" rather
    // than as an empty inbox.
    mailItems: () => getCachedMailItems(),

    contacts: (w: Widget) => {
      if (!w.taskId) return null
      return listContactsForNode(w.taskId).map((c) => ({
        name: c.name,
        email: c.email ?? undefined,
        phone: c.phone ?? undefined,
        role: c.role ?? undefined,
        company: c.company ?? undefined,
        tags: c.tags && c.tags.length ? c.tags : undefined
      }))
    },

    workItems: (w: Widget) => {
      // The widget's own scope decides whether it shows this desk's items or
      // every open one, the same choice the widget itself reads from content.
      let scope = 'desk'
      try {
        const parsed = JSON.parse(w.content ?? '{}') as { scope?: string }
        if (parsed?.scope === 'all') scope = 'all'
      } catch {
        // Unparseable content: fall back to the desk, which is the default.
      }
      const all = listWorkItems()
      const mine = scope === 'all' ? all : all.filter((n) => n.parentId === w.taskId)
      return mine.map((n) => ({
        title: n.title,
        state: n.workItemState ?? n.status ?? undefined,
        dueAt: n.dueAt ?? null
      }))
    },

    fileRefs: (w: Widget) => {
      const refs: ResolvedFileRef[] = []
      // A gallery names its files by id in content; a drive widget binds a folder
      // and has no id list, so it is left to the honest label rather than guessed
      // at from the whole file table.
      if (w.kind !== 'gallery') return null
      let ids: string[] = []
      try {
        const parsed = JSON.parse(w.content ?? '[]') as { fileIds?: string[] } | string[]
        ids = Array.isArray(parsed) ? parsed : (parsed?.fileIds ?? [])
      } catch {
        return null
      }
      for (const id of ids) {
        const f = getFile(id)
        if (f) refs.push({ name: f.originalName, mimeType: f.mimeType })
      }
      return refs
    }
  }
}

// Shared, synchronous per-widget summariser. Used for resolving a single agent
// input and for aggregating a whole desk behind a portal. Network-free: a
// browser contributes its URL + title here (a deep page read happens when a
// browser is wired directly into an agent, via the live webview in agentInputs).
export function summariseWidget(w: Widget): string {
  return widgetToText(w, mainWidgetResolvers()).text
}
