// A field's value as plain text, for a viewer that shows it without editing it
// (a read-only Field widget, lib/widgetSurface WidgetReadOnlyContext).
//
// Every editor in components/fields is an input; a viewer needs the value the
// way a person reads it: option labels rather than option ids, a date rather
// than milliseconds, the number with its prefix and suffix, a count for
// references to things outside the field. Nothing is invented: an empty value
// is an empty string, and the caller shows that as empty.
import type { FieldDefinition } from '@shared/fields'

/** Plain text of a rich-text value (serialised Tiptap JSON); text that is not JSON is returned as is. */
function richText(value: string): string {
  let doc: unknown
  try {
    doc = JSON.parse(value)
  } catch {
    return value
  }
  const blocks: string[] = []
  const walk = (node: unknown, into: string[]): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; text?: string; content?: unknown[] }
    if (typeof n.text === 'string') into.push(n.text)
    if (Array.isArray(n.content)) {
      const block = n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' || n.type === 'taskItem'
      if (block) {
        const line: string[] = []
        for (const c of n.content) walk(c, line)
        blocks.push(line.join(''))
      } else for (const c of n.content) walk(c, into)
    }
  }
  const top: string[] = []
  walk(doc, top)
  if (top.length) blocks.push(top.join(''))
  return blocks.filter((b) => b !== '').join('\n')
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function fieldValueText(def: FieldDefinition, value: unknown): string {
  switch (def.type) {
    case 'text-short':
    case 'text-long':
      return typeof value === 'string' ? value : ''
    case 'text-rich':
      return typeof value === 'string' ? richText(value) : ''
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      const { precision, prefix = '', suffix = '' } = def.config
      return `${prefix}${typeof precision === 'number' ? value.toFixed(precision) : String(value)}${suffix}`
    }
    case 'checkbox':
      return value === true ? 'Yes' : 'No'
    case 'single-select':
      return def.config.options.find((o) => o.id === value)?.label ?? ''
    case 'multi-select':
      return Array.isArray(value) ? value.map((id) => def.config.options.find((o) => o.id === id)?.label).filter(Boolean).join(', ') : ''
    case 'date': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      const d = new Date(value)
      return def.config.withTime ? d.toLocaleString() : d.toLocaleDateString(undefined, { timeZone: 'UTC' })
    }
    case 'attachment':
      return Array.isArray(value) && value.length ? plural(value.length, 'file', 'files') : ''
    case 'relation':
      return Array.isArray(value) && value.length ? plural(value.length, 'linked record', 'linked records') : ''
    case 'doc-ref':
      return Array.isArray(value) && value.length ? plural(value.length, 'document', 'documents') : ''
    case 'button':
      return def.config.label ?? ''
  }
}
