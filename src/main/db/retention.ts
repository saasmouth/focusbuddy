// DEC-056 / DEC-057 — the retention sweep, and the caller that makes caps real.
//
// Every prune function in this codebase was written and then never called.
// `pruneActivity()` (activity.ts, nominal cap 5,000), `pruneHistory()`
// (browsing.ts, nominal cap 500) and `pruneOutbox()` (eventStore.ts) all had
// zero call sites outside their own definitions, so the tables they claim to
// bound grew without limit. On the operator's machine that produced an
// `event_outbox` of 764,373 rows / 89.4 MB including its index, and an
// `activity_log` of 52,208 rows against its own declared 5,000. A cap that
// nothing invokes is a comment, not a cap.
//
// DEC-056 wired the outbox. DEC-057 wired the other two, which needed a product
// decision first (they hold user-visible history) and a policy change second —
// `activity_log`'s original table-wide cap would have evicted real history to
// make room for telemetry. All three now have exactly one caller: this file.
// If you add a fourth prune anywhere, it belongs in `runRetentionSweep()` or it
// does not exist.
//
// ── What this sweep MUST NOT touch ──────────────────────────────────────────
// Events are not prunable and cannot be made prunable. Four independent
// mechanisms say so, and they agree deliberately:
//
//   1. PLX-EVT-030 — the Event Store MUST be immutable and append-only; "no
//      interface, including administrative and database-level access" may
//      delete a written Event. A pruneEvents() would BE that interface.
//   2. PLX-EVT-031 — replay MUST reconstruct the state of any Desk at any
//      point in its history. Deleting old Events deletes old history.
//   3. `events_no_delete` — a BEFORE DELETE trigger that RAISE(ABORT)s, so the
//      database refuses even if application code asks.
//   4. PLX-DATA-012 / INV-05 / DOM-043 — `assertRetentionTarget()` holds
//      'events' in PROTECTED_TARGETS and throws by construction.
//
// So every target below is routed through `assertRetentionTarget()` before a
// single row is deleted. That is not ceremony: it means a future edit that
// adds a protected target to this list fails loudly instead of quietly
// deleting history the spec promises is replayable.
//
// `event_outbox` is a different kind of thing and that is why it qualifies. It
// is delivery bookkeeping — one row per Event still awaiting publication to
// the bus — and it carries no history of its own. The Event each row points at
// stays in `events`, fully replayable, whether or not the pointer survives.
// Capping the queue therefore destroys nothing any requirement protects. It
// needs a cap precisely because it gains a row per Event and only sheds one
// when a publisher drains it; with no bus attached, nothing ever drains it.

import { assertRetentionTarget } from '../privacy/erasure'
import { getContextEngine, emitObjectEvent } from '../context/engine'
import { getDb } from './database'
import {
  pruneActivity,
  ACTIVITY_RETENTION,
  NAV_KIND,
  type ActivityRetentionPolicy,
  type PruneDb
} from './activity'
import { pruneHistory, HISTORY_KEEP } from './browsing'

export interface RetentionOutcome {
  target: string
  removed: number
  kept: number
}

// The queue depth to retain. Deep enough that a bus attaching later still finds
// a useful recent backlog to publish; shallow enough that the table stays flat.
export const OUTBOX_KEEP = 5_000

// Sweep the transactional outbox down to its cap.
//
// Note on the audit record: this deliberately does NOT reuse
// `applyRetentionPolicyEvent()` from context/workspaceMemory. That helper's
// `RetentionPolicy` is age-based (`maxAgeDays`), and this cap is count-based —
// calling it would require inventing a maxAgeDays that was never applied,
// which would put a false number in an auditable record. The guard that
// actually matters (`assertRetentionTarget`) is invoked directly instead, and
// the emitted Event describes what genuinely happened.
export function sweepOutbox(keep = OUTBOX_KEEP): RetentionOutcome {
  const target = 'event_outbox'
  assertRetentionTarget(target) // throws for 'events' — see the header

  const engine = getContextEngine()
  const removed = engine.events.pruneOutbox(keep)
  const kept = (engine.db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get() as { n: number }).n

  // Applying retention is itself an auditable act (PLX-PRD-034 / PLX-DATA-010).
  // Emit only when rows actually moved, so a steady-state boot stays silent
  // rather than writing an unprunable Event to say it did nothing.
  if (removed > 0) {
    emitObjectEvent({
      eventType: 'RetentionPolicyApplied',
      category: 'administrative',
      currentState: { target, policy: 'keep-newest', keep, removed, kept },
      changeSummary: `Retention applied to ${target}: ${removed} queued rows released, ${kept} retained`
    })
  }

  return { target, removed, kept }
}

// ── DEC-057 — activity_log ───────────────────────────────────────────────────
// DEC-056 deliberately left this table alone. The reasoning was sound: unlike
// the outbox, `activity_log` is USER-VISIBLE history — it backs the activity
// feed (RecentActivityCard), `browser_nav` rows included — so capping it is a
// product decision rather than housekeeping, and 47,000 rows of somebody's own
// history is not a call an implementation detail gets to make.
//
// Measuring the table is what made it answerable. 96% of it is `browser_nav`,
// and 76% of the entire table is a single ~19-hour burst of it (~35 rows a
// minute on 2026-06-29→30). Only 2,088 rows are the kinds a person would
// recognise in a feed. So the product question was never "delete 47,000 pieces
// of history" — it was "cap runaway navigation telemetry without touching the
// 2,088 rows that mean something", and those are separable. The per-kind policy
// in `pruneActivity()` separates them; see its comment for the full census.
//
// Note on the audit record — the same reasoning as `sweepOutbox()` above, one
// step further. `applyRetentionPolicyEvent()` (context/workspaceMemory) models
// retention as `{layer, target, maxAgeDays}`, and this policy is genuinely
// hybrid: an age ceiling AND a per-organisation count cap on one kind. Routing
// it through that helper would record the age half and silently drop the half
// that removed 48,120 of the rows, which is a worse audit record than no helper
// at all. The guard that carries the actual weight — `assertRetentionTarget()`
// — is called directly, exactly as `sweepOutbox()` calls it, and the Event
// below describes both dimensions of what really happened.
export function sweepActivity(policy: ActivityRetentionPolicy = ACTIVITY_RETENTION): RetentionOutcome {
  const target = 'activity_log'
  assertRetentionTarget(target) // throws for 'events' — see the header

  const db = getDb()
  const { navRemoved, agedRemoved, removed } = pruneActivity(policy, db as unknown as PruneDb)
  const kept = (db.prepare('SELECT COUNT(*) AS n FROM activity_log').get() as { n: number }).n

  if (removed > 0) {
    emitObjectEvent({
      eventType: 'RetentionPolicyApplied',
      category: 'administrative',
      currentState: {
        target,
        policy: 'per-kind: keep-newest-per-org + max-age',
        navKind: NAV_KIND,
        navKeep: policy.navKeep,
        maxAgeDays: policy.maxAgeDays,
        navRemoved,
        agedRemoved,
        removed,
        kept
      },
      changeSummary:
        `Retention applied to ${target}: ${removed} rows released ` +
        `(${navRemoved} ${NAV_KIND} over the ${policy.navKeep}/org cap, ` +
        `${agedRemoved} past ${policy.maxAgeDays} days), ${kept} retained`
    })
  }

  return { target, removed, kept }
}

// ── DEC-057 — browsing_history ───────────────────────────────────────────────
// The last cap in the codebase that was declared and never called. Small in
// practice (814 rows / 0.27 MB against a declared 500), so this is about
// leaving no prune function uncalled rather than reclaiming space: an
// unenforced cap reads as a guarantee and isn't one.
export function sweepBrowsing(keep: number = HISTORY_KEEP): RetentionOutcome {
  const target = 'browsing_history'
  assertRetentionTarget(target)

  const db = getDb()
  const removed = pruneHistory(keep, db as unknown as PruneDb)
  const kept = (db.prepare('SELECT COUNT(*) AS n FROM browsing_history').get() as { n: number }).n

  if (removed > 0) {
    emitObjectEvent({
      eventType: 'RetentionPolicyApplied',
      category: 'administrative',
      currentState: { target, policy: 'keep-newest-per-org', keep, removed, kept },
      changeSummary: `Retention applied to ${target}: ${removed} entries released, ${kept} retained`
    })
  }

  return { target, removed, kept }
}

// Run every bounded-table sweep. Non-fatal by contract: retention is
// housekeeping and must never be able to take the app down with it. Each target
// is isolated so one failing sweep cannot suppress the others.
export function runRetentionSweep(): RetentionOutcome[] {
  const outcomes: RetentionOutcome[] = []
  const sweeps: [string, () => RetentionOutcome][] = [
    ['outbox', sweepOutbox],
    ['activity', () => sweepActivity()],
    ['browsing', () => sweepBrowsing()]
  ]
  for (const [name, run] of sweeps) {
    try {
      outcomes.push(run())
    } catch (err) {
      console.warn(`[retention] ${name} sweep failed (non-fatal):`, (err as Error).message)
    }
  }
  return outcomes
}
