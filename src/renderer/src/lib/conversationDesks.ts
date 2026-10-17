import type { ActionProposal, AppliedProposal } from '@shared/types'

// Conversation↔desk linking rules (Plexii P5), kept pure so they unit-test.
//
// A conversation links the desks it PRODUCES: when the user applies a
// create-task proposal (a desk is a task node), the new desk's id links to the
// conversation, element 0 of the list being the primary — the pinned chip and
// the default push target. Updating or navigating to an existing desk is not
// production and links nothing.

export function linkTargetForApplied(
  proposalKind: ActionProposal['kind'] | undefined,
  applied: AppliedProposal
): string | null {
  if (proposalKind !== 'create-task') return null
  if (!applied.target || applied.target.kind !== 'task') return null
  return applied.target.id
}

// The canned request behind the persistent affordance. Turn-into-desk is a
// genuine user message riding the normal proposal pipeline — the model plans
// the desk and its widgets as cards the user approves, so nothing is built
// silently.
export const TURN_INTO_DESK_MESSAGE =
  'Turn this conversation into a desk: propose a create-task action for the desk itself and the work widgets that bring everything we discussed to life.'

// The follow-up push once a desk is linked. The send rides the linked desk as
// task context, so the model can see the canvas and propose only what is new.
export const PUSH_TO_DESK_MESSAGE =
  'Push what is new from this conversation to the desk: propose work widgets and updates for anything we discussed that is not on the canvas yet.'
