// Sends the join details for a scheduled meeting to its invitees over the user's
// connected mailbox. This is the "sent out to invitees" half of a calendar
// meeting: each invitee gets an email with the time and a link that opens the
// room in PlexiDesk. If no mailbox is connected we say so honestly rather than
// pretending the invites went out.

import { meetingDeepLink } from '@shared/deepLink'

export interface MeetingInviteResult {
  sent: number
  failed: string[]
  noAccount: boolean
}

// The deep link that opens (or joins) the meeting room in the desktop app. The
// same link is used by the host's calendar "Join" button and by every invitee.
export function meetingJoinLink(roomId: string): string {
  return meetingDeepLink(roomId)
}

/** The invite's text — a pure function so the suite can read every line.
 *  Where-aware: an external link is THE join line (the Plexii room stays as
 *  the PlexiDesk door), a place is stated first with the room as the remote
 *  option, and a plain Plexii meeting reads exactly as it always has. */
export function composeInviteBody(input: {
  title: string
  durationMin: number
  host?: string
  when: string
  link: string
  joinUrl?: string | null
  location?: string | null
}): string {
  const lines = [
    `${input.host ? `${input.host} has invited you to a meeting.` : 'You have been invited to a meeting.'}`,
    '',
    `What: ${input.title}`,
    `When: ${input.when} (${input.durationMin} min)`
  ]
  if (input.location?.trim()) lines.push(`Where: ${input.location.trim()}`)
  lines.push('')
  if (input.joinUrl?.trim()) {
    lines.push(`Join the meeting: ${input.joinUrl.trim()}`, `Or in PlexiDesk: ${input.link}`)
  } else if (input.location?.trim()) {
    lines.push(`Can't be there? Join remotely in PlexiDesk: ${input.link}`)
  } else {
    lines.push(`Join the meeting in PlexiDesk: ${input.link}`)
  }
  lines.push('', 'Open the PlexiDesk link on a device with PlexiDesk installed to join at the scheduled time.')
  return lines.join('\n')
}

function fmtWhen(startMs: number): string {
  try {
    return new Date(startMs).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return new Date(startMs).toString()
  }
}

export async function sendMeetingInvites(input: {
  title: string
  startMs: number
  durationMin: number
  roomId: string
  invitees: string[]
  hostName?: string
  /** DEC-063's other answers to "where": an external link takes precedence
   *  over the built-in room; a place is stated, with the room kept as the
   *  remote door. Absent → the Plexii room alone, as before. */
  joinUrl?: string | null
  location?: string | null
}): Promise<MeetingInviteResult> {
  const to = input.invitees.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'))
  if (to.length === 0) return { sent: 0, failed: [], noAccount: false }

  const link = meetingJoinLink(input.roomId)
  const when = fmtWhen(input.startMs)
  const host = input.hostName?.trim()
  const body = composeInviteBody({ ...input, host, when, link })

  const failed: string[] = []
  let sent = 0
  let noAccount = false
  for (const addr of to) {
    const res = await window.api.mail.send({
      to: [addr],
      subject: `Meeting invitation: ${input.title}`,
      text: body
    })
    if (res.ok) {
      sent += 1
    } else {
      failed.push(addr)
      // A missing mailbox is the same for every recipient — record it once so
      // the UI can tell the user to connect mail rather than listing failures.
      if (/no mail account/i.test(res.error)) noAccount = true
    }
  }
  return { sent, failed, noAccount }
}
