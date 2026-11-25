// Writes tests/widget-host/fixtures: one .plexii-* file per kind the widget host
// shows, made the way Plexii makes them -- a widget with its catalog default
// content (as the desk's picker creates it), an Office document with the blank
// body Plexii gives a new one. Run on purpose, never in the suite:
//
//   MAKE_HOST_FIXTURES=1 npx vitest run tests/unit/_makeWidgetHostFixtures.test.ts
//
// INTERIM: F1 (9e) brings the official fixtures (tests/fixtures/widget-files/,
// kept word for word in PlexiiLite). When they land, point the widget host's
// browser tests at those and delete this file and its output.
import { describe, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/main/db/database', () => ({ getDb: () => { throw new Error('no db here') }, databaseFilePath: () => ':memory:', closeDb: () => {}, nodesKindMigrationStatus: () => null }))
// A file carries no brand kit: a new document's blank body is the plain one.
vi.mock('../../src/main/db/brandKit', async (orig) => ({ ...(await orig<object>()), hasBrandKit: () => false }))

const run = process.env.MAKE_HOST_FIXTURES === '1' ? it : it.skip

describe('widget host fixtures', () => {
  run('writes one file per kind', async () => {
    const { buildWidgetFileExport, widgetFileType, taskListContent } = await import('../../src/shared/widgetFiles')
    const { catalogFor } = await import('../../src/renderer/src/lib/widgetCatalog')
    const { emptyBody } = await import('../../src/main/db/documents')
    const { HOST_WIDGET_LOADERS, HOST_DOCUMENT_TYPES } = await import('../../src/web/widgetHost/kinds')
    const { defaultConfig } = await import('../../src/shared/fields')
    const dir = join(process.cwd(), 'tests/widget-host/fixtures')
    mkdirSync(dir, { recursive: true })
    const now = new Date('2026-11-20T00:00:00.000Z')
    for (const kind of Object.keys(HOST_WIDGET_LOADERS)) {
      // The task list in its own-list mode (the plan's offer): the desk-scope
      // default lists a desk's tasks, which a file has none of.
      const content = kind === 'task-list' ? taskListContent([{ title: 'Buy milk' }, { title: 'Call the plumber' }]) : String(catalogFor(kind as never)?.defaultContent ?? '')
      const table = kind === 'table'
        // Columns as Plexii makes them (shared/fields FieldDefinition).
        ? { title: 'Prices', columns: [{ id: 'c1', type: 'text-short', label: 'Item', config: defaultConfig('text-short') }, { id: 'c2', type: 'number', label: 'Price', config: defaultConfig('number') }], rows: [{ c1: 'Tea', c2: 4 }, { c1: 'Milk', c2: 2 }] }
        : undefined
      const env = buildWidgetFileExport({ kind: kind as never, title: `Test ${kind}`, content, color: null }, { table, now })
      writeFileSync(join(dir, `${kind}${widgetFileType(kind)!.ext}`), JSON.stringify(env, null, 2) + '\n')
    }
    for (const docType of HOST_DOCUMENT_TYPES) {
      const body = emptyBody(docType)
      const env = { type: `plexii.document.${docType}`, version: 1, title: `Test ${docType}`, docType, body, exportedAt: now.toISOString() }
      writeFileSync(join(dir, `${docType}.plexii-${docType}`), JSON.stringify(env, null, 2) + '\n')
    }
  })
})
