import { randomUUID } from 'crypto'
import { getDb } from './database'
import {
  computeSchedule,
  detectDrift,
  rescheduleOnDrift,
  DAY_MS,
  type GanttInput,
  type DepLink
} from '@shared/gantt'
import { makeDayToMs, workingDaysBetween, DEFAULT_CALENDAR, type WorkingCalendar } from '@shared/workingCalendar'
import type {
  ProjectPlan,
  PlanTask,
  PlanDep,
  ProjectSummary,
  PlanTaskPatch,
  AddDepResult,
  DepType
} from '@shared/projects'

// The PlexiProjects plan store. A project is an existing folder node; its plan is
// the task nodes beneath it plus the finish-to-start dependencies between them.
// This module reads those, runs the critical-path engine (gantt.ts) and returns a
// fully scheduled ProjectPlan. It also persists planning edits (dates, milestone,
// dependencies) and can auto-reschedule the plan from what actually happened.
// Nothing here invents data: a project with no dated tasks still returns a real,
// if trivial, schedule anchored at today.

interface TaskRow {
  id: string
  title: string
  status: string
  is_milestone: number | null
  plan_start: number | null
  due_date: number | null
  estimate_minutes: number | null
  started_at: number | null
  completed_at: number | null
  assignee: string | null
  progress_pct: number | null
  must_start: number | null
  deadline: number | null
  cost: number | null
}

// All non-trashed, non-archived task descendants of a project folder, at any
// depth, via a recursive walk of parent_id.
function projectTaskRows(projectId: string): TaskRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE parent_id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
       )
       SELECT n.id, n.title, n.status, n.is_milestone, n.plan_start, n.due_date,
              n.estimate_minutes, n.started_at, n.completed_at, n.assignee, n.progress_pct,
              n.must_start, n.deadline, n.cost
       FROM nodes n JOIN sub ON n.id = sub.id
       WHERE n.kind = 'task' AND n.trashed_at IS NULL AND n.archived = 0`
    )
    .all(projectId) as TaskRow[]
  return rows
}

// Dependencies whose endpoints are both inside the given task-id set, carrying
// their type (FS/SS/FF/SF) and working-day lag.
function projectDeps(taskIds: Set<string>): PlanDep[] {
  if (taskIds.size === 0) return []
  const db = getDb()
  const rows = db.prepare('SELECT id, pred_id, succ_id, dep_type, lag_days FROM fb_task_deps').all() as Array<{
    id: string
    pred_id: string
    succ_id: string
    dep_type: string | null
    lag_days: number | null
  }>
  const VALID: DepType[] = ['FS', 'SS', 'FF', 'SF']
  return rows
    .filter((r) => taskIds.has(r.pred_id) && taskIds.has(r.succ_id))
    .map((r) => ({
      id: r.id,
      predId: r.pred_id,
      succId: r.succ_id,
      type: VALID.includes((r.dep_type ?? 'FS') as DepType) ? ((r.dep_type ?? 'FS') as DepType) : 'FS',
      lag: r.lag_days ?? 0
    }))
}

// Load a project's working calendar; the Mon-Fri default when no row exists.
export function loadProjectCalendar(projectId: string): WorkingCalendar {
  const db = getDb()
  const row = db
    .prepare('SELECT working_days, holidays_json FROM fb_project_calendars WHERE project_id = ?')
    .get(projectId) as { working_days: string; holidays_json: string } | undefined
  if (!row) return DEFAULT_CALENDAR
  try {
    const workingDays = JSON.parse(row.working_days) as boolean[]
    const holidays = JSON.parse(row.holidays_json) as number[]
    if (!Array.isArray(workingDays) || workingDays.length !== 7) return DEFAULT_CALENDAR
    return { workingDays, holidays: Array.isArray(holidays) ? holidays : [] }
  } catch {
    return DEFAULT_CALENDAR
  }
}

export function saveProjectCalendar(projectId: string, cal: WorkingCalendar): boolean {
  const db = getDb()
  const workingDays = Array.isArray(cal.workingDays) && cal.workingDays.length === 7 ? cal.workingDays.map(Boolean) : DEFAULT_CALENDAR.workingDays
  const holidays = Array.isArray(cal.holidays) ? cal.holidays.filter((h) => typeof h === 'number') : []
  db.prepare(
    `INSERT INTO fb_project_calendars (project_id, working_days, holidays_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET working_days = excluded.working_days, holidays_json = excluded.holidays_json, updated_at = excluded.updated_at`
  ).run(projectId, JSON.stringify(workingDays), JSON.stringify(holidays), Date.now())
  return true
}

// Whole-day duration for a task in WORKING days under the given calendar: from
// explicit start/due when both are set, otherwise from the estimate at an 8 hour
// working day, otherwise one day. A milestone is always zero.
function durationDays(row: TaskRow, cal: WorkingCalendar): number {
  if (row.is_milestone) return 0
  if (row.plan_start != null && row.due_date != null && row.due_date > row.plan_start) {
    // Count whole calendar days: floor both ends so a task's duration does not
    // shift with the time-of-day at which its dates were set.
    const startDay = Math.floor(row.plan_start / DAY_MS) * DAY_MS
    const dueDay = Math.floor(row.due_date / DAY_MS) * DAY_MS
    return Math.max(1, workingDaysBetween(startDay, dueDay, cal))
  }
  if (row.estimate_minutes && row.estimate_minutes > 0) {
    return Math.max(1, Math.ceil(row.estimate_minutes / (60 * 8)))
  }
  return 1
}

// Working-day offset of a timestamp from the anchor (for minStartDay / actuals).
// Floors ms to its calendar day so a task dated on the anchor day is offset 0
// regardless of the time-of-day component the date carries.
function workingOffset(anchor: number, ms: number, cal: WorkingCalendar): number {
  const day = Math.floor(ms / DAY_MS) * DAY_MS
  return day <= anchor ? 0 : workingDaysBetween(anchor, day, cal)
}

// ── Baselines ────────────────────────────────────────────────────────────────
interface BaselineTasks {
  [taskId: string]: { startMs: number; endMs: number }
}

// Snapshot the current scheduled start/end of every task as a named baseline.
export function captureBaseline(projectId: string, name: string, nowMs = Date.now()): { id: string; name: string; createdAt: number } {
  const db = getDb()
  const plan = getProjectPlan(projectId, nowMs)
  const tasks: BaselineTasks = {}
  for (const t of plan.tasks) tasks[t.id] = { startMs: t.scheduledStartMs, endMs: t.scheduledEndMs }
  const id = randomUUID()
  const created = Date.now()
  const cleanName = (name || 'Baseline').toString().trim().slice(0, 120) || 'Baseline'
  db.prepare('INSERT INTO fb_project_baselines (id, project_id, name, tasks_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    projectId,
    cleanName,
    JSON.stringify(tasks),
    created
  )
  return { id, name: cleanName, createdAt: created }
}

function latestBaselineTasks(projectId: string): BaselineTasks | null {
  const db = getDb()
  const row = db
    .prepare('SELECT tasks_json FROM fb_project_baselines WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectId) as { tasks_json: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.tasks_json) as BaselineTasks
  } catch {
    return null
  }
}

// Midnight-floored anchor: the earliest planned start across the tasks, or today
// when nothing is dated, so the schedule has a stable day-0 to offset from.
function planAnchor(rows: TaskRow[], nowMs: number): number {
  const starts = rows.map((r) => r.plan_start).filter((s): s is number => s != null)
  const base = starts.length ? Math.min(...starts) : nowMs
  return Math.floor(base / DAY_MS) * DAY_MS
}

export function getProjectPlan(projectId: string, nowMs = Date.now()): ProjectPlan {
  const db = getDb()
  const projectRow = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(projectId) as
    | { id: string; title: string }
    | undefined
  const rows = projectTaskRows(projectId)
  const ids = new Set(rows.map((r) => r.id))
  const deps = projectDeps(ids)
  const anchor = planAnchor(rows, nowMs)
  const cal = loadProjectCalendar(projectId)
  const dayToMs = makeDayToMs(anchor, cal)

  const predsByTask = new Map<string, string[]>()
  const linksByTask = new Map<string, DepLink[]>()
  for (const d of deps) {
    predsByTask.set(d.succId, [...(predsByTask.get(d.succId) ?? []), d.predId])
    linksByTask.set(d.succId, [...(linksByTask.get(d.succId) ?? []), { id: d.predId, type: d.type, lag: d.lag }])
  }

  const inputs: GanttInput[] = rows.map((r) => ({
    id: r.id,
    durationDays: durationDays(r, cal),
    deps: predsByTask.get(r.id) ?? [],
    links: linksByTask.get(r.id),
    isMilestone: !!r.is_milestone,
    minStartDay: r.plan_start != null ? workingOffset(anchor, r.plan_start, cal) : undefined,
    mustStartDay: r.must_start != null ? workingOffset(anchor, r.must_start, cal) : undefined,
    deadlineDay: r.deadline != null ? workingOffset(anchor, r.deadline, cal) : undefined
  }))

  const schedule = computeSchedule(inputs, anchor, dayToMs)
  const schedById = new Map(schedule.tasks.map((s) => [s.id, s]))

  // Actual finishes (completed_at) as working-day offsets, for drift detection.
  const actualFinish = new Map<string, number>()
  for (const r of rows) {
    if (r.completed_at != null) actualFinish.set(r.id, workingOffset(anchor, r.completed_at, cal))
  }
  const drift = detectDrift(schedule, actualFinish)
  const baseline = latestBaselineTasks(projectId)

  const tasks: PlanTask[] = rows.map((r) => {
    const s = schedById.get(r.id)!
    const done = r.status === 'done' || r.completed_at != null
    const bl = baseline?.[r.id]
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      isMilestone: !!r.is_milestone,
      planStart: r.plan_start,
      planDue: r.due_date,
      estimateMinutes: r.estimate_minutes,
      assignee: r.assignee ?? null,
      progressPct: done ? 100 : Math.max(0, Math.min(100, Math.round(r.progress_pct ?? 0))),
      startedAt: r.started_at,
      completedAt: r.completed_at,
      scheduledStartMs: s.startMs,
      scheduledEndMs: s.endMs,
      durationDays: s.durationDays,
      slackDays: s.slackDays,
      critical: s.critical,
      deps: predsByTask.get(r.id) ?? [],
      baselineStartMs: bl?.startMs ?? null,
      baselineEndMs: bl?.endMs ?? null,
      mustStartMs: r.must_start,
      deadlineMs: r.deadline,
      deadlineMiss: s.deadlineMiss,
      cost: r.cost
    }
  })
  // Stable order: by scheduled start, then title, so the Gantt reads top-down.
  tasks.sort((a, b) => a.scheduledStartMs - b.scheduledStartMs || a.title.localeCompare(b.title))
  const totalCost = rows.reduce((n, r) => n + (typeof r.cost === 'number' ? r.cost : 0), 0)

  return {
    projectId,
    title: projectRow?.title ?? 'Project',
    anchorMs: anchor,
    projectEndMs: schedule.projectEndMs,
    tasks,
    deps,
    criticalPath: schedule.criticalPath,
    hasCycle: schedule.hasCycle,
    drift,
    hasBaseline: baseline != null,
    totalCost
  }
}

export function setTaskPlan(taskId: string, patch: PlanTaskPatch): boolean {
  const db = getDb()
  // Plan write guard (§2.5.8): plan fields belong to desks only — a work_item
  // (or folder) id here is a caller bug, refused rather than silently written.
  const target = db.prepare('SELECT kind FROM nodes WHERE id = ?').get(taskId) as
    | { kind: string }
    | undefined
  if (target?.kind !== 'task') return false
  const sets: string[] = []
  const vals: Array<number | string | null> = []
  if ('planStart' in patch) {
    sets.push('plan_start = ?')
    vals.push(patch.planStart ?? null)
  }
  if ('planDue' in patch) {
    sets.push('due_date = ?')
    vals.push(patch.planDue ?? null)
  }
  if ('estimateMinutes' in patch) {
    sets.push('estimate_minutes = ?')
    vals.push(patch.estimateMinutes ?? null)
  }
  if ('isMilestone' in patch) {
    sets.push('is_milestone = ?')
    vals.push(patch.isMilestone ? 1 : 0)
  }
  if ('assignee' in patch) {
    const a = (patch.assignee ?? '').toString().trim()
    sets.push('assignee = ?')
    vals.push(a ? a.slice(0, 200) : null)
  }
  if ('progressPct' in patch) {
    sets.push('progress_pct = ?')
    vals.push(Math.max(0, Math.min(100, Math.round(patch.progressPct ?? 0))))
  }
  if ('mustStartMs' in patch) {
    sets.push('must_start = ?')
    vals.push(patch.mustStartMs ?? null)
  }
  if ('deadlineMs' in patch) {
    sets.push('deadline = ?')
    vals.push(patch.deadlineMs ?? null)
  }
  if ('cost' in patch) {
    sets.push('cost = ?')
    vals.push(typeof patch.cost === 'number' && Number.isFinite(patch.cost) ? patch.cost : null)
  }
  if (sets.length === 0) return false
  sets.push('updated_at = ?')
  vals.push(Date.now())
  vals.push(taskId)
  const res = db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return res.changes > 0
}

// Would adding pred -> succ create a cycle? True when succ can already reach pred
// through existing edges (so pred would then depend on itself transitively).
function wouldCycle(predId: string, succId: string): boolean {
  const db = getDb()
  const edges = db.prepare('SELECT pred_id, succ_id FROM fb_task_deps').all() as Array<{
    pred_id: string
    succ_id: string
  }>
  const adj = new Map<string, string[]>()
  for (const e of edges) adj.set(e.pred_id, [...(adj.get(e.pred_id) ?? []), e.succ_id])
  // Can we reach predId starting from succId? If so, pred->succ closes a loop.
  const stack = [succId]
  const seen = new Set<string>()
  while (stack.length) {
    const n = stack.pop()!
    if (n === predId) return true
    if (seen.has(n)) continue
    seen.add(n)
    for (const m of adj.get(n) ?? []) stack.push(m)
  }
  return false
}

export function addDependency(predId: string, succId: string, type: DepType = 'FS', lag = 0): AddDepResult {
  const db = getDb()
  if (predId === succId) return { ok: false, reason: 'self' }
  // Plan write guard (§2.5.8): dependencies join desks only.
  const exists = (id: string): boolean =>
    !!db
      .prepare("SELECT id FROM nodes WHERE id = ? AND trashed_at IS NULL AND kind = 'task'")
      .get(id)
  if (!exists(predId) || !exists(succId)) return { ok: false, reason: 'missing' }
  const dup = db
    .prepare('SELECT id FROM fb_task_deps WHERE pred_id = ? AND succ_id = ?')
    .get(predId, succId)
  if (dup) return { ok: false, reason: 'duplicate' }
  if (wouldCycle(predId, succId)) return { ok: false, reason: 'cycle' }
  const safeType: DepType = (['FS', 'SS', 'FF', 'SF'] as DepType[]).includes(type) ? type : 'FS'
  const safeLag = Number.isFinite(lag) ? Math.trunc(lag) : 0
  const id = randomUUID()
  db.prepare('INSERT INTO fb_task_deps (id, pred_id, succ_id, dep_type, lag_days, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    predId,
    succId,
    safeType,
    safeLag,
    Date.now()
  )
  return { ok: true, dep: { id, predId, succId, type: safeType, lag: safeLag } }
}

// Update an existing dependency's type and/or lag.
export function setDependency(predId: string, succId: string, type: DepType, lag: number): boolean {
  const db = getDb()
  const safeType: DepType = (['FS', 'SS', 'FF', 'SF'] as DepType[]).includes(type) ? type : 'FS'
  const safeLag = Number.isFinite(lag) ? Math.trunc(lag) : 0
  const res = db
    .prepare('UPDATE fb_task_deps SET dep_type = ?, lag_days = ? WHERE pred_id = ? AND succ_id = ?')
    .run(safeType, safeLag, predId, succId)
  return res.changes > 0
}

export function removeDependency(predId: string, succId: string): boolean {
  const db = getDb()
  const res = db.prepare('DELETE FROM fb_task_deps WHERE pred_id = ? AND succ_id = ?').run(predId, succId)
  return res.changes > 0
}

// Auto-reschedule: recompute the plan honouring actual finishes, then persist the
// shifted planned start/due dates back onto the tasks so the saved plan matches
// reality. Returns the freshly read plan. Milestones and untouched tasks keep
// their dates unless a slip pushes them.
export function rescheduleProject(projectId: string, nowMs = Date.now()): ProjectPlan {
  const db = getDb()
  const rows = projectTaskRows(projectId)
  const ids = new Set(rows.map((r) => r.id))
  const deps = projectDeps(ids)
  const anchor = planAnchor(rows, nowMs)
  const cal = loadProjectCalendar(projectId)
  const dayToMs = makeDayToMs(anchor, cal)
  const predsByTask = new Map<string, string[]>()
  const linksByTask = new Map<string, DepLink[]>()
  for (const d of deps) {
    predsByTask.set(d.succId, [...(predsByTask.get(d.succId) ?? []), d.predId])
    linksByTask.set(d.succId, [...(linksByTask.get(d.succId) ?? []), { id: d.predId, type: d.type, lag: d.lag }])
  }

  const inputs: GanttInput[] = rows.map((r) => ({
    id: r.id,
    durationDays: durationDays(r, cal),
    deps: predsByTask.get(r.id) ?? [],
    links: linksByTask.get(r.id),
    isMilestone: !!r.is_milestone,
    minStartDay: r.plan_start != null ? workingOffset(anchor, r.plan_start, cal) : undefined,
    mustStartDay: r.must_start != null ? workingOffset(anchor, r.must_start, cal) : undefined,
    deadlineDay: r.deadline != null ? workingOffset(anchor, r.deadline, cal) : undefined
  }))
  const actualFinish = new Map<string, number>()
  for (const r of rows) {
    if (r.completed_at != null) actualFinish.set(r.id, workingOffset(anchor, r.completed_at, cal))
  }

  const rescheduled = rescheduleOnDrift(inputs, anchor, actualFinish, dayToMs)
  const upd = db.prepare('UPDATE nodes SET plan_start = ?, due_date = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  const writeAll = db.transaction((tasks: typeof rescheduled.tasks) => {
    for (const s of tasks) {
      // Persist the new planned window. A milestone keeps a single instant.
      const params: Array<number | string> = [s.startMs, s.isMilestone ? s.startMs : s.endMs, now, s.id]
      upd.run(...params)
    }
  })
  writeAll(rescheduled.tasks)
  return getProjectPlan(projectId, nowMs)
}

// Greedy resource leveling: for each assignee, walk their tasks in scheduled-start
// order and push any that overlap the previous one so a person never works two
// tasks at once. Pins each shifted task's planned start (so it holds), preserving
// its duration. This is a simple serial level, not an optimiser: it ignores
// priority and may extend the finish date. Milestones, done tasks, the
// unassigned bucket, and tasks already pinned with a must-start are left alone.
export function levelResources(projectId: string, nowMs = Date.now()): ProjectPlan {
  const db = getDb()
  const plan = getProjectPlan(projectId, nowMs)
  const byAssignee = new Map<string, typeof plan.tasks>()
  for (const t of plan.tasks) {
    const done = t.status === 'done' || t.completedAt != null
    if (t.isMilestone || done || t.mustStartMs != null) continue
    const who = (t.assignee && t.assignee.trim()) || null
    if (!who) continue
    byAssignee.set(who, [...(byAssignee.get(who) ?? []), t])
  }
  const upd = db.prepare('UPDATE nodes SET plan_start = ?, due_date = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  const apply = db.transaction(() => {
    for (const tasks of byAssignee.values()) {
      const ordered = [...tasks].sort((a, b) => a.scheduledStartMs - b.scheduledStartMs)
      let cursor = -Infinity
      for (const t of ordered) {
        const durationMs = Math.max(DAY_MS, t.scheduledEndMs - t.scheduledStartMs)
        const start = Math.max(t.scheduledStartMs, cursor)
        if (start > t.scheduledStartMs) {
          // Pin the shifted task so leveling holds against a recompute.
          upd.run(start, start + durationMs, now, t.id)
        }
        cursor = start + durationMs
      }
    }
  })
  apply()
  return getProjectPlan(projectId, nowMs)
}

// Every folder explicitly marked as a Plan (is_plan = 1) that contains at least
// one task, with a rollup for the portfolio view. percentComplete is real,
// computed from task status. A plain Room (is_plan = 0) never shows here even if
// it holds desks — that is the Rooms/Desks/Plans decoupling. Existing folders
// with tasks were grandfathered to is_plan = 1 (see migratePlanFlag).
export function listProjectSummaries(nowMs = Date.now()): ProjectSummary[] {
  const db = getDb()
  const folders = db
    .prepare(
      `SELECT id, title FROM nodes WHERE kind = 'folder' AND is_plan = 1 AND trashed_at IS NULL AND archived = 0`
    )
    .all() as Array<{ id: string; title: string }>
  const out: ProjectSummary[] = []
  for (const f of folders) {
    const rows = projectTaskRows(f.id)
    if (rows.length === 0) continue
    const doneCount = rows.filter((r) => r.status === 'done' || r.completed_at != null).length
    const plan = getProjectPlan(f.id, nowMs)
    out.push({
      id: f.id,
      title: f.title,
      taskCount: rows.length,
      doneCount,
      percentComplete: Math.round((doneCount / rows.length) * 100),
      endMs: plan.tasks.length ? plan.projectEndMs : null,
      hasDrift: plan.drift.some((d) => d.pushesSuccessors),
      hasCycle: plan.hasCycle
    })
  }
  out.sort((a, b) => a.title.localeCompare(b.title))
  return out
}
