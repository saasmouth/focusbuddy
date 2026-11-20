// create {kind}: a new file made by Plexii's own code, for PlexiiLite's
// New > Plexii widget and New > Plexii document (1a's contract).
//
// The same calls the app makes for a new file, through this page's window.api:
//   a widget   widgetFiles.create with the kind's catalog default. For a file,
//              createWidgetFile itself picks a task list's own-list mode.
//   a table    also its backing table, with the starter columns the desk's
//              table widget gives a new one (lib/tableStarter.ts).
//   a document documents.create: Plexii gives a new one its blank body.
// Then the exporter's text (widgetFiles:exportText), exactly what a save carries.
import { UNTITLED_TABLE, starterTableColumns } from '@renderer/lib/tableStarter'
import { isHostDocumentType } from './kinds'

interface Api {
  widgetFiles: { create: (draft: unknown, opts?: unknown) => Promise<unknown>; update: (id: string, patch: unknown) => Promise<unknown> }
  tables: { create: (draft: unknown) => Promise<unknown> }
  documents: { create: (draft: unknown) => Promise<unknown> }
}

export interface CreateDeps {
  api: Api
  exportText: (which: { fileId: string } | { documentId: string }) => Promise<{ ok?: boolean; text?: string; error?: string }>
  /** The kind's default content as the desk's picker gives it (lib/widgetCatalog). */
  defaultContent: (kind: string) => Promise<string>
}

export type CreateResult = { ok: true; text: string } | { ok: false; error: string }

export function makeCreate(d: CreateDeps): (kind: string) => Promise<CreateResult> {
  return async (kind) => {
    try {
      let which: { fileId: string } | { documentId: string }
      if (isHostDocumentType(kind)) {
        const doc = (await d.api.documents.create({ docType: kind, title: '' })) as { id: string }
        which = { documentId: doc.id }
      } else {
        const file = (await d.api.widgetFiles.create({ kind }, { defaultContent: await d.defaultContent(kind) })) as { id: string }
        if (kind === 'table') {
          const table = (await d.api.tables.create({ taskId: null, title: UNTITLED_TABLE, schema: { columns: starterTableColumns() } })) as { id: string }
          await d.api.widgetFiles.update(file.id, { content: table.id })
        }
        which = { fileId: file.id }
      }
      const r = await d.exportText(which)
      return r?.ok && typeof r.text === 'string' ? { ok: true, text: r.text } : { ok: false, error: r?.error ?? 'the new file could not be written out' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
