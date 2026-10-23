import type { DocType, WidgetKind } from '@shared/types'

// Which work widget kind shows a document of each type, and back.
//
// ONE table, used by OfficeDocWidget (kind → which editor to mount) and by
// every place that turns a document into a widget (the Home dashboard's
// document card). A second, hand-written mapping is how a drawing came to open
// in PlexiiWrite: the dashboard card knew sheet and slides and sent every
// other type, drawings included, to the 'doc' kind.
export const OFFICE_KIND_TO_DOCTYPE = {
  doc: 'doc',
  sheet: 'sheet',
  slides: 'slides',
  map: 'map',
  design: 'design',
  draw: 'draw'
} as const satisfies Partial<Record<WidgetKind, DocType>>

export type OfficeWidgetKind = keyof typeof OFFICE_KIND_TO_DOCTYPE

/** The document type an office widget kind edits, or null for any other kind. */
export function docTypeForOfficeKind(kind: string): DocType | null {
  return (OFFICE_KIND_TO_DOCTYPE as Record<string, DocType>)[kind] ?? null
}

/** The widget kind that edits a document of this type, or null when no office widget can. */
export function officeKindForDocType(docType: string): OfficeWidgetKind | null {
  for (const [kind, t] of Object.entries(OFFICE_KIND_TO_DOCTYPE)) if (t === docType) return kind as OfficeWidgetKind
  return null
}
