// @vitest-environment node
// AI Space record store + Impact engine, against real SQLite (node:sqlite).
// Includes the spec's acceptance "Trace a decision" (SPEC-AI-SPACE.md §7).

import { describe, expect, it } from 'vitest'
import { memSqlDb } from './_memdb'
import { createAiSpaceStore, StaleWriteError } from '../../src/main/aispace/store'
import { computeImpact, findValue, stateAsOf, valuePattern } from '../../src/shared/aispace/impact'
import type { RunManifest } from '../../src/shared/aispace/model'

function setup() {
  let t = Date.UTC(2026, 10, 20, 9, 0, 0)
  const clock = { now: () => t, advance: (ms: number) => (t += ms) }
  let n = 0
  const store = createAiSpaceStore(memSqlDb(), { now: clock.now, newId: (p) => `${p}_${++n}` })
  const [personal] = store.ensureDefaultWorkspaces()
  const work = store.createWorkspace('work', 'SaaSMouth')
  return { store, clock, personal, work }
}

const manifest = (inputs: RunManifest['inputs'], extra: Partial<RunManifest> = {}): RunManifest => ({
  connectionId: null,
  connectionAlias: null,
  billedTo: null,
  provider: null,
  model: null,
  inputs,
  tools: [],
  hostedExecution: false,
  budgetMinor: null,
  instruction: 'Write it',
  targetOutputId: null,
  ...extra
})

describe('AI Space store', () => {
  it('writes the record and its activity event in one transaction', () => {
    const { store, work } = setup()
    const seen: string[] = []
    store.onEvent((e) => seen.push(e.kind))
    const p = store.createProject({ workspaceId: work.id, title: 'Launch', brief: 'Offer a 14-day trial.' })
    expect(p.briefOutputId).toBeTruthy()
    expect(seen).toEqual(['project.created', 'output.created', 'output.version_added', 'output.approved'])
    // A failing transaction leaves neither the record nor its event.
    const before = store.latestSeq()
    expect(() => store.tx(() => { store.createTask({ projectId: p.id, title: 'x' }); throw new Error('boom') })).toThrow('boom')
    expect(store.latestSeq()).toBe(before)
    expect(store.listTasks(p.id)).toHaveLength(0)
  })

  it('keeps versions and the activity log immutable', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch', brief: 'v1' })
    const db = (store as unknown as { tx: unknown }) && p
    expect(db).toBeTruthy()
    const raw = memSqlDb()
    const s2 = createAiSpaceStore(raw)
    const [ws] = s2.ensureDefaultWorkspaces()
    const p2 = s2.createProject({ workspaceId: ws.id, title: 'T', brief: 'hello' })
    expect(() => raw.prepare(`UPDATE ais_versions SET content = 'changed'`).run()).toThrow(/immutable/)
    expect(() => raw.prepare(`DELETE FROM ais_versions`).run()).toThrow(/immutable/)
    expect(() => raw.prepare(`DELETE FROM ais_events`).run()).toThrow(/append-only/)
    expect(() => raw.prepare(`UPDATE ais_events SET summary = 'x'`).run()).toThrow(/append-only/)
    expect(s2.listVersions(p2.briefOutputId!)[0].content).toBe('hello')
  })

  it('never duplicates a run or its output on a reconnect or duplicate event', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch' })
    const a = store.createRun({ projectId: p.id, kind: 'model', manifest: manifest([]), idempotencyKey: 'k1' })
    const b = store.createRun({ projectId: p.id, kind: 'model', manifest: manifest([]), idempotencyKey: 'k1' })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.run.id).toBe(a.run.id)
    const out = store.createOutput({ projectId: p.id, kind: 'document', title: 'Hero' })
    const v1 = store.addVersion({ outputId: out.id, content: 'A', author: 'agent:writer', runId: a.run.id })
    const v1again = store.addVersion({ outputId: out.id, content: 'A', author: 'agent:writer', runId: a.run.id })
    expect(v1again.id).toBe(v1.id)
    expect(store.listVersions(out.id)).toHaveLength(1)
    // A terminal run stays terminal: a late "running" changes nothing.
    store.setRunStatus(a.run.id, 'succeeded', 'Done')
    expect(store.setRunStatus(a.run.id, 'running', 'late').status).toBe('succeeded')
  })

  it('rejects a stale write and hands back what changed', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch' })
    const out = store.createOutput({ projectId: p.id, kind: 'document', title: 'Hero' })
    const v1 = store.addVersion({ outputId: out.id, content: 'one', author: 'user:me' })
    store.addVersion({ outputId: out.id, content: 'two', author: 'agent:writer', expectedParentVersionId: v1.id })
    let err: unknown
    try {
      store.addVersion({ outputId: out.id, content: 'three', author: 'user:me', expectedParentVersionId: v1.id })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StaleWriteError)
    expect((err as StaleWriteError).currentContent).toBe('two')
    expect(store.listVersions(out.id).map((v) => v.content)).toEqual(['one', 'two'])
  })

  it('moves approved and published pointers without touching content, and keeps them apart', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch' })
    const out = store.createOutput({ projectId: p.id, kind: 'site', title: 'Site' })
    const v1 = store.addVersion({ outputId: out.id, content: '<h1>One</h1>', author: 'user:me' })
    store.approveVersion(out.id, v1.id)
    store.publishVersion(out.id, v1.id)
    const v2 = store.addVersion({ outputId: out.id, content: '<h1>Two</h1>', author: 'agent:writer' })
    const o = store.getOutput(out.id)!
    expect(o.latestVersionId).toBe(v2.id)
    expect(o.approvedVersionId).toBe(v1.id)
    expect(o.publishedVersionId).toBe(v1.id)
    expect(o.reviewState).toBe('draft')
  })

  it('lets only a person approve a decision, and supersedes the earlier one on the topic', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch' })
    const d1 = store.recordDecision({ projectId: p.id, topic: 'trial', title: 'Trial is 14 days', value: '14 days', status: 'approved' })
    const d2 = store.recordDecision({ projectId: p.id, topic: 'trial', title: 'Trial is 30 days', value: '30 days' })
    expect(() => store.approveDecision(d2.id, 'agent:writer')).toThrow(/person/)
    const ok = store.approveDecision(d2.id, 'user:me')
    expect(ok.supersedes).toBe(d1.id)
    expect(ok.previousValue).toBe('14 days')
    expect(store.getDecision(d1.id)!.status).toBe('superseded')
  })

  it('delivers supplied evidence exactly once and dedupes suggestions', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch' })
    const req = store.openRequest({ projectId: p.id, requestedBy: 'agent:writer', recipient: 'user', question: 'What is the churn rate?', topics: ['churn'] })
    const src = store.addSource({ projectId: p.id, workspaceId: work.id, kind: 'note', title: 'Churn report', content: 'Churn is 3%.' })
    store.supplyRequest(req.id, src.id)
    expect(store.markRequestDelivered(req.id)).toBe(true)
    expect(store.markRequestDelivered(req.id)).toBe(false)
    const args = { projectId: p.id, fromActor: 'agent:research', recipient: 'agent:writer', target: { type: 'output' as const, id: 'out_x' }, targetVersionId: 'ver_1', evidence: [], proposedAction: 'Use 3% churn', sourceEventId: 'evt_9' }
    expect(store.createSuggestion(args).created).toBe(true)
    expect(store.createSuggestion({ ...args, proposedAction: '  use 3% CHURN ' }).created).toBe(false)
    expect(store.createSuggestion({ ...args, targetVersionId: 'ver_2' }).created).toBe(true)
  })

  it('refuses a dependency cycle', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch' })
    const a = store.createTask({ projectId: p.id, title: 'A' })
    const b = store.createTask({ projectId: p.id, title: 'B', dependsOn: [a.id] })
    expect(() => store.setDependencies(a.id, [b.id])).toThrow(/wait on each other/)
    expect(store.getTask(b.id)!.dependsOn).toEqual([a.id])
  })

  it('detects a branch conflict when the main output changed during review', () => {
    const { store, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'Launch' })
    const out = store.createOutput({ projectId: p.id, kind: 'document', title: 'Hero' })
    const v1 = store.addVersion({ outputId: out.id, content: 'main one', author: 'user:me' })
    const branchA = store.createBranch(p.id, 'Bold')
    store.createBranch(p.id, 'Calm')
    const bOut = store.createOutput({ projectId: p.id, kind: 'document', title: 'Hero (Bold)', branchId: branchA.id })
    const bv = store.addVersion({ outputId: bOut.id, content: 'bold draft', author: 'agent:writer' })
    // Main moved on meanwhile.
    store.addVersion({ outputId: out.id, content: 'main two', author: 'user:me', expectedParentVersionId: v1.id })
    expect(() => store.applyBranchSelection({ branchId: branchA.id, mainOutputId: out.id, fromVersionId: bv.id })).toThrow(StaleWriteError)
    // After resolving against the current main version, it applies.
    const cur = store.getOutput(out.id)!.latestVersionId
    const applied = store.applyBranchSelection({ branchId: branchA.id, mainOutputId: out.id, fromVersionId: bv.id, resolvedAgainstVersionId: cur })
    expect(applied.content).toBe('bold draft')
  })

  it('keeps a personal project out of work search, and shares only the pinned version', () => {
    const { store, personal, work } = setup()
    const mine = store.createProject({ workspaceId: personal.id, title: 'Wedding speech', goal: 'secret plans' })
    store.createProject({ workspaceId: work.id, title: 'Client launch', goal: 'plans for launch' })
    const workCtx = { workspaceIds: [work.id] }
    expect(store.search(workCtx, 'plans').map((h) => h.title)).toEqual(['Client launch'])
    expect(store.listProjects(workCtx).map((p) => p.title)).toEqual(['Client launch'])
    expect(store.getProjectInCtx(workCtx, mine.id)).toBeNull()
    expect(store.listEvents(workCtx).some((e) => e.projectId === mine.id)).toBe(false)
    // Share one authorised reference.
    const out = store.createOutput({ projectId: mine.id, kind: 'document', title: 'Toast draft' })
    const v1 = store.addVersion({ outputId: out.id, content: 'Draft one', author: 'user:me' })
    store.addVersion({ outputId: out.id, content: 'Draft two (private)', author: 'user:me' })
    store.shareVersion({ outputId: out.id, versionId: v1.id, toWorkspaceId: work.id })
    const shared = store.listSharedInto(workCtx)
    expect(shared).toHaveLength(1)
    expect(shared[0].version.content).toBe('Draft one')
    expect(store.search(workCtx, 'private')).toEqual([])
    expect(store.listEvents(workCtx).some((e) => e.projectId === mine.id)).toBe(false)
  })
})

describe('Impact: trace a decision (acceptance)', () => {
  function saasMouth() {
    const { store, clock, work } = setup()
    const p = store.createProject({ workspaceId: work.id, title: 'SaaSMouth launch', brief: 'Offer: a 14-day free trial. Audience: agency owners.' })
    const brief = store.getOutput(p.briefOutputId!)!
    const briefV1 = brief.latestVersionId!
    const writer = store.createAgent({ projectId: p.id, name: 'Writer', role: 'writer' })
    const inputs = [{ type: 'version' as const, id: briefV1, versionId: briefV1, label: 'the brief v1' }]

    // Site hero: made from brief v1, approved and published.
    const heroTask = store.createTask({ projectId: p.id, title: 'Site hero', deliverableKind: 'site' })
    const hero = store.createOutput({ projectId: p.id, kind: 'site', title: 'Site hero', aiTaskId: heroTask.id })
    const r1 = store.createRun({ projectId: p.id, kind: 'model', manifest: manifest(inputs), idempotencyKey: 'r1', aiTaskId: heroTask.id, agentId: writer.id }).run
    const heroV1 = store.addVersion({ outputId: hero.id, content: 'Start your 14-day free trial today.', author: `agent:${writer.name}`, runId: r1.id, sources: inputs })
    store.setRunStatus(r1.id, 'succeeded', 'Done')
    store.approveVersion(hero.id, heroV1.id)
    store.publishVersion(hero.id, heroV1.id)

    // Image 03: made from brief v1; its caption says 14 days.
    const img = store.createOutput({ projectId: p.id, kind: 'image', title: 'Image 03' })
    const r2 = store.createRun({ projectId: p.id, kind: 'model', manifest: manifest(inputs), idempotencyKey: 'r2' }).run
    store.addVersion({ outputId: img.id, content: 'Banner: “Try it free for 14 days”', mediaRef: 'data:image/png;base64,AAA', mediaWidth: 1200, mediaHeight: 628, author: 'agent:Design', runId: r2.id, sources: inputs })
    store.setRunStatus(r2.id, 'succeeded', 'Done')
    store.approveVersion(img.id, store.getOutput(img.id)!.latestVersionId!)

    // Tomorrow's email run, queued with brief v1.
    // 48 h after start = the day after the person returns (24 h later), in any timezone.
    const emailTask = store.createTask({ projectId: p.id, title: 'Email run', scheduledAt: clock.now() + 48 * 3600_000 })
    const r3 = store.createRun({ projectId: p.id, kind: 'model', manifest: manifest(inputs), idempotencyKey: 'r3', aiTaskId: emailTask.id }).run

    // A blog post that mentions fourteen days with NO recorded link.
    const blog = store.createOutput({ projectId: p.id, kind: 'document', title: 'Blog post' })
    store.addVersion({ outputId: blog.id, content: 'Our fourteen-day trial lets agencies test everything.', author: 'user:me' })

    // An unrelated output that must not appear.
    const faq = store.createOutput({ projectId: p.id, kind: 'document', title: 'FAQ' })
    store.addVersion({ outputId: faq.id, content: 'Support is open on weekdays.', author: 'user:me' })

    const leftAt = clock.now()
    clock.advance(24 * 3600_000)

    // The change: client approves a 30-day trial. The brief is revised from it,
    // and the writer already drafted a hero revision from the new brief.
    store.recordDecision({ projectId: p.id, topic: 'trial_length', title: 'Trial is 14 days', value: '14 days', status: 'approved' })
    clock.advance(60_000)
    const dec = store.recordDecision({ projectId: p.id, topic: 'trial_length', title: 'Client approved a 30-day trial', value: '30 days', evidence: [{ type: 'source', id: 'src_email', label: 'Client email' }] })
    store.approveDecision(dec.id, 'user:me')
    clock.advance(60_000)
    const briefV2 = store.addVersion({ outputId: brief.id, content: 'Offer: a 30-day free trial. Audience: agency owners.', author: 'user:me', sources: [{ type: 'decision', id: dec.id }], changeSummary: 'Trial 14 → 30 days.' })
    store.approveVersion(brief.id, briefV2.id)
    clock.advance(60_000)
    const r4 = store.createRun({ projectId: p.id, kind: 'revision', manifest: manifest([{ type: 'version', id: briefV2.id, versionId: briefV2.id }]), idempotencyKey: 'r4', agentId: writer.id }).run
    const heroV2 = store.addVersion({ outputId: hero.id, content: 'Start your 30-day free trial today.', author: `agent:${writer.name}`, runId: r4.id, sources: [{ type: 'version', id: briefV2.id, versionId: briefV2.id }], changeSummary: 'Trial now 30 days.' })
    store.setRunStatus(r4.id, 'succeeded', 'Done')
    return { store, clock, p, hero, heroV1, heroV2, img, blog, faq, r3, leftAt, dec }
  }

  it('surfaces the revised hero, the stale image, tomorrow’s run and an inferred match with evidence', () => {
    const { store, p, hero, heroV1, heroV2, img, blog, faq, r3, dec } = saasMouth()
    const result = computeImpact(store.loadProjectState(p.id))
    const row = result.rows.find((r) => r.change.kind === 'decision' && r.change.id === `chg_${dec.id}`)!
    expect(row).toBeTruthy()
    expect(row.change.title).toBe('Client approved a 30-day trial.')
    expect(row.change.detail).toBe('Previously 14 days.')
    expect(row.change.source).toEqual({ type: 'source', id: 'src_email', label: 'Client email' })

    const byId = new Map(row.affected.map((a) => [a.ref.id, a]))
    const heroItem = byId.get(hero.id)!
    expect(heroItem.status).toBe('revision_ready')
    expect(heroItem.relation).toBe('acted')
    expect(heroItem.reason).toBe('Site hero has a revision.')
    expect(heroItem.actions[0]).toMatchObject({ id: 'compare', payload: { a: heroV1.id, b: heroV2.id } })

    const imgItem = byId.get(img.id)!
    expect(imgItem.status).toBe('stale')
    expect(imgItem.relation).toBe('recorded')
    expect(imgItem.reason).toBe('Image 03 still says 14 days.')
    expect(imgItem.evidence[0].basis).toBe('recorded')
    expect(imgItem.preview?.mediaWidth).toBe(1200)

    const runItem = byId.get(r3.id)!
    expect(runItem.status).toBe('will_use_old_input')
    expect(runItem.reason).toMatch(/^Tomorrow's Email run uses/)

    const blogItem = byId.get(blog.id)!
    expect(blogItem.relation).toBe('possible')
    expect(blogItem.status).toBe('possible_match')
    expect(blogItem.evidence[0]).toMatchObject({ basis: 'inferred' })
    expect(blogItem.evidence[0].excerpt).toContain('fourteen-day')
    const ev = blogItem.evidence[0]
    expect(ev.excerpt!.slice(ev.matchStart!, ev.matchEnd!).toLowerCase()).toBe('fourteen-day')

    expect(byId.has(faq.id)).toBe(false)
    // The row's actions read like the spec's example.
    expect(row.actions.map((a) => a.id)).toEqual(['compare', 'update_input', 'queue_revision'])
    expect(row.category).toBe('conflict')

    // Approved and published versions were preserved.
    const h = store.getOutput(hero.id)!
    expect(h.approvedVersionId).toBe(heroV1.id)
    expect(h.publishedVersionId).toBe(heroV1.id)
  })

  it('rebuilds "When I left" from the same records, with no trace of later changes', () => {
    const { store, p, hero, heroV1, leftAt } = saasMouth()
    const full = store.loadProjectState(p.id)
    const then = stateAsOf(full, leftAt)
    expect(then.outputs.find((o) => o.id === hero.id)!.latestVersionId).toBe(heroV1.id)
    expect(then.decisions).toHaveLength(0)
    const impactThen = computeImpact(then)
    expect(impactThen.rows.some((r) => r.change.kind === 'decision')).toBe(false)
    // Same output ids, same order: headings and positions stay consistent.
    const now = stateAsOf(full, full.asOf)
    expect(then.outputs.map((o) => o.id)).toEqual(now.outputs.slice(0, then.outputs.length).map((o) => o.id))
    // Replaying "now" through stateAsOf matches the stored pointers.
    for (const o of now.outputs) {
      const stored = full.outputs.find((x) => x.id === o.id)!
      expect([o.id, o.latestVersionId, o.approvedVersionId, o.publishedVersionId]).toEqual([stored.id, stored.latestVersionId, stored.approvedVersionId, stored.publishedVersionId])
    }
  })

  it('groups two changes to one output into a single proposed revision', () => {
    const { store, p, img } = saasMouth()
    // A second decision on another topic whose old value also appears in Image 03.
    store.recordDecision({ projectId: p.id, topic: 'cta', title: 'CTA is Try it free', value: 'Try it free', status: 'approved' })
    store.recordDecision({ projectId: p.id, topic: 'cta', title: 'CTA is Start now', value: 'Start now', status: 'approved' })
    const res = computeImpact(store.loadProjectState(p.id))
    const rev = res.proposedRevisions.find((r) => r.outputId === img.id)
    expect(rev).toBeTruthy()
    expect(rev!.contributingChangeIds.length).toBe(2)
  })
})

describe('value matching', () => {
  it('matches numeric values in their usual written forms', () => {
    const re = valuePattern('14 days')!
    for (const s of ['a 14-day trial', '14 days', 'fourteen days', 'Fourteen-day', '14 day']) expect(re.test(s)).toBe(true)
    for (const s of ['114 days', '14 daysx', '1.14 days', '30 days']) expect(re.test(s)).toBe(false)
  })
  it('returns an excerpt with exact match offsets', () => {
    const hit = findValue('x '.repeat(100) + 'Start your 14-day trial now. ' + 'y '.repeat(100), '14 days')!
    expect(hit.excerpt.slice(hit.start, hit.end)).toBe('14-day')
    expect(hit.excerpt.startsWith('…')).toBe(true)
  })
})
