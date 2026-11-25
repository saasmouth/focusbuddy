// INTERIM, until F1 lands (9e, focusbuddy branch widget-files-f1). Delete this
// file then.
//
// The widget host reads and writes its file through two channels whose
// contract F1 defines (9e, 2026-11-20):
//
//   'widgetFiles:import'     { text, parentId? } -> { ok: true, kind: 'widget', file }
//                                                  | { ok: true, kind: 'document', document } | { ok: false, error }
//   'widgetFiles:exportText' { fileId } | { documentId } -> { ok: true, name, text } | { ok: false, error }
//
// F1 owns the real ones (in src/web/worker/handlers.ts and Electron's IPC). The
// Worker looks up its own HANDLERS first, so the moment F1's exist these are
// never reached. They are here only so the host can be built and tested
// against the contract now; tests/unit/widgetHostF1Channels.test.ts pins the
// contract and must pass against F1's handlers after the swap.
import { buildWidgetFileExport, parseWidgetFileExport, widgetFileExportName } from '../../shared/widgetFiles'
import { getWidgetFile, importWidgetFile } from '../../main/db/widgetFiles'
import { getTable, listRows } from '../../main/db/tables'
import { createDocument, getDocument } from '../../main/db/documents'
import type { FbDocument } from '../../shared/types'
import { FIELD_TYPE_LABELS } from '../../shared/fields'

const OFFICE = ['doc', 'sheet', 'slides', 'map', 'design', 'draw'] as const
type OfficeDocType = (typeof OFFICE)[number]
const isOffice = (x: unknown): x is OfficeDocType => typeof x === 'string' && (OFFICE as readonly string[]).includes(x)

type Result = Record<string, unknown>

const DAMAGED_TABLE = 'This table file is damaged: its columns or rows are not a Plexii table.'
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
/** Columns that are FieldDefinitions ({ id, type, label, config }) and rows that are objects. */
function isPlexiiTable(t: { columns?: unknown; rows?: unknown }): boolean {
  if (!Array.isArray(t.columns) || !Array.isArray(t.rows)) return false
  const okColumn = (c: unknown): boolean =>
    isRecord(c) && typeof c.id === 'string' && typeof c.label === 'string' && typeof c.type === 'string' && c.type in FIELD_TYPE_LABELS && isRecord(c.config)
  return t.columns.every(okColumn) && t.rows.every(isRecord)
}

/** F1's document envelope, read minimally: a type or docType, a title, a body object. */
function parseDocument(p: Record<string, unknown>): { docType: OfficeDocType; title: string; body: FbDocument['body'] } | { error: string } | null {
  const fromType = typeof p.type === 'string' && p.type.startsWith('plexii.document.') ? p.type.slice('plexii.document.'.length) : null
  const docType = (p.docType ?? fromType) as unknown
  if (docType === undefined || docType === null) return null
  if (!isOffice(docType)) return { error: `This document type (${String(docType)}) is not supported by this version of Plexii.` }
  if (!p.body || typeof p.body !== 'object') return { error: 'This Plexii document file has no body.' }
  return { docType, title: typeof p.title === 'string' ? p.title : '', body: p.body as FbDocument['body'] }
}

function importText(input: { text?: unknown; parentId?: string | null } | undefined): Result {
  if (typeof input?.text !== 'string') return { ok: false, error: 'No file text was given.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(input.text)
  } catch {
    return { ok: false, error: 'This file is not a Plexii file (it is not valid JSON).' }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const doc = parseDocument(parsed as Record<string, unknown>)
    if (doc && 'error' in doc) return { ok: false, error: doc.error }
    if (doc) return { ok: true, kind: 'document', document: createDocument({ docType: doc.docType, title: doc.title, body: doc.body }) }
  }
  const env = parseWidgetFileExport(input.text)
  if ('error' in env) return { ok: false, error: env.error }
  // As F1 refuses it (9e, 2026-11-20): a table carries real column definitions
  // and object rows, or nothing is made. A file with other columns crashed the
  // table while drawing.
  if (env.kind === 'table' && env.table && !isPlexiiTable(env.table)) return { ok: false, error: DAMAGED_TABLE }
  return { ok: true, kind: 'widget', file: importWidgetFile(env, input.parentId ?? null) }
}

function exportText(input: { fileId?: unknown; documentId?: unknown } | undefined): Result {
  if (typeof input?.fileId === 'string') {
    const file = getWidgetFile(input.fileId)
    if (!file) return { ok: false, error: 'That widget file no longer exists.' }
    let table: { title: string; columns: Array<Record<string, unknown>>; rows: Array<Record<string, unknown>> } | undefined
    if (file.kind === 'table' && file.content) {
      const t = getTable(file.content)
      if (t) table = { title: t.title, columns: t.schema.columns as never, rows: listRows(t.id).map((r) => r.cells as Record<string, unknown>) }
    }
    return { ok: true, name: widgetFileExportName(file), text: JSON.stringify(buildWidgetFileExport(file, { table }), null, 2) }
  }
  if (typeof input?.documentId === 'string') {
    const doc = getDocument(input.documentId)
    if (!doc || !isOffice(doc.docType)) return { ok: false, error: 'That document no longer exists.' }
    const base = (doc.title || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Document'
    const text = JSON.stringify({ type: `plexii.document.${doc.docType}`, version: 1, title: doc.title, docType: doc.docType, body: doc.body, exportedAt: new Date().toISOString() }, null, 2)
    return { ok: true, name: `${base}.plexii-${doc.docType}`, text }
  }
  return { ok: false, error: 'Say which file or document to export.' }
}

export const INTERIM_F1_HANDLERS: Record<string, (input?: never) => unknown> = {
  'widgetFiles:import': importText as never,
  'widgetFiles:exportText': exportText as never
}
