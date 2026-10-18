// What kind of thing a Files entry is — its type key, label and icon.
//
// One place, because Files used to special-case only sheets and slides, so a
// diagram, a design and a drawing all read as "Document". Widget files
// (4.3.32, docs/widget-files.md) each read as their own type — "Table",
// "Task list", "Mind map" — with the widget's own icon.

import type { FileEntry } from '@shared/fields'
import type { WidgetFileDesk } from '@shared/types'
import { widgetFileType } from '@shared/widgetFiles'
import type { FileTypeFilter } from '../stores/fileManager'

const DOC_LABEL: Record<string, string> = {
  doc: 'Document',
  sheet: 'Spreadsheet',
  slides: 'Slides',
  map: 'Diagram',
  design: 'Design',
  draw: 'Artwork',
  widget: 'Work widget'
}

const DOC_ICON: Record<string, string> = {
  doc: 'description',
  sheet: 'table_chart',
  slides: 'slideshow',
  map: 'account_tree',
  design: 'palette',
  draw: 'brush',
  widget: 'widgets'
}

/** True for a widget file's entry. */
export function isWidgetFileEntry(e: FileEntry): boolean {
  return e.kind === 'doc' && e.docType === 'widget'
}

/**
 * A stable key per type: '' for folders, the doc type for documents,
 * 'widget:<kind>' for widget files, the extension for imported files. Sorting by
 * type sorts on this.
 */
export function fileTypeKey(e: FileEntry): string {
  if (e.kind === 'folder') return ''
  if (e.kind === 'doc') {
    if (e.docType === 'widget') return `widget:${e.widgetKind ?? ''}`
    return e.docType ?? 'doc'
  }
  return e.ext ?? ''
}

export function fileTypeLabel(e: FileEntry): string {
  if (e.kind === 'folder') return 'Folder'
  if (e.kind === 'doc') {
    if (e.docType === 'widget') return widgetFileType(e.widgetKind)?.label ?? 'Work widget'
    return DOC_LABEL[e.docType ?? 'doc'] ?? 'Document'
  }
  const ext = (e.ext ?? '').replace(/^\./, '').toUpperCase()
  return ext ? `${ext} file` : 'File'
}

export function fileTypeIcon(e: FileEntry): string {
  if (e.kind === 'folder') return 'folder'
  if (e.kind === 'doc') {
    if (e.docType === 'widget') return widgetFileType(e.widgetKind)?.icon ?? 'widgets'
    return DOC_ICON[e.docType ?? 'doc'] ?? 'description'
  }
  const m = e.mimeType ?? ''
  const ext = (e.ext ?? '').replace(/^\./, '')
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'movie'
  if (m.startsWith('audio/')) return 'music_note'
  if (m === 'application/pdf') return 'picture_as_pdf'
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return 'description'
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'table_chart'
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'slideshow'
  if (['md', 'txt'].includes(ext)) return 'article'
  if (['html', 'json', 'js', 'ts', 'css'].includes(ext)) return 'code'
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext)) return 'folder_zip'
  return 'draft'
}

/** Does an entry pass the type filter? */
export function matchesTypeFilter(e: FileEntry, f: FileTypeFilter): boolean {
  switch (f) {
    case 'all':
      return true
    case 'folders':
      return e.kind === 'folder'
    case 'files':
      return e.kind === 'file'
    case 'documents':
      return e.kind === 'doc' && e.docType !== 'widget'
    case 'widgets':
      return isWidgetFileEntry(e)
    default:
      return isWidgetFileEntry(e) && `widget:${e.widgetKind ?? ''}` === f
  }
}

/** The filter choices worth offering for a listing: the families, then each widget type present. */
export function typeFilterOptions(entries: FileEntry[]): Array<{ value: FileTypeFilter; label: string }> {
  const out: Array<{ value: FileTypeFilter; label: string }> = [
    { value: 'all', label: 'All types' },
    { value: 'folders', label: 'Folders' },
    { value: 'documents', label: 'Documents' },
    { value: 'files', label: 'Imported files' },
    { value: 'widgets', label: 'All work widgets' }
  ]
  const kinds = new Map<string, string>()
  for (const e of entries) {
    if (isWidgetFileEntry(e) && e.widgetKind) kinds.set(e.widgetKind, fileTypeLabel(e))
  }
  for (const [kind, label] of [...kinds.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    out.push({ value: `widget:${kind}`, label: plural(label) })
  }
  return out
}

/** "Table" → "Tables", "Sticky" → "Stickies", "Colour swatch" → "Colour swatches". */
export function plural(label: string): string {
  if (/[^aeiou]y$/i.test(label)) return label.slice(0, -1) + 'ies'
  if (/(s|sh|ch|x|z)$/i.test(label)) return label + 'es'
  return label + 's'
}

/**
 * Where a work widget file lives, for its Files row: "On Launch plan",
 * "On Launch plan and Hiring", "On Launch plan, Hiring and 3 more desks", or
 * "Not on a desk". Null while the placements are still loading, so the row
 * says nothing rather than something untrue.
 */
export function widgetFileDeskLine(desks: readonly WidgetFileDesk[] | undefined): string | null {
  if (!desks) return null
  if (desks.length === 0) return 'Not on a desk'
  const names = desks.map((d) => d.deskTitle)
  if (names.length === 1) return `On ${names[0]}`
  if (names.length === 2) return `On ${names[0]} and ${names[1]}`
  const rest = names.length - 2
  return `On ${names[0]}, ${names[1]} and ${rest} more desk${rest === 1 ? '' : 's'}`
}
