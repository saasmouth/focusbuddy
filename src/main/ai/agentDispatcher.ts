// Agent dispatcher — Phase 2C FOUNDATION.
//
// This is NOT the autonomous agent runtime. That's a 2-4 week project
// in its own right (PHASE_3 markers throughout, see below). What this
// file does is the floor that makes Phase 3 tractable:
//
//   - One IPC entry point to "invoke an agent" against a node's
//     context, with the result piped back to the renderer as
//     ActionProposal[] for human review and apply-via-existing-flow.
//   - Each invocation is bounded: a single message exchange with
//     Claude, the agent's system prompt loaded from its .md file,
//     no follow-up turns, no canvas write access from main.
//   - The proposals returned use the SAME ActionProposal schema the
//     chat panel already applies — so the user gets a familiar
//     review-then-accept flow with no new UI primitives.
//
// PHASE_3 work that builds on this foundation:
//   - Multi-turn agent loops with a kill switch + token budget
//   - Scheduler that watches canvas state changes + triggers agents
//     on configurable conditions (new task / overdue task / etc.)
//   - Audit log: every agent invocation, its inputs, its outputs,
//     and what the user did with each proposal
//   - Trust UX: green/yellow/red badge per agent based on track
//     record (apply rate, refute rate, undo rate)
//   - Inter-agent dispatch — one agent invokes another via the same
//     bounded contract instead of inlining the work
//   - Cross-user messaging once identity infra exists

import { readFileSync } from 'fs'
import type Anthropic from '@anthropic-ai/sdk'
import { getModelClient } from './modelClient'
import { randomUUID } from 'crypto'
import { ADD_SUBTASK_DEFINITION, CREATE_TASK_DEFINITION } from './vocabulary'
import { normalizeIntentClass } from '@shared/workItems'
import type { ActionProposal } from '@shared/types'
import { resolveAnthropicKey } from '../settingsStore'
import { recordInvocation } from './agentHistory'
import { MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET } from './modelRouting'

export interface AgentInvocationContext {
  // Absolute path to the agent's .md file. The system prompt is
  // extracted from this — body after the YAML frontmatter.
  agentPath: string
  // Mind-map context the user wants the agent to act on.
  rootPath: string[]
  nodeLabel: string
  nodeKind: string
  // Optional user-typed message — "do this for me", "summarise",
  // "draft three options". Empty string means "just do whatever
  // your role implies for this node".
  userMessage: string
  // Phase 2 polish — multi-turn conversation. When the user replies
  // to an agent's first response, we feed Claude the full prior
  // exchange as message history. Capped at MAX_CONVERSATION_TURNS to
  // bound runaway costs + protect against infinite loops.
  //
  // Each entry is one turn — 'user' messages are what the human
  // typed, 'agent' messages are the JSON contract output from a
  // previous invocation (we send the raw reply string back, NOT the
  // parsed structure, so Claude reads its own prior reasoning).
  conversationHistory?: Array<{ role: 'user' | 'agent'; content: string }>
  // Optional identifier so the history bookkeeping in agentHistory.ts
  // can group turns under one conversation. Defaults to "<nodeId>:<slug>"
  // shaped strings the renderer constructs.
  conversationKey?: string
  // Optional node id for history attribution.
  nodeId?: string | null
}

// Hard cap on conversation length. Stops the user from accidentally
// rolling 50-turn conversations against Sonnet. The renderer should
// surface "conversation full" UI when length reaches this.
export const MAX_CONVERSATION_TURNS = 5

export interface InvokeOk {
  ok: true
  agentName: string
  // Plain-text reply from the agent. Always shown to the user even
  // if proposals are empty — gives the agent a way to say "I need
  // more info before I can propose actions."
  reply: string
  // Concrete ActionProposals the user can accept individually or
  // in bulk. Same schema chat panel already applies.
  proposals: ActionProposal[]
  // History attribution. The renderer references these when the
  // user applies / dismisses / undoes a proposal so outcomes get
  // attributed to the right invocation row.
  invocationId: string
  conversationTurn: number
  conversationCapped: boolean
}
export interface InvokeErr {
  ok: false
  error: string
  reason?: 'no_key' | 'agent_not_found' | 'agent_unreadable' | 'api' | 'parse'
}

/**
 * Bounded single-turn invocation. Loads the agent's system prompt
 * from its markdown file, prepends a small contract preamble (return
 * JSON, propose don't act), sends one message to Claude, parses the
 * result.
 */
export async function invokeAgent(
  ctx: AgentInvocationContext
): Promise<InvokeOk | InvokeErr> {
  const key = resolveAnthropicKey()
  if (!key) {
    return {
      ok: false,
      error: 'No Anthropic key set. Add one in Settings → AI · API keys.',
      reason: 'no_key'
    }
  }

  // Load the agent file. Strip frontmatter — Claude's API doesn't
  // need the YAML, only the body is the actual instruction set.
  let raw: string
  try {
    raw = readFileSync(ctx.agentPath, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Agent file unreadable at ${ctx.agentPath}: ${(err as Error).message}`,
      reason: 'agent_unreadable'
    }
  }
  const { frontmatter, body } = splitFrontmatter(raw)
  const agentName = frontmatter.name ?? 'Agent'
  const modelOverride = frontmatter.model
  // Map kit conventions ("opus") to current model IDs. The kit's
  // agent files use short tier labels; the SDK needs concrete IDs.
  const model = mapModelTier(modelOverride ?? 'sonnet')

  // We give the agent a strict output contract so the renderer can
  // apply its proposals via the existing ActionProposal pipeline
  // without per-agent custom parsing.
  const CONTRACT =
    '\n\n---\n\n' +
    '## Invocation contract (added at runtime; do NOT remove from output)\n\n' +
    'You are being invoked SINGLE-TURN. Read the context the user provides, then return a JSON object with this shape and NOTHING ELSE — no preamble, no markdown fence, no commentary:\n\n' +
    '```\n' +
    '{\n' +
    '  "reply": "<plain-text reply explaining what you propose and why, 1-4 short paragraphs>",\n' +
    '  "proposals": [\n' +
    '    /* zero or more ActionProposal items. Each MUST be one of these shapes: */\n' +
    '    {"kind":"add-subtask","title":"…","notes":"…","reason":"…"},  /* ' +
    ADD_SUBTASK_DEFINITION +
    ' */\n' +
    '    {"kind":"create-task","title":"…","notes":"…","reason":"…"},  /* ' +
    CREATE_TASK_DEFINITION +
    ' */\n' +
    '    {"kind":"create-todo-list","title":"…","items":["…","…"],"reason":"…"},\n' +
    '    {"kind":"create-widget","widgetKind":"sticky"|"note"|"markdown"|"page","title":"…","content":"…","reason":"…"},\n' +
    '    {"kind":"create-page","title":"…","content":"…","reason":"…"}\n' +
    '  ]\n' +
    '}\n' +
    '```\n\n' +
    'Rules:\n' +
    '- ALWAYS include both `reply` and `proposals` keys, even if proposals is `[]`.\n' +
    '- 0-6 proposals max. Quality over quantity.\n' +
    '- If you need more context before proposing actions, return `proposals: []` and explain what you need in `reply`.\n' +
    '- Do NOT mutate anything yourself. You can only propose — the user applies.'

  const system = body + CONTRACT

  const history = ctx.conversationHistory ?? []
  const prevTurns = history.length

  // Cap enforcement. We count BOTH sides of the prior exchange as
  // turns — one full back-and-forth is two turns. Refuse politely if
  // we'd push past MAX_CONVERSATION_TURNS so the user gets a clear
  // signal instead of mysteriously high bills.
  // PHASE_3 follow-up: a per-conversation token budget instead of a
  // hard turn count, so a chatty agent and a curt user can have more
  // exchanges than a verbose pair.
  if (prevTurns >= MAX_CONVERSATION_TURNS * 2) {
    return {
      ok: false,
      error: `Conversation is at the ${MAX_CONVERSATION_TURNS}-turn cap. Start a fresh invocation for further work.`,
      reason: 'api'
    }
  }

  // Build the messages array. Prior history first (each entry is one
  // turn), then the new user message tail.
  type ApiMessage = { role: 'user' | 'assistant'; content: string }
  const messages: ApiMessage[] = []
  if (history.length === 0) {
    // First turn — inject the mind-map context preamble.
    const userMsg =
      `Mind-map context:\n` +
      `${ctx.rootPath.concat([ctx.nodeLabel]).join(' › ')}\n` +
      `Node kind: ${ctx.nodeKind}\n` +
      `\n` +
      (ctx.userMessage.trim()
        ? `User says: ${ctx.userMessage.trim()}\n`
        : `User has not added a specific request — apply your role to the node above.\n`)
    messages.push({ role: 'user', content: userMsg })
  } else {
    // Continuing a conversation. Replay history as alternating
    // user/assistant turns. The renderer is responsible for the
    // alternation; we trust it but defensively filter empties.
    for (const t of history) {
      if (!t.content.trim()) continue
      messages.push({
        role: t.role === 'agent' ? 'assistant' : 'user',
        content: t.content
      })
    }
    // And the new user reply.
    if (!ctx.userMessage.trim()) {
      return {
        ok: false,
        error: 'A follow-up turn needs a user message — leave it blank to start a fresh invocation instead.',
        reason: 'api'
      }
    }
    messages.push({ role: 'user', content: ctx.userMessage.trim() })
  }

  // eslint-disable-next-line no-console
  console.log(
    `[agentDispatcher] invoking "${agentName}" on "${ctx.nodeLabel}" — turn ${prevTurns + 1}/${MAX_CONVERSATION_TURNS * 2}`
  )

  const client = getModelClient(key)
  let parsed: { reply: string; proposals: ActionProposal[] }
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 2048,
      system,
      messages
    })
    const text = extractText(resp).trim()
    const parsedOrErr = parseInvokeResult(text)
    if (!parsedOrErr.ok) {
      return parsedOrErr
    }
    parsed = { reply: parsedOrErr.reply, proposals: parsedOrErr.proposals }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: msg.length > 240 ? msg.slice(0, 240) + '…' : msg,
      reason: 'api'
    }
  }

  // Record in the history table. We do this AFTER the parse so we
  // don't persist garbage rows for malformed model output. The
  // conversation_key + turn give the UI everything it needs to render
  // a clean transcript later.
  const conversationKey =
    ctx.conversationKey ?? `${ctx.nodeId ?? 'orphan'}:${agentName}`
  const record = recordInvocation({
    agentSlug: deriveSlugFromPath(ctx.agentPath),
    agentName,
    nodeId: ctx.nodeId ?? null,
    nodeLabel: ctx.nodeLabel,
    rootPath: ctx.rootPath,
    reply: parsed.reply,
    proposals: parsed.proposals,
    conversationKey
  })

  const newTurnCount = prevTurns + 2 // user + agent
  const capped = newTurnCount >= MAX_CONVERSATION_TURNS * 2

  return {
    ok: true,
    agentName,
    reply: parsed.reply,
    proposals: parsed.proposals,
    invocationId: record.id,
    conversationTurn: record.conversationTurn,
    conversationCapped: capped
  }
}

// Derive a slug for the history table. The agentPath looks like
// "/abs/path/.claude/agents/<slug>.md" — we take the basename minus
// the extension. Lets us join across the live agents directory + the
// history rows even if the user renames an agent.
function deriveSlugFromPath(agentPath: string): string {
  const base = agentPath.split('/').pop() ?? agentPath
  return base.replace(/\.md$/, '')
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractText(resp: Anthropic.Message): string {
  const out: string[] = []
  for (const block of resp.content) {
    if (block.type === 'text') out.push(block.text)
  }
  return out.join('\n').trim()
}

function mapModelTier(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'opus':
      return MODEL_OPUS
    case 'haiku':
      return MODEL_HAIKU
    case 'sonnet':
    default:
      return MODEL_SONNET
  }
}

interface SplitResult {
  frontmatter: { name?: string; model?: string; description?: string }
  body: string
}

function splitFrontmatter(raw: string): SplitResult {
  const trimmed = raw.replace(/^﻿/, '')
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: {}, body: trimmed }
  const fmBlock = trimmed.slice(3, end)
  const body = trimmed.slice(end + 4).trimStart()
  const fm: SplitResult['frontmatter'] = {}
  for (const key of ['name', 'model', 'description'] as const) {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fmBlock)
    if (m) {
      let v = m[1].trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      fm[key] = v
    }
  }
  return { frontmatter: fm, body }
}

type ParseOk = { ok: true; reply: string; proposals: ActionProposal[] }
type ParseErr = InvokeErr
function parseInvokeResult(raw: string): ParseOk | ParseErr {
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    return {
      ok: false,
      error: 'Agent did not return a JSON object.',
      reason: 'parse'
    }
  }
  let obj: unknown
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse failed: ${(err as Error).message}`,
      reason: 'parse'
    }
  }
  if (typeof obj !== 'object' || obj === null) {
    return { ok: false, error: 'Not an object.', reason: 'parse' }
  }
  const o = obj as Record<string, unknown>
  const reply = typeof o.reply === 'string' ? o.reply : ''
  const proposalsRaw = Array.isArray(o.proposals) ? o.proposals : []
  const proposals: ActionProposal[] = []
  for (const p of proposalsRaw.slice(0, 6)) {
    if (typeof p !== 'object' || p === null) continue
    const pp = p as Record<string, unknown>
    const kind = pp.kind
    const id = randomUUID()
    if (kind === 'create-work-item' && typeof pp.title === 'string') {
      // Reserved Attention-layer kind (S0): parsed everywhere, executes nowhere
      // until the work-items capability ships.
      proposals.push({
        id,
        kind: 'create-work-item',
        title: pp.title,
        notes: typeof pp.notes === 'string' ? pp.notes : undefined,
        intentClass: normalizeIntentClass(pp.intentClass),
        reason: typeof pp.reason === 'string' ? pp.reason : undefined
      })
    } else if (kind === 'add-subtask' && typeof pp.title === 'string') {
      proposals.push({
        id,
        kind: 'add-subtask',
        title: pp.title,
        notes: typeof pp.notes === 'string' ? pp.notes : undefined,
        parentId: typeof pp.parentId === 'string' ? pp.parentId : undefined,
        reason: typeof pp.reason === 'string' ? pp.reason : undefined
      })
    } else if (kind === 'create-task' && typeof pp.title === 'string') {
      proposals.push({
        id,
        kind: 'create-task',
        title: pp.title,
        notes: typeof pp.notes === 'string' ? pp.notes : undefined,
        parentId: typeof pp.parentId === 'string' ? pp.parentId : undefined,
        reason: typeof pp.reason === 'string' ? pp.reason : undefined
      })
    } else if (
      kind === 'create-todo-list' &&
      typeof pp.title === 'string' &&
      Array.isArray(pp.items)
    ) {
      proposals.push({
        id,
        kind: 'create-todo-list',
        title: pp.title,
        items: pp.items.filter((x): x is string => typeof x === 'string'),
        reason: typeof pp.reason === 'string' ? pp.reason : undefined
      })
    } else if (
      kind === 'create-widget' &&
      typeof pp.widgetKind === 'string' &&
      ['sticky', 'note', 'markdown', 'page'].includes(pp.widgetKind)
    ) {
      proposals.push({
        id,
        kind: 'create-widget',
        widgetKind: pp.widgetKind as 'sticky' | 'note' | 'markdown' | 'page',
        title: typeof pp.title === 'string' ? pp.title : undefined,
        content: typeof pp.content === 'string' ? pp.content : undefined,
        reason: typeof pp.reason === 'string' ? pp.reason : undefined
      })
    } else if (
      kind === 'create-page' &&
      typeof pp.title === 'string' &&
      typeof pp.content === 'string'
    ) {
      proposals.push({
        id,
        kind: 'create-page',
        title: pp.title,
        content: plainTextToTiptapJson(pp.content),
        reason: typeof pp.reason === 'string' ? pp.reason : undefined
      })
    }
  }
  return { ok: true, reply, proposals }
}

function plainTextToTiptapJson(text: string): string {
  const paragraphs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: l }]
    }))
  return JSON.stringify({ type: 'doc', content: paragraphs })
}
