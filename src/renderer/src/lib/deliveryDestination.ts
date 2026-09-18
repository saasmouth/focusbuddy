// Where a browsing run's results actually went.
//
// Reported as: "Created a ranked table of chicken soup recipes ordered by
// rating… but doesn't give indication where, or link to it."
//
// Exactly right. Delivery showed the model's one-line prose and nothing else.
// The prose says what was MADE; it never says where it landed, because the
// model writing it does not know — the destination is decided when the
// proposals are applied, in the renderer, after that sentence was written.
//
// Worse, the desk it lands on is the last desk you had ACTIVE, which from a
// desk-less Office browser is some desk you are not looking at and may not
// have thought about in an hour. So the one piece of information the user
// needed was the one piece nobody was tracking.
//
// This works it out from what was actually applied — the proposals plus the
// real ids they resolved to — so the answer comes from what happened rather
// than from what the model said it would do.

import type { ActionProposal } from '@shared/types'
import type { View } from '../stores/view'

export interface Destination {
  /** What to call it: the desk's name, the document's title. */
  label: string
  /** Material icon for the button. */
  icon: string
  /** Where "Open" goes. */
  view: View
}

// Kinds that produce something you can go and LOOK at, most specific first. A
// document opens on its own; everything else lives on a desk canvas, so the
// desk is the honest destination even when a table was the thing created.
const DESK_KINDS: ReadonlySet<string> = new Set([
  'create-widget',
  'create-table',
  'create-page',
  'create-todo-list',
  'create-agent',
  'create-section',
  'create-field'
])

function realId(p: ActionProposal, resolved: ReadonlyMap<string, string>): string | null {
  return resolved.get(p.id) ?? null
}

/**
 * The single place to send someone after a delivery, or null when nothing that
 * landed has somewhere to go.
 *
 * ONE destination, deliberately. A delivery can apply several proposals — a
 * table plus its rows, a desk plus what went on it — and offering a button per
 * proposal would turn "where did it go" back into a puzzle. The rule is: the
 * thing that was created, or failing that the canvas it was created on.
 */
export function destinationOf(
  proposals: readonly ActionProposal[],
  resolved: ReadonlyMap<string, string>,
  ctx: {
    activeTaskId: string | null
    /** Desk title by id, so a destination is named rather than pointed at. */
    deskTitle: (id: string) => string | null
  }
): Destination | null {
  // A document is its own place and beats a desk: "open the sheet" is more use
  // than "open the desk the sheet is on".
  for (const p of proposals) {
    if (p.kind === 'create-document') {
      const id = realId(p, resolved)
      if (id) return { label: p.title || 'the document', icon: 'description', view: { kind: 'document', documentId: id } }
    }
  }

  // A NEW desk the delivery made for the purpose — the best possible answer,
  // because everything else it applied went onto it.
  for (const p of proposals) {
    if (p.kind === 'create-task') {
      const id = realId(p, resolved)
      if (id) return { label: p.title || 'the new desk', icon: 'desk', view: { kind: 'task', taskId: id } }
    }
  }

  // Otherwise: the desk whatever-it-was was put on. A proposal may name its own
  // desk; failing that it used the one that was active, which is precisely the
  // desk the user could not have guessed.
  for (const p of proposals) {
    if (!DESK_KINDS.has(p.kind)) continue
    const deskId = ('deskId' in p && typeof p.deskId === 'string' ? p.deskId : null) ?? ctx.activeTaskId
    if (!deskId) continue
    return { label: ctx.deskTitle(deskId) || 'the desk', icon: 'desk', view: { kind: 'task', taskId: deskId } }
  }

  for (const p of proposals) {
    if (p.kind === 'create-knowledge-entry') {
      const id = realId(p, resolved)
      if (id) return { label: p.title || 'the entry', icon: 'psychology', view: { kind: 'knowledge', entryId: id } }
    }
  }

  return null
}

/**
 * The delivery sentence, with the destination named in it.
 *
 * The model's prose stays — it says what was made, which is worth reading —
 * and this adds the half it could not know. Kept separate from the button so
 * the text is still right for anyone reading it aloud or seeing it in a log.
 */
export function deliveryMessage(reply: string, dest: Destination | null): string {
  const said = reply.trim()
  if (!dest) return said
  // Never say it twice: the model sometimes names the desk itself.
  if (said.toLowerCase().includes(dest.label.toLowerCase())) return said
  const base = said.replace(/\s*[.]\s*$/, '')
  return base ? `${base} — on ${dest.label}.` : `Placed on ${dest.label}.`
}
