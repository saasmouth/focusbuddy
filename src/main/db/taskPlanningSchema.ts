import { TASK_PLANNING_COLUMNS } from '@shared/taskPlanning'

interface SchemaDb {
  prepare(sql: string): { all(): unknown[] }
  exec(sql: string): void
}

/**
 * Add the planning columns to `nodes` if this database predates them.
 *
 * Idempotent and additive: every column is nullable with no default, so an
 * existing row keeps meaning exactly what it meant -- an untouched task has no
 * planned start rather than a start of "now", which is the difference between
 * an empty plan and a wrong one.
 */
export function ensureTaskPlanningSchema(db: SchemaDb): void {
  const have = new Set(
    (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name)
  )
  for (const def of TASK_PLANNING_COLUMNS) {
    if (!have.has(def.column)) db.exec(`ALTER TABLE nodes ADD COLUMN ${def.column} ${def.ddl}`)
  }
}
