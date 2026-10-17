import type { FbNode } from '@shared/types'

// DEC-037 — what an attention item is ABOUT, readable at a glance.
//
// The operator's ask: "if an item is created from a desk and it's associated
// with a desk, I should see what desk… if it's associated with a plan, I
// should see the plan… tags will not be mandatory, but having the ability to
// add urgency or any other relevant tags is going to be important for
// filtering and classification."
//
// Two kinds of chip, deliberately distinguished:
//
//   DERIVED — the desk it lives on, the plan that desk belongs to, where it
//   was captured from. Nobody types these; they are facts about the item, so
//   they can never be stale or wrong, and they cost nothing to maintain.
//
//   CHOSEN — urgency and free-form tags. Never mandatory (the value of a tag
//   is that someone decided it), and stored on the item so they travel and
//   filter.

// ── Chosen: urgency ─────────────────────────────────────────────────────────

export const URGENCY_LEVELS = ['low', 'normal', 'high', 'urgent'] as const
export type Urgency = (typeof URGENCY_LEVELS)[number]

export function isUrgency(v: unknown): v is Urgency {
  return typeof v === 'string' && (URGENCY_LEVELS as readonly string[]).includes(v)
}

/** 'normal' is the unset default and deliberately renders NO chip — a badge
 *  every row wears carries no information. */
export function urgencyOf(i: Pick<FbNode, 'wiUrgency'>): Urgency | null {
  return isUrgency(i.wiUrgency) && i.wiUrgency !== 'normal' ? i.wiUrgency : null
}

// ── Chosen: free-form tags ──────────────────────────────────────────────────

const MAX_TAGS = 12
const MAX_TAG_LEN = 24

/** One tag, normalized: lowercase, single-spaced, no commas (the delimiter),
 *  no leading '#', length-capped. Returns '' for anything that survives as
 *  nothing, so callers can filter falsy. */
export function normalizeTag(raw: string): string {
  const t = raw
    .replace(/,/g, ' ')
    // Trim BEFORE stripping '#', or a leading space defeats the anchor and
    // "  #client" keeps its hash.
    .trim()
    .replace(/^#+/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
  return t.slice(0, MAX_TAG_LEN)
}

/** The stored string → a de-duplicated, ordered list. */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    const t = normalizeTag(part)
    if (t && !out.includes(t)) out.push(t)
  }
  return out.slice(0, MAX_TAGS)
}

/** A list → the stored string. Null when empty, so "no tags" is NULL in the
 *  column rather than an empty string pretending to be a value. */
export function serializeTags(tags: string[]): string | null {
  const clean: string[] = []
  for (const raw of tags) {
    const t = normalizeTag(raw)
    if (t && !clean.includes(t)) clean.push(t)
  }
  return clean.length ? clean.slice(0, MAX_TAGS).join(',') : null
}

/** Every tag in use, with counts — the filter bar's vocabulary. */
export function tagVocabulary(items: FbNode[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const i of items) {
    for (const t of parseTags(i.tags)) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export function hasTag(i: Pick<FbNode, 'tags'>, tag: string): boolean {
  return parseTags(i.tags).includes(normalizeTag(tag))
}

// ── Derived: where the item actually lives ──────────────────────────────────

/** How far up the tree to look for an enclosing plan. Mirrors the feeders'
 *  own cap so the two agree about what "inside a plan" means. */
const PLAN_CHAIN_CAP = 12

export interface ItemContext {
  desk: { id: string; title: string } | null
  plan: { id: string; title: string } | null
  /** What the item was captured FROM, when it was a marked object. */
  source: { type: string; ref: string } | null
}

/**
 * The derived context of one item: its desk, the plan enclosing that desk,
 * and the object it was marked from. Pure over a node lookup, so the chips are
 * testable without a store.
 */
export function itemContext(i: FbNode, byId: Map<string, FbNode>): ItemContext {
  const deskNode = i.parentId ? byId.get(i.parentId) : undefined
  const desk =
    deskNode && deskNode.kind === 'task'
      ? { id: deskNode.id, title: deskNode.title || 'Untitled desk' }
      : null

  let plan: { id: string; title: string } | null = null
  let cur = deskNode?.parentId ? byId.get(deskNode.parentId) : undefined
  for (let hops = 0; cur && hops < PLAN_CHAIN_CAP; hops++) {
    if (cur.kind === 'folder' && cur.isPlan) {
      plan = { id: cur.id, title: cur.title || 'Untitled plan' }
      break
    }
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }

  // 'note' is the ordinary typed capture — not worth a chip.
  const source =
    i.sourceRef && i.sourceType && i.sourceType !== 'note'
      ? { type: i.sourceType, ref: i.sourceRef }
      : null

  return { desk, plan, source }
}

/** A short human label for a marked source ("Widget", "Desk"). */
export function sourceLabel(type: string): string {
  switch (type) {
    case 'message':
      return 'From a message — open it to reply in the conversation'
    case 'widget':
      return 'From a work widget'
    case 'widgets':
      return 'From several work widgets'
    case 'desk':
      return 'From a desk'
    case 'meeting':
      return 'From a meeting — open it to review the transcript'
    default:
      return `From ${type}`
  }
}
