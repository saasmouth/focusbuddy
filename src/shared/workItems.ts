// work_item shared contract — the column manifest and the status projection
// (Attention layer S2; ARCHITECTURE §2.2–§2.3). Pure and dependency-free: the
// main db module, the renderer CRDT allowlists/emitters, and the CI parity
// test all import THIS file, so the column set can never drift between the
// schema, the transports, and the tests (guess-list #9).

export interface WorkItemColumnDef {
  /** snake_case DB column on nodes */
  column: string
  /** camelCase CRDT attr / sync-body key / FbNode field */
  attr: string
  /** ensureColumn DDL type */
  ddl: string
  /** Rides the renderer emit snapshot. false = main-process-written only
   *  (schema_epoch — excluded from the emit-fires assertion, F-m2″). */
  rendererEmitted: boolean
}

export const WORK_ITEM_COLUMNS: readonly WorkItemColumnDef[] = [
  { column: 'work_item_state', attr: 'workItemState', ddl: 'TEXT', rendererEmitted: true },
  { column: 'intent_class', attr: 'intentClass', ddl: 'TEXT', rendererEmitted: true },
  // Reserved secondary-intent axis (taxonomy alignment, analysis/22 §2.4):
  // emitted + allowlisted NOW while schema churn is cheap; no UI writes it yet.
  // UI adoption waits for the per-class question sets (SPEC-027 era).
  { column: 'intent_sub', attr: 'intentSub', ddl: 'TEXT', rendererEmitted: true },
  // DEC-035 — grouping. The id of the item that LEADS this item's group.
  // A SIBLING reference, deliberately not parent_id: work items are leaf nodes
  // (§2.5 leaf invariant — nothing nests under a work item, enforced at create
  // AND at sync apply), and parent_id already means "the desk this lives on".
  // Exactly one level: a group leader never itself carries a group_id, so a
  // group can never become a tree.
  { column: 'group_id', attr: 'groupId', ddl: 'TEXT', rendererEmitted: true },
  // DEC-037 — free-form tags, comma-delimited and normalized (see
  // renderer/lib/itemTags.ts). Never mandatory: the value of a tag is that it
  // was chosen, so nothing in the layer requires one.
  { column: 'tags', attr: 'tags', ddl: 'TEXT', rendererEmitted: true },
  // DEC-039 — ENTITY mentions: people, desks, rooms, plans this item is about,
  // as a JSON array of {kind,id,title} (renderer/lib/itemMentions.ts). Typed
  // references, distinct from free-form tags: they resolve to real things and
  // (people, once SPEC-027 routing exists) will carry attention TO someone.
  { column: 'mentions', attr: 'mentions', ddl: 'TEXT', rendererEmitted: true },
  { column: 'originator_id', attr: 'originatorId', ddl: 'TEXT', rendererEmitted: true },
  { column: 'recipient_id', attr: 'recipientId', ddl: 'TEXT', rendererEmitted: true },
  // DEC-144 — the people a task is ASSIGNED to, as a JSON array of server
  // account ids (organisation members and guests). Many people, not one: a
  // task in a team workspace can be shared out. This is the routing field: in a
  // team workspace a task appears in the Focus of everyone listed here, and a
  // guest's device receives only the tasks that list them (server
  // orgGuestScope). Distinct from `mentions` (who a task is ABOUT) and from the
  // Plan-domain free-text `assignee` column (ARCHITECTURE §2.2). Empty or null =
  // unassigned. Always written through normalizeAssigneeIds.
  { column: 'assignee_ids', attr: 'assigneeIds', ddl: 'TEXT', rendererEmitted: true },
  // ISO-8601 string — collision-proof vs the numeric desk due_date (§2.2)
  { column: 'due_at', attr: 'dueAt', ddl: 'TEXT', rendererEmitted: true },
  { column: 'wi_urgency', attr: 'wiUrgency', ddl: 'TEXT', rendererEmitted: true },
  { column: 'source_ref', attr: 'sourceRef', ddl: 'TEXT', rendererEmitted: true },
  { column: 'source_type', attr: 'sourceType', ddl: 'TEXT', rendererEmitted: true },
  // DEC-052 (Track D baseline) — a deep link back to the EXACT external
  // source: the URL/URI to reopen (a mail message-id URI, a Slack permalink,
  // a web page). source_ref stays the internal id; this is the external one.
  { column: 'source_url', attr: 'sourceUrl', ddl: 'TEXT', rendererEmitted: true },
  { column: 'confidence', attr: 'confidence', ddl: 'REAL', rendererEmitted: true },
  { column: 'approval_state', attr: 'approvalState', ddl: 'TEXT', rendererEmitted: true },
  { column: 'reason_code', attr: 'reasonCode', ddl: 'TEXT', rendererEmitted: true },
  { column: 'wi_origin', attr: 'wiOrigin', ddl: 'TEXT', rendererEmitted: true },
  // ── DEC-063 — a Meet item POINTS AT a meeting ─────────────────────────────
  // The operator ruled option 2 over "a Meet item IS a time block", and the
  // deciding case was his own: "the RSVP if it is for responding to". An
  // invitation you have not answered is a meeting that is NOT on your calendar
  // — there is no block to be. So the item carries the meeting's own shape and
  // links to a block only once something is actually scheduled.
  //
  // A meeting has an agreed shape — when, where, who, how to join — which is
  // exactly what earns Meet its invite treatment where `to_respond` (GAP-017)
  // has to be investigated first: a "response" has no equivalent shape.
  //
  // `meet_start_at` is deliberately NOT due_at. A meeting's start is not a
  // deadline: nothing is late at 2pm because the meeting begins at 2pm, and
  // collapsing the two would put every invitation into the overdue radar.
  { column: 'meet_start_at', attr: 'meetStartAt', ddl: 'TEXT', rendererEmitted: true },
  { column: 'meet_duration_min', attr: 'meetDurationMin', ddl: 'INTEGER', rendererEmitted: true },
  // The join link, whoever hosts it — Google Meet, Zoom, Teams, or Plexii's own
  // room. Stored as the URL rather than a provider enum: a link that opens is
  // worth more than a taxonomy of links, and the provider is readable from it.
  { column: 'meet_url', attr: 'meetUrl', ddl: 'TEXT', rendererEmitted: true },
  // Where to physically be. Free text, because an address, a room name and
  // "the coffee place on 3rd" are all answers a person acts on.
  { column: 'meet_location', attr: 'meetLocation', ddl: 'TEXT', rendererEmitted: true },
  // Who else. Comma-delimited emails for people outside Plexii; internal people
  // ride `mentions`, which already resolves to real records.
  { column: 'meet_attendees', attr: 'meetAttendees', ddl: 'TEXT', rendererEmitted: true },
  // The answer you owe, when one is owed: 'needed' | 'yes' | 'no' | 'maybe'.
  // Null means no RSVP was ever asked for — a meeting you called yourself.
  { column: 'meet_rsvp', attr: 'meetRsvp', ddl: 'TEXT', rendererEmitted: true },
  // Writer's schema version — forward-compat receiver guard (F-M5″): a device
  // at epoch N parks a row stamped N+1 instead of mis-applying it.
  { column: 'schema_epoch', attr: 'schemaEpoch', ddl: 'INTEGER', rendererEmitted: false }
] as const

/** The most people one task can be assigned to. */
export const MAX_ASSIGNEES = 50

/**
 * The one way an assignee list is written (DEC-144): a JSON array of distinct,
 * non-empty account ids, sorted so the same set always serializes the same way
 * (the server's guest rule compares bodies), or null when nobody is assigned.
 * Accepts the stored JSON text or an array. Returns undefined for input that
 * is not an assignee list at all, so a caller can refuse it.
 */
export function normalizeAssigneeIds(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === '') return null
  let arr: unknown = v
  if (typeof v === 'string') {
    try {
      arr = JSON.parse(v)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(arr)) return undefined
  const ids = Array.from(new Set(arr.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)))
  if (ids.length !== arr.length && arr.some((x) => typeof x !== 'string')) return undefined
  if (ids.length > MAX_ASSIGNEES) return undefined
  ids.sort()
  return ids.length ? JSON.stringify(ids) : null
}

/** The account ids in a stored assignee list ([] for none or junk). */
export function parseAssigneeIds(v: unknown): string[] {
  const norm = normalizeAssigneeIds(v)
  return norm ? (JSON.parse(norm) as string[]) : []
}

/** This build's work_item schema epoch. Bump ONLY when a new epoch's rows
 *  would be unsafe for an older build to materialize as-is. */
export const WORK_ITEM_SCHEMA_EPOCH = 1

/** Non-terminal states — "this still needs the person". One source for every
 *  SQL visibility predicate (badge, nudges) so a new state can never be
 *  half-added. */
export const ACTIVE_WORK_ITEM_STATES = [
  'open',
  'in_progress',
  'waiting',
  'needs_review',
  'needs_approval',
  'delegated',
  'blocked',
  'suggested',
  'stale'
] as const

/** Terminal states. 'decided' is the To Decide queue's closing verb (taxonomy
 *  alignment; analysis/22 §2.1). Cross-version note: an un-updated peer
 *  coarsens any state it doesn't know to 'open' (the conservative default)
 *  until it updates — accepted, same as every state added since v1. */
export const TERMINAL_WORK_ITEM_STATES = [
  'acknowledged',
  'answered',
  'scheduled',
  'delivered',
  'reviewed',
  'completed',
  'discussed',
  'decided',
  'dismissed',
  'reclassified',
  // DEC-024: shelved — "keep it, done looking at it". Terminal for queue
  // visibility, but NOT a loop closure: no notification, no Recently-closed
  // row; it lives on the Archived shelf until unarchived (state → open).
  'archived'
] as const

export const WORK_ITEM_STATES = [...ACTIVE_WORK_ITEM_STATES, ...TERMINAL_WORK_ITEM_STATES] as const
export type WorkItemState = (typeof WORK_ITEM_STATES)[number]

/** The eight intent primaries (taxonomy alignment stage, DEC-029a sequencing;
 *  analysis/22). Schema values keep the full to_* form (R-01); surface labels
 *  live in the renderer (attentionQueues). The legacy classes 'acknowledgment'
 *  and 'direct' merged into 'to_respond'; 'to_decide' is the one genuinely new
 *  primary. The five taxonomy tests T-1…T-5 + anti-collision (DEC-029a LAW)
 *  govern any future change to this list. */
export const INTENT_CLASSES = [
  'to_do',
  'to_review',
  'to_decide',
  'to_respond',
  'to_meet',
  'to_discuss',
  'to_remember',
  'to_know'
] as const

/** The db default when a draft names no class ("something to do"). */
export const DEFAULT_INTENT_CLASS = 'to_do'

/** Pre-alignment class values, mapped forward. Applied at every boundary a
 *  legacy value can still enter: model output (stale prompt caches, saved
 *  Flows), sync arrivals from un-updated peers, stored widget/section keys.
 *  The startup migration (migrateIntentTaxonomyV2) rewrites stored rows with
 *  this same map — one table, two consumers, no drift. */
export const LEGACY_INTENT_CLASS_MAP: Readonly<Record<string, string>> = {
  action: 'to_do',
  review: 'to_review',
  scheduling: 'to_meet',
  fyi: 'to_know',
  acknowledgment: 'to_respond',
  direct: 'to_respond',
  discussion: 'to_discuss',
  loose_thought: 'to_remember'
}

/** Canonical form of any intent-class value: a current class passes through,
 *  a legacy class maps forward, anything else is undefined (the db default
 *  then applies). */
export function canonicalIntentClass(v: unknown): string | undefined {
  const s = String(v)
  if ((INTENT_CLASSES as readonly string[]).includes(s)) return s
  return LEGACY_INTENT_CLASS_MAP[s]
}

/** Validate a model-supplied intent class; undefined for anything else (the
 *  db default then applies). Used by every proposal parser. Legacy values
 *  normalize forward rather than falling to the default. */
export function normalizeIntentClass(v: unknown): string | undefined {
  return canonicalIntentClass(v)
}

/** DEC-047 (D-5) — states an item may be BORN in: the active subset a person
 *  would honestly tag at capture time. Terminal states at birth would skip
 *  closure notifications and pollute Recently closed, so they remain
 *  setState-only (the closing verbs). 'suggested' stays approval-driven. */
export const CAPTURE_STATES = ['open', 'in_progress', 'waiting', 'blocked'] as const

/** DEC-048 — grouping may nest, but never deeper than this many LEVELS
 *  (a root, a subtask, a sub-subtask = 3). Enforced at the db write path and
 *  mirrored by every drop planner, so no surface can exceed it. Supersedes
 *  DEC-035/047's one-level rule by operator instruction. */
export const MAX_GROUP_DEPTH = 3

export function initialWorkItemState(
  approvalState: string | undefined,
  requested: string | undefined
): WorkItemState {
  if (approvalState === 'suggested') return 'suggested'
  return (CAPTURE_STATES as readonly string[]).includes(requested ?? '')
    ? (requested as WorkItemState)
    : 'open'
}

/** §2.3 (A-02): the derived coarse projection. Computed at every write and
 *  recomputed at every sync apply — never authoritative, never written from
 *  the wire. Dismissed/reclassified → 'parked', NEVER 'done'. The 'open'
 *  bucket is a legacy-compatibility value only, never a "needs me" signal
 *  (F013): every Attention count derives from work_item_state exclusively. */
export function statusForWorkItemState(
  state: string
): 'open' | 'in_progress' | 'done' | 'parked' {
  switch (state) {
    case 'in_progress':
    case 'delegated':
    case 'needs_review':
    case 'needs_approval':
      return 'in_progress'
    case 'acknowledged':
    case 'answered':
    case 'scheduled':
    case 'delivered':
    case 'reviewed':
    case 'completed':
    case 'discussed':
    case 'decided':
      return 'done'
    case 'dismissed':
    case 'reclassified':
    case 'archived':
      return 'parked'
    default:
      // open, suggested, stale, waiting, blocked — and unknown future states,
      // which coarsen conservatively into the legacy bucket.
      return 'open'
  }
}
