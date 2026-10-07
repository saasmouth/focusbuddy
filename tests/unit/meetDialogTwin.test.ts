// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeInviteBody } from '../../src/renderer/src/lib/meetingInvite'

// ── DEC-117 — the New meeting dialog is the Calendar composer's twin.
// Operator (2026-09-06): "make the Start or schedule a meeting button and
// the window that pops up look more like the booking page from making a
// calendar invite… it could be nearly identical… just make sure the
// relevant functionality exists for actually scheduling and booking a
// meeting." So: BookTimeDialog's recipes, verbatim, under Meet's own
// behaviour — Start now opens the live room and rings / emails; Schedule
// writes a real meeting block with guests, where, agenda, attach and repeat,
// and emails the invites.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const meet = read('renderer/src/components/NewMeetingDialog.tsx')
const composer = read('renderer/src/components/BookTimeDialog.tsx')

describe('DEC-117 — twins: every recipe the dialog wears is the composer\'s own string', () => {
  // If the composer's material ever changes, this list breaks in BOTH files
  // at once — the twin cannot drift quietly.
  const SHARED = [
    // the header slider and its sliding thumb
    'relative grid grid-cols-2 rounded-full bg-[var(--surface-sunken)] p-1 select-none',
    'absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]',
    "mode === m ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'",
    // the 23px title with the hairline base and the reserved hint line
    'w-full bg-transparent text-[23px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-50)] outline-none [&:focus-visible]:outline-none border-b border-[var(--edge-soft)] focus:border-[rgb(var(--accent))] pb-1.5 transition-colors',
    'Leave blank and it saves as',
    // the time-row chips, the derived duration label, the quiet Repeat chip
    "'h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] text-[13px] font-medium ' +",
    "'text-[var(--ink-90)] fb-tabular fb-press inline-flex items-center gap-1.5'",
    'title="Click: longer · Shift+Click: shorter"',
    'Don&rsquo;t repeat',
    // guests: the filled field, the chip, the ranked suggestions
    'min-h-10 px-2 py-1.5 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] flex flex-wrap items-center gap-1.5 cursor-text',
    'inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] text-[12.5px] text-[var(--ink-90)]',
    "placeholder={guests.length === 0 ? 'Name or email' : ''}",
    'absolute left-0 right-0 top-full mt-1 z-20 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1',
    // WHERE: one segmented question
    "['plexi', 'videocam', 'Plexii Meet'],",
    "['link', 'link', 'Paste link'],",
    "['inperson', 'place', 'In person'],",
    "['none', null, 'None']",
    "? 'bg-[var(--surface-raised)] border border-[var(--edge-soft)] text-[rgb(var(--accent))] shadow-[0_1px_3px_rgba(0,0,0,0.06)]'",
    'placeholder="Paste a Google Meet, Zoom or Teams link"',
    'placeholder="An address, a room, or where to meet"',
    // AGENDA and Attach
    'placeholder="What this meeting needs to settle"',
    'h-10 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-[var(--edge-strong)] inline-flex items-center gap-2 text-[13px] text-[var(--ink-70)] fb-press transition-colors hover:text-[var(--ink-90)]',
    'Attach a desk or work item',
    'inline-flex items-center gap-1 h-6 px-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold',
    // the footer
    'to discard',
    'className="btn-primary ml-auto"',
    'rounded bg-white/20 px-1 text-[11px] leading-4',
    // the dialog frame
    'fb-card w-full max-w-[560px] overflow-hidden max-h-[86vh] flex flex-col shadow-[0_32px_80px_-16px_rgba(0,0,0,0.5)]',
    'px-6 pt-5 pb-5 flex flex-col gap-4 overflow-y-auto',
    'px-6 py-4 border-t border-[var(--edge-soft)] flex items-center gap-3 shrink-0'
  ]
  it.each(SHARED)('%s', (s) => {
    expect(composer).toContain(s)
    expect(meet).toContain(s)
  })

  it('the slider chooses Start now / Schedule — both meetings, no Focus', () => {
    expect(meet).toContain("['now', 'videocam', 'Start now'],")
    expect(meet).toContain("['schedule', 'event', 'Schedule']")
    expect(meet).toContain('data-testid={`new-meeting-mode-${m}`}')
    expect(meet).not.toContain('Focus time')
    // the composer's stub copy about hosted links that do not exist is NOT copied
    expect(meet).not.toContain('Guests join in the')
  })

  it('the keyboard map is the composer\'s: Esc discards, Enter commits, Cmd+M flips, guests and agenda guard Enter', () => {
    expect(meet).toContain("if (e.key === 'Escape') {")
    expect(meet).toContain("if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {")
    expect(meet).toContain("if (e.key === 'Enter' && !e.shiftKey) {")
    expect(meet).toContain('function onGuestKeyDown(')
    expect(meet).toContain('function onAgendaKeyDown(')
    expect(meet).toContain("if (e.key === 'Backspace' && guestInput === '' && guests.length > 0) {")
  })
})

describe('DEC-117 — Meet\'s own behaviour behind the twin', () => {
  it('Start now opens the live room, rings the picked teammates, emails the rest', () => {
    expect(meet).toContain('const roomId = await startRoom(finalTitle)')
    expect(meet).toContain('for (const p of ring) inviteToRoom({ accountId: p.accountId!, handle: p.handle! })')
    expect(meet).toContain('sendMeetingInvites({ title: finalTitle, startMs: Date.now(), durationMin, roomId, invitees: emails, hostName })')
    expect(meet).toContain("useEntitlement('meet', 'Meetings')")
    expect(meet).toContain('Could not start the meeting. Check your microphone and camera permissions.')
  })

  it('Schedule writes a real meeting block: room id, guests, where, agenda, attached desk, repeat', () => {
    expect(meet).toContain("useEntitlement('meet_schedule', 'Meeting scheduling')")
    expect(meet).toContain('const roomId = newMeetingRoomId()')
    expect(meet).toContain("joinUrl: where === 'link' && joinUrl.trim() ? joinUrl.trim() : null,")
    expect(meet).toContain("location: where === 'inperson' && location.trim() ? location.trim() : null,")
    expect(meet).toContain("agenda: agenda.trim() || null")
    expect(meet).toContain('taskId: attached?.id ?? null,')
    expect(meet).toContain('recurrence: repeat || null')
    expect(meet).toContain('Meeting scheduled. It is on your calendar with a Join button.')
    // the invite email knows where the meeting is
    expect(meet).toContain('joinUrl: meeting.joinUrl,')
    expect(meet).toContain('location: meeting.location')
  })

  it('guests: a typed, uncommitted address still counts; online teammates are chips that ring, not addresses', () => {
    expect(meet).toContain('function finalGuests(): Guest[] {')
    expect(meet).toContain('type Guest = GuestChip & { accountId?: string; handle?: string }')
    expect(meet).toContain('data-testid={`new-meeting-peer-${p.chip.accountId}`}')
    expect(meet).toContain('data-testid="new-meeting-invitees"')
    // the ring path is Start-now only — a scheduled meeting has no live room to ring into
    expect(meet).toContain("mode === 'now'\n        ? peers.filter(")
  })

  it('Attach is REAL here: an open desk from the store, and the block links to it', () => {
    expect(meet).toContain("nodes\n        .filter((n) => n.kind === 'task' && n.status !== 'done')")
    expect(meet).toContain('data-testid="new-meeting-attach-picker"')
    expect(meet).toContain('data-testid={`new-meeting-attach-${d.id}`}')
    expect(meet).not.toContain('STUB_ATTACH')
  })

  it('the honest notes survive: mailbox, failures, scheduled', () => {
    expect(meet).toContain('Connect a mailbox in Mail to email the invites. The join link is on the meeting.')
    expect(meet).toContain('could not email ${r.failed.join')
    expect(meet).toContain('data-testid="new-meeting-note"')
    expect(meet).toContain('data-testid="new-meeting-error"')
  })

  it('the call sites are untouched — the dialog still opens from the Meet page and the home widget', () => {
    expect(read('renderer/src/components/views/PlexiMeetView.tsx')).toContain('<NewMeetingDialog onClose={() => setShowNew(false)} />')
    expect(read('renderer/src/components/views/homeWidgets.tsx')).toContain('NewMeetingDialog')
  })
})

describe('DEC-117 — the invite email knows where the meeting is', () => {
  const base = { title: 'Roadmap sync', durationMin: 30, host: 'Ryan', when: 'Mon, Sep 7, 8:00 PM', link: 'plexii://meet?room=r1' }

  it('a plain Plexii meeting reads exactly as it always has', () => {
    const body = composeInviteBody(base)
    expect(body).toContain('Ryan has invited you to a meeting.')
    expect(body).toContain('What: Roadmap sync')
    expect(body).toContain('When: Mon, Sep 7, 8:00 PM (30 min)')
    expect(body).toContain('Join the meeting in PlexiDesk: plexii://meet?room=r1')
    expect(body).not.toContain('Where:')
  })

  it('an external link is THE join line; the Plexii room stays as the PlexiDesk door', () => {
    const body = composeInviteBody({ ...base, joinUrl: 'https://meet.google.com/abc-defg-hij' })
    expect(body).toContain('Join the meeting: https://meet.google.com/abc-defg-hij')
    expect(body).toContain('Or in PlexiDesk: plexii://meet?room=r1')
    expect(body).not.toContain('Join the meeting in PlexiDesk:')
  })

  it('an in-person meeting states the place first and keeps the remote door', () => {
    const body = composeInviteBody({ ...base, location: 'Room 4B, 12 Main St' })
    expect(body).toContain('Where: Room 4B, 12 Main St')
    expect(body).toContain("Can't be there? Join remotely in PlexiDesk: plexii://meet?room=r1")
  })

  it('a hybrid meeting carries both; blank strings count as absent; no host still reads', () => {
    const body = composeInviteBody({ ...base, host: undefined, joinUrl: '  ', location: 'HQ' })
    expect(body).toContain('You have been invited to a meeting.')
    expect(body).toContain('Where: HQ')
    expect(body).not.toContain('Join the meeting:   ')
    expect(body).toContain("Can't be there?")
  })
})
