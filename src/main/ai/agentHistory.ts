// Agent invocation history + outcome bookkeeping.
//
// Three responsibilities:
//
//   1. Record every agent invocation as it happens, so the user can
//      see what they ran, when, against which node, and what the
//      agent replied — durable across reloads and across widgets.
//
//   2. Record every outcome (applied / dismissed / undone) per
//      proposal so we can compute per-agent stats and surface a
//      track record per agent. This is the "trust UX" foundation
//      called out as PHASE_3 — having the data in place is the
//      enabler.
//
//   3. Undo the last apply. Walks back from now: finds the most
//      recent outcome with action='applied' that hasn't been undone,
//      figures out what entity was created, deletes it, marks the
//      outcome as undone. Only the kinds that are safely reversible
//      (create-task, create-widget, create-todo-list, create-page)
//      qualify. Open-url isn't undoable; we never write those as
//      applied outcomes against deletable kinds.

import { randomUUID } from 'crypto'
import type { ActionProposal } from '@shared/types'
import { getDb } from '../db/database'
import { detachAndReviveWorkItemDescendants } from '../db/nodeLifecycle'
import { workItemDetachHook } from '../db/workItems'

export interface InvocationRecord {
  id: string
  agentSlug: string
  agentName: string
  nodeId: string | null
  nodeLabel: string
  rootPath: string[]
  reply: string
  proposals: ActionProposal[]
  conversationTurn: number
  conversationKey: string
  invokedAt: number
}

interface InvocationRow {
  id: string
  agent_slug: string
  agent_name: string
  node_id: string | null
  node_label: string
  root_path: string
  reply: string
  proposals: string
  conversation_turn: number
  conversation_key: string
  invoked_at: number
}

interface OutcomeRow {
  id: string
  invocation_id: string
  agent_slug: string
  proposal_id: string
  proposal_kind: string
  action: 'applied' | 'dismissed' | 'undone'
  created_entity_ref: string | null
  at: number
}

function rowToInvocation(r: InvocationRow): InvocationRecord {
  let proposals: ActionProposal[] = []
  let rootPath: string[] = []
  try {
    proposals = JSON.parse(r.proposals) as ActionProposal[]
  } catch {
    // Already-malformed rows shouldn't crash the history view —
    // surface them with empty proposals instead.
  }
  try {
    rootPath = JSON.parse(r.root_path) as string[]
  } catch {
    rootPath = []
  }
  return {
    id: r.id,
    agentSlug: r.agent_slug,
    agentName: r.agent_name,
    nodeId: r.node_id,
    nodeLabel: r.node_label,
    rootPath,
    reply: r.reply,
    proposals,
    conversationTurn: r.conversation_turn,
    conversationKey: r.conversation_key,
    invokedAt: r.invoked_at
  }
}

export function recordInvocation(input: {
  agentSlug: string
  agentName: string
  nodeId: string | null
  nodeLabel: string
  rootPath: string[]
  reply: string
  proposals: ActionProposal[]
  conversationKey: string
}): InvocationRecord {
  const db = getDb()
  // Conversation turn = (existing rows in this conversation_key) + 1.
  // Lets the renderer reason about "turn N of M" without bookkeeping.
  const existing = db
    .prepare(
      'SELECT COUNT(*) AS c FROM agent_invocations WHERE conversation_key = ?'
    )
    .get(input.conversationKey) as { c: number }
  const turn = existing.c + 1
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO agent_invocations
       (id, agent_slug, agent_name, node_id, node_label, root_path,
        reply, proposals, conversation_turn, conversation_key, invoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.agentSlug,
    input.agentName,
    input.nodeId,
    input.nodeLabel,
    JSON.stringify(input.rootPath),
    input.reply,
    JSON.stringify(input.proposals),
    turn,
    input.conversationKey,
    now
  )
  return {
    id,
    agentSlug: input.agentSlug,
    agentName: input.agentName,
    nodeId: input.nodeId,
    nodeLabel: input.nodeLabel,
    rootPath: input.rootPath,
    reply: input.reply,
    proposals: input.proposals,
    conversationTurn: turn,
    conversationKey: input.conversationKey,
    invokedAt: now
  }
}

export function listConversation(conversationKey: string): InvocationRecord[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM agent_invocations
        WHERE conversation_key = ?
        ORDER BY conversation_turn ASC`
    )
    .all(conversationKey) as InvocationRow[]
  return rows.map(rowToInvocation)
}

// ── Outcomes ───────────────────────────────────────────────────────────────

export function recordOutcome(input: {
  invocationId: string
  agentSlug: string
  proposalId: string
  proposalKind: string
  action: 'applied' | 'dismissed' | 'undone'
  createdEntityRef?: string | null
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO agent_outcomes
       (id, invocation_id, agent_slug, proposal_id, proposal_kind,
        action, created_entity_ref, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    input.invocationId,
    input.agentSlug,
    input.proposalId,
    input.proposalKind,
    input.action,
    input.createdEntityRef ?? null,
    Date.now()
  )
}

export interface AgentStats {
  slug: string
  invocations: number
  totalProposals: number
  applied: number
  dismissed: number
  undone: number
  applyRate: number
}

export function statsForSlug(slug: string): AgentStats {
  const db = getDb()
  const invCount = (
    db
      .prepare('SELECT COUNT(*) AS c FROM agent_invocations WHERE agent_slug = ?')
      .get(slug) as { c: number }
  ).c
  const totalProposalsAgg = db
    .prepare(
      `SELECT proposals FROM agent_invocations WHERE agent_slug = ?`
    )
    .all(slug) as Array<{ proposals: string }>
  let totalProposals = 0
  for (const r of totalProposalsAgg) {
    try {
      totalProposals += (JSON.parse(r.proposals) as ActionProposal[]).length
    } catch {
      // skip malformed
    }
  }
  const applied = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_outcomes
          WHERE agent_slug = ? AND action = 'applied'`
      )
      .get(slug) as { c: number }
  ).c
  const dismissed = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_outcomes
          WHERE agent_slug = ? AND action = 'dismissed'`
      )
      .get(slug) as { c: number }
  ).c
  const undone = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_outcomes
          WHERE agent_slug = ? AND action = 'undone'`
      )
      .get(slug) as { c: number }
  ).c
  const reviewed = applied + dismissed
  const applyRate = reviewed === 0 ? 0 : applied / reviewed
  return {
    slug,
    invocations: invCount,
    totalProposals,
    applied,
    dismissed,
    undone,
    applyRate
  }
}

// ── Undo last apply ────────────────────────────────────────────────────────

export interface UndoResult {
  ok: boolean
  // Human-readable summary of what was undone — surface in a toast.
  message: string
  // Pointer to the deleted entity so the renderer can drop it from
  // local stores if necessary.
  entityRef?: string | null
}

/**
 * Find the most recent applied outcome that has NOT been undone, and
 * reverse its effect. Inverts these proposal kinds:
 *   - create-task  → delete the created node
 *   - create-widget / create-todo-list / create-page → delete the
 *     created widget
 *
 * Outcomes whose `created_entity_ref` is null (e.g. open-url) are
 * skipped — they aren't reversible.
 */
export function undoLastApply(): UndoResult {
  const db = getDb()
  // Most recent applied outcome that doesn't already have a sibling
  // 'undone' outcome for the same proposal_id.
  const row = db
    .prepare(
      `SELECT o.* FROM agent_outcomes o
        WHERE o.action = 'applied'
          AND o.created_entity_ref IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_outcomes u
             WHERE u.proposal_id = o.proposal_id
               AND u.action = 'undone'
               AND u.at > o.at
          )
        ORDER BY o.at DESC
        LIMIT 1`
    )
    .get() as OutcomeRow | undefined

  if (!row) {
    return { ok: false, message: 'Nothing to undo.' }
  }

  const ref = row.created_entity_ref!
  const sepIdx = ref.indexOf(':')
  if (sepIdx === -1) {
    return { ok: false, message: 'Outcome record malformed; cannot undo.' }
  }
  const kind = ref.slice(0, sepIdx)
  const id = ref.slice(sepIdx + 1)

  try {
    if (kind === 'task') {
      // Sanctioned hard-delete site 2/3 (§2.5.3): the FK cascade on
      // nodes.parent_id cannot be kind-filtered, so any work_item that landed
      // under this agent-created desk is detached-and-revived first — the
      // undo removes what the agent made, never the user's attention items.
      detachAndReviveWorkItemDescendants(db, [id], workItemDetachHook(db))
      // ci-delete-allowlist: agentHistory undo (§2.5.3 lock — sanctioned site 2/4)
      db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
    } else if (kind === 'widget') {
      db.prepare('DELETE FROM widgets WHERE id = ?').run(id)
    } else {
      return {
        ok: false,
        message: `Don't know how to undo entity kind "${kind}".`
      }
    }
  } catch (err) {
    return {
      ok: false,
      message: `Could not delete ${ref}: ${(err as Error).message}`
    }
  }

  // Mark the original outcome as undone.
  recordOutcome({
    invocationId: row.invocation_id,
    agentSlug: row.agent_slug,
    proposalId: row.proposal_id,
    proposalKind: row.proposal_kind,
    action: 'undone',
    createdEntityRef: row.created_entity_ref
  })
  return {
    ok: true,
    message: `Undid ${row.proposal_kind} (${ref})`,
    entityRef: row.created_entity_ref
  }
}
