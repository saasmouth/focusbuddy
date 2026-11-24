// The AI Space project record store (SPEC-AI-SPACE.md §6 "Implement the shared
// project record").
//
// Factory style over the minimal SqlDb interface, so unit tests drive the same
// code through node:sqlite and the app drives it through better-sqlite3.
//
// Rules this store keeps, each with a test:
//  - Every mutation appends its activity event in the SAME transaction, so the
//    log and the records can never disagree (the "As of" view replays the log).
//  - Runs are keyed by an idempotency key: a reconnect or a duplicate event
//    that tries to create the same run gets the existing one back.
//  - Versions are immutable (DB triggers) and one run can add at most one
//    version per output (unique index): a duplicate completion adds nothing.
//  - A write against a version that is no longer the latest is refused with
//    the diff the person needs to review (StaleWriteError).
//  - Approving or publishing only ever moves a pointer; content never changes.
//  - Everything is read through an AccessContext; a record outside the
//    context's workspaces does not exist as far as the caller can tell.

import { createHash, randomUUID } from 'node:crypto'
import type { SqlDb } from '../db/eventStore'
import { ensureAiSpaceSchema } from './schema'
import type {
  AccessContext,
  AiAgent,
  AiBranch,
  AiDecision,
  AiMessage,
  AiOutput,
  AiProject,
  AiRun,
  AiSource,
  AiSpaceEvent,
  AiSpaceEventKind,
  AiSuggestion,
  AiTask,
  AiThread,
  AiWorkspace,
  AgentRole,
  ConnectionLevel,
  Evidence,
  InfoRequest,
  OutputKind,
  OutputVersion,
  ProjectAuthority,
  RecordRef,
  ReviewState,
  RunManifest,
  RunStatus,
  RunStep,
  SourceKind,
  SuggestionStatus,
  WorkspaceKind
} from '@shared/aispace/model'
import { DEFAULT_AUTHORITY, isTerminalRun } from '@shared/aispace/model'
import type { ProjectState } from '@shared/aispace/impact'

export class StaleWriteError extends Error {
  constructor(
    readonly outputId: string,
    readonly expectedVersionId: string | null,
    readonly currentVersionId: string | null,
    readonly currentContent: string
  ) {
    super('This output changed since you started. Review the newer version before saving.')
    this.name = 'StaleWriteError'
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found.`)
    this.name = 'NotFoundError'
  }
}

export interface StoreOptions {
  now?: () => number
  newId?: (prefix: string) => string
}

type Row = Record<string, unknown>

const j = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function hashContent(content: string, mediaRef: string | null = null): string {
  return createHash('sha256').update(content).update('\u0000').update(mediaRef ?? '').digest('hex')
}

export type AiSpaceStore = ReturnType<typeof createAiSpaceStore>

export function createAiSpaceStore(db: SqlDb, opts: StoreOptions = {}) {
  ensureAiSpaceSchema(db)
  const now = opts.now ?? (() => Date.now())
  const newId = opts.newId ?? ((p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`)
  const listeners = new Set<(e: AiSpaceEvent) => void>()
  // Events appended inside a transaction are delivered after it commits.
  let pending: AiSpaceEvent[] | null = null

  const run = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a)
  const get = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as Row | undefined
  const all = (sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as Row[]

  function tx<T>(fn: () => T): T {
    if (pending) return fn() // nested: the outer transaction delivers
    pending = []
    let delivered: AiSpaceEvent[] = []
    try {
      const r = db.transaction(fn)()
      delivered = pending
      return r
    } finally {
      pending = null
      for (const e of delivered) for (const l of listeners) {
        try {
          l(e)
        } catch {
          /* a listener's failure never undoes a committed write */
        }
      }
    }
  }

  // ── Row mappers ─────────────────────────────────────────────────────────────

  const toWorkspace = (r: Row): AiWorkspace => ({ id: String(r.id), kind: r.kind as WorkspaceKind, name: String(r.name), createdAt: Number(r.created_at) })

  const toProject = (r: Row): AiProject => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    deskId: str(r.desk_id),
    roomId: str(r.room_id),
    title: String(r.title),
    goal: String(r.goal ?? ''),
    briefOutputId: str(r.brief_output_id),
    authority: { ...DEFAULT_AUTHORITY, ...j<Partial<ProjectAuthority>>(r.authority_json, {}) },
    budgetLimitMinor: num(r.budget_limit_minor),
    budgetCurrency: String(r.budget_currency ?? 'USD'),
    defaultConnectionId: str(r.default_connection_id),
    defaultModel: str(r.default_model),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    archivedAt: num(r.archived_at)
  })

  const toTask = (r: Row, deps: string[]): AiTask => ({
    id: String(r.id),
    projectId: String(r.project_id),
    parentTaskId: str(r.parent_task_id),
    branchId: str(r.branch_id),
    title: String(r.title),
    outcome: String(r.outcome ?? ''),
    deliverableKind: (str(r.deliverable_kind) as OutputKind | null) ?? null,
    status: r.status as AiTask['status'],
    assignee: str(r.assignee),
    scheduledAt: num(r.scheduled_at),
    sortOrder: Number(r.sort_order),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    dependsOn: deps
  })

  const toAgent = (r: Row): AiAgent => ({
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    role: r.role as AgentRole,
    connectionId: str(r.connection_id),
    model: str(r.model),
    instructions: String(r.instructions ?? ''),
    createdAt: Number(r.created_at)
  })

  const toThread = (r: Row): AiThread => ({
    id: String(r.id),
    projectId: str(r.project_id),
    workspaceId: String(r.workspace_id),
    aiTaskId: str(r.ai_task_id),
    kind: r.kind as AiThread['kind'],
    title: String(r.title),
    level: r.level as ConnectionLevel,
    provider: str(r.provider),
    originalUrl: str(r.original_url),
    capturedAt: num(r.captured_at),
    createdAt: Number(r.created_at)
  })

  const toMessage = (r: Row): AiMessage => ({
    id: String(r.id),
    threadId: String(r.thread_id),
    role: r.role as AiMessage['role'],
    author: String(r.author),
    text: String(r.text),
    refs: j<RecordRef[]>(r.refs_json, []),
    runId: str(r.run_id),
    createdAt: Number(r.created_at)
  })

  const toRun = (r: Row): AiRun => ({
    id: String(r.id),
    projectId: String(r.project_id),
    aiTaskId: str(r.ai_task_id),
    threadId: str(r.thread_id),
    agentId: str(r.agent_id),
    branchId: str(r.branch_id),
    kind: r.kind as AiRun['kind'],
    status: r.status as RunStatus,
    statusDetail: String(r.status_detail ?? ''),
    manifest: j<RunManifest>(r.manifest_json, emptyManifest()),
    idempotencyKey: String(r.idempotency_key),
    externalId: str(r.external_id),
    lastConfirmedStep: String(r.last_confirmed_step ?? ''),
    lastConfirmedAt: num(r.last_confirmed_at),
    handoverOf: str(r.handover_of),
    attempt: Number(r.attempt ?? 1),
    createdAt: Number(r.created_at),
    startedAt: num(r.started_at),
    endedAt: num(r.ended_at)
  })

  const toOutput = (r: Row): AiOutput => ({
    id: String(r.id),
    projectId: String(r.project_id),
    aiTaskId: str(r.ai_task_id),
    branchId: str(r.branch_id),
    kind: r.kind as OutputKind,
    role: (r.role as AiOutput['role']) ?? 'deliverable',
    title: String(r.title),
    latestVersionId: str(r.latest_version_id),
    approvedVersionId: str(r.approved_version_id),
    publishedVersionId: str(r.published_version_id),
    domain: str(r.domain),
    reviewState: r.review_state as ReviewState,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  })

  const toVersion = (r: Row): OutputVersion => ({
    id: String(r.id),
    outputId: String(r.output_id),
    n: Number(r.n),
    parentVersionId: str(r.parent_version_id),
    branchId: str(r.branch_id),
    author: String(r.author),
    runId: str(r.run_id),
    content: String(r.content),
    mediaRef: str(r.media_ref),
    mediaWidth: num(r.media_width),
    mediaHeight: num(r.media_height),
    contentHash: String(r.content_hash),
    changeSummary: String(r.change_summary ?? ''),
    sources: j<RecordRef[]>(r.sources_json, []),
    createdAt: Number(r.created_at)
  })

  const toDecision = (r: Row): AiDecision => ({
    id: String(r.id),
    projectId: String(r.project_id),
    topic: String(r.topic),
    title: String(r.title),
    value: String(r.value),
    previousValue: str(r.previous_value),
    status: r.status as AiDecision['status'],
    dueAt: num(r.due_at),
    evidence: j<RecordRef[]>(r.evidence_json, []),
    decidedBy: str(r.decided_by),
    decidedAt: num(r.decided_at),
    supersedes: str(r.supersedes),
    createdAt: Number(r.created_at)
  })

  const toSource = (r: Row): AiSource => ({
    id: String(r.id),
    projectId: str(r.project_id),
    workspaceId: String(r.workspace_id),
    kind: r.kind as SourceKind,
    title: String(r.title),
    url: str(r.url),
    content: String(r.content ?? ''),
    trusted: false,
    provider: str(r.provider),
    connectionId: str(r.connection_id),
    runId: str(r.run_id),
    originalLocation: str(r.original_location),
    capturedAt: Number(r.captured_at),
    createdAt: Number(r.created_at)
  })

  const toRequest = (r: Row): InfoRequest => ({
    id: String(r.id),
    projectId: String(r.project_id),
    aiTaskId: str(r.ai_task_id),
    requestedBy: String(r.requested_by),
    recipient: String(r.recipient),
    question: String(r.question),
    topics: j<string[]>(r.topics_json, []),
    canProceed: String(r.can_proceed ?? ''),
    status: r.status as InfoRequest['status'],
    suppliedSourceId: str(r.supplied_source_id),
    deliveredAt: num(r.delivered_at),
    createdAt: Number(r.created_at)
  })

  const toSuggestion = (r: Row): AiSuggestion => ({
    id: String(r.id),
    projectId: String(r.project_id),
    fromActor: String(r.from_actor),
    recipient: String(r.recipient),
    target: j<RecordRef>(r.target_json, { type: 'output', id: '' }),
    targetVersionId: str(r.target_version_id),
    evidence: j<Evidence[]>(r.evidence_json, []),
    proposedAction: String(r.proposed_action),
    status: r.status as SuggestionStatus,
    dedupeKey: String(r.dedupe_key),
    sourceEventId: str(r.source_event_id),
    createdAt: Number(r.created_at),
    resolvedAt: num(r.resolved_at)
  })

  const toBranch = (r: Row): AiBranch => ({
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    snapshot: j<AiBranch['snapshot']>(r.snapshot_json, { briefVersionId: null, outputVersions: {} }),
    status: r.status as AiBranch['status'],
    createdAt: Number(r.created_at)
  })

  const toEvent = (r: Row): AiSpaceEvent => ({
    seq: Number(r.seq),
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    projectId: str(r.project_id),
    actor: String(r.actor),
    kind: r.kind as AiSpaceEventKind,
    subject: j<RecordRef | null>(r.subject_json, null),
    refs: j<RecordRef[]>(r.refs_json, []),
    summary: String(r.summary ?? ''),
    data: j<Record<string, unknown>>(r.data_json, {}),
    visibility: (r.visibility as AiSpaceEvent['visibility']) ?? 'project',
    at: Number(r.at)
  })

  // ── Events ──────────────────────────────────────────────────────────────────

  interface EventInput {
    workspaceId: string
    projectId: string | null
    actor: string
    kind: AiSpaceEventKind
    subject: RecordRef | null
    refs?: RecordRef[]
    summary: string
    data?: Record<string, unknown>
    visibility?: AiSpaceEvent['visibility']
    at?: number
  }

  function appendEvent(e: EventInput): AiSpaceEvent {
    const id = newId('evt')
    const at = e.at ?? now()
    run(
      `INSERT INTO ais_events (id, workspace_id, project_id, actor, kind, subject_json, refs_json, summary, data_json, visibility, at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      e.workspaceId,
      e.projectId,
      e.actor,
      e.kind,
      e.subject ? JSON.stringify(e.subject) : null,
      JSON.stringify(e.refs ?? []),
      e.summary,
      JSON.stringify(e.data ?? {}),
      e.visibility ?? 'project',
      at
    )
    const ev = toEvent(get(`SELECT * FROM ais_events WHERE id = ?`, id)!)
    if (pending) pending.push(ev)
    else for (const l of listeners) l(ev)
    return ev
  }

  function wsOfProject(projectId: string): string {
    const r = get(`SELECT workspace_id FROM ais_projects WHERE id = ?`, projectId)
    if (!r) throw new NotFoundError('Project')
    return String(r.workspace_id)
  }

  const inCtx = (ctx: AccessContext) => ctx.workspaceIds.map(() => '?').join(',') || "''"

  // ── Workspaces ──────────────────────────────────────────────────────────────

  function ensureDefaultWorkspaces(): AiWorkspace[] {
    const rows = all(`SELECT * FROM ais_workspaces ORDER BY created_at`)
    if (rows.length > 0) return rows.map(toWorkspace)
    const id = newId('ws')
    run(`INSERT INTO ais_workspaces (id, kind, name, created_at) VALUES (?,?,?,?)`, id, 'personal', 'Personal', now())
    return all(`SELECT * FROM ais_workspaces ORDER BY created_at`).map(toWorkspace)
  }

  function createWorkspace(kind: WorkspaceKind, name: string): AiWorkspace {
    const id = newId('ws')
    run(`INSERT INTO ais_workspaces (id, kind, name, created_at) VALUES (?,?,?,?)`, id, kind, name.trim() || (kind === 'work' ? 'Work' : 'Personal'), now())
    return toWorkspace(get(`SELECT * FROM ais_workspaces WHERE id = ?`, id)!)
  }

  function listWorkspaces(): AiWorkspace[] {
    return all(`SELECT * FROM ais_workspaces ORDER BY created_at`).map(toWorkspace)
  }

  function renameWorkspace(id: string, name: string): void {
    run(`UPDATE ais_workspaces SET name = ? WHERE id = ?`, name.trim(), id)
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  interface CreateProjectInput {
    workspaceId: string
    title: string
    goal?: string
    deskId?: string | null
    roomId?: string | null
    brief?: string
    actor?: string
  }

  function createProject(input: CreateProjectInput): AiProject {
    return tx(() => {
      const id = newId('prj')
      const t = now()
      const actor = input.actor ?? 'user:me'
      if (input.deskId) {
        const existing = get(`SELECT id FROM ais_projects WHERE desk_id = ? AND archived_at IS NULL`, input.deskId)
        if (existing) throw new Error('This Desk already has a project.')
      }
      run(
        `INSERT INTO ais_projects (id, workspace_id, desk_id, room_id, title, goal, authority_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        input.workspaceId,
        input.deskId ?? null,
        input.roomId ?? null,
        input.title.trim() || 'Untitled project',
        input.goal ?? '',
        JSON.stringify(DEFAULT_AUTHORITY),
        t,
        t
      )
      appendEvent({ workspaceId: input.workspaceId, projectId: id, actor, kind: 'project.created', subject: { type: 'project', id }, summary: `Project “${input.title}” started.` })
      // The brief is an output so every change to it is a version runs can cite.
      // Every project has a Project Manager (§3); it uses the project default connection.
      createAgent({ projectId: id, name: 'Project Manager', role: 'manager', instructions: 'You coordinate this project: explain what changed, what it affects and what would help most. Cite the records you rely on.' })
      const brief = createOutput({ projectId: id, kind: 'document', title: 'Project brief', role: 'brief', actor })
      run(`UPDATE ais_projects SET brief_output_id = ? WHERE id = ?`, brief.id, id)
      if (input.brief && input.brief.trim()) {
        const v = addVersion({ outputId: brief.id, content: input.brief, author: actor, changeSummary: 'First brief.' })
        approveVersion(brief.id, v.id, actor)
      }
      return getProject(id)!
    })
  }

  function getProject(id: string): AiProject | null {
    const r = get(`SELECT * FROM ais_projects WHERE id = ?`, id)
    return r ? toProject(r) : null
  }

  function getProjectInCtx(ctx: AccessContext, id: string): AiProject | null {
    const p = getProject(id)
    return p && ctx.workspaceIds.includes(p.workspaceId) ? p : null
  }

  function listProjects(ctx: AccessContext, opts: { includeArchived?: boolean } = {}): AiProject[] {
    if (ctx.workspaceIds.length === 0) return []
    return all(
      `SELECT * FROM ais_projects WHERE workspace_id IN (${inCtx(ctx)}) ${opts.includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC`,
      ...ctx.workspaceIds
    ).map(toProject)
  }

  function projectForDesk(deskId: string): AiProject | null {
    const r = get(`SELECT * FROM ais_projects WHERE desk_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, deskId)
    return r ? toProject(r) : null
  }

  function updateProject(
    id: string,
    patch: Partial<Pick<AiProject, 'title' | 'goal' | 'deskId' | 'roomId' | 'budgetLimitMinor' | 'budgetCurrency' | 'authority' | 'defaultConnectionId' | 'defaultModel'>>,
    actor = 'user:me'
  ): AiProject {
    return tx(() => {
      const p = getProject(id)
      if (!p) throw new NotFoundError('Project')
      const next = { ...p, ...patch }
      run(
        `UPDATE ais_projects SET title = ?, goal = ?, desk_id = ?, room_id = ?, budget_limit_minor = ?, budget_currency = ?, authority_json = ?, default_connection_id = ?, default_model = ?, updated_at = ? WHERE id = ?`,
        next.title,
        next.goal,
        next.deskId,
        next.roomId,
        next.budgetLimitMinor,
        next.budgetCurrency,
        JSON.stringify(next.authority),
        next.defaultConnectionId,
        next.defaultModel,
        now(),
        id
      )
      appendEvent({ workspaceId: p.workspaceId, projectId: id, actor, kind: 'project.updated', subject: { type: 'project', id }, summary: `Project details updated.`, data: { fields: Object.keys(patch) } })
      return getProject(id)!
    })
  }

  function archiveProject(id: string, actor = 'user:me'): void {
    tx(() => {
      const p = getProject(id)
      if (!p) throw new NotFoundError('Project')
      run(`UPDATE ais_projects SET archived_at = ?, updated_at = ? WHERE id = ?`, now(), now(), id)
      appendEvent({ workspaceId: p.workspaceId, projectId: id, actor, kind: 'project.updated', subject: { type: 'project', id }, summary: 'Project archived.', data: { archived: true } })
    })
  }

  function touchProject(id: string): void {
    run(`UPDATE ais_projects SET updated_at = ? WHERE id = ?`, now(), id)
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────

  function depsOf(taskId: string): string[] {
    return all(`SELECT depends_on FROM ais_task_deps WHERE ai_task_id = ? ORDER BY depends_on`, taskId).map((r) => String(r.depends_on))
  }

  function getTask(id: string): AiTask | null {
    const r = get(`SELECT * FROM ais_tasks WHERE id = ?`, id)
    return r ? toTask(r, depsOf(id)) : null
  }

  interface CreateTaskInput {
    projectId: string
    title: string
    outcome?: string
    deliverableKind?: OutputKind | null
    assignee?: string | null
    parentTaskId?: string | null
    scheduledAt?: number | null
    branchId?: string | null
    dependsOn?: string[]
    actor?: string
  }

  function createTask(input: CreateTaskInput): AiTask {
    return tx(() => {
      const ws = wsOfProject(input.projectId)
      const id = newId('tsk')
      const t = now()
      const max = get(`SELECT MAX(sort_order) AS m FROM ais_tasks WHERE project_id = ?`, input.projectId)
      run(
        `INSERT INTO ais_tasks (id, project_id, parent_task_id, branch_id, title, outcome, deliverable_kind, status, assignee, scheduled_at, sort_order, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.parentTaskId ?? null,
        input.branchId ?? null,
        input.title.trim() || 'Untitled task',
        input.outcome ?? '',
        input.deliverableKind ?? null,
        'todo',
        input.assignee ?? null,
        input.scheduledAt ?? null,
        (num(max?.m) ?? 0) + 1,
        t,
        t
      )
      for (const d of input.dependsOn ?? []) addDependency(id, d)
      appendEvent({ workspaceId: ws, projectId: input.projectId, actor: input.actor ?? 'user:me', kind: 'task.created', subject: { type: 'task', id, label: input.title }, summary: `Task “${input.title}” added.` })
      touchProject(input.projectId)
      return getTask(id)!
    })
  }

  function addDependency(taskId: string, dependsOn: string): void {
    if (taskId === dependsOn) throw new Error('A task can’t depend on itself.')
    // Refuse a cycle: walk dependsOn's own dependencies.
    const seen = new Set<string>()
    const stack = [dependsOn]
    while (stack.length) {
      const cur = stack.pop()!
      if (cur === taskId) throw new Error('That would make the tasks wait on each other.')
      if (seen.has(cur)) continue
      seen.add(cur)
      stack.push(...depsOf(cur))
    }
    run(`INSERT OR IGNORE INTO ais_task_deps (ai_task_id, depends_on) VALUES (?,?)`, taskId, dependsOn)
  }

  function setDependencies(taskId: string, dependsOn: string[], actor = 'user:me'): AiTask {
    return tx(() => {
      const task = getTask(taskId)
      if (!task) throw new NotFoundError('Task')
      run(`DELETE FROM ais_task_deps WHERE ai_task_id = ?`, taskId)
      for (const d of dependsOn) addDependency(taskId, d)
      appendEvent({ workspaceId: wsOfProject(task.projectId), projectId: task.projectId, actor, kind: 'task.updated', subject: { type: 'task', id: taskId, label: task.title }, summary: `Dependencies changed for “${task.title}”.`, data: { dependsOn } })
      return getTask(taskId)!
    })
  }

  function updateTask(
    id: string,
    patch: Partial<Pick<AiTask, 'title' | 'outcome' | 'deliverableKind' | 'status' | 'assignee' | 'scheduledAt' | 'sortOrder' | 'parentTaskId'>>,
    actor = 'user:me'
  ): AiTask {
    return tx(() => {
      const task = getTask(id)
      if (!task) throw new NotFoundError('Task')
      const next = { ...task, ...patch }
      run(
        `UPDATE ais_tasks SET title = ?, outcome = ?, deliverable_kind = ?, status = ?, assignee = ?, scheduled_at = ?, sort_order = ?, parent_task_id = ?, updated_at = ? WHERE id = ?`,
        next.title,
        next.outcome,
        next.deliverableKind,
        next.status,
        next.assignee,
        next.scheduledAt,
        next.sortOrder,
        next.parentTaskId,
        now(),
        id
      )
      const ws = wsOfProject(task.projectId)
      if (patch.status && patch.status !== task.status) {
        appendEvent({ workspaceId: ws, projectId: task.projectId, actor, kind: 'task.status_changed', subject: { type: 'task', id, label: next.title }, summary: `“${next.title}” is now ${patch.status.replace('_', ' ')}.`, data: { from: task.status, to: patch.status } })
      } else {
        appendEvent({ workspaceId: ws, projectId: task.projectId, actor, kind: 'task.updated', subject: { type: 'task', id, label: next.title }, summary: `“${next.title}” updated.`, data: { fields: Object.keys(patch) } })
      }
      touchProject(task.projectId)
      return getTask(id)!
    })
  }

  function listTasks(projectId: string): AiTask[] {
    const deps = new Map<string, string[]>()
    for (const r of all(`SELECT d.ai_task_id, d.depends_on FROM ais_task_deps d JOIN ais_tasks t ON t.id = d.ai_task_id WHERE t.project_id = ?`, projectId)) {
      const k = String(r.ai_task_id)
      deps.set(k, [...(deps.get(k) ?? []), String(r.depends_on)])
    }
    return all(`SELECT * FROM ais_tasks WHERE project_id = ? ORDER BY sort_order, created_at`, projectId).map((r) => toTask(r, deps.get(String(r.id)) ?? []))
  }

  // ── Agents ──────────────────────────────────────────────────────────────────

  function createAgent(input: { projectId: string; name: string; role: AgentRole; connectionId?: string | null; model?: string | null; instructions?: string }): AiAgent {
    const id = newId('agt')
    run(
      `INSERT INTO ais_agents (id, project_id, name, role, connection_id, model, instructions, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      id,
      input.projectId,
      input.name.trim() || 'Agent',
      input.role,
      input.connectionId ?? null,
      input.model ?? null,
      input.instructions ?? '',
      now()
    )
    return toAgent(get(`SELECT * FROM ais_agents WHERE id = ?`, id)!)
  }

  function updateAgent(id: string, patch: Partial<Pick<AiAgent, 'name' | 'role' | 'connectionId' | 'model' | 'instructions'>>): AiAgent {
    const a = getAgent(id)
    if (!a) throw new NotFoundError('Agent')
    const n = { ...a, ...patch }
    run(`UPDATE ais_agents SET name = ?, role = ?, connection_id = ?, model = ?, instructions = ? WHERE id = ?`, n.name, n.role, n.connectionId, n.model, n.instructions, id)
    return getAgent(id)!
  }

  function getAgent(id: string): AiAgent | null {
    const r = get(`SELECT * FROM ais_agents WHERE id = ?`, id)
    return r ? toAgent(r) : null
  }

  function listAgents(projectId: string): AiAgent[] {
    return all(`SELECT * FROM ais_agents WHERE project_id = ? ORDER BY created_at`, projectId).map(toAgent)
  }

  // ── Threads, messages, captures ─────────────────────────────────────────────

  function createThread(input: { projectId: string | null; workspaceId: string; kind: AiThread['kind']; title: string; level: ConnectionLevel; provider?: string | null; originalUrl?: string | null; capturedAt?: number | null; aiTaskId?: string | null }): AiThread {
    const id = newId('thr')
    run(
      `INSERT INTO ais_threads (id, project_id, workspace_id, ai_task_id, kind, title, level, provider, original_url, captured_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.projectId,
      input.workspaceId,
      input.aiTaskId ?? null,
      input.kind,
      input.title,
      input.level,
      input.provider ?? null,
      input.originalUrl ?? null,
      input.capturedAt ?? null,
      now()
    )
    return toThread(get(`SELECT * FROM ais_threads WHERE id = ?`, id)!)
  }

  function managerThread(projectId: string): AiThread {
    const r = get(`SELECT * FROM ais_threads WHERE project_id = ? AND kind = 'manager' ORDER BY created_at LIMIT 1`, projectId)
    if (r) return toThread(r)
    return createThread({ projectId, workspaceId: wsOfProject(projectId), kind: 'manager', title: 'Project Manager', level: 'native' })
  }

  function getThread(id: string): AiThread | null {
    const r = get(`SELECT * FROM ais_threads WHERE id = ?`, id)
    return r ? toThread(r) : null
  }

  function listThreads(ctx: AccessContext, projectId: string | null): AiThread[] {
    if (ctx.workspaceIds.length === 0) return []
    if (projectId === null) {
      return all(`SELECT * FROM ais_threads WHERE project_id IS NULL AND workspace_id IN (${inCtx(ctx)}) ORDER BY created_at DESC`, ...ctx.workspaceIds).map(toThread)
    }
    return all(`SELECT * FROM ais_threads WHERE project_id = ? AND workspace_id IN (${inCtx(ctx)}) ORDER BY created_at DESC`, projectId, ...ctx.workspaceIds).map(toThread)
  }

  function addMessage(input: { threadId: string; role: AiMessage['role']; author: string; text: string; refs?: RecordRef[]; runId?: string | null }): AiMessage {
    return tx(() => {
      const th = getThread(input.threadId)
      if (!th) throw new NotFoundError('Thread')
      const id = newId('msg')
      run(
        `INSERT INTO ais_messages (id, thread_id, role, author, text, refs_json, run_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        id,
        input.threadId,
        input.role,
        input.author,
        input.text,
        JSON.stringify(input.refs ?? []),
        input.runId ?? null,
        now()
      )
      if (input.role === 'user' || input.role === 'agent') {
        appendEvent({ workspaceId: th.workspaceId, projectId: th.projectId, actor: input.author, kind: 'message.posted', subject: { type: 'message', id }, refs: [{ type: 'thread', id: th.id, label: th.title }], summary: firstLine(input.text, 120), visibility: 'project' })
      }
      return toMessage(get(`SELECT * FROM ais_messages WHERE id = ?`, id)!)
    })
  }

  function listMessages(threadId: string, limit = 200): AiMessage[] {
    return all(`SELECT * FROM (SELECT * FROM ais_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rowid`, threadId, limit).map(toMessage)
  }

  // Start and capture (§1): a pasted link becomes a Linked thread; selected
  // content becomes an Imported thread with a dated snapshot source. Original
  // location and capture time are kept. Imported text is material only.
  function captureChat(input: { workspaceId: string; projectId: string | null; url: string | null; title: string; provider: string | null; selectedText?: string | null; actor?: string }): { thread: AiThread; source: AiSource | null } {
    return tx(() => {
      const t = now()
      const imported = Boolean(input.selectedText && input.selectedText.trim())
      const thread = createThread({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        kind: 'capture',
        title: input.title.trim() || (input.url ?? 'Captured chat'),
        level: imported ? 'imported' : 'linked',
        provider: input.provider,
        originalUrl: input.url,
        capturedAt: t
      })
      let source: AiSource | null = null
      if (imported) {
        source = addSource({
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          kind: 'import',
          title: thread.title,
          url: input.url,
          content: input.selectedText!,
          provider: input.provider,
          originalLocation: input.url,
          capturedAt: t,
          actor: input.actor
        })
        addMessage({ threadId: thread.id, role: 'system', author: 'system', text: input.selectedText!, refs: [{ type: 'source', id: source.id }] })
      }
      appendEvent({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: input.actor ?? 'user:me',
        kind: 'thread.captured',
        subject: { type: 'thread', id: thread.id, label: thread.title },
        refs: source ? [{ type: 'source', id: source.id }] : [],
        summary: imported ? `Imported from ${input.provider ?? 'a chat'}: “${thread.title}”.` : `Linked a ${input.provider ?? ''} chat: “${thread.title}”.`.replace('  ', ' '),
        data: { level: thread.level, url: input.url }
      })
      return { thread, source }
    })
  }

  function fileThread(threadId: string, projectId: string, actor = 'user:me'): AiThread {
    return tx(() => {
      const th = getThread(threadId)
      if (!th) throw new NotFoundError('Thread')
      const ws = wsOfProject(projectId)
      if (ws !== th.workspaceId) throw new Error('That project is in another workspace.')
      run(`UPDATE ais_threads SET project_id = ? WHERE id = ?`, projectId, threadId)
      run(`UPDATE ais_sources SET project_id = ? WHERE id IN (SELECT json_extract(value, '$.id') FROM ais_messages, json_each(ais_messages.refs_json) WHERE ais_messages.thread_id = ?)`, projectId, threadId)
      appendEvent({ workspaceId: ws, projectId, actor, kind: 'thread.captured', subject: { type: 'thread', id: threadId, label: th.title }, summary: `Filed “${th.title}” into this project.`, data: { filed: true, from: th.projectId } })
      return getThread(threadId)!
    })
  }

  // Undo for filing: the capture goes back to the inbox, history kept.
  function unfileThread(threadId: string, actor = 'user:me'): AiThread {
    return tx(() => {
      const th = getThread(threadId)
      if (!th || !th.projectId) throw new NotFoundError('Filed chat')
      run(`UPDATE ais_threads SET project_id = NULL WHERE id = ?`, threadId)
      appendEvent({ workspaceId: th.workspaceId, projectId: th.projectId, actor, kind: 'thread.captured', subject: { type: 'thread', id: threadId, label: th.title }, summary: `Moved “${th.title}” back to the inbox.`, data: { unfiled: true } })
      return getThread(threadId)!
    })
  }

  // ── Runs ────────────────────────────────────────────────────────────────────

  interface CreateRunInput {
    projectId: string
    kind: AiRun['kind']
    manifest: RunManifest
    idempotencyKey: string
    aiTaskId?: string | null
    threadId?: string | null
    agentId?: string | null
    branchId?: string | null
    handoverOf?: string | null
    actor?: string
    status?: RunStatus
  }

  // Returns the EXISTING run when the idempotency key was seen before, so a
  // reconnect or a duplicate event never creates a second run.
  function createRun(input: CreateRunInput): { run: AiRun; created: boolean } {
    return tx(() => {
      const existing = get(`SELECT * FROM ais_runs WHERE idempotency_key = ?`, input.idempotencyKey)
      if (existing) return { run: toRun(existing), created: false }
      const ws = wsOfProject(input.projectId)
      const id = newId('run')
      const t = now()
      const prior = input.handoverOf ? getRun(input.handoverOf) : null
      run(
        `INSERT INTO ais_runs (id, project_id, ai_task_id, thread_id, agent_id, branch_id, kind, status, manifest_json, idempotency_key, handover_of, attempt, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.aiTaskId ?? null,
        input.threadId ?? null,
        input.agentId ?? null,
        input.branchId ?? null,
        input.kind,
        input.status ?? 'queued',
        JSON.stringify(input.manifest),
        input.idempotencyKey,
        input.handoverOf ?? null,
        prior ? prior.attempt + 1 : 1,
        t
      )
      appendEvent({
        workspaceId: ws,
        projectId: input.projectId,
        actor: input.actor ?? 'user:me',
        kind: 'run.queued',
        subject: { type: 'run', id },
        refs: input.manifest.inputs,
        summary: `Run queued${input.manifest.connectionAlias ? ` on ${input.manifest.connectionAlias}` : ''}.`,
        data: { connectionId: input.manifest.connectionId, model: input.manifest.model, handoverOf: input.handoverOf ?? null }
      })
      touchProject(input.projectId)
      return { run: getRun(id)!, created: true }
    })
  }

  function getRun(id: string): AiRun | null {
    const r = get(`SELECT * FROM ais_runs WHERE id = ?`, id)
    return r ? toRun(r) : null
  }

  function listRuns(ctx: AccessContext, opts: { projectId?: string; statuses?: RunStatus[]; limit?: number } = {}): AiRun[] {
    if (ctx.workspaceIds.length === 0) return []
    const where: string[] = [`p.workspace_id IN (${inCtx(ctx)})`]
    const args: unknown[] = [...ctx.workspaceIds]
    if (opts.projectId) {
      where.push('r.project_id = ?')
      args.push(opts.projectId)
    }
    if (opts.statuses && opts.statuses.length) {
      where.push(`r.status IN (${opts.statuses.map(() => '?').join(',')})`)
      args.push(...opts.statuses)
    }
    args.push(opts.limit ?? 200)
    return all(`SELECT r.* FROM ais_runs r JOIN ais_projects p ON p.id = r.project_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`, ...args).map(toRun)
  }

  const STATUS_EVENT: Record<RunStatus, AiSpaceEventKind> = {
    queued: 'run.queued',
    running: 'run.started',
    waiting: 'run.step',
    succeeded: 'run.succeeded',
    failed: 'run.failed',
    cancelled: 'run.cancelled',
    unavailable: 'run.unavailable'
  }

  function setRunStatus(
    id: string,
    status: RunStatus,
    detail: string,
    extra: { externalId?: string | null; lastConfirmedStep?: string; interrupted?: boolean; manifest?: RunManifest; actor?: string } = {}
  ): AiRun {
    return tx(() => {
      const r = getRun(id)
      if (!r) throw new NotFoundError('Run')
      // A terminal run stays terminal; a late duplicate event changes nothing.
      if (isTerminalRun(r.status) && r.status !== status) return r
      if (r.status === status && !extra.lastConfirmedStep && !extra.externalId && !extra.manifest) return r
      const t = now()
      run(
        `UPDATE ais_runs SET status = ?, status_detail = ?, external_id = COALESCE(?, external_id), last_confirmed_step = COALESCE(?, last_confirmed_step),
           last_confirmed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE last_confirmed_at END,
           started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
           ended_at = CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ? ELSE ended_at END,
           manifest_json = COALESCE(?, manifest_json)
         WHERE id = ?`,
        status,
        detail,
        extra.externalId ?? null,
        extra.lastConfirmedStep ?? null,
        extra.lastConfirmedStep ?? null,
        t,
        status,
        t,
        status,
        t,
        extra.manifest ? JSON.stringify(extra.manifest) : null,
        id
      )
      if (r.status !== status) {
        appendEvent({
          workspaceId: wsOfProject(r.projectId),
          projectId: r.projectId,
          actor: extra.actor ?? (r.agentId ? `agent:${r.agentId}` : 'system'),
          kind: extra.interrupted ? 'run.interrupted' : STATUS_EVENT[status],
          subject: { type: 'run', id },
          summary: detail || `Run ${status}.`,
          data: { from: r.status, to: status, externalId: extra.externalId ?? r.externalId }
        })
      }
      touchProject(r.projectId)
      return getRun(id)!
    })
  }

  function addRunStep(runId: string, kind: RunStep['kind'], text: string): RunStep {
    const r = get(`SELECT COALESCE(MAX(seq), 0) AS m FROM ais_run_steps WHERE run_id = ?`, runId)
    const seq = Number(r?.m ?? 0) + 1
    const at = now()
    run(`INSERT INTO ais_run_steps (run_id, seq, kind, text, at) VALUES (?,?,?,?,?)`, runId, seq, kind, text, at)
    if (kind === 'progress' || kind === 'output') run(`UPDATE ais_runs SET last_confirmed_step = ?, last_confirmed_at = ? WHERE id = ?`, text, at, runId)
    return { runId, seq, kind, text, at }
  }

  function listRunSteps(runId: string): RunStep[] {
    return all(`SELECT * FROM ais_run_steps WHERE run_id = ? ORDER BY seq`, runId).map((r) => ({ runId: String(r.run_id), seq: Number(r.seq), kind: r.kind as RunStep['kind'], text: String(r.text), at: Number(r.at) }))
  }

  function updateRunManifest(id: string, manifest: RunManifest, actor = 'user:me', summary = 'Run inputs updated.'): AiRun {
    return tx(() => {
      const r = getRun(id)
      if (!r) throw new NotFoundError('Run')
      if (isTerminalRun(r.status) || r.status === 'running') throw new Error('Only a run that hasn’t started can change its inputs.')
      run(`UPDATE ais_runs SET manifest_json = ? WHERE id = ?`, JSON.stringify(manifest), id)
      appendEvent({ workspaceId: wsOfProject(r.projectId), projectId: r.projectId, actor, kind: 'run.step', subject: { type: 'run', id }, refs: manifest.inputs, summary, data: { manifestUpdated: true } })
      return getRun(id)!
    })
  }

  // ── Outputs and versions ────────────────────────────────────────────────────

  function createOutput(input: { projectId: string; kind: OutputKind; title: string; aiTaskId?: string | null; role?: AiOutput['role']; branchId?: string | null; domain?: string | null; actor?: string }): AiOutput {
    return tx(() => {
      const ws = wsOfProject(input.projectId)
      const id = newId('out')
      const t = now()
      run(
        `INSERT INTO ais_outputs (id, project_id, ai_task_id, branch_id, kind, role, title, domain, review_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.aiTaskId ?? null,
        input.branchId ?? null,
        input.kind,
        input.role ?? 'deliverable',
        input.title.trim() || 'Untitled',
        input.domain ?? null,
        'draft',
        t,
        t
      )
      appendEvent({ workspaceId: ws, projectId: input.projectId, actor: input.actor ?? 'user:me', kind: 'output.created', subject: { type: 'output', id, label: input.title }, summary: `“${input.title}” added to ${input.kind}s.` })
      return getOutput(id)!
    })
  }

  function getOutput(id: string): AiOutput | null {
    const r = get(`SELECT * FROM ais_outputs WHERE id = ?`, id)
    return r ? toOutput(r) : null
  }

  function listOutputs(projectId: string, opts: { kind?: OutputKind; includeBrief?: boolean; branchId?: string | null } = {}): AiOutput[] {
    const where = ['project_id = ?']
    const args: unknown[] = [projectId]
    if (opts.kind) {
      where.push('kind = ?')
      args.push(opts.kind)
    }
    if (!opts.includeBrief) where.push(`role != 'brief'`)
    if (opts.branchId !== undefined) {
      if (opts.branchId === null) where.push('branch_id IS NULL')
      else {
        where.push('branch_id = ?')
        args.push(opts.branchId)
      }
    }
    return all(`SELECT * FROM ais_outputs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, ...args).map(toOutput)
  }

  function getVersion(id: string): OutputVersion | null {
    const r = get(`SELECT * FROM ais_versions WHERE id = ?`, id)
    return r ? toVersion(r) : null
  }

  function listVersions(outputId: string): OutputVersion[] {
    return all(`SELECT * FROM ais_versions WHERE output_id = ? ORDER BY n`, outputId).map(toVersion)
  }

  interface AddVersionInput {
    outputId: string
    content: string
    author: string
    runId?: string | null
    sources?: RecordRef[]
    changeSummary?: string
    mediaRef?: string | null
    mediaWidth?: number | null
    mediaHeight?: number | null
    branchId?: string | null
    // Stale-write guard: the version the writer started from. When the output
    // has moved on since, the write is refused with what changed.
    expectedParentVersionId?: string | null
  }

  function addVersion(input: AddVersionInput): OutputVersion {
    return tx(() => {
      const out = getOutput(input.outputId)
      if (!out) throw new NotFoundError('Output')
      if (input.runId) {
        const dup = get(`SELECT * FROM ais_versions WHERE run_id = ? AND output_id = ?`, input.runId, input.outputId)
        if (dup) return toVersion(dup)
      }
      if (input.expectedParentVersionId !== undefined && input.expectedParentVersionId !== out.latestVersionId) {
        const cur = out.latestVersionId ? getVersion(out.latestVersionId) : null
        throw new StaleWriteError(out.id, input.expectedParentVersionId, out.latestVersionId, cur?.content ?? '')
      }
      const id = newId('ver')
      const t = now()
      const nRow = get(`SELECT COALESCE(MAX(n), 0) AS m FROM ais_versions WHERE output_id = ?`, out.id)
      const n = Number(nRow?.m ?? 0) + 1
      const parent = input.expectedParentVersionId !== undefined ? input.expectedParentVersionId : out.latestVersionId
      run(
        `INSERT INTO ais_versions (id, output_id, n, parent_version_id, branch_id, author, run_id, content, media_ref, media_width, media_height, content_hash, change_summary, sources_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        out.id,
        n,
        parent ?? null,
        input.branchId ?? out.branchId ?? null,
        input.author,
        input.runId ?? null,
        input.content,
        input.mediaRef ?? null,
        input.mediaWidth ?? null,
        input.mediaHeight ?? null,
        hashContent(input.content, input.mediaRef ?? null),
        input.changeSummary ?? '',
        JSON.stringify(input.sources ?? []),
        t
      )
      const review: ReviewState = out.reviewState === 'approved' ? 'draft' : out.reviewState
      run(`UPDATE ais_outputs SET latest_version_id = ?, review_state = ?, updated_at = ? WHERE id = ?`, id, review, t, out.id)
      appendEvent({
        workspaceId: wsOfProject(out.projectId),
        projectId: out.projectId,
        actor: input.author,
        kind: 'output.version_added',
        subject: { type: 'output', id: out.id, label: out.title },
        refs: [{ type: 'version', id, label: `${out.title} v${n}` }, ...(input.sources ?? [])],
        summary: `${out.title} v${n}${input.changeSummary ? `: ${input.changeSummary}` : ''}`,
        data: { versionId: id, n, runId: input.runId ?? null }
      })
      touchProject(out.projectId)
      return getVersion(id)!
    })
  }

  function approveVersion(outputId: string, versionId: string, actor = 'user:me'): AiOutput {
    return tx(() => {
      const out = getOutput(outputId)
      const v = getVersion(versionId)
      if (!out || !v || v.outputId !== outputId) throw new NotFoundError('Version')
      if (out.approvedVersionId === versionId) return out
      run(`UPDATE ais_outputs SET approved_version_id = ?, review_state = 'approved', updated_at = ? WHERE id = ?`, versionId, now(), outputId)
      appendEvent({
        workspaceId: wsOfProject(out.projectId),
        projectId: out.projectId,
        actor,
        kind: 'output.approved',
        subject: { type: 'output', id: outputId, label: out.title },
        refs: [{ type: 'version', id: versionId, label: `${out.title} v${v.n}` }],
        summary: `${out.title} v${v.n} approved.`,
        data: { versionId, previousVersionId: out.approvedVersionId }
      })
      return getOutput(outputId)!
    })
  }

  function publishVersion(outputId: string, versionId: string, actor = 'user:me'): AiOutput {
    return tx(() => {
      const out = getOutput(outputId)
      const v = getVersion(versionId)
      if (!out || !v || v.outputId !== outputId) throw new NotFoundError('Version')
      run(`UPDATE ais_outputs SET published_version_id = ?, updated_at = ? WHERE id = ?`, versionId, now(), outputId)
      appendEvent({ workspaceId: wsOfProject(out.projectId), projectId: out.projectId, actor, kind: 'output.published', subject: { type: 'output', id: outputId, label: out.title }, refs: [{ type: 'version', id: versionId }], summary: `${out.title} v${v.n} marked published.`, data: { versionId, previousVersionId: out.publishedVersionId } })
      return getOutput(outputId)!
    })
  }

  function setReviewState(outputId: string, state: ReviewState, actor = 'user:me'): AiOutput {
    return tx(() => {
      const out = getOutput(outputId)
      if (!out) throw new NotFoundError('Output')
      run(`UPDATE ais_outputs SET review_state = ?, updated_at = ? WHERE id = ?`, state, now(), outputId)
      if (state === 'in_review') {
        appendEvent({ workspaceId: wsOfProject(out.projectId), projectId: out.projectId, actor, kind: 'output.review_requested', subject: { type: 'output', id: outputId, label: out.title }, summary: `${out.title} is ready for review.`, data: { versionId: out.latestVersionId } })
      }
      return getOutput(outputId)!
    })
  }

  function renameOutput(outputId: string, title: string): AiOutput {
    run(`UPDATE ais_outputs SET title = ?, updated_at = ? WHERE id = ?`, title.trim() || 'Untitled', now(), outputId)
    return getOutput(outputId)!
  }

  // ── Decisions ───────────────────────────────────────────────────────────────

  // A decision is approved only by a person (the codebase's PLX-DOM-040 rule,
  // shared/decision.ts). An approved decision on a topic supersedes the earlier
  // approved one and keeps its value as previousValue.
  function recordDecision(input: { projectId: string; topic: string; title: string; value: string; status?: 'open' | 'approved'; dueAt?: number | null; evidence?: RecordRef[]; actor?: string }): AiDecision {
    return tx(() => {
      const ws = wsOfProject(input.projectId)
      const id = newId('dec')
      const t = now()
      const actor = input.actor ?? 'user:me'
      run(
        `INSERT INTO ais_decisions (id, project_id, topic, title, value, status, due_at, evidence_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.topic,
        input.title,
        input.value,
        'open',
        input.dueAt ?? null,
        JSON.stringify(input.evidence ?? []),
        t
      )
      appendEvent({ workspaceId: ws, projectId: input.projectId, actor, kind: 'decision.recorded', subject: { type: 'decision', id, label: input.title }, refs: input.evidence ?? [], summary: `Decision recorded: ${input.title}.` })
      if (input.status === 'approved') return approveDecision(id, actor)
      return getDecision(id)!
    })
  }

  function approveDecision(id: string, actor = 'user:me'): AiDecision {
    if (!actor.startsWith('user:')) throw new Error('Only a person can approve a decision.')
    return tx(() => {
      const d = getDecision(id)
      if (!d) throw new NotFoundError('Decision')
      if (d.status === 'approved') return d
      const prior = get(`SELECT * FROM ais_decisions WHERE project_id = ? AND topic = ? AND status = 'approved' AND id != ? ORDER BY decided_at DESC LIMIT 1`, d.projectId, d.topic, id)
      const t = now()
      if (prior) run(`UPDATE ais_decisions SET status = 'superseded' WHERE id = ?`, String(prior.id))
      run(
        `UPDATE ais_decisions SET status = 'approved', decided_by = ?, decided_at = ?, supersedes = ?, previous_value = COALESCE(previous_value, ?) WHERE id = ?`,
        actor,
        t,
        prior ? String(prior.id) : null,
        prior ? String(prior.value) : null,
        id
      )
      appendEvent({
        workspaceId: wsOfProject(d.projectId),
        projectId: d.projectId,
        actor,
        kind: 'decision.approved',
        subject: { type: 'decision', id, label: d.title },
        refs: d.evidence,
        summary: `${d.title}${prior ? ` (was ${String(prior.value)})` : ''}.`,
        data: { supersedes: prior ? String(prior.id) : null, value: d.value, previousValue: prior ? String(prior.value) : d.previousValue }
      })
      return getDecision(id)!
    })
  }

  function setDecisionPrevious(id: string, previousValue: string): void {
    run(`UPDATE ais_decisions SET previous_value = ? WHERE id = ?`, previousValue, id)
  }

  function resolveDecision(id: string, resolution: 'resolved' | 'rejected', actor = 'user:me'): AiDecision {
    if (!actor.startsWith('user:')) throw new Error('Only a person can resolve a decision.')
    return tx(() => {
      const d = getDecision(id)
      if (!d) throw new NotFoundError('Decision')
      run(`UPDATE ais_decisions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`, resolution, actor, now(), id)
      appendEvent({ workspaceId: wsOfProject(d.projectId), projectId: d.projectId, actor, kind: 'decision.resolved', subject: { type: 'decision', id, label: d.title }, summary: `${d.title}: ${resolution}.`, data: { resolution } })
      return getDecision(id)!
    })
  }

  function getDecision(id: string): AiDecision | null {
    const r = get(`SELECT * FROM ais_decisions WHERE id = ?`, id)
    return r ? toDecision(r) : null
  }

  function listDecisions(projectId: string): AiDecision[] {
    return all(`SELECT * FROM ais_decisions WHERE project_id = ? ORDER BY created_at DESC`, projectId).map(toDecision)
  }

  // ── Sources ─────────────────────────────────────────────────────────────────

  function addSource(input: { projectId: string | null; workspaceId: string; kind: SourceKind; title: string; url?: string | null; content: string; provider?: string | null; connectionId?: string | null; runId?: string | null; originalLocation?: string | null; capturedAt?: number; actor?: string }): AiSource {
    return tx(() => {
      const id = newId('src')
      const t = now()
      run(
        `INSERT INTO ais_sources (id, project_id, workspace_id, kind, title, url, content, provider, connection_id, run_id, original_location, captured_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.workspaceId,
        input.kind,
        input.title.trim() || 'Source',
        input.url ?? null,
        input.content,
        input.provider ?? null,
        input.connectionId ?? null,
        input.runId ?? null,
        input.originalLocation ?? null,
        input.capturedAt ?? t,
        t
      )
      appendEvent({ workspaceId: input.workspaceId, projectId: input.projectId, actor: input.actor ?? 'user:me', kind: 'source.added', subject: { type: 'source', id, label: input.title }, summary: `Source added: ${input.title}.`, data: { kind: input.kind } })
      return getSource(id)!
    })
  }

  function getSource(id: string): AiSource | null {
    const r = get(`SELECT * FROM ais_sources WHERE id = ?`, id)
    return r ? toSource(r) : null
  }

  function listSources(projectId: string): AiSource[] {
    return all(`SELECT * FROM ais_sources WHERE project_id = ? ORDER BY created_at DESC`, projectId).map(toSource)
  }

  // ── Info requests ───────────────────────────────────────────────────────────

  function openRequest(input: { projectId: string; aiTaskId?: string | null; requestedBy: string; recipient: string; question: string; topics: string[]; canProceed?: string }): InfoRequest {
    return tx(() => {
      const id = newId('req')
      run(
        `INSERT INTO ais_requests (id, project_id, ai_task_id, requested_by, recipient, question, topics_json, can_proceed, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.aiTaskId ?? null,
        input.requestedBy,
        input.recipient,
        input.question,
        JSON.stringify(input.topics.map((s) => s.toLowerCase())),
        input.canProceed ?? '',
        now()
      )
      appendEvent({ workspaceId: wsOfProject(input.projectId), projectId: input.projectId, actor: input.requestedBy, kind: 'request.opened', subject: { type: 'request', id, label: input.question }, summary: `Needs: ${input.question}`, data: { recipient: input.recipient, canProceed: input.canProceed ?? '' } })
      return getRequest(id)!
    })
  }

  function getRequest(id: string): InfoRequest | null {
    const r = get(`SELECT * FROM ais_requests WHERE id = ?`, id)
    return r ? toRequest(r) : null
  }

  function listRequests(projectId: string): InfoRequest[] {
    return all(`SELECT * FROM ais_requests WHERE project_id = ? ORDER BY created_at DESC`, projectId).map(toRequest)
  }

  function supplyRequest(id: string, sourceId: string, actor = 'system'): InfoRequest {
    return tx(() => {
      const r = getRequest(id)
      if (!r) throw new NotFoundError('Request')
      if (r.status !== 'open') return r
      run(`UPDATE ais_requests SET status = 'supplied', supplied_source_id = ? WHERE id = ?`, sourceId, id)
      appendEvent({ workspaceId: wsOfProject(r.projectId), projectId: r.projectId, actor, kind: 'request.supplied', subject: { type: 'request', id, label: r.question }, refs: [{ type: 'source', id: sourceId }], summary: `A source answers: ${r.question}`, data: { sourceId } })
      return getRequest(id)!
    })
  }

  // Delivered exactly once: the second call returns false and changes nothing.
  function markRequestDelivered(id: string, actor = 'system'): boolean {
    return tx(() => {
      const r = getRequest(id)
      if (!r || r.status !== 'supplied' || r.deliveredAt !== null) return false
      run(`UPDATE ais_requests SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`, now(), id)
      appendEvent({ workspaceId: wsOfProject(r.projectId), projectId: r.projectId, actor, kind: 'request.delivered', subject: { type: 'request', id, label: r.question }, refs: r.suppliedSourceId ? [{ type: 'source', id: r.suppliedSourceId }] : [], summary: `Delivered to ${r.requestedBy.replace(/^agent:/, '')}.` })
      return true
    })
  }

  // ── Suggestions ─────────────────────────────────────────────────────────────

  function suggestionKey(eventId: string | null, targetVersionId: string | null, target: RecordRef, action: string): string {
    return createHash('sha256').update(`${eventId ?? ''}|${target.type}:${target.id}@${targetVersionId ?? ''}|${action.trim().toLowerCase()}`).digest('hex').slice(0, 32)
  }

  // Deduplicated by event + target version + proposed action (§3).
  function createSuggestion(input: { projectId: string; fromActor: string; recipient: string; target: RecordRef; targetVersionId: string | null; evidence: Evidence[]; proposedAction: string; sourceEventId: string | null }): { suggestion: AiSuggestion; created: boolean } {
    return tx(() => {
      const key = suggestionKey(input.sourceEventId, input.targetVersionId, input.target, input.proposedAction)
      const existing = get(`SELECT * FROM ais_suggestions WHERE dedupe_key = ?`, key)
      if (existing) return { suggestion: toSuggestion(existing), created: false }
      const id = newId('sug')
      run(
        `INSERT INTO ais_suggestions (id, project_id, from_actor, recipient, target_json, target_version_id, evidence_json, proposed_action, dedupe_key, source_event_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.fromActor,
        input.recipient,
        JSON.stringify(input.target),
        input.targetVersionId,
        JSON.stringify(input.evidence),
        input.proposedAction,
        key,
        input.sourceEventId,
        now()
      )
      appendEvent({ workspaceId: wsOfProject(input.projectId), projectId: input.projectId, actor: input.fromActor, kind: 'suggestion.created', subject: { type: 'suggestion', id }, refs: [input.target], summary: `Suggestion for ${input.recipient.replace(/^agent:/, '')}: ${input.proposedAction}`, data: { recipient: input.recipient } })
      return { suggestion: getSuggestion(id)!, created: true }
    })
  }

  function getSuggestion(id: string): AiSuggestion | null {
    const r = get(`SELECT * FROM ais_suggestions WHERE id = ?`, id)
    return r ? toSuggestion(r) : null
  }

  function listSuggestions(projectId: string, status?: SuggestionStatus): AiSuggestion[] {
    if (status) return all(`SELECT * FROM ais_suggestions WHERE project_id = ? AND status = ? ORDER BY created_at DESC`, projectId, status).map(toSuggestion)
    return all(`SELECT * FROM ais_suggestions WHERE project_id = ? ORDER BY created_at DESC`, projectId).map(toSuggestion)
  }

  function resolveSuggestion(id: string, status: Exclude<SuggestionStatus, 'pending'>, actor: string): AiSuggestion {
    return tx(() => {
      const s = getSuggestion(id)
      if (!s) throw new NotFoundError('Suggestion')
      run(`UPDATE ais_suggestions SET status = ?, resolved_at = ? WHERE id = ?`, status, now(), id)
      appendEvent({ workspaceId: wsOfProject(s.projectId), projectId: s.projectId, actor, kind: 'suggestion.resolved', subject: { type: 'suggestion', id }, refs: [s.target], summary: `${actor.replace(/^(agent|user):/, '')} ${status} the suggestion: ${s.proposedAction}`, data: { status } })
      return getSuggestion(id)!
    })
  }

  // Undo for dismissing: the suggestion is pending again (and an Impact match
  // the person dismissed shows again).
  function reopenSuggestion(id: string, actor = 'user:me'): AiSuggestion {
    return tx(() => {
      const s = getSuggestion(id)
      if (!s) throw new NotFoundError('Suggestion')
      run(`UPDATE ais_suggestions SET status = 'pending', resolved_at = NULL WHERE id = ?`, id)
      appendEvent({ workspaceId: wsOfProject(s.projectId), projectId: s.projectId, actor, kind: 'suggestion.resolved', subject: { type: 'suggestion', id }, refs: [s.target], summary: `Reopened: ${s.proposedAction}`, data: { status: 'pending' } })
      return getSuggestion(id)!
    })
  }

  // ── Branches ────────────────────────────────────────────────────────────────

  // A branch starts from a named snapshot of the brief and the current output
  // versions (§1 Tasks, runs and branches).
  function createBranch(projectId: string, name: string, actor = 'user:me'): AiBranch {
    return tx(() => {
      const p = getProject(projectId)
      if (!p) throw new NotFoundError('Project')
      const outputs = listOutputs(projectId, { includeBrief: true, branchId: null })
      const snapshot: AiBranch['snapshot'] = { briefVersionId: null, outputVersions: {} }
      for (const o of outputs) {
        const vid = o.approvedVersionId ?? o.latestVersionId
        if (!vid) continue
        if (o.role === 'brief') snapshot.briefVersionId = vid
        else snapshot.outputVersions[o.id] = vid
      }
      const id = newId('brn')
      run(`INSERT INTO ais_branches (id, project_id, name, snapshot_json, created_at) VALUES (?,?,?,?,?)`, id, projectId, name.trim() || 'Draft direction', JSON.stringify(snapshot), now())
      appendEvent({ workspaceId: p.workspaceId, projectId, actor, kind: 'branch.created', subject: { type: 'branch', id, label: name }, summary: `Branch “${name}” started from the current brief and outputs.`, data: { snapshot } })
      return getBranch(id)!
    })
  }

  function getBranch(id: string): AiBranch | null {
    const r = get(`SELECT * FROM ais_branches WHERE id = ?`, id)
    return r ? toBranch(r) : null
  }

  function listBranches(projectId: string): AiBranch[] {
    return all(`SELECT * FROM ais_branches WHERE project_id = ? ORDER BY created_at`, projectId).map(toBranch)
  }

  // Bring back one selected change: the branch version's content becomes a new
  // version of the MAIN output. If the main output moved since the branch was
  // taken, the selection is refused with a conflict for the person to resolve.
  function applyBranchSelection(input: { branchId: string; mainOutputId: string; fromVersionId: string; resolvedAgainstVersionId?: string | null; actor?: string }): OutputVersion {
    return tx(() => {
      const b = getBranch(input.branchId)
      const main = getOutput(input.mainOutputId)
      const from = getVersion(input.fromVersionId)
      if (!b || !main || !from) throw new NotFoundError('Branch selection')
      const base = input.resolvedAgainstVersionId !== undefined && input.resolvedAgainstVersionId !== null ? input.resolvedAgainstVersionId : b.snapshot.outputVersions[main.id] ?? null
      const v = addVersion({
        outputId: main.id,
        content: from.content,
        mediaRef: from.mediaRef,
        mediaWidth: from.mediaWidth,
        mediaHeight: from.mediaHeight,
        author: input.actor ?? 'user:me',
        changeSummary: `Brought back from branch “${b.name}”.`,
        sources: [{ type: 'version', id: from.id, label: `${b.name} v${from.n}` }, { type: 'branch', id: b.id, label: b.name }],
        expectedParentVersionId: base
      })
      appendEvent({ workspaceId: wsOfProject(b.projectId), projectId: b.projectId, actor: input.actor ?? 'user:me', kind: 'branch.merged', subject: { type: 'branch', id: b.id, label: b.name }, refs: [{ type: 'version', id: v.id }], summary: `Applied a change from “${b.name}” to ${main.title}.` })
      return v
    })
  }

  // ── Shares across workspaces ────────────────────────────────────────────────

  // Share ONE pinned version into another workspace. Only that version becomes
  // visible there; nothing else about the project does.
  function shareVersion(input: { outputId: string; versionId: string; toWorkspaceId: string; actor?: string }): string {
    return tx(() => {
      const out = getOutput(input.outputId)
      const v = getVersion(input.versionId)
      if (!out || !v || v.outputId !== out.id) throw new NotFoundError('Version')
      const fromWs = wsOfProject(out.projectId)
      const id = newId('shr')
      run(`INSERT INTO ais_shares (id, from_workspace_id, to_workspace_id, output_id, version_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)`, id, fromWs, input.toWorkspaceId, out.id, v.id, input.actor ?? 'user:me', now())
      appendEvent({ workspaceId: fromWs, projectId: out.projectId, actor: input.actor ?? 'user:me', kind: 'share.created', subject: { type: 'version', id: v.id }, summary: `Shared ${out.title} v${v.n} into another workspace.`, data: { toWorkspaceId: input.toWorkspaceId }, visibility: 'private' })
      return id
    })
  }

  // What a context can see that was shared INTO it: exactly the pinned
  // versions, with the output title and kind, nothing else.
  function listSharedInto(ctx: AccessContext): Array<{ shareId: string; title: string; kind: OutputKind; version: OutputVersion }> {
    if (ctx.workspaceIds.length === 0) return []
    return all(
      `SELECT s.id AS share_id, o.title, o.kind, v.* FROM ais_shares s JOIN ais_outputs o ON o.id = s.output_id JOIN ais_versions v ON v.id = s.version_id
       WHERE s.revoked_at IS NULL AND s.to_workspace_id IN (${inCtx(ctx)}) ORDER BY s.created_at DESC`,
      ...ctx.workspaceIds
    ).map((r) => ({ shareId: String(r.share_id), title: String(r.title), kind: r.kind as OutputKind, version: toVersion(r) }))
  }

  // ── Activity and view marks ─────────────────────────────────────────────────

  function listEvents(ctx: AccessContext, opts: { projectId?: string; afterSeq?: number; limit?: number; kinds?: AiSpaceEventKind[] } = {}): AiSpaceEvent[] {
    if (ctx.workspaceIds.length === 0) return []
    const where = [`workspace_id IN (${inCtx(ctx)})`, `visibility != 'private'`]
    const args: unknown[] = [...ctx.workspaceIds]
    if (opts.projectId) {
      where.push('project_id = ?')
      args.push(opts.projectId)
    }
    if (opts.afterSeq !== undefined) {
      where.push('seq > ?')
      args.push(opts.afterSeq)
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`)
      args.push(...opts.kinds)
    }
    args.push(opts.limit ?? 500)
    return all(`SELECT * FROM (SELECT * FROM ais_events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?) ORDER BY seq`, ...args).map(toEvent)
  }

  function latestSeq(): number {
    return Number(get(`SELECT COALESCE(MAX(seq), 0) AS m FROM ais_events`)?.m ?? 0)
  }

  function getViewMark(scope: string): { lastSeq: number; at: number } | null {
    const r = get(`SELECT * FROM ais_view_marks WHERE scope = ?`, scope)
    return r ? { lastSeq: Number(r.last_seq), at: Number(r.at) } : null
  }

  // Opening a brief moves the mark; it never resolves anything (§3).
  function markViewed(scope: string, seq = latestSeq()): void {
    run(`INSERT INTO ais_view_marks (scope, last_seq, at) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET last_seq = excluded.last_seq, at = excluded.at`, scope, seq, now())
  }

  function onEvent(listener: (e: AiSpaceEvent) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  // ── Project state for Impact ────────────────────────────────────────────────

  function loadProjectState(projectId: string, revokedConnectionIds: string[] = []): ProjectState {
    const project = getProject(projectId)
    if (!project) throw new NotFoundError('Project')
    const outputs = all(`SELECT * FROM ais_outputs WHERE project_id = ? ORDER BY created_at`, projectId).map(toOutput)
    return {
      asOf: now(),
      project,
      tasks: listTasks(projectId),
      runs: all(`SELECT * FROM ais_runs WHERE project_id = ? ORDER BY created_at`, projectId).map(toRun),
      outputs,
      versions: all(`SELECT v.* FROM ais_versions v JOIN ais_outputs o ON o.id = v.output_id WHERE o.project_id = ? ORDER BY v.created_at, v.n`, projectId).map(toVersion),
      decisions: all(`SELECT * FROM ais_decisions WHERE project_id = ? ORDER BY created_at`, projectId).map(toDecision),
      sources: all(`SELECT * FROM ais_sources WHERE project_id = ? ORDER BY created_at`, projectId).map(toSource),
      requests: all(`SELECT * FROM ais_requests WHERE project_id = ? ORDER BY created_at`, projectId).map(toRequest),
      suggestions: all(`SELECT * FROM ais_suggestions WHERE project_id = ? ORDER BY created_at`, projectId).map(toSuggestion),
      events: all(`SELECT * FROM ais_events WHERE project_id = ? ORDER BY seq`, projectId).map(toEvent),
      revokedConnectionIds
    }
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  interface SearchHit {
    type: 'project' | 'task' | 'thread' | 'output' | 'decision'
    id: string
    projectId: string | null
    title: string
    snippet: string
    provider: string | null
  }

  // Search across permitted spaces only: the workspace filter is part of every
  // query, so a personal project can't surface in a work context.
  function search(ctx: AccessContext, query: string, opts: { projectId?: string; type?: SearchHit['type']; provider?: string } = {}): SearchHit[] {
    const q = query.trim()
    if (!q || ctx.workspaceIds.length === 0) return []
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
    const ws = ctx.workspaceIds
    const pf = opts.projectId ? 'AND p.id = ?' : ''
    const pa = opts.projectId ? [opts.projectId] : []
    const hits: SearchHit[] = []
    const want = (t: SearchHit['type']) => !opts.type || opts.type === t
    if (want('project')) {
      for (const r of all(`SELECT p.* FROM ais_projects p WHERE p.workspace_id IN (${inCtx(ctx)}) ${pf} AND p.archived_at IS NULL AND (p.title LIKE ? ESCAPE '\\' OR p.goal LIKE ? ESCAPE '\\') LIMIT 20`, ...ws, ...pa, like, like))
        hits.push({ type: 'project', id: String(r.id), projectId: String(r.id), title: String(r.title), snippet: snippetOf(String(r.goal ?? ''), q), provider: null })
    }
    if (want('task')) {
      for (const r of all(`SELECT t.* FROM ais_tasks t JOIN ais_projects p ON p.id = t.project_id WHERE p.workspace_id IN (${inCtx(ctx)}) ${pf} AND (t.title LIKE ? ESCAPE '\\' OR t.outcome LIKE ? ESCAPE '\\') LIMIT 20`, ...ws, ...pa, like, like))
        hits.push({ type: 'task', id: String(r.id), projectId: String(r.project_id), title: String(r.title), snippet: snippetOf(String(r.outcome ?? ''), q), provider: null })
    }
    if (want('thread')) {
      const prov = opts.provider ? 'AND th.provider = ?' : ''
      const provA = opts.provider ? [opts.provider] : []
      for (const r of all(
        `SELECT th.*, (SELECT m.text FROM ais_messages m WHERE m.thread_id = th.id AND m.text LIKE ? ESCAPE '\\' LIMIT 1) AS hit_text FROM ais_threads th LEFT JOIN ais_projects p ON p.id = th.project_id
         WHERE th.workspace_id IN (${inCtx(ctx)}) ${opts.projectId ? 'AND th.project_id = ?' : ''} ${prov}
           AND (th.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ais_messages m WHERE m.thread_id = th.id AND m.text LIKE ? ESCAPE '\\')) LIMIT 20`,
        like,
        ...ws,
        ...pa,
        ...provA,
        like,
        like
      ))
        hits.push({ type: 'thread', id: String(r.id), projectId: str(r.project_id), title: String(r.title), snippet: snippetOf(String(r.hit_text ?? ''), q), provider: str(r.provider) })
    }
    if (want('output')) {
      for (const r of all(
        `SELECT o.*, v.content AS v_content FROM ais_outputs o JOIN ais_projects p ON p.id = o.project_id LEFT JOIN ais_versions v ON v.id = o.latest_version_id
         WHERE p.workspace_id IN (${inCtx(ctx)}) ${pf} AND (o.title LIKE ? ESCAPE '\\' OR v.content LIKE ? ESCAPE '\\') LIMIT 20`,
        ...ws,
        ...pa,
        like,
        like
      ))
        hits.push({ type: 'output', id: String(r.id), projectId: String(r.project_id), title: String(r.title), snippet: snippetOf(String(r.v_content ?? ''), q), provider: null })
    }
    if (want('decision')) {
      for (const r of all(`SELECT d.* FROM ais_decisions d JOIN ais_projects p ON p.id = d.project_id WHERE p.workspace_id IN (${inCtx(ctx)}) ${pf} AND (d.title LIKE ? ESCAPE '\\' OR d.value LIKE ? ESCAPE '\\') LIMIT 20`, ...ws, ...pa, like, like))
        hits.push({ type: 'decision', id: String(r.id), projectId: String(r.project_id), title: String(r.title), snippet: `${String(r.value)} · ${String(r.status)}`, provider: null })
    }
    return hits
  }

  return {
    tx,
    appendEvent,
    onEvent,
    ensureDefaultWorkspaces,
    createWorkspace,
    listWorkspaces,
    renameWorkspace,
    createProject,
    getProject,
    getProjectInCtx,
    listProjects,
    projectForDesk,
    updateProject,
    archiveProject,
    createTask,
    getTask,
    updateTask,
    listTasks,
    setDependencies,
    createAgent,
    updateAgent,
    getAgent,
    listAgents,
    createThread,
    managerThread,
    getThread,
    listThreads,
    addMessage,
    listMessages,
    captureChat,
    fileThread,
    unfileThread,
    createRun,
    getRun,
    listRuns,
    setRunStatus,
    addRunStep,
    listRunSteps,
    updateRunManifest,
    createOutput,
    getOutput,
    listOutputs,
    getVersion,
    listVersions,
    addVersion,
    approveVersion,
    publishVersion,
    setReviewState,
    renameOutput,
    recordDecision,
    approveDecision,
    setDecisionPrevious,
    resolveDecision,
    getDecision,
    listDecisions,
    addSource,
    getSource,
    listSources,
    openRequest,
    getRequest,
    listRequests,
    supplyRequest,
    markRequestDelivered,
    createSuggestion,
    getSuggestion,
    listSuggestions,
    resolveSuggestion,
    reopenSuggestion,
    createBranch,
    getBranch,
    listBranches,
    applyBranchSelection,
    shareVersion,
    listSharedInto,
    listEvents,
    latestSeq,
    getViewMark,
    markViewed,
    loadProjectState,
    search
  }
}

export function emptyManifest(): RunManifest {
  return { connectionId: null, connectionAlias: null, billedTo: null, provider: null, model: null, inputs: [], tools: [], hostedExecution: false, budgetMinor: null, instruction: '', targetOutputId: null }
}

function firstLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function snippetOf(text: string, q: string): string {
  const t = text.replace(/\s+/g, ' ')
  const i = t.toLowerCase().indexOf(q.toLowerCase())
  if (i === -1) return t.slice(0, 120)
  const from = Math.max(0, i - 50)
  return `${from > 0 ? '…' : ''}${t.slice(from, i + q.length + 70)}${i + q.length + 70 < t.length ? '…' : ''}`
}
