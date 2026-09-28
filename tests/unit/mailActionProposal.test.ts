import { describe, it, expect } from 'vitest'
import { parseChatJson } from '../../src/main/ai/anthropic'
import { isAutoApplyable } from '../../src/renderer/src/lib/actionExecutor'
import { describeAction } from '../../src/main/ai/actionLabel'
import { MAIL_ACTION_OPS, type ActionProposal } from '../../src/shared/types'

// Plexii could read an inbox and draft a reply, and could do nothing whatever to
// a message already in it. mail:markSeen, mail:archive, mail:move, mail:trash and
// mail:spam all existed and worked; the only thing that could reach them was a
// human clicking in the triage panel. mail-action is the proposal that closes
// that, and these are the properties that keep it safe to have.

const parse = (action: Record<string, unknown>) =>
  parseChatJson(JSON.stringify({ reply: 'ok', actions: [action] }))

const mailAction = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'mail-action',
  op: 'archive',
  uid: 4321,
  subject: 'Weekly digest',
  ...over
})

describe('mail-action parses the operations mail actually supports', () => {
  it('accepts every op in MAIL_ACTION_OPS', () => {
    for (const op of MAIL_ACTION_OPS) {
      const extra = op === 'move' ? { mailbox: 'Receipts' } : {}
      const out = parse(mailAction({ op, ...extra }))
      expect(out?.dropped, `op ${op} was dropped`).toBe(0)
      expect(out?.proposals[0]).toMatchObject({ kind: 'mail-action', op, uid: 4321 })
    }
  })

  it('refuses an op the mail layer cannot carry out', () => {
    // mark-unread reads perfectly plausibly and there is no IPC for it, so a card
    // offering it would fail at apply time after the user had accepted it.
    const out = parse(mailAction({ op: 'mark-unread' }))
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })

  it('keeps the destination on a move', () => {
    const out = parse(mailAction({ op: 'move', mailbox: 'Receipts' }))
    expect(out?.proposals[0]).toMatchObject({ op: 'move', mailbox: 'Receipts' })
  })

  it('refuses a move with nowhere to move to', () => {
    const out = parse(mailAction({ op: 'move' }))
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })

  it('drops a mailbox on ops that do not use one, rather than carrying it', () => {
    const out = parse(mailAction({ op: 'archive', mailbox: 'Receipts' }))
    expect(out?.proposals[0]).toMatchObject({ op: 'archive' })
    expect((out?.proposals[0] as { mailbox?: string }).mailbox).toBeUndefined()
  })
})

describe('a message must be identified by uid, never by subject', () => {
  // A subject is not a handle. Two emails can share one, and the one that gets
  // archived would be whichever the code happened to match first — so a missing
  // or non-numeric uid has to be refused, not guessed around.
  it('refuses an action with no uid', () => {
    const out = parse({ kind: 'mail-action', op: 'trash', subject: 'Invoice' })
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })

  it('refuses a uid that is not a whole number', () => {
    for (const uid of ['4321', 4.5, null, {}]) {
      const out = parse(mailAction({ uid }))
      expect(out?.proposals, `uid ${JSON.stringify(uid)} was accepted`).toHaveLength(0)
    }
  })

  it('accepts uid 0, which is a legal uid and not "missing"', () => {
    expect(parse(mailAction({ uid: 0 }))?.proposals[0]).toMatchObject({ uid: 0 })
  })

  it('still offers the action when only the subject is missing', () => {
    // The subject is what the card shows, so its absence is cosmetic. Dropping the
    // action over it would lose a real instruction for a presentational reason.
    const out = parse({ kind: 'mail-action', op: 'archive', uid: 9 })
    expect(out?.dropped).toBe(0)
    expect(out?.proposals[0]).toMatchObject({ uid: 9, subject: '(no subject)' })
  })
})

describe('mail actions are never applied without a person accepting', () => {
  it('is gated, like the other kinds that touch the world outside the app', () => {
    // Every op moves or flags real mail on a real server. The agent loop applies
    // ungated proposals by itself, so this being absent from GATED_KINDS would let
    // an autonomous run file someone's inbox unattended.
    for (const op of MAIL_ACTION_OPS) {
      const p = { id: 'm1', kind: 'mail-action', op, uid: 1, subject: 's' } as ActionProposal
      expect(isAutoApplyable(p), `op ${op} was auto-applyable`).toBe(false)
    }
  })
})

describe('the trace says which operation, not just "mail"', () => {
  it('names the op alongside the subject', () => {
    const t = describeAction({ kind: 'mail-action', op: 'trash', uid: 5, subject: 'Invoice' })
    expect(t?.label).toContain('trash')
    expect(t?.label).toContain('Invoice')
  })

  it('falls back to the uid when there is no subject to show', () => {
    expect(describeAction({ kind: 'mail-action', op: 'archive', uid: 77 })?.label).toContain('77')
  })
})
