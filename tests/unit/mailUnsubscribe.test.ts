import { describe, it, expect } from 'vitest'
import { parseUnsubscribe } from '../../src/main/mail/unsubscribe'

// An unsubscribe offer is one of the few things in the app that sends a real
// person's identifier somewhere on their behalf. It must come from what the
// SENDER published, never from anything found in the body.

describe('parseUnsubscribe', () => {
  it('reads an https target the sender published', () => {
    const r = parseUnsubscribe('List-Unsubscribe: <https://news.example.com/opt-out?u=abc>')
    expect(r.unsubscribe).toEqual({ kind: 'http', target: 'https://news.example.com/opt-out?u=abc' })
  })

  it('prefers https over mailto when both are offered', () => {
    const r = parseUnsubscribe(
      'List-Unsubscribe: <mailto:stop@example.com>, <https://example.com/out>'
    )
    expect(r.unsubscribe?.kind).toBe('http')
  })

  it('surfaces a mailto when that is all the sender gave', () => {
    const r = parseUnsubscribe('List-Unsubscribe: <mailto:stop@example.com?subject=unsub>')
    expect(r.unsubscribe).toEqual({ kind: 'mailto', target: 'mailto:stop@example.com?subject=unsub' })
  })

  // An opt-out request carries an identifier for a real person. Sending it in
  // the clear is not an improvement on leaving it alone.
  it('ignores a plain-http target rather than offering it', () => {
    const r = parseUnsubscribe('List-Unsubscribe: <http://insecure.example.com/out>')
    expect(r.unsubscribe).toBeNull()
  })

  it('handles the header folded across continuation lines', () => {
    const r = parseUnsubscribe('List-Unsubscribe: <https://example.com/a>,\r\n <mailto:b@example.com>\r\nFrom: x@y.z')
    expect(r.unsubscribe?.target).toBe('https://example.com/a')
  })

  it('is case-insensitive about the header name', () => {
    expect(parseUnsubscribe('list-unsubscribe: <https://e.test/x>').unsubscribe).toBeTruthy()
    expect(parseUnsubscribe('LIST-UNSUBSCRIBE: <https://e.test/x>').unsubscribe).toBeTruthy()
  })

  it('reports one-click only when the sender said so, and only over https', () => {
    const yes = parseUnsubscribe(
      'List-Unsubscribe: <https://e.test/x>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click'
    )
    expect(yes.oneClickUnsubscribe).toBe(true)
    const noPost = parseUnsubscribe('List-Unsubscribe: <https://e.test/x>')
    expect(noPost.oneClickUnsubscribe).toBe(false)
    // One-click against a mailto is meaningless — there is nothing to POST to.
    const mailtoOnly = parseUnsubscribe(
      'List-Unsubscribe: <mailto:s@e.test>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click'
    )
    expect(mailtoOnly.oneClickUnsubscribe).toBe(false)
  })

  // The absence of an offer is information. Inventing one would be worse than
  // showing nothing.
  it('returns null when the sender published nothing, whatever the body said', () => {
    expect(parseUnsubscribe(undefined).unsubscribe).toBeNull()
    expect(parseUnsubscribe('').unsubscribe).toBeNull()
    expect(parseUnsubscribe('Subject: Click here to unsubscribe!\r\nFrom: spam@e.test').unsubscribe).toBeNull()
    expect(parseUnsubscribe('X-Unsubscribe: <https://not-the-header.test/x>').unsubscribe).toBeNull()
  })

  it('does not fall for an unsubscribe link in the body', () => {
    const headersThenBody =
      'From: news@example.com\r\nSubject: Weekly\r\n\r\n<a href="https://evil.test/confirm?you=real">Unsubscribe</a>'
    expect(parseUnsubscribe(headersThenBody).unsubscribe).toBeNull()
  })
})
