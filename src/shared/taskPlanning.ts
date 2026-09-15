// The planning fields a task grows once it is more than a line on a list.
//
// One manifest, read by the DDL, the row mapper and the patch writer alike.
// The work_item columns learned this the hard way (DEC-064): a hand-kept list
// in each of those three places gave `source_url` DDL and a writer but no way
// back out, so it stored fine and read as undefined for months. A column that
// isn't in all three is decoration.

export interface TaskPlanningColumn {
  /** SQLite column on `nodes`. */
  column: string
  /** Attribute on FbNode. */
  attr: string
  ddl: string
}

export const TASK_PLANNING_COLUMNS: readonly TaskPlanningColumn[] = [
  // The date work is MEANT to start, which is not started_at: that one records
  // when it actually did. A plan needs both -- the gap between them is the
  // whole reason anyone looks at a schedule.
  { column: 'planned_start_at', attr: 'plannedStartAt', ddl: 'INTEGER' },
  // Free text, not a user id. Half the people a task is assigned to are not in
  // the workspace -- a conveyancer, a photographer -- and a foreign key to a
  // users table would quietly make those unassignable.
  { column: 'assignee', attr: 'assignee', ddl: 'TEXT' },
  // The task that must finish before this one can start.
  { column: 'depends_on', attr: 'dependsOn', ddl: 'TEXT' },
  // Days after the predecessor finishes before this starts. Negative means
  // overlap -- the two run together, which is a real plan, not an error.
  { column: 'lag_days', attr: 'lagDays', ddl: 'INTEGER' },
  // JSON array of { id, name, mime, size } pointing at fb_files rows.
  { column: 'attachments_json', attr: 'attachmentsJson', ddl: 'TEXT' }
] as const

/** One attachment on a task: a pointer to fb_files, plus what to show. */
export interface TaskAttachment {
  id: string
  name: string
  mime?: string
  size?: number
}

export function parseAttachments(raw: string | null | undefined): TaskAttachment[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw) as unknown
    return Array.isArray(p) ? (p.filter((a) => a && typeof (a as TaskAttachment).id === 'string') as TaskAttachment[]) : []
  } catch {
    return []
  }
}

/**
 * When this task should start, given what it waits on.
 *
 * An explicit plannedStartAt always wins -- somebody typed it. Otherwise it is
 * derived from the predecessor finishing, plus the lag. Returns null when
 * neither is known, which is honest: an undated task has no start, and
 * defaulting it to today would put a date on the plan that nobody chose.
 */
export function derivedStart(
  task: { plannedStartAt?: number | null; dependsOn?: string | null; lagDays?: number | null },
  predecessorEnd: number | null
): number | null {
  if (task.plannedStartAt) return task.plannedStartAt
  if (task.dependsOn && predecessorEnd) {
    return predecessorEnd + (task.lagDays ?? 0) * 86_400_000
  }
  return null
}

/** Working days between two instants, or null when either end is unknown. */
export function durationDays(start: number | null, end: number | null): number | null {
  if (!start || !end) return null
  return Math.max(0, Math.round((end - start) / 86_400_000))
}
