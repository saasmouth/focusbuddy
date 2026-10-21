import { dueStanding, dueLabel, type DueStanding } from './dueDates'
import type { FbNode } from '@shared/types'
import { isDeskTask } from '@shared/attentionProjection'

// Attention feeders (S7, SPEC-022/023/024 intelligence-light; CR-08(b)'s
// enabler). Feeders READ desk/plan state and surface it AS attention signals —
// computed rows, never materialized work_items: no new data, no sync, nothing
// owned. Strictly one-directional (F006): Attention never writes back into
// desks. Signals stay OUT of the headline badge (system-class information;
// DEC-016's restraint) and carry a one-line reason like every other row.
//
// Dismissal is a MUTE, remembered per signal; muting several of one kind
// offers muting the whole source (Δ10's suppression shape, device-local).

export interface FeederSignal {
  /** Stable identity for muting: `${kind}:${id}` */
  key: string
  kind: 'desk-due' | 'desk-stale' | 'plan-due'
  id: string
  title: string
  /** The one-line reason ("Due tomorrow", "Quiet for 9 days"). */
  line: string
  /** Sort urgency — smaller = more urgent. */
  order: number
  /** Where opening the signal lands: the desk itself, or a plan dashboard. */
  target: 'desk' | 'plan'
}

/** Max parent hops when resolving a desk's enclosing plan (cycle guard). */
const PLAN_CHAIN_CAP = 20

function dueLine(due: DueStanding, planPrefix: boolean): string {
  const base = dueLabel(due)
  return planPrefix ? `Plan ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base
}

/**
 * Due signals across desks AND plans (DEC-020 — plan due dates joined the
 * feeders before the Plans tab retired). A desk inside a plan emits kind
 * 'plan-due' with the plan's name on the line; a plan root with its own due
 * date emits 'plan-due' opening the plan dashboard. Plain desks stay
 * 'desk-due'. Separate kinds keep mutes and Δ10 offers independent.
 */
export function deskDueSignals(nodes: FbNode[], nowMs: number): FeederSignal[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const enclosingPlan = (n: FbNode): FbNode | null => {
    let cur = n.parentId != null ? byId.get(n.parentId) : undefined
    for (let hops = 0; cur && hops < PLAN_CHAIN_CAP; hops++) {
      if (cur.kind === 'folder' && cur.isPlan) return cur
      cur = cur.parentId != null ? byId.get(cur.parentId) : undefined
    }
    return null
  }
  const out: FeederSignal[] = []
  for (const n of nodes) {
    if (n.archived || n.status === 'done' || n.status === 'parked') continue
    if (n.dueDate == null) continue
    // DEC-144: a task filed on a desk is already in Focus as itself; a feeder
    // row for its due date was the same task listed twice.
    if (isDeskTask(n, (id) => byId.get(id))) continue
    // Calendar days in local time (lib/dueDates): a desk due today, stored as
    // local midnight, is "Due today" all day, not "Past due" from 00:01.
    const due = dueStanding(n.dueDate, nowMs)
    if (!due || (!due.overdue && due.days > 7)) continue
    if (n.kind === 'task') {
      const plan = enclosingPlan(n)
      out.push({
        key: `${plan ? 'plan-due' : 'desk-due'}:${n.id}`,
        kind: plan ? 'plan-due' : 'desk-due',
        id: n.id,
        title: n.title || 'Untitled desk',
        line: plan ? `${dueLine(due, false)} · ${plan.title || 'Untitled plan'}` : dueLine(due, false),
        order: n.dueDate,
        target: 'desk'
      })
    } else if (n.kind === 'folder' && n.isPlan) {
      out.push({
        key: `plan-due:${n.id}`,
        kind: 'plan-due',
        id: n.id,
        title: n.title || 'Untitled plan',
        line: dueLine(due, true),
        order: n.dueDate,
        target: 'plan'
      })
    }
  }
  return out.sort((a, b) => a.order - b.order)
}

export function deskStaleSignals(
  stale: Array<{ id: string; title: string; daysQuiet: number }>
): FeederSignal[] {
  return stale.map((d) => ({
    key: `desk-stale:${d.id}`,
    kind: 'desk-stale',
    id: d.id,
    title: d.title,
    line: `Quiet for ${d.daysQuiet} day${d.daysQuiet === 1 ? '' : 's'}`,
    order: -d.daysQuiet,
    target: 'desk'
  }))
}

/** Merge, apply mutes (per-signal keys plus whole-kind mutes), due first. */
export function feederSignals(
  nodes: FbNode[],
  stale: Array<{ id: string; title: string; daysQuiet: number }>,
  nowMs: number,
  muted: ReadonlySet<string>
): FeederSignal[] {
  const all = [...deskDueSignals(nodes, nowMs), ...deskStaleSignals(stale)]
  return all.filter((s) => !muted.has(s.key) && !muted.has(`kind:${s.kind}`))
}

// ── Mute persistence (device-local by design — a mute is "stop showing ME
// this here", never data) ───────────────────────────────────────────────────

const MUTE_KEY = 'attention.feeder.mutes'

export function loadMutes(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTE_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    /* fresh */
  }
  return new Set()
}

export function saveMutes(mutes: ReadonlySet<string>): void {
  try {
    localStorage.setItem(MUTE_KEY, JSON.stringify([...mutes].slice(-500)))
  } catch {
    /* best-effort */
  }
}

/** Δ10 — after this many muted signals of one kind, offer muting the source. */
export const KIND_MUTE_OFFER_THRESHOLD = 3

export function mutedCountOfKind(mutes: ReadonlySet<string>, kind: FeederSignal['kind']): number {
  let n = 0
  for (const k of mutes) if (k.startsWith(`${kind}:`)) n++
  return n
}
