import { describe, it, expect } from 'vitest'
import { targetForSource, isOpenable } from '../../src/renderer/src/lib/sourceTarget'

// A citation that lands you in the inbox is not a citation, it is a hint — and in
// a mailbox of thousands, a useless one. An email source carries the uid, so the
// click can open the exact message.

const email = (docId: string) => ({ docId, docType: 'email' })

describe('an email citation opens that message', () => {
  it('resolves mail:<uid> to the uid', () => {
    expect(targetForSource(email('mail:4321'))).toEqual({ kind: 'email', uid: 4321 })
  })

  it('is clickable, rather than rendering as dead text', () => {
    expect(isOpenable(email('mail:4321'))).toBe(true)
  })

  it('accepts uid 0, which is a legal uid', () => {
    expect(targetForSource(email('mail:0'))).toEqual({ kind: 'email', uid: 0 })
  })

  it('refuses anything that is not a whole uid, rather than opening the wrong email', () => {
    // Opening the WRONG message is worse than not opening at all: the user would
    // read it as the cited source and have no reason to doubt it.
    for (const bad of ['mail:', 'mail:abc', 'mail:1.5', 'mail:-2', 'mail:1 2', '4321', 'mail:4321x']) {
      expect(targetForSource(email(bad)), bad).toBeNull()
      expect(isOpenable(email(bad)), bad).toBe(false)
    }
  })

  it('refuses a uid too large to be exact', () => {
    // Beyond Number.MAX_SAFE_INTEGER the value silently rounds, which would
    // address a different message than the one cited.
    expect(targetForSource(email('mail:99999999999999999999'))).toBeNull()
  })

  it('does not disturb the other source kinds', () => {
    expect(targetForSource({ docId: 'd1', docType: 'doc' })).toEqual({ kind: 'document', documentId: 'd1' })
    expect(targetForSource({ docId: 'n1', docType: 'task' })).toEqual({ kind: 'desk', taskId: 'n1' })
    expect(targetForSource({ docId: 'c1', docType: 'chat' })).toEqual({ kind: 'chat', conversationId: 'c1' })
  })
})
