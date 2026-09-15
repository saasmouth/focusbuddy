// The protocol vocabulary quarantine (SPEC-044, Attention layer S0).
//
// One word, three meanings, one source of truth. On the action-proposal wire,
// "task"/"create-task" has ALWAYS meant a desk — a whole workspace — and saved
// Flows persist that verb, so it can never be renamed. The Attention layer adds
// a second, to-do-like entity (`work_item`, wire verb "create-work-item"), and a
// third sense ("task" as a browsing goal in agent-browse) already ships. Every
// definition a model sees comes from the constants below, imported at each
// prompt-assembly site, so the three senses can never drift apart or get
// re-explained inconsistently at one site.
//
// Dependency-free on purpose (no electron, no db): unit tests import it
// directly, and the capability gate is passed in by callers rather than read
// here.

import { INTENT_CLASSES } from '@shared/workItems'

/** The reserved wire verb for creating a work_item. Defined end-to-end at S0
 *  (parsed by all five proposal parsers, listed in the creation gate, labeled,
 *  no-op'd by the executor) so nothing can ever squat on the name; it does real
 *  work only when the work-items capability is enabled (S3+). */
export const CREATE_WORK_ITEM_KIND = 'create-work-item' as const

// The intentClass union every prompt shows, derived from the one shared list
// (taxonomy alignment) so a class can never exist in prompts but not in code.
const INTENT_CLASS_UNION = INTENT_CLASSES.map((c) => `"${c}"`).join('|')

/** Appended to the create-task catalog entries: what create-task actually makes. */
export const CREATE_TASK_DEFINITION =
  'creates a new DESK — a whole workspace/canvas the user opens and works in. ' +
  'NOT a to-do, checklist entry, or action-item line; for line-items use create-todo-list'

/**
 * The verb for a task on the desk the user is already on.
 *
 * Exists because create-task is frozen: it means a DESK on the wire and saved
 * Flows persist that meaning, so "add a task here" could not simply become its
 * new default without changing what every stored Flow does.
 */
export const ADD_SUBTASK_DEFINITION =
  'adds a task TO THE DESK THE USER IS ALREADY ON. This is the normal way to ' +
  'add a task — prefer it over create-task, which builds a whole new desk the ' +
  'user must then navigate to and which clutters their sidebar permanently. ' +
  'Use create-task ONLY when the user explicitly asks for a new desk, ' +
  'workspace or canvas'

/** Appended to the update-task catalog entry. */
export const UPDATE_TASK_DEFINITION =
  'edits the CURRENT desk’s own fields — "task" in this verb’s name means the desk'

/** The one-paragraph disambiguation appended to the shared action catalog. */
export const PROTOCOL_VOCAB_NOTE =
  'VOCABULARY: in this protocol the word "task" inside kind names and ids ' +
  '(create-task, update-task, taskId) ALWAYS means a DESK — a whole workspace — ' +
  'for historical wire-compatibility reasons. It never means a to-do. The "task" ' +
  'field of agent-browse is unrelated: a browsing goal in plain words.\n'

/** Scope note for the mind-map prompt, whose node kind "task" is a third,
 *  map-local sense (a to-do-line idea) unrelated to desks or the wire. */
export const MINDMAP_TASK_SCOPE_NOTE =
  '(this "task" node kind is local to the mind map — it is unrelated to the ' +
  'workspace protocol, where "task"/"create-task" means a desk)'

/** The catalog entry + rules for create-work-item, injected into prompts ONLY
 *  while the work-items capability is enabled. Includes the explicit override
 *  of hard rule 4’s "ALWAYS create-todo-list" so actionable to-dos route to
 *  work items the moment the tool exists, and not a turn before. */
const WORK_ITEM_CATALOG_ENTRY =
  `  { "kind": "create-work-item", "title": "Call Bob about the lease", "notes": "optional detail", "intentClass": ${INTENT_CLASS_UNION}, "reason": "..." }` +
  '  (creates a WORK ITEM — a single actionable to-do the user tracks in their Attention queues. ' +
  'NOT a desk and NOT a widget: use it for individual commitments, follow-ups, and action items)\n'

const WORK_ITEM_RULES =
  'WORK-ITEM RULES:\n' +
  '- A single actionable commitment ("call Bob", "send the invoice") is a create-work-item, ' +
  'NOT a create-task (that opens a whole desk) and NOT a create-todo-list.\n' +
  '- Set intentClass from what the item is TRYING TO DO: something to be done = "to_do"; needs ' +
  'judgment or sign-off on an artifact = "to_review"; a choice between options = "to_decide"; ' +
  'someone awaits words back (an answer, reply, or acknowledgment) = "to_respond"; time/meeting ' +
  'related = "to_meet" (e.g. a call being arranged); talk it through live = "to_discuss"; an idle ' +
  'idea worth keeping = "to_remember"; information worth keeping with nothing owed back = "to_know". ' +
  'Context decides — an item born from a scheduling conversation is "to_meet", not "to_do".\n' +
  '- create-todo-list remains correct ONLY for a static multi-line checklist living on the ' +
  'current desk’s canvas; individual tracked to-dos are work items (this refines rule 4).\n' +
  '- "@attention" ANYWHERE in the message — start, middle, or end — is a STANDING ORDER, not a topic: ' +
  'this reply MUST include a create-work-item action for what the user described, with intentClass ' +
  'chosen from context. The same goes for "put/route/add/file this to my attention". It is never ' +
  'optional and never satisfied by prose alone.\n' +
  '- If that message ALSO asks for something buildable (a deck, a page, a document, a desk), emit ' +
  'BOTH: the build action AND the create-work-item that tracks it. Emitting only the build action is ' +
  'a FAILURE — the user asked for the thing and for it to be tracked. Never answer that you cannot ' +
  'access Attention: the action card IS the access.\n' +
  '- Tracking work ABOUT a desk is a WORK ITEM, never a desk edit: "make this desk a task", ' +
  '"remind me to finish this desk", "I need to complete X desk" → create-work-item (put the desk\'s ' +
  'name in the title). update-task exists ONLY to edit the desk\'s own fields when the user asks to ' +
  'rename/complete/re-date THE DESK ITSELF, and create-task ONLY to open a brand-new workspace.\n'

/** The gated addendum. Callers pass the live capability flag; '' while OFF so
 *  the model is never taught a verb that would no-op. */
export function workItemCatalogAddendum(enabled: boolean): string {
  if (!enabled) return ''
  return WORK_ITEM_CATALOG_ENTRY + '\n' + WORK_ITEM_RULES + '\n'
}

/** Meeting-wrapup deliverable line for create-work-item, injected only while
 *  the capability is ON (S5): the meeting is the surface most likely to
 *  produce action items, so its routing flips the moment work items exist. */
export const MEETING_WORK_ITEM_DELIVERABLE =
  '  { "kind": "create-work-item", "title": "short action item", "notes": "optional detail", "intentClass": "to_do"|"to_review"|"to_decide"|"to_respond"|"to_meet"|"to_discuss"|"to_know", "reason": "what in the transcript calls for this" }\n'

/** The capture-routing rule for meeting wrapups. OFF: the S0 legacy phrasing
 *  (create-task still carries action items, correctly defined as desk-
 *  creating). ON: action items become work items; desks are reserved for work
 *  streams that need their own space. */
export function meetingCaptureRule(enabled: boolean): string {
  if (!enabled) {
    return (
      '- Use create-task for an action item someone needs to do — it creates a DESK: a whole workspace ' +
      'opens for that item, so the user can work it to completion there.'
    )
  }
  return (
    '- Use create-work-item for an action item someone needs to do (a single tracked to-do in their ' +
    'Attention queues). Use create-task ONLY when a work stream deserves its own DESK — a whole ' +
    'workspace, not a line item.'
  )
}

/** Voice-note action shape for create-work-item, injected while ON (Δ13):
 *  "remind me to call Bob" is the canonical work-item utterance. */
export const VOICE_WORK_ITEM_SHAPE =
  `{"kind":"create-work-item","title":"…","notes":"…","intentClass":${INTENT_CLASS_UNION},"reason":"…"}  (a single tracked to-do — ` +
  'use this for reminders and action items; pick intentClass from what it is trying to do; create-task creates a whole DESK)\n'
