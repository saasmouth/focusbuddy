// The assistant's @-mention reference layer (Phase 4.1), pure and store-free —
// the same pattern as lib/assistantPin and lib/assistantQuestion. These rules
// decide what a reference IS, when one may be added, and when the set clears.
// The composer and the store only perform what they decide.
//
// This generalises click-to-pin (3a.1) from ONE widget to N typed references
// (plan D7/D8): a click and a typed "@" both produce a chip in the same layer,
// all chips are equal, and all are sticky to the CONVERSATION rather than to a
// single message — "primarily referenced in the conversation", exactly the P2
// lifecycle the pin already shipped, now with cardinality.
//
// Distinct from the three other "pin"-shaped concepts in the tree, deliberately:
//   • stores/chat `pinnedThread` — a CONVERSATION kept across navigation.
//   • widgets `pinned`/`pinnedZone` — a widget docked to a canvas corner.
//   • lib/mentions.ts — PlexiChat's @handle TEXT tokens, which notify a person.
// A MentionRef is none of those: it is a typed, id-bearing reference to a real
// workspace object, resolved to real content before it may claim anything.

import type {
  ChatMentionKind,
  ChatMentionRef,
  FbNode,
  SearchHit,
  Widget,
  WidgetKind
} from '@shared/types'
import { ATTACHABLE_WIDGET_KINDS } from '@shared/widgetText'
import { catalogFor } from './widgetCatalog'
import { searchHitEntity, type EntityRef } from './plexiiIconMap'

// What can be mentioned. Every member of this union must have a main-process
// resolver that can turn it into real text (see main/ai/mentionResolver) — a
// kind with no resolver could only ever produce a chip that lies about what
// rode the request. `person` is context-only: there is no notification path
// from the assistant, and nothing here pretends otherwise.
//
// Vocabulary follows the app's own (types.ts: "Task nodes (Desks)"):
// a task node IS a Desk; a folder node is a Room.
//
// The kind and the wire shape are the SHARED ones — one definition, so the
// renderer and the resolver cannot drift about what a reference is.
export type MentionKind = ChatMentionKind

export interface MentionRef extends ChatMentionRef {
  icon: string
  /** Presentation only, like `icon`: the app or work widget whose Plexii icon the chip wears. */
  entity?: EntityRef | null
  // The conversation this reference belongs to. Opaque on purpose (plan P6):
  // it is the per-screen thread key before unification and the persisted
  // conversation id after, so re-homing costs a value rather than a rewrite.
  conversationKey: string
}

// Strip the renderer-only fields for the request. The main process resolves by
// (kind, id, taskId); `icon` is presentation and `conversationKey` is renderer
// state, and sending either would imply the server cares which conversation a
// reference came from. It does not.
export function toWireMentions(refs: readonly MentionRef[]): ChatMentionRef[] {
  return refs.map((m) => ({ kind: m.kind, id: m.id, title: m.title, taskId: m.taskId ?? null }))
}

// How many references one conversation may carry. The force-included content
// shares the prompt's 24 000-char attachment budget, so an unbounded set would
// silently push earlier references out of the prompt while their chips kept
// claiming otherwise. Six is generous for real use and small enough that every
// chip's content genuinely fits.
export const MENTION_CAP = 6

// Stable identity for a reference. Composite because ids are only unique within
// a kind — a document and a widget may share an id without being the same thing.
export function mentionKey(ref: Pick<MentionRef, 'kind' | 'id'>): string {
  return `${ref.kind}:${ref.id}`
}

// The references live for a given conversation, in insertion order.
export function activeMentions(
  all: readonly MentionRef[],
  conversationKey: string
): MentionRef[] {
  return all.filter((m) => m.conversationKey === conversationKey)
}

export interface AddMentionResult {
  mentions: MentionRef[]
  added: boolean
  // Already referenced in this conversation — adding again is a no-op, not an
  // error, so a user who @-s the same doc twice simply keeps one chip.
  duplicate: boolean
  // At MENTION_CAP. The add is REFUSED rather than silently evicting the oldest:
  // a chip disappearing on its own would mean the row stopped describing what
  // rides the request, which is the one thing this layer exists to guarantee.
  rejectedForCap: boolean
}

export function addMention(all: readonly MentionRef[], ref: MentionRef): AddMentionResult {
  const mine = activeMentions(all, ref.conversationKey)
  const key = mentionKey(ref)
  if (mine.some((m) => mentionKey(m) === key)) {
    return { mentions: [...all], added: false, duplicate: true, rejectedForCap: false }
  }
  if (mine.length >= MENTION_CAP) {
    return { mentions: [...all], added: false, duplicate: false, rejectedForCap: true }
  }
  return { mentions: [...all, ref], added: true, duplicate: false, rejectedForCap: false }
}

// Drop one reference from one conversation. Scoped by conversation so an
// identical object referenced in two conversations loses only the one dismissed.
export function removeMention(
  all: readonly MentionRef[],
  conversationKey: string,
  key: string
): MentionRef[] {
  return all.filter((m) => !(m.conversationKey === conversationKey && mentionKey(m) === key))
}

// Everything this conversation referenced, gone. Used when a conversation is
// cleared or deleted; other conversations' references are untouched.
export function clearConversationMentions(
  all: readonly MentionRef[],
  conversationKey: string
): MentionRef[] {
  return all.filter((m) => m.conversationKey !== conversationKey)
}

// Only widget kinds whose content the shared extractor can genuinely read may
// be referenced — the same gate isPinnableWidget applies, for the same reason:
// a chip promises "the assistant is looking at this", and referencing a timer
// or a section would promise content that cannot be sent.
export function isMentionableWidget(kind: WidgetKind): boolean {
  return ATTACHABLE_WIDGET_KINDS.has(kind)
}

export function mentionFromWidget(w: Widget, conversationKey: string): MentionRef | null {
  if (!isMentionableWidget(w.kind)) return null
  const cat = catalogFor(w.kind)
  return {
    kind: 'widget',
    id: w.id,
    title: w.title || cat?.label || w.kind,
    icon: cat?.icon ?? 'widgets',
    entity: { kind: 'widget', id: w.kind },
    taskId: w.taskId,
    conversationKey
  }
}

export function mentionFromNode(n: FbNode, conversationKey: string): MentionRef {
  const isDesk = n.kind === 'task'
  return {
    kind: isDesk ? 'desk' : 'room',
    id: n.id,
    title: n.title || (isDesk ? 'Untitled desk' : 'Untitled room'),
    icon: isDesk ? 'space_dashboard' : 'folder',
    taskId: isDesk ? n.id : null,
    conversationKey
  }
}

// A deep-search hit becomes a reference only when its type maps to a kind the
// resolver can read. Everything else — calendar events, meetings, signatures,
// mail, individual table rows — returns null rather than a chip that would
// claim content no resolver can produce. Icons mirror CommandCenter's hitIcon
// so a mention looks like the same object the user searched for.
export function mentionFromSearchHit(
  hit: SearchHit,
  conversationKey: string
): MentionRef | null {
  switch (hit.type) {
    case 'document':
      return {
        kind: 'document',
        id: hit.id,
        title: hit.title || 'Untitled document',
        icon:
          hit.docType === 'sheet'
            ? 'table_chart'
            : hit.docType === 'slides'
              ? 'slideshow'
              : 'description',
        entity: searchHitEntity(hit),
        taskId: hit.taskId ?? null,
        conversationKey
      }
    case 'task':
      return {
        kind: 'desk',
        id: hit.id,
        title: hit.title || 'Untitled desk',
        icon: 'space_dashboard',
        taskId: hit.id,
        conversationKey
      }
    case 'folder':
      return {
        kind: 'room',
        id: hit.id,
        title: hit.title || 'Untitled room',
        icon: 'folder',
        taskId: null,
        conversationKey
      }
    case 'widget':
      return {
        kind: 'widget',
        id: hit.id,
        title: hit.title || 'Untitled work widget',
        icon: 'widgets',
        entity: searchHitEntity(hit),
        taskId: hit.taskId ?? null,
        conversationKey
      }
    case 'file':
      return {
        kind: 'file',
        id: hit.id,
        title: hit.title || 'Untitled file',
        icon: 'draft',
        taskId: hit.taskId ?? null,
        conversationKey
      }
    case 'knowledge':
      return {
        kind: 'knowledge',
        id: hit.id,
        title: hit.title || 'Untitled entry',
        icon: 'neurology',
        entity: searchHitEntity(hit),
        taskId: null,
        conversationKey
      }
    default:
      // table-row, event, meeting, sign, mail — no resolver, so no chip.
      return null
  }
}

// Human label for a kind, for the typeahead's secondary text and the chip's
// tooltip. Mirrors CommandCenter's hitKindLabel vocabulary.
export function mentionKindLabel(kind: MentionKind | 'capture'): string {
  switch (kind) {
    // DEC-027: the @attention COMMAND row in the picker — not a mention kind
    // and never a chip (no resolver → no reference; see the doctrine above).
    case 'capture':
      return 'Capture'
    case 'document':
      return 'Document'
    case 'desk':
      return 'Desk'
    case 'room':
      return 'Room'
    case 'widget':
      return 'Work widget'
    case 'file':
      return 'File'
    case 'knowledge':
      return 'PlexiiBrain'
    case 'person':
      return 'Person'
  }
}

// ── Resolution status ───────────────────────────────────────────────────────
// Whether a reference genuinely produced content is a MAIN-PROCESS fact, known
// only after a send. The renderer keeps what the server reported so a chip whose
// object has been deleted (or a person the user is signed out of) stops looking
// live. Nothing is assumed: a key the server never reported on is simply
// unknown, and an unknown reference renders normally rather than as broken.

export type MentionResolution = Record<string, boolean>

// Merge one response's verdicts into what we already knew. Later verdicts win —
// a document that was deleted between two sends flips to unresolved and stays
// there until it resolves again.
export function mergeMentionResolution(
  prev: MentionResolution,
  reported: ReadonlyArray<{ kind: MentionKind; id: string; resolved: boolean }>
): MentionResolution {
  if (reported.length === 0) return prev
  const next = { ...prev }
  for (const r of reported) next[mentionKey(r)] = r.resolved
  return next
}

// True only when the server has actually told us this reference produced
// nothing. Absence of a verdict is NOT a failure.
export function isKnownUnresolved(resolution: MentionResolution, ref: MentionRef): boolean {
  return resolution[mentionKey(ref)] === false
}
