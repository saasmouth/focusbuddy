// The discovery creation gate (A4, AI-08 — ruling R8).
//
// "No premature desk creation. The conversation grows until Caleb is
// deliberately prompted ('want me to create a desk?') or uses a persistent
// convert-to-desk control."
//
// Two halves enforce that:
//   1. The prompt half — discoveryMode.ts teaches the model to OFFER, never
//      build, until the user says the word.
//   2. This half — a deterministic backstop at the one chokepoint both chat
//      paths share (buildChatResponse): if a discovery response carries
//      workspace-building actions before the transcript shows a green light,
//      the build is held, the reply says so honestly, and (where the surface
//      renders question cards) an explicit offer question is put up instead.
//
// The green light is read from the transcript, deterministically: the last
// user turn explicitly asks to build, OR it accepts an offer the nearest
// preceding assistant turn actually made. Tapping the offer card's "Create
// the desk" option sends that text as a user turn, so the card path and the
// typed path converge on the same rules. The composer's Turn-into-desk chip
// (the persistent control R8 names) bypasses chat entirely and is untouched.
//
// Dependency-free so it unit-tests in isolation, same policy as
// discoveryMode.ts and retrievalIntent.ts.

import type { ActionProposal, ChatQuestion } from '@shared/types'

// The workspace-building family — what R8 means by "creation". Editing kinds
// (update-task, set-cell, edit-document), drafts (compose-mail, post-chat),
// navigation (open-url, navigate-to) and remembering (create-knowledge-entry)
// stay legal mid-discovery; none of them builds the desk.
export const CREATION_KINDS: ReadonlySet<string> = new Set([
  'create-task',
  'add-subtask',
  'create-work-item',
  'create-widget',
  'create-todo-list',
  'create-table',
  'add-table-row',
  'create-page',
  'create-field',
  'create-agent',
  'link-widgets',
  'generate-document'
])

// An explicit ask to build. Covers the offer card's canonical option ("Create
// the desk"), the typed forms ("build it", "set up the workspace", "turn this
// into a desk"), and "make this real". A build verb reaching for a vague "it"
// counts only with create/build — "make it calmer" must never green-light.
const BUILD_ASK =
  /\b(?:create|build|make|set ?up|spin up|generate|start)\b[^.?!]{0,40}\b(?:desk|workspace|board|room)\b|\b(?:create|build) (?:it|this|that|one)\b|\bturn (?:this|it|that) into a desk\b|\bmake (?:this|it) real\b/i

// A short affirmative that accepts a standing offer. Anchored to the start so
// "yes, but first tell me more about budgets?" still reads as acceptance while
// a sentence merely containing "sure" does not.
const ACCEPTANCE =
  /^(?:yes|yeah|yep|sure|ok(?:ay)?|sounds good|perfect|please do|do it|go ahead|let'?s (?:do it|go|build it?)|i'?m ready|ready)\b/i

// An assistant turn that offered to build. discoveryMode.ts mandates the offer
// live in the reply prose in plain words that include a create verb, so this
// is detection of taught behaviour, not divination.
const OFFER =
  /\b(?:want me to|shall i|should i|would you like me to|ready (?:for me )?to)\b[^.?!]{0,60}\b(?:create|build|set ?up|make)\b|\bcreate (?:the|this|your|a) (?:desk|workspace)\b/i

export function isBuildAsk(text: string): boolean {
  return BUILD_ASK.test(text.trim())
}

export function isAcceptance(text: string): boolean {
  return ACCEPTANCE.test(text.trim())
}

export function offersCreation(assistantText: string): boolean {
  return OFFER.test(assistantText)
}

// The transcript's verdict: may this response build? `messages` is the request
// transcript (the just-sent user turn is last).
export function buildGreenLit(
  messages: ReadonlyArray<{ role: string; content: string }>
): boolean {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return false
  const lastUser = messages[lastUserIdx].content
  if (isBuildAsk(lastUser)) return true
  if (isAcceptance(lastUser)) {
    // Acceptance means nothing unless something was offered: the nearest
    // assistant turn before it must have made the offer.
    for (let i = lastUserIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return offersCreation(messages[i].content)
    }
  }
  return false
}

export interface GatedEnvelope {
  proposals: ActionProposal[]
  question: ChatQuestion | undefined
  // Appended to the reply when the gate held a build, so the prose never
  // implies cards that are not there. Null when nothing was held.
  notice: string | null
}

// The canonical offer question the gate puts up when it holds a build and the
// model asked nothing itself. Its first option is a BUILD_ASK on purpose:
// tapping it green-lights the next turn.
export const HELD_BUILD_QUESTION: ChatQuestion = {
  prompt: 'Ready to make this real?',
  options: ['Create the desk', 'Keep exploring'],
  allowFreeText: true
}

export function gateCreation(input: {
  proposals: ActionProposal[]
  question: ChatQuestion | undefined
  discovery: boolean
  greenLit: boolean
  supportsQuestions?: boolean
}): GatedEnvelope {
  const pass: GatedEnvelope = {
    proposals: input.proposals,
    question: input.question,
    notice: null
  }
  if (!input.discovery || input.greenLit) return pass
  const kept = input.proposals.filter((p) => !CREATION_KINDS.has(p.kind))
  const held = input.proposals.length - kept.length
  if (held === 0) return pass
  return {
    proposals: kept,
    // Never override a question the model genuinely asked; only fill silence.
    question:
      input.question ?? (input.supportsQuestions ? HELD_BUILD_QUESTION : undefined),
    notice:
      held === 1
        ? 'I held that build. Nothing gets created in discovery until you say the word.'
        : `I held those ${held} pieces. Nothing gets created in discovery until you say the word.`
  }
}
