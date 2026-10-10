// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A row written into a trashed table was accepted and then lost.
//
// `deleteTable()` is a SOFT delete: it sets `trashed_at` and leaves the
// `fb_tables` row in place. `fb_rows.table_id` is declared
// `REFERENCES fb_tables(id) ON DELETE CASCADE` with `foreign_keys = ON`, so the
// obvious reading is that the database protects this. It does not — nothing was
// deleted, so there is nothing for the constraint to object to. The INSERT
// succeeded and returned an ordinary row, while `listRows()`
// (`trashed_at IS NULL`) would never return it again.
//
// PlexiForms is where it surfaced: submit a form whose backing table has been
// trashed and it answered "Response saved". The form's own code was honest —
// it checks for a null row and catches a throw — it was simply never told
// anything had gone wrong. The response was gone.
//
// The first half of this file proves the PREMISE in real SQLite, because that
// premise is what makes the guard in `createRow()` load-bearing rather than
// redundant with the foreign key. Anyone reading the schema alone would
// reasonably conclude the guard can go; these two tests are the answer.
//
// Production runs better-sqlite3 (Electron ABI, unloadable in this runner), so
// the schema below mirrors db/schema.ts for the columns involved and is driven
// through Node's built-in node:sqlite. The full path through the real app and
// the real driver is covered by correctnessBatch.spec.ts test 2.

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec('PRAGMA foreign_keys = ON')
  d.exec(`
    CREATE TABLE fb_tables (
      id TEXT PRIMARY KEY,
      title TEXT,
      trashed_at INTEGER
    );
    CREATE TABLE fb_rows (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES fb_tables(id) ON DELETE CASCADE,
      cells_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      trashed_at INTEGER
    );
  `)
  d.exec("INSERT INTO fb_tables (id, title, trashed_at) VALUES ('t1', 'Responses', NULL)")
  return d
}

const insertRow = (d: DatabaseSync, id: string): void => {
  d.prepare(
    `INSERT INTO fb_rows (id, table_id, cells_json, sort_order, created_at, updated_at)
     VALUES (?, 't1', '{}', 0, 1, 1)`
  ).run(id)
}

describe('the premise: a soft delete leaves the foreign key satisfied', () => {
  it('a hard delete IS caught by the constraint', () => {
    const d = db()
    d.prepare("DELETE FROM fb_tables WHERE id = 't1'").run()
    // With the parent actually gone, SQLite refuses the row. This is the
    // protection the schema appears to offer.
    expect(() => insertRow(d, 'r1')).toThrow(/FOREIGN KEY/i)
  })

  it('a trashed table still accepts rows, which is the whole bug', () => {
    const d = db()
    // Exactly what deleteTable() does.
    d.prepare("UPDATE fb_tables SET trashed_at = 999 WHERE id = 't1'").run()

    // No error. The parent row is still there, so the constraint has no
    // objection, and the write looks like a complete success to its caller.
    expect(() => insertRow(d, 'r1')).not.toThrow()

    // And the row is unreachable the moment it is written: listRows() filters
    // on trashed_at IS NULL, so this is what the caller can read back.
    const visible = d
      .prepare("SELECT * FROM fb_rows WHERE table_id = 't1' AND trashed_at IS NULL")
      .all()
    expect(visible).toHaveLength(1)
    // The row itself is not trashed — only its table is. So the loss is not
    // visible from the row at all; it is visible only by joining to the table,
    // which is why no caller noticed.
    const reachable = d
      .prepare(
        `SELECT r.id FROM fb_rows r
         JOIN fb_tables t ON t.id = r.table_id
         WHERE r.trashed_at IS NULL AND t.trashed_at IS NULL`
      )
      .all()
    expect(reachable, 'the row is stranded behind a trashed table').toHaveLength(0)
  })
})

describe('createRow refuses to write into a table that reads as gone', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', 'src', 'main', 'db', 'tables.ts'),
    'utf8'
  )
  // createRow sits between listAllRowsByTable and updateRow — slice to the
  // next export rather than naming a neighbour, so reordering the file does
  // not quietly empty this slice and pass everything vacuously.
  const start = src.indexOf('export function createRow')
  const createRowBody = src.slice(start, src.indexOf('export function', start + 10))

  it('guards on getTable, which already treats trashed as gone', () => {
    expect(createRowBody).toContain('if (!getTable(draft.tableId))')
  })

  it('throws rather than returning, so no caller gets a row it cannot keep', () => {
    expect(createRowBody).toMatch(/throw new Error\([\s\S]*does not exist or is in the trash/)
  })

  it('guards before the INSERT', () => {
    const guardAt = createRowBody.indexOf('if (!getTable(draft.tableId))')
    const insertAt = createRowBody.indexOf('INSERT INTO fb_rows')
    expect(guardAt).toBeGreaterThan(-1)
    expect(insertAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(insertAt)
  })

  it('still answers an idempotent re-create of an existing row', () => {
    // The create-if-missing path (a client-provided id that already exists) is
    // a READ and returns before the guard. Sync restores lean on it, so the
    // guard must not turn that into a throw.
    const earlyReturn = createRowBody.indexOf('if (existing) return rowToFbRow(existing)')
    const guardAt = createRowBody.indexOf('if (!getTable(draft.tableId))')
    expect(earlyReturn).toBeGreaterThan(-1)
    expect(earlyReturn).toBeLessThan(guardAt)
  })
})
