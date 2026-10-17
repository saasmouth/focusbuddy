import { getTable, listRows } from '../db/tables'
import { getDocument } from '../db/documents'
import { listContactsForNode } from '../db/contacts'
import { listWorkItems } from '../db/workItems'
import { getFile } from '../db/files'
import { listStoredMail } from '../db/mailStore'
import { getDb } from '../db/database'
import { listNodes } from '../db/nodes'
import { getAccountKey } from '../mail/mailAccount'
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

    // From the LOCAL MAIL STORE now, not a session cache. That is the difference
    // between "the assistant knows about mail you have opened in this session"
    // and "the assistant knows what is in your inbox" — the store is filled by
    // every listing, including pages the user scrolled back through.
    //
    // Still headers only HERE. This text goes into the desk index of every prompt,
    // so it is a listing, not a reading: bodies belong to the question-time path
    // (findInMail), which fetches them only when a question is actually about mail
    // and can fence them as third-party text. Putting every body in every prompt
    // would cost a fortune and widen the injection surface to every turn.
    //
    // null when nothing has been ingested at all, which the extractor reports as
    // "not loaded" rather than as an empty inbox.
    mailItems: () => {
      const accountKey = getAccountKey()
      if (!accountKey) return null
      const rows = listStoredMail(getDb() as never, { accountKey, limit: 60 })
      if (rows.length === 0) return null
      return rows.map((m) => ({
        uid: m.uid,
        fromName: m.fromName,
        fromAddress: m.fromAddress,
        subject: m.subject,
        date: m.date,
        seen: m.seen,
        flagged: m.flagged,
        hasAttachments: m.hasAttachments
      }))
    },

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

    // The tasks a task-list lens shows, chosen exactly as TaskListWidget
    // chooses them: the desk's own tasks (or every task for 'all'), subtasks
    // folded under their parent, filtered by the widget's own tab. A list that
    // keeps its own items ('own' scope) never reaches this: its content IS the
    // list and the extractor reads it directly.
    tasks: (w: Widget) => {
      let model: { scope?: string; filter?: string } = {}
      try {
        model = JSON.parse(w.content || '{}') as typeof model
      } catch {
        model = {}
      }
      if (model.scope === 'own') return null
      const scope = model.scope === 'all' ? 'all' : 'desk'
      const filter = model.filter === 'done' || model.filter === 'all' ? model.filter : 'open'
      const nodes = listNodes()
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const deskId = w.taskId || null
      let pool = nodes
      if (scope === 'desk') {
        if (!deskId) return null
        const byParent = new Map<string | null, typeof nodes>()
        for (const n of nodes) {
          const l = byParent.get(n.parentId) ?? []
          l.push(n)
          byParent.set(n.parentId, l)
        }
        pool = []
        const queue = [...(byParent.get(deskId) ?? [])]
        while (queue.length) {
          const n = queue.shift()!
          pool.push(n)
          queue.push(...(byParent.get(n.id) ?? []))
        }
      }
      return pool
        .filter((n) => n.kind === 'task' && !n.archived)
        .filter((n) => {
          if (!n.parentId || n.parentId === deskId) return true
          const parent = byId.get(n.parentId)
          return !parent || parent.kind !== 'task'
        })
        .filter((n) => (filter === 'all' ? true : filter === 'done' ? n.status === 'done' : n.status !== 'done'))
        .map((n) => ({ title: n.title, done: n.status === 'done', dueAt: n.dueDate ?? null, status: n.status }))
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
