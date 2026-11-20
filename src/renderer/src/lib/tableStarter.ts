// The columns a new table starts with, in one place: the desk's table widget
// provisions its backing table with them, and so does a table file made in
// PlexiiLite (src/web/widgetHost/create.ts), so the two never differ.
import type { FieldDefinition } from '@shared/fields'

export function starterTableColumns(): FieldDefinition[] {
  return [
    { id: 'c-name', type: 'text-short', label: 'Name', config: {} } as FieldDefinition,
    { id: 'c-done', type: 'checkbox', label: 'Done', config: {} } as FieldDefinition
  ]
}

/** A new table's name when its widget has no name of its own. */
export const UNTITLED_TABLE = 'Untitled table'
