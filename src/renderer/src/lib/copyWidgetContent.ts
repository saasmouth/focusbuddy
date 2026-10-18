// The content an INDEPENDENT copy of a work widget starts with.
//
// A copy is a new file of its own (docs/widget-files.md, "Copies"), so it must
// not keep editing the original's data behind the scenes. For almost every kind
// the content is the data and copying the string is enough. A table's content
// is only the id of its fb_tables row, so a copy that kept it would be a second
// file over the SAME rows — independent in name only. The table is cloned.
// (A linked duplicate is the opposite: another instance of one file, sharing
// everything, and never comes through here.)

import type { WidgetKind } from '@shared/types'

export async function contentForIndependentCopy(kind: WidgetKind, content: string): Promise<string> {
  if (kind !== 'table' || !content) return content
  try {
    const t = await window.api.tables.get(content)
    if (!t) return content
    const copy = await window.api.tables.create({ taskId: t.taskId ?? null, title: t.title, schema: t.schema })
    const rows = await window.api.tables.listRows(t.id)
    for (const r of rows) await window.api.tables.createRow({ tableId: copy.id, cells: r.cells })
    return copy.id
  } catch {
    // A copy that shares rows is better than no copy; say nothing more.
    return content
  }
}
