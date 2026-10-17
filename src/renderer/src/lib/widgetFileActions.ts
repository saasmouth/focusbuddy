// The assistant's create-widget-file / update-widget-file actions —
// docs/widget-files.md. Reached only through applyProposal, so they inherit the
// review-and-apply flow every other workspace change uses: a card the user
// approves (or, where autonomy policy already allows it, auto-apply).
//
// The content builders (shared/widgetFiles) are pure and tested: the model supplies
// plain shapes (text, items, columns + rows, an outline) and these turn them
// into exactly what each widget stores, so nothing the model writes is a widget
// shape it could get wrong.

import type { ActionProposal } from '@shared/types'
import { appendTaskItems, cardContent, mergeText, mindmapContent, taskListContent } from '@shared/widgetFiles'
import { useWidgetFilesStore } from '../stores/widgetFiles'
import { useViewStore } from '../stores/view'
import { useNoticeStore } from '../stores/notice'
import { canCreateWidget } from './gating'
import { useCapabilityStore } from '../stores/capabilities'
import { catalogFor } from './widgetCatalog'

type CreateP = Extract<ActionProposal, { kind: 'create-widget-file' }>
type UpdateP = Extract<ActionProposal, { kind: 'update-widget-file' }>
export interface ApplyResultLike {
  ok: boolean
  message: string
}

/** Rows as cells keyed by column id, positionally. */
function cellsFor(columnIds: string[], row: string[]): Record<string, unknown> {
  const cells: Record<string, unknown> = {}
  columnIds.forEach((id, i) => {
    if (row[i] !== undefined && row[i] !== '') cells[id] = row[i]
  })
  return cells
}

export async function applyCreateWidgetFile(
  p: CreateP,
  ctx: { resolvedIds?: Map<string, string> }
): Promise<ApplyResultLike> {
  const label = catalogFor(p.widgetKind)?.label ?? p.widgetKind
  if (!canCreateWidget(useCapabilityStore.getState().capabilities, p.widgetKind)) {
    return { ok: false, message: `The ${label} work widget is not available on your plan.` }
  }
  let content: string
  switch (p.widgetKind) {
    case 'sticky':
    case 'note':
    case 'markdown':
      content = p.text ?? ''
      break
    case 'card':
      content = cardContent(p.title, p.text ?? '')
      break
    case 'task-list':
      content = taskListContent(p.items ?? [])
      break
    case 'mindmap':
      content = mindmapContent(p.title, p.outline ?? [])
      break
    case 'table': {
      const cols = (p.columns?.length ? p.columns : ['Name']).map((c, i) => ({
        id: `c-${Date.now().toString(36)}-${i}`,
        label: c,
        type: 'text-short' as const
      }))
      const table = await window.api.tables.create({ taskId: null, title: p.title, schema: { columns: cols } as never })
      for (const row of p.rows ?? []) {
        await window.api.tables.createRow({ tableId: table.id, cells: cellsFor(cols.map((c) => c.id), row) })
      }
      content = table.id
      break
    }
  }
  const file = await useWidgetFilesStore.getState().create(p.widgetKind, { open: false, title: p.title, content })
  if (!file) return { ok: false, message: `Could not create the ${label.toLowerCase()} file.` }
  ctx.resolvedIds?.set(p.id, file.id)
  let placed = ''
  if (p.deskId) {
    const w = await useWidgetFilesStore.getState().place(file.id, p.deskId)
    if (w) placed = ' and placed it on the desk'
  }
  useNoticeStore.getState().show({
    text: `Created ${label.toLowerCase()} “${file.title}” in Files`,
    icon: 'widgets',
    action: { label: 'Open', run: () => useViewStore.getState().goDocument(file.id) }
  })
  return { ok: true, message: `Created ${label.toLowerCase()} file "${file.title}"${placed}` }
}

export async function applyUpdateWidgetFile(
  p: UpdateP,
  ctx: { resolvedIds?: Map<string, string> }
): Promise<ApplyResultLike> {
  let fileId = p.fileId
  if (fileId.startsWith('$')) {
    const resolved = ctx.resolvedIds?.get(fileId.slice(1))
    if (!resolved) return { ok: false, message: 'This edit refers to a work widget file that was not created — try again.' }
    fileId = resolved
  }
  const store = useWidgetFilesStore.getState()
  const file = await store.load(fileId)
  if (!file) return { ok: false, message: `${p.label} no longer exists.` }
  const op = p.operation ?? 'append'
  const done: string[] = []

  if (p.text) {
    const next = mergeText(file.kind, file.content, p.text, op)
    if (next === null) {
      return { ok: false, message: `${p.label} is a ${file.kind} — its own work widget AI changes what it shows, not text.` }
    }
    await store.update(file.id, { content: next })
    done.push(op === 'replace' ? 'rewrote the text' : 'added the text')
  }
  if (p.items?.length) {
    if (file.kind !== 'task-list') return { ok: false, message: `${p.label} is not a task list.` }
    const next = appendTaskItems(file.content, p.items)
    if (next === null) {
      return { ok: false, message: `${p.label} shows a desk's tasks rather than its own — add them on that desk.` }
    }
    await store.update(file.id, { content: next })
    done.push(`added ${p.items.length} task${p.items.length === 1 ? '' : 's'}`)
  }
  if (p.rows?.length) {
    if (file.kind !== 'table' || !file.content) return { ok: false, message: `${p.label} is not a table.` }
    const table = await window.api.tables.get(file.content)
    if (!table) return { ok: false, message: `${p.label}'s table no longer exists.` }
    const ids = table.schema.columns.map((c) => c.id)
    for (const row of p.rows) await window.api.tables.createRow({ tableId: table.id, cells: cellsFor(ids, row) })
    done.push(`added ${p.rows.length} row${p.rows.length === 1 ? '' : 's'}`)
  }
  if (p.title) {
    await store.rename(file.id, p.title)
    done.push(`renamed it "${p.title}"`)
  }
  if (done.length === 0) return { ok: false, message: 'Nothing to change.' }
  return { ok: true, message: `Updated ${p.label}: ${done.join(', ')}` }
}
