// Turn an AI suggestion into a widget that is READY, not a shell.
//
// A suggestion carries its configuration — a table's columns, a page's body, a
// field's definition — and that configuration has to become a real thing before
// the widget is spawned: an fb_tables row for a table, serialised Tiptap JSON
// for a page, a wrapped def for a field. Skip this step and the widget still
// appears, which is exactly what makes the omission hard to notice: you get a
// table with no columns and a page with no content, and the AI looks like it
// suggested furniture rather than set anything up.
//
// It lived inline in Canvas's builder handler, so only the free-form builder
// did it. The new-desk path next to it spawned `s.content ?? ''` and nothing
// else, which is why creating a desk with AI assist produced empty containers.
// One helper, three call sites (Canvas has two, the Sidebar one), so they
// cannot disagree about what "configured" means.

import type { AiBuildSuggestion } from '@shared/types'
import { cellsFromAiRow } from './actionExecutor'
import { tableFitWidth } from '@shared/widgetSizing'

export interface Materialized {
  content: string
  title: string
  // The size this thing needs, when materialising learned something the
  // catalog's per-kind default could not know (2026-10-30). A table is the
  // case: its width depends on the columns, and the columns only exist once
  // the suggestion is in hand. Absent means "the catalog default is right".
  width?: number
  height?: number
}

export async function materializeSuggestion(
  s: AiBuildSuggestion,
  taskId: string,
  fallbackContent = ''
): Promise<Materialized> {
  let content = s.content ?? ''
  let title = s.title || ''
  let width: number | undefined
  let height: number | undefined

  if (s.kind === 'table' && s.tableSchema) {
    // Provision the backing table now, so widget.content is a real table id
    // and the grid arrives with its columns already there.
    try {
      const created = await window.api.tables.create({
        taskId,
        title: s.title || 'Untitled',
        schema: {
          columns: s.tableSchema.columns.map((c) => ({
            id: c.id,
            type: c.type,
            label: c.label,
            config: c.config
          })) as never
        }
      })
      content = created.id
      // Wide enough to show every column it was just given. The catalog's
      // 680px predates the columns; here they exist, so measure instead.
      width = tableFitWidth(s.tableSchema.columns.length)
      // Rows the AI researched arrive WITH the table (ADR-0011). Created
      // after the table and before the widget is spawned, so the grid's first
      // render already has them — a table that pops in empty and fills a
      // moment later reads as a bug.
      //
      // A row that maps to no known column is skipped, not failed: losing one
      // bad row is better than losing the other nineteen.
      const rows = s.tableSchema.rows ?? []
      if (rows.length > 0) {
        const columns = s.tableSchema.columns.map((c) => ({
          id: c.id,
          label: c.label,
          type: c.type,
          config: c.config
        }))
        for (const raw of rows) {
          const { cells } = cellsFromAiRow(columns, raw as Record<string, unknown>)
          if (Object.keys(cells).length === 0) continue
          try {
            await window.api.tables.createRow({ tableId: created.id, cells })
          } catch {
            /* one row short beats no table */
          }
        }
      }
    } catch {
      // Fall through to an empty table widget, which auto-provisions its own
      // schema on first render. Worse than the configured one, better than
      // failing the whole batch for one bad column type.
      content = ''
    }
  } else if (s.kind === 'page' && s.pageContent) {
    // Tiptap holds a JSON object; widget.content is a string field.
    content = JSON.stringify(s.pageContent)
  } else if (s.kind === 'field' && s.fieldDef) {
    // FieldWidget reads `{ def, value }`. A null value makes it substitute the
    // type's own default, which avoids importing every field type here.
    content = JSON.stringify({ def: s.fieldDef, value: null })
    title = s.fieldDef.label || s.title
  } else if (!content) {
    content = fallbackContent
  }

  return { content, title, width, height }
}
