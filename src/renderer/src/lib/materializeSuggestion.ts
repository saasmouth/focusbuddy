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

export interface Materialized {
  content: string
  title: string
}

export async function materializeSuggestion(
  s: AiBuildSuggestion,
  taskId: string,
  fallbackContent = ''
): Promise<Materialized> {
  let content = s.content ?? ''
  let title = s.title || ''

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

  return { content, title }
}
