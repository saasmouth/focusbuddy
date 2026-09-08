// A better-sqlite3-shaped facade over SQLite compiled to WebAssembly.
//
// The desktop's data layer -- 68 modules, 551 prepared statements -- is written
// against better-sqlite3's synchronous API. The cloud runtime wants that exact
// code, not a reimplementation of it, because a workspace item's sync body is
// the table row minus its sync columns: two implementations of "what a node is"
// would not fail loudly, they would quietly exchange rows missing each other's
// columns. So rather than port the data layer, this makes the browser look like
// the environment the data layer already expects.
//
// Two constraints shape it. SQLite's OPFS backing needs
// FileSystemSyncAccessHandle, which exists only inside a dedicated Worker, and
// the data layer's API is synchronous. Both are satisfied in the same place:
// this runs in a Worker, where the handles are available and blocking is fine,
// which is why the cloud runtime mirrors Electron's split -- Worker as the main
// process, window.api as the IPC boundary. That was not a design preference; it
// is the only arrangement in which the existing code runs unchanged.
//
// Only what the data layer actually calls is implemented: prepare/get/all/run,
// exec, transaction, pragma, close. It uses no iterate, no pluck, no custom
// functions and no extensions, so the surface below is complete rather than a
// subset that will surprise someone later.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

type Params = unknown[]
type Row = Record<string, unknown>

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface Statement {
  get(...params: Params): Row | undefined
  all(...params: Params): Row[]
  run(...params: Params): RunResult
}

export interface SqliteDb {
  prepare(sql: string): Statement
  exec(sql: string): void
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  pragma(source: string, opts?: { simple?: boolean }): unknown
  close(): void
}

// The oo1 handle is typed loosely on purpose: @sqlite.org/sqlite-wasm ships
// types that describe the C API far more precisely than the object API, and
// pinning these would mean asserting through them at every call anyway.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Oo1Db = any
type Oo1Stmt = any

let sqlite3: any = null

/**
 * Load the WASM module and install the OPFS pool VFS. Called once, before any
 * database is opened.
 *
 * The pool VFS is the variant that works without cross-origin isolation: it
 * reserves a set of files up front and takes sync access handles on them, so it
 * needs neither SharedArrayBuffer nor COOP/COEP headers. That matters because
 * requiring those headers would constrain how the cloud app can ever be served
 * and would break embedding.
 */
export async function initSqlite(): Promise<void> {
  if (sqlite3) return
  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: (m: string) => console.warn('[sqlite]', m) })
}

/**
 * Install the OPFS pool VFS, which is what makes a browser database durable.
 *
 * The pool variant is the one that works without cross-origin isolation: it
 * reserves files up front and takes sync access handles on them, needing
 * neither SharedArrayBuffer nor COOP/COEP headers. Requiring those would
 * constrain how the cloud app can ever be served, and would break embedding.
 *
 * It refuses rather than falling back to a memory database. A memory database
 * would work perfectly for a whole session and lose everything on reload, which
 * is the most expensive possible way to find out that persistence is missing.
 */
async function ensureOpfs(): Promise<void> {
  if (sqlite3.oo1?.OpfsSAHPoolDb) return
  const util = await sqlite3.installOpfsSAHPoolVfs?.({ name: 'plexii' })
  if (!util) {
    const why = typeof FileSystemHandle === 'undefined' ? 'OPFS unavailable in this context' : 'pool VFS not installed'
    throw new Error(`SQLite cannot persist in this browser (${why})`)
  }
  sqlite3.oo1.OpfsSAHPoolDb = util.OpfsSAHPoolDb
}

/** True once the WASM module is loaded; callers use this to fail honestly. */
export function sqliteReady(): boolean {
  return sqlite3 != null
}

function bindAll(stmt: Oo1Stmt, params: Params): void {
  if (params.length === 0) return
  // better-sqlite3 takes named parameters as one plain object whose keys carry
  // no sigil (`{ id }` for `@id`), while the WASM binder wants the sigil that
  // appears in the SQL. Resolving each key to its index covers all three sigils
  // without having to know which the statement used, and without rewriting SQL.
  const [first] = params
  if (params.length === 1 && first !== null && typeof first === 'object' && !Array.isArray(first) && !(first instanceof Uint8Array)) {
    for (const [key, value] of Object.entries(first as Row)) {
      const idx =
        stmt.getParamIndex(`@${key}`) || stmt.getParamIndex(`:${key}`) || stmt.getParamIndex(`$${key}`)
      // A body carrying keys the statement does not name is normal -- callers
      // pass whole rows to statements that write a subset -- so skip, not throw.
      if (idx) stmt.bind(idx, normalize(value))
    }
    return
  }
  params.forEach((value, i) => stmt.bind(i + 1, normalize(value)))
}

/**
 * better-sqlite3 accepts booleans and undefined at the binding boundary; the
 * WASM binder does not. Converting here keeps every call site unchanged.
 */
function normalize(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined) return null
  return value
}

class WasmStatement implements Statement {
  constructor(
    private readonly db: Oo1Db,
    private readonly sql: string
  ) {}

  private withStmt<T>(params: Params, fn: (stmt: Oo1Stmt) => T): T {
    // Prepared per call and finalized in a finally. better-sqlite3 caches the
    // compiled statement behind its handle and callers reuse one `prepare` for
    // many executions; holding a live WASM statement across those calls would
    // leak whenever an exception escaped mid-iteration.
    const stmt = this.db.prepare(this.sql)
    try {
      bindAll(stmt, params)
      return fn(stmt)
    } finally {
      stmt.finalize()
    }
  }

  get(...params: Params): Row | undefined {
    return this.withStmt(params, (stmt) => (stmt.step() ? (stmt.get({}) as Row) : undefined))
  }

  all(...params: Params): Row[] {
    return this.withStmt(params, (stmt) => {
      const rows: Row[] = []
      while (stmt.step()) rows.push(stmt.get({}) as Row)
      return rows
    })
  }

  run(...params: Params): RunResult {
    return this.withStmt(params, (stmt) => {
      stmt.step()
      return {
        changes: this.db.changes(),
        lastInsertRowid: sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer) as number
      }
    })
  }
}

class WasmDb implements SqliteDb {
  private depth = 0

  constructor(private readonly db: Oo1Db) {}

  prepare(sql: string): Statement {
    return new WasmStatement(this.db, sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    // better-sqlite3's transactions nest: an inner one joins the outer rather
    // than opening a second. The data layer relies on that -- applyRemote wraps
    // per-item helpers that open transactions of their own -- so nesting uses
    // savepoints and only the outermost commits.
    const wrapped = (...args: never[]): unknown => {
      const name = `sp_${this.depth}`
      this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`)
      this.depth++
      try {
        const out = fn(...args)
        this.depth--
        this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`)
        return out
      } catch (err) {
        this.depth--
        this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`)
        throw err
      }
    }
    return wrapped as unknown as T
  }

  pragma(source: string, opts?: { simple?: boolean }): unknown {
    // `pragma('user_version', { simple: true })` reads; `pragma('foreign_keys =
    // ON')` writes and returns nothing of interest. One shape covers both.
    const rows = this.db.exec({ sql: `PRAGMA ${source}`, rowMode: 'object', returnValue: 'resultRows' }) as Row[]
    if (opts?.simple) {
      const first = rows[0]
      return first ? Object.values(first)[0] : undefined
    }
    return rows
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Open (or create) the named database in OPFS. `initSqlite` must have resolved.
 */
export async function openDatabase(name: string): Promise<SqliteDb> {
  if (!sqlite3) throw new Error('openDatabase called before initSqlite resolved')
  await ensureOpfs()
  return new WasmDb(new sqlite3.oo1.OpfsSAHPoolDb(`/${name}`))
}

/**
 * An in-memory database on the same engine and the same facade.
 *
 * Used by tests that need to execute the desktop's SQL where better-sqlite3
 * cannot load -- it is built against Electron's ABI, so plain Node refuses it.
 * The engine is the same SQLite either way; only the bindings differ.
 */
export function openMemoryDatabase(): SqliteDb {
  if (!sqlite3) throw new Error('openMemoryDatabase called before initSqlite resolved')
  return new WasmDb(new sqlite3.oo1.DB(':memory:'))
}
