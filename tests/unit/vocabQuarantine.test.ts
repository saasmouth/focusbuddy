import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CREATE_WORK_ITEM_KIND,
  CREATE_TASK_DEFINITION,
  PROTOCOL_VOCAB_NOTE,
  workItemCatalogAddendum
} from '../../src/main/ai/vocabulary'
import { CREATION_KINDS, gateCreation } from '../../src/main/ai/creationGate'
import type { ActionProposal } from '../../src/shared/types'

// SPEC-044 (Attention layer S0) — the protocol vocabulary quarantine.
//
// One word, three senses: node kind 'task' / wire verb 'create-task' = a DESK
// (frozen protocol, saved Flows persist it); 'work_item' = the new to-do-like
// attention entity; agent-browse "task" = a browsing goal. These tests are
// grep-locks on the source of truth: every model-visible create-task definition
// must come from vocabulary.ts, the reserved 'create-work-item' verb must be
// parsed by all five proposal parsers, and the gated addendum must never leak
// into prompts while the capability is off.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

const anthropic = read('src/main/ai/anthropic.ts')
const dispatcher = read('src/main/ai/agentDispatcher.ts')
const voiceNote = read('src/main/ai/voiceNote.ts')
const mindMap = read('src/main/ai/mindMap.ts')
const flowsDb = read('src/main/db/flows.ts')
const apiServer = read('src/main/apiServer.ts')

describe('vocabulary module', () => {
  // DEC-144 rewrite: this pinned '' while the capability was OFF. The flag is
  // retired (Focus is always on), so the addendum always teaches the verb.
  it('the addendum always teaches the verb (the capability flag is retired)', () => {
    const on = workItemCatalogAddendum()
    expect(on).toContain(CREATE_WORK_ITEM_KIND)
    expect(on).toContain('WORK ITEM')
    // The rule-4 refinement ships exactly when the tool exists, not before.
    expect(on).toContain('create-todo-list')
  })

  it('@attention anywhere is a standing order that must ALSO ride alongside a build action', () => {
    // Operator live QA: "i need to create a pitch deck for cetra by friday
    // @attention" produced ONLY a create-page — the item never reached the
    // queue. Mid-sentence @attention keeps the model path by DEC-027, so the
    // rule has to make the obligation unmissable and explicitly non-exclusive.
    const on = workItemCatalogAddendum()
    expect(on).toContain('ANYWHERE in the message')
    expect(on).toContain('STANDING ORDER')
    expect(on).toMatch(/emit\s+BOTH/)
    expect(on).toContain('Emitting only the build action is a FAILURE')
    // It picks from the eight primaries (taxonomy alignment).
    expect(on).toContain('to_decide')
    expect(on).toContain('to_respond')
  })

  it('the desk definition says desk and forbids the to-do reading', () => {
    expect(CREATE_TASK_DEFINITION).toContain('DESK')
    expect(CREATE_TASK_DEFINITION).toMatch(/NOT a to-do/)
    expect(PROTOCOL_VOCAB_NOTE).toContain('ALWAYS means a DESK')
  })
})

describe('prompt sites import the shared definitions (no local redefinitions)', () => {
  it.each([
    ['src/main/ai/anthropic.ts', anthropic],
    ['src/main/ai/agentDispatcher.ts', dispatcher],
    ['src/main/ai/voiceNote.ts', voiceNote],
    ['src/main/ai/mindMap.ts', mindMap]
  ])('%s imports ./vocabulary', (_name, src) => {
    expect(src).toMatch(/from '\.\/vocabulary'/)
  })

  it('anthropic.ts interpolates the shared definition at its create-task catalog sites', () => {
    // The shared chat+agent catalog entry and the desk-agent/workspace-suggestion
    // entries all append CREATE_TASK_DEFINITION rather than restating it.
    const sites = anthropic.match(/CREATE_TASK_DEFINITION/g) ?? []
    expect(sites.length).toBeGreaterThanOrEqual(3)
    expect(anthropic).toContain('PROTOCOL_VOCAB_NOTE')
  })

  it('the "short action" to-do-teaching example is gone', () => {
    expect(anthropic).not.toContain('"title":"short action"')
    expect(anthropic).not.toContain('short task title')
  })

  it('the meeting-wrapup rule defines create-task as a desk (assembled from vocabulary since S5)', () => {
    const vocab = readFileSync(join(ROOT, 'src/main/ai/vocabulary.ts'), 'utf-8')
    // DEC-144: the OFF phrasing ("it creates a DESK") retired with the flag;
    // the one rule left still defines create-task as a desk.
    expect(vocab).toContain('deserves its own DESK')
    expect(anthropic).toContain('meetingCaptureRule()')
    expect(anthropic).not.toContain('(each task opens its own workspace)')
  })

  it('the update-task rule and catalog speak desk while keeping the wire values', () => {
    expect(anthropic).toContain('To change the CURRENT desk')
    // The wire contract is untouched: field names, kind names, status values.
    expect(anthropic).toContain('status must be one of open|in_progress|done|parked')
    expect(anthropic).toContain('"kind": "update-task", "taskId"')
  })

  it('the mind-map prompt scopes its map-local "task" sense', () => {
    expect(mindMap).toContain('MINDMAP_TASK_SCOPE_NOTE')
  })
})

describe('create-work-item is reserved end-to-end', () => {
  it('all five proposal parsers have an arm for it', () => {
    // parseChatJson + suggestWorkspaceActions + parseMeetingDeliverables all
    // live in anthropic.ts — three distinct arms required there.
    const arms = anthropic.match(/case 'create-work-item'/g) ?? []
    expect(arms.length).toBeGreaterThanOrEqual(3)
    expect(dispatcher).toContain("kind === 'create-work-item'")
    expect(voiceNote).toContain("kind === 'create-work-item'")
  })

  it('the creation gate holds it in discovery like every other build kind', () => {
    expect(CREATION_KINDS.has('create-work-item')).toBe(true)
    const proposal: ActionProposal = {
      id: 'wi-1',
      kind: 'create-work-item',
      title: 'Call Bob about the lease'
    }
    const gated = gateCreation({
      proposals: [proposal],
      question: undefined,
      discovery: true,
      greenLit: false,
      supportsQuestions: false
    })
    expect(gated.proposals).toHaveLength(0)
    expect(gated.notice).toBeTruthy()
  })

  it('the executor routes it through the one code path (real since S5)', () => {
    const executor = read('src/renderer/src/lib/actionExecutor.ts')
    expect(executor).toContain("case 'create-work-item':")
    // S5 replaced the S0 no-op with the real apply; the typed refusals from
    // the db module still surface honestly through the catch.
    expect(executor).toContain('applyCreateWorkItem')
  })

  // DEC-144 rewrite: was "flag-checked" — the flag is retired, so both catalog
  // consumers inject the addendum unconditionally.
  it('the addendum reaches both catalog consumers', () => {
    const injections = anthropic.match(/workItemCatalogAddendum\(\)/g) ?? []
    expect(injections.length).toBe(2)
    expect(anthropic).not.toContain('isWorkItemsEnabled')
  })
})

describe('published protocol strings are untouched', () => {
  it('the wire verbs and event names survive verbatim', () => {
    // Saved Flows persist these; the quarantine renames labels, never protocol.
    expect(read('src/shared/flows.ts')).toContain("'task-completed'")
    expect(flowsDb).toContain("case 'create-task'")
    expect(anthropic).toContain('"kind": "create-task"')
    // The flow engine still creates a desk node from the frozen verb.
    expect(flowsDb).toMatch(/kind: 'task', title/)
  })

  it('the flow engine fails honestly on an unknown persisted action type', () => {
    expect(flowsDb).toContain('Unknown action type')
  })

  it('the local API cannot mint arbitrary node kinds', () => {
    // apiServer hardcodes kind:'task' at its node-create route; work_items can
    // never arrive through it until a deliberate arm ships (S3+).
    expect(apiServer).toContain("kind: 'task'")
    expect(apiServer).not.toContain('create-work-item')
  })
})
