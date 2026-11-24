// @vitest-environment node
// Runner + Project Manager coordination, against real SQLite and fake model
// adapters. Covers SPEC-AI-SPACE §7 "Prove cooperation" and "Restore work after
// failure", and SPEC-CONNECTIONS §8 "Two accounts", "Disconnect mid-run",
// "Usage and fallback".

import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memSqlDb } from './_memdb'
import { createAiSpaceStore } from '../../src/main/aispace/store'
import { createConnectionsStore } from '../../src/main/aispace/connectionsStore'
import { createVault } from '../../src/main/aispace/vault'
import { createBroker } from '../../src/main/aispace/broker'
import { createRunner } from '../../src/main/aispace/runner'
import { createCoordinator } from '../../src/main/aispace/coordinator'
import type { ModelAdapter, ModelRequest, ModelResult } from '../../src/main/aispace/providers/types'
import { ProviderError } from '../../src/main/aispace/providers/types'
import type { SqlDb } from '../../src/main/db/eventStore'

const fakeCrypto = { available: () => true, encrypt: (s: string) => Buffer.from(`enc:${s}`), decrypt: (b: Buffer) => b.toString().slice(4) }

function result(text: string, extra: Partial<ModelResult> = {}): ModelResult {
  return { status: 'completed', text, usage: { inputTokens: 100, outputTokens: 50, source: 'reported' }, requestId: 'req_1', externalId: null, model: 'm', stopReason: 'end_turn', error: null, ...extra }
}

interface FakeAdapter extends ModelAdapter {
  calls: ModelRequest[]
  next: Array<(req: ModelRequest) => Promise<ModelResult>>
  pollQueue: Array<ModelResult | Error>
}

function fakeAdapter(providerId: 'anthropic' | 'openai' = 'anthropic', price: number | null = 1000): FakeAdapter {
  const a: FakeAdapter = {
    providerId,
    calls: [],
    next: [],
    pollQueue: [],
    async verify() {
      return { ok: true, identity: 'org_1', providerOrg: 'org_1', models: ['m'], capabilities: [{ capability: 'run_model', state: 'passed', checkedAt: 1, detail: '' }], detail: 'ok', billable: false }
    },
    async run(req) {
      a.calls.push(req)
      const f = a.next.shift()
      if (f) return f(req)
      return result(`Draft based on: ${req.messages[0].content.slice(-40)}`)
    },
    async poll() {
      const n = a.pollQueue.shift()
      if (!n) return result('', { status: 'in_progress', externalId: 'resp_1' })
      if (n instanceof Error) throw n
      return n
    },
    async cancel() {
      return result('', { status: 'cancelled', externalId: 'resp_1' })
    },
    estimateCostMicros: (_m, i, o) => (price === null ? null : (i + o) * price)
  }
  return a
}

function world(db: SqlDb = memSqlDb(), adapter = fakeAdapter(), vaultPath = join(mkdtempSync(join(tmpdir(), 'aisv-')), 'v.json')) {
  let t = Date.UTC(2026, 10, 24, 1, 0, 0)
  const now = () => t
  const store = createAiSpaceStore(db, { now })
  const conns = createConnectionsStore(db, store, { now })
  const broker = createBroker(createVault(vaultPath, fakeCrypto))
  const timers: Array<() => void> = []
  const runner = createRunner({ store, conns, broker, adapterFor: () => adapter, grant: (fn) => fn(), now, setTimer: (fn) => timers.push(fn), clearTimer: () => {} })
  const coord = createCoordinator({ store, conns, runner, revokedConnectionIds: () => [] })
  coord.start()
  const flushTimers = async () => {
    while (timers.length) await timers.shift()!()
  }
  return { db, store, conns, broker, runner, coord, adapter, vaultPath, now, advance: (ms: number) => (t += ms), flushTimers }
}

function addReadyConnection(w: ReturnType<typeof world>, workspaceId: string, alias = 'SaaSMouth Claude', billedTo = 'SaaSMouth') {
  const c = w.conns.addConnection({ workspaceId, providerId: 'anthropic', kind: 'model_api', alias, credentialOwner: 'me', billedTo })
  w.broker.store(c.id, 'sk-ant-test-abcdefghijklmnop')
  w.conns.updateConnection(c.id, { hasSecret: true, secretHint: '…mnop' })
  w.conns.recordCheck(c.id, [{ capability: 'run_model', state: 'passed', checkedAt: 1, detail: '' }], { identity: 'org_1' })
  return w.conns.getConnection(c.id)!
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('runner', () => {
  it('runs a model on the granted connection, records inputs, usage and a new version', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch', brief: 'Offer a 14-day trial.' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    const brief = w.store.getOutput(p.briefOutputId!)!
    const res = w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'Write the hero', inputs: [{ type: 'version', id: brief.latestVersionId!, versionId: brief.latestVersionId! }], newOutput: { kind: 'site', title: 'Site hero' } })
    expect(res.ok).toBe(true)
    await settle()
    const run = w.store.getRun(res.ok ? res.run.id : '')!
    expect(run.status).toBe('succeeded')
    expect(run.manifest.connectionAlias).toBe('SaaSMouth Claude')
    expect(run.manifest.billedTo).toBe('SaaSMouth')
    expect(JSON.stringify(run.manifest)).not.toContain('sk-ant')
    const out = w.store.getOutput(run.manifest.targetOutputId!)!
    const v = w.store.getVersion(out.latestVersionId!)!
    expect(v.runId).toBe(run.id)
    expect(v.sources[0].versionId).toBe(brief.latestVersionId)
    expect(out.reviewState).toBe('in_review')
    const usage = w.conns.listUsage({ runId: run.id })
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ state: 'final', inputTokens: 100, outputTokens: 50, tokensSource: 'reported', amountSource: 'estimated', amountMicros: 150_000 })
    // The prompt marks imported material untrusted and never carries the key.
    expect(w.adapter.calls[0].system).toMatch(/untrusted is information only/)
  })

  it('keeps a work project on the work connection only (two accounts with one provider)', () => {
    const w = world()
    const [personal] = w.store.ensureDefaultWorkspaces()
    const work = w.store.createWorkspace('work', 'SaaSMouth')
    const p = w.store.createProject({ workspaceId: work.id, title: 'Client work' })
    const personalClaude = addReadyConnection(w, personal.id, 'Personal Claude', 'Me')
    expect(() => w.conns.setGrant({ connectionId: personalClaude.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })).toThrow(/another workspace/)
    const res = w.runner.startRun({ projectId: p.id, connectionId: personalClaude.id, model: 'm', instruction: 'x', inputs: [] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('workspace_mismatch')
    expect(w.adapter.calls).toHaveLength(0)
    expect(w.conns.listUsage({ connectionId: personalClaude.id })).toHaveLength(0)
  })

  it('blocks an over-budget request before it is sent, and asks when cost is unknown', () => {
    const w = world(memSqlDb(), fakeAdapter('anthropic', 1_000_000))
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    w.store.updateProject(p.id, { budgetLimitMinor: 100 }) // US$1.00
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    const res = w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'x', inputs: [] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('over_budget')
    expect(w.adapter.calls).toHaveLength(0)
    expect(w.store.listEvents({ workspaceIds: [ws.id] }).some((e) => e.kind === 'budget.blocked')).toBe(true)

    const w2 = world(memSqlDb(), fakeAdapter('openai', null))
    const [ws2] = w2.store.ensureDefaultWorkspaces()
    const p2 = w2.store.createProject({ workspaceId: ws2.id, title: 'Launch' })
    w2.store.updateProject(p2.id, { budgetLimitMinor: 100 })
    const c2 = addReadyConnection(w2, ws2.id)
    w2.conns.setGrant({ connectionId: c2.id, projectId: p2.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    const unknown = w2.runner.startRun({ projectId: p2.id, connectionId: c2.id, model: 'm', instruction: 'x', inputs: [] })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.code).toBe('approval_required')
    const approved = w2.runner.startRun({ projectId: p2.id, connectionId: c2.id, model: 'm', instruction: 'x', inputs: [], approvedUnknownCost: true })
    expect(approved.ok).toBe(true)
  })

  it('holds a draft for review when the output changed while the run worked', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    const out = w.store.createOutput({ projectId: p.id, kind: 'document', title: 'Hero' })
    w.store.addVersion({ outputId: out.id, content: 'v1', author: 'user:me' })
    let release!: () => void
    w.adapter.next.push(() => new Promise((r) => (release = () => r(result('agent draft')))))
    const res = w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'Improve', inputs: [], targetOutputId: out.id })
    await settle()
    w.store.addVersion({ outputId: out.id, content: 'person edit', author: 'user:me' })
    release()
    await settle()
    const run = w.store.getRun(res.ok ? res.run.id : '')!
    expect(run.status).toBe('waiting')
    expect(w.store.listVersions(out.id).map((v) => v.content)).toEqual(['v1', 'person edit'])
    expect(w.store.listSuggestions(p.id, 'pending')[0].proposedAction).toMatch(/held draft/)
    w.runner.saveHeldDraft(run.id)
    expect(w.store.listVersions(out.id).map((v) => v.content)).toEqual(['v1', 'person edit', 'agent draft'])
  })

  it('marks the connection for reconnect when the key is rejected, and keeps partial text', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    w.adapter.next.push(async () => {
      throw new ProviderError('reconnect_required', 'Invalid key sk-ant-test-abcdefghijklmnop', { providerId: 'anthropic', status: 401, secret: 'sk-ant-test-abcdefghijklmnop' })
    })
    const res = w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'x', inputs: [] })
    await settle()
    const run = w.store.getRun(res.ok ? res.run.id : '')!
    expect(run.status).toBe('failed')
    expect(run.statusDetail).not.toContain('sk-ant')
    expect(w.conns.getConnection(c.id)!.status).toBe('reconnect_required')
    expect(w.conns.listUsage({ runId: run.id })).toHaveLength(0)
    // New calls stop while it needs reconnecting.
    const again = w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'x', inputs: [] })
    expect(again.ok).toBe(false)
  })
})

describe('restore work after failure (acceptance)', () => {
  it('resumes a background run after a restart and never re-sends an interrupted one', async () => {
    const db = memSqlDb()
    const adapter = fakeAdapter('openai')
    const w1 = world(db, adapter)
    const [ws] = w1.store.ensureDefaultWorkspaces()
    const p = w1.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const c = addReadyConnection(w1, ws.id, 'SaaSMouth OpenAI')
    w1.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    adapter.next.push(async () => result('', { status: 'queued', externalId: 'resp_abc' }))
    const bg = w1.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'Long research', inputs: [], background: true, newOutput: { kind: 'document', title: 'Research' } })
    // A local run that is still streaming when Plexii closes.
    adapter.next.push(() => new Promise(() => {}))
    const local = w1.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'Quick draft', inputs: [] })
    await settle()
    expect(w1.store.getRun(bg.ok ? bg.run.id : '')!.externalId).toBe('resp_abc')
    expect(w1.store.getRun(local.ok ? local.run.id : '')!.status).toBe('running')
    const callsBefore = adapter.calls.length

    // "Reopen Plexii": a fresh runner on the same database and vault.
    const w2 = world(db, adapter, w1.vaultPath)
    adapter.pollQueue.push(result('Finished research.', { externalId: 'resp_abc' }))
    const rec = w2.runner.recoverOnStartup()
    expect(rec).toEqual({ resumed: 1, interrupted: 1 })
    const lr = w2.store.getRun(local.ok ? local.run.id : '')!
    expect(lr.status).toBe('failed')
    expect(lr.statusDetail).toMatch(/closed while this run was working/)
    await w2.flushTimers()
    const br = w2.store.getRun(bg.ok ? bg.run.id : '')!
    expect(br.status).toBe('succeeded')
    expect(w2.store.getVersion(w2.store.getOutput(br.manifest.targetOutputId!)!.latestVersionId!)!.content).toBe('Finished research.')
    // Nothing was re-sent: no new run calls after the restart.
    expect(adapter.calls.length).toBe(callsBefore)
  })

  it('leaves an external job visibly unresolved when its connection is disconnected mid-run', async () => {
    const adapter = fakeAdapter('openai')
    const w = world(memSqlDb(), adapter)
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const c = addReadyConnection(w, ws.id, 'SaaSMouth OpenAI')
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    adapter.next.push(async () => result('', { status: 'in_progress', externalId: 'resp_x' }))
    const bg = w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'Long', inputs: [], background: true })
    await settle()
    w.conns.setStatus(c.id, 'disconnected', 'Disconnected by you.', 'user:me')
    w.broker.forget(c.id)
    await w.flushTimers()
    const r = w.store.getRun(bg.ok ? bg.run.id : '')!
    expect(r.status).toBe('unavailable')
    expect(r.statusDetail).toMatch(/may still be running/)
    expect(r.lastConfirmedStep).toMatch(/Started at the provider/)
    // New calls stop.
    expect(w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'x', inputs: [] }).ok).toBe(false)
  })
})

describe('Project Manager coordination', () => {
  it('asks the assigned agent for a draft fix when an approved input changes, within the bound', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch', brief: 'Offer a 14-day trial.' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    w.store.updateProject(p.id, { defaultConnectionId: c.id, defaultModel: 'm', authority: { draftRevisions: true, maxAutoFollowUps: 2 } })
    const writer = w.store.createAgent({ projectId: p.id, name: 'Writer', role: 'writer', connectionId: c.id, model: 'm' })
    const brief = w.store.getOutput(p.briefOutputId!)!
    const briefV1 = brief.latestVersionId!
    // Three outputs made from brief v1.
    const outs = ['Hero', 'Email', 'Ad']
    for (const title of outs) {
      const task = w.store.createTask({ projectId: p.id, title, assignee: writer.id })
      w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: `Write ${title}`, inputs: [{ type: 'version', id: briefV1, versionId: briefV1 }], aiTaskId: task.id, agentId: writer.id, newOutput: { kind: 'document', title } })
      await settle()
    }
    // A blog post that only MENTIONS the old value (possible match): never auto-acted on.
    const blog = w.store.createOutput({ projectId: p.id, kind: 'document', title: 'Blog' })
    w.store.addVersion({ outputId: blog.id, content: 'Try our 14-day trial', author: 'user:me' })
    for (const o of w.store.listOutputs(p.id)) if (o.latestVersionId) w.store.approveVersion(o.id, o.latestVersionId)
    const callsBefore = w.adapter.calls.length

    w.advance(60_000)
    w.store.recordDecision({ projectId: p.id, topic: 'trial', title: 'Trial is 14 days', value: '14 days', status: 'approved' })
    const d = w.store.recordDecision({ projectId: p.id, topic: 'trial', title: 'Client approved a 30-day trial', value: '30 days' })
    w.store.approveDecision(d.id, 'user:me')
    const v2 = w.store.addVersion({ outputId: brief.id, content: 'Offer a 30-day trial.', author: 'user:me', sources: [{ type: 'decision', id: d.id }] })
    w.store.approveVersion(brief.id, v2.id)
    await settle()
    await settle()
    const revisionRuns = w.store.listRuns({ workspaceIds: [ws.id] }, { projectId: p.id }).filter((r) => r.kind === 'revision')
    expect(revisionRuns).toHaveLength(2) // bounded at maxAutoFollowUps
    expect(w.adapter.calls.length - callsBefore).toBe(2)
    expect(revisionRuns.every((r) => r.manifest.inputs.some((i) => i.versionId === v2.id))).toBe(true)
    expect(revisionRuns.some((r) => r.manifest.targetOutputId === blog.id)).toBe(false)
    expect(w.store.listEvents({ workspaceIds: [ws.id] }).some((e) => /Stopped after 2 automatic drafts/.test(e.summary))).toBe(true)
    // Approved versions stayed on v1; the drafts are new latest versions only.
    for (const o of w.store.listOutputs(p.id).filter((x) => outs.includes(x.title))) {
      expect(w.store.getVersion(o.approvedVersionId!)!.n).toBe(1)
    }
    const revised = w.store.listOutputs(p.id).filter((o) => outs.includes(o.title) && o.latestVersionId !== o.approvedVersionId)
    expect(revised).toHaveLength(2)
  })

  it('delivers later evidence exactly once and the requester drafts a revision citing it (prove cooperation)', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    const writer = w.store.createAgent({ projectId: p.id, name: 'Writer', role: 'writer', connectionId: c.id, model: 'm' })
    const task = w.store.createTask({ projectId: p.id, title: 'Case study', assignee: writer.id })
    const out = w.store.createOutput({ projectId: p.id, kind: 'document', title: 'Case study', aiTaskId: task.id })
    w.store.addVersion({ outputId: out.id, content: 'Draft without numbers.', author: 'agent:Writer' })
    const req = w.store.openRequest({ projectId: p.id, aiTaskId: task.id, requestedBy: `agent:${writer.id}`, recipient: 'agent:Research', question: 'What churn reduction did the client see?', topics: ['churn'], canProceed: 'The intro and structure.' })
    // A second agent adds a source later.
    w.store.addSource({ projectId: p.id, workspaceId: ws.id, kind: 'note', title: 'Client QBR notes', content: 'Revenue grew. Churn fell from 6% to 3% after onboarding changes.', actor: 'agent:Research' })
    await settle()
    await settle()
    const r = w.store.getRequest(req.id)!
    expect(r.status).toBe('supplied')
    expect(r.deliveredAt).not.toBeNull()
    // Delivered once: a duplicate source event changes nothing.
    w.store.addSource({ projectId: p.id, workspaceId: ws.id, kind: 'note', title: 'Churn copy', content: 'Churn fell from 6% to 3%.' })
    await settle()
    const delivered = w.store.listEvents({ workspaceIds: [ws.id] }).filter((e) => e.kind === 'request.delivered')
    expect(delivered).toHaveLength(1)
    const v = w.store.getVersion(w.store.getOutput(out.id)!.latestVersionId!)!
    expect(v.n).toBe(2)
    expect(v.sources.some((s) => s.type === 'source')).toBe(true)
    const sug = w.store.listSuggestions(p.id).find((s) => s.fromActor === `agent:${writer.id}`)!
    expect(sug.status).toBe('acted')
    expect(sug.evidence[0].text).toMatch(/supports: “Churn fell from 6% to 3%/)
  })

  it('previews and approves a bundle, keeping successes when one activity fails', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch', brief: '14 days' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    w.store.updateProject(p.id, { authority: { draftRevisions: false, maxAutoFollowUps: 0 }, defaultConnectionId: c.id, defaultModel: 'm' })
    const brief = w.store.getOutput(p.briefOutputId!)!
    const b1 = brief.latestVersionId!
    for (const title of ['Hero', 'Ad']) {
      w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: title, inputs: [{ type: 'version', id: b1, versionId: b1 }], newOutput: { kind: 'document', title } })
      await settle()
    }
    const task = w.store.createTask({ projectId: p.id, title: 'Email', scheduledAt: Date.UTC(2026, 10, 26) })
    w.store.createRun({ projectId: p.id, kind: 'model', manifest: { connectionId: c.id, connectionAlias: c.alias, billedTo: null, provider: 'anthropic', model: 'm', inputs: [{ type: 'version', id: b1, versionId: b1 }], tools: [], hostedExecution: false, budgetMinor: null, instruction: 'Email', targetOutputId: null }, idempotencyKey: 'email', aiTaskId: task.id })
    w.advance(60_000)
    const d = w.store.recordDecision({ projectId: p.id, topic: 'trial', title: 'Trial is 30 days', value: '30 days' })
    w.store.setDecisionPrevious(d.id, '14 days')
    w.store.approveDecision(d.id)
    const v2 = w.store.addVersion({ outputId: brief.id, content: '30 days', author: 'user:me', sources: [{ type: 'decision', id: d.id }] })
    w.store.approveVersion(brief.id, v2.id)
    await settle()
    const preview = w.coord.previewBundle(p.id, `chg_${d.id}`)!
    expect(preview.activities.map((a) => a.label).sort()).toEqual(['Draft a revision of Ad', 'Draft a revision of Hero', 'Give Email the new input'])
    // Make the Ad revision fail at the provider.
    w.adapter.next.push(async (req) => (req.messages[0].content.includes('Ad') ? Promise.reject(new ProviderError('unavailable', 'Overloaded', { providerId: 'anthropic' })) : result('Hero fixed')))
    w.adapter.next.push(async (req) => (req.messages[0].content.includes('Ad') ? Promise.reject(new ProviderError('unavailable', 'Overloaded', { providerId: 'anthropic' })) : result('Hero fixed')))
    const results = w.coord.approveBundle(p.id, `chg_${d.id}`, preview.activities.map((a) => a.id))
    expect(results.every((r) => r.ok)).toBe(true) // all three started
    await settle()
    const runs = w.store.listRuns({ workspaceIds: [ws.id] }, { projectId: p.id }).filter((r) => r.kind === 'revision')
    expect(runs.map((r) => r.status).sort()).toEqual(['failed', 'succeeded'])
    const emailRun = w.store.listRuns({ workspaceIds: [ws.id] }, { projectId: p.id }).find((r) => r.idempotencyKey === 'email')!
    expect(emailRun.manifest.inputs[0].versionId).toBe(v2.id)
  })
})

describe('agent needs information', () => {
  it('turns a NEEDS INFO line into an open request, keeps the draft without it, and a later matching source answers it once', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    w.store.updateProject(p.id, { defaultConnectionId: c.id, defaultModel: 'm' })
    const writer = w.store.createAgent({ projectId: p.id, name: 'Writer', role: 'writer', connectionId: c.id, model: 'm' })
    const task = w.store.createTask({ projectId: p.id, title: 'Case study', assignee: writer.id })
    w.adapter.next.push(async () => result('Agencies cut onboarding time.\n\nNEEDS INFO: What churn reduction did the client see after onboarding?'))
    w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'Write the case study', inputs: [], aiTaskId: task.id, agentId: writer.id, newOutput: { kind: 'document', title: 'Case study' } })
    await settle()
    const out = w.store.listOutputs(p.id).find((o) => o.title === 'Case study')!
    expect(w.store.getVersion(out.latestVersionId!)!.content).toBe('Agencies cut onboarding time.')
    const [req] = w.store.listRequests(p.id)
    expect(req.question).toBe('What churn reduction did the client see after onboarding?')
    expect(req.requestedBy).toBe(`agent:${writer.id}`)
    expect(req.topics).toEqual(['churn', 'reduction', 'onboarding'])
    // An unrelated source that shares one word doesn't answer it.
    w.store.addSource({ projectId: p.id, workspaceId: ws.id, kind: 'note', title: 'Onboarding checklist', content: 'Steps for onboarding new agencies.' })
    await settle()
    expect(w.store.getRequest(req.id)!.status).toBe('open')
    w.store.addSource({ projectId: p.id, workspaceId: ws.id, kind: 'note', title: 'QBR notes', content: 'Churn fell from 6% to 3% after the onboarding changes, a 50% reduction.' })
    await settle()
    await settle()
    expect(w.store.getRequest(req.id)!.deliveredAt).not.toBeNull()
    expect(w.store.getVersion(w.store.getOutput(out.id)!.latestVersionId!)!.n).toBe(2)
  })

  it('a run that only asks a question waits instead of saving an empty version', async () => {
    const w = world()
    const [ws] = w.store.ensureDefaultWorkspaces()
    const p = w.store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const c = addReadyConnection(w, ws.id)
    w.conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
    w.adapter.next.push(async () => result('NEEDS INFO: Which plan names are final?'))
    const r = w.runner.startRun({ projectId: p.id, connectionId: c.id, model: 'm', instruction: 'Write pricing copy', inputs: [], newOutput: { kind: 'document', title: 'Pricing copy' } })
    await settle()
    const run = w.store.getRun(r.ok ? r.run.id : '')!
    expect(run.status).toBe('waiting')
    expect(run.statusDetail).toContain('Which plan names are final?')
    expect(w.store.listVersions(run.manifest.targetOutputId!)).toHaveLength(0)
  })
})
