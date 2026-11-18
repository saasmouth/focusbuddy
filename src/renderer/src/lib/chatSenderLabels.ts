// Who wrote each message, for the Messages view (4.3.50).
//
// MessageRow drew other people's bubbles with no name at all, so in a space or
// channel the full Messages view could not tell you who said what (the desk's
// chat work widget always named them). A message from someone else now carries
// their name above it, once per run of messages from the same person. Your own
// messages carry none (they sit on the right), and neither does a DM, whose
// header already names the one other person.

import type { ChatMessage } from './messagingClient'
import { personDisplayName, type NamedPerson } from './personName'

export interface SenderMember extends NamedPerson {
  accountId: string
}

/** One label per message: the sender's name where it should show, else null. */
export function chatSenderLabels(
  messages: Pick<ChatMessage, 'fromAccount'>[],
  myId: string,
  members: SenderMember[],
  isDm: boolean
): (string | null)[] {
  if (isDm) return messages.map(() => null)
  const byId = new Map(members.map((m) => [m.accountId, m]))
  return messages.map((m, i) => {
    if (m.fromAccount === myId) return null
    if (i > 0 && messages[i - 1].fromAccount === m.fromAccount) return null
    return personDisplayName(byId.get(m.fromAccount), 'Someone')
  })
}
