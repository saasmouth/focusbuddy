// What a file's text is, decided before anything is imported, so a file the
// host cannot show gets an honest state in its tile: never a blank one and
// never a widget that half works.
import { kindForWidgetFileType, widgetFileType } from '../../shared/widgetFiles'
import type { HostErrorCode } from './protocol'
import { isHostDocumentType, isHostWidgetKind, type HostDocumentType, type HostWidgetKind } from './kinds'

export type Classified =
  | { family: 'widget'; kind: HostWidgetKind }
  | { family: 'document'; kind: HostDocumentType }
  | { error: HostErrorCode; label?: string }

const DOC_PREFIX = 'plexii.document.'

export function classifyFileText(text: string): Classified {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'not-a-plexii-file' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'not-a-plexii-file' }
  const p = parsed as Record<string, unknown>
  const type = typeof p.type === 'string' ? p.type : null

  // An Office document: its docType, or the type id's suffix.
  if (typeof p.docType === 'string' || type?.startsWith(DOC_PREFIX)) {
    const docType = typeof p.docType === 'string' ? p.docType : type!.slice(DOC_PREFIX.length)
    return isHostDocumentType(docType) ? { family: 'document', kind: docType } : { error: 'newer-than-host' }
  }

  // A widget: its kind, or the kind its type id names (as parseWidgetFileExport reads it).
  const kind = (typeof p.kind === 'string' ? p.kind : null) ?? (type ? kindForWidgetFileType(type) : null)
  if (kind && isHostWidgetKind(kind)) return { family: 'widget', kind }
  const known = kind ? widgetFileType(kind) : null
  if (known) return { error: 'needs-plexii', label: known.label }
  if (type?.startsWith('plexii.')) return { error: 'newer-than-host' }
  return { error: 'not-a-plexii-file' }
}
