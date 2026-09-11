// Everything the browser's database needs before a handler may touch it.
//
// This exists as one function, rather than a sequence inlined into the Worker's
// open, so that what the Worker builds and what the tests build cannot drift.
// The distinction it captures: applySchemaAndMigrations covers the tables the
// migration set knows about, but a few modules create their own on first use
// and the desktop calls those explicitly while registering IPC handlers. A
// browser runtime that serves those channels owes the same calls, and a test
// that constructs the schema some other way would not prove that it makes them.
import { applySchemaAndMigrations } from '../../main/db/migrations'
import { ensureSignalSchema } from '../../main/db/signals'

/** Migrate `db`, then create the lazily-built tables the served channels need. */
export function applyBrowserSchema(db: unknown): void {
  applySchemaAndMigrations(db as never)
  // signals:* -- the arrival router's record of what came in. Desktop does this
  // at src/main/ipc/index.ts, right before registering the same channels.
  ensureSignalSchema(db as never)
}
