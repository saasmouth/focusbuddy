import { beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// R26's standing-grant store (A6/B2): one canonical key per site, grants
// persist to disk, and revocation genuinely removes them. app.getPath is
// pointed at a fresh temp dir per test so the file round-trip is real.

let userData = ''
vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import {
  consentHostOf,
  consentGate,
  hasConsent,
  grantConsent,
  revokeConsent,
  listConsent,
  _resetConsentCache
} from '../../src/main/browserConsent'

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'consent-test-'))
  _resetConsentCache()
})

describe('consentHostOf — one key per site', () => {
  test('lowercases, strips www and ignores port/path/query', () => {
    expect(consentHostOf('https://WWW.Example.COM:8443/checkout?x=1')).toBe('example.com')
    expect(consentHostOf('http://example.com')).toBe('example.com')
  })
  test('bare IPs and localhost keep their identity', () => {
    expect(consentHostOf('http://127.0.0.1:5000/page')).toBe('127.0.0.1')
  })
  test('garbage is null, never a guessed host', () => {
    expect(consentHostOf('not a url')).toBeNull()
    expect(consentHostOf('')).toBeNull()
  })
})

describe('the grant store', () => {
  test('grant → has → list → revoke round-trips', () => {
    expect(hasConsent('example.com')).toBe(false)
    grantConsent('example.com')
    expect(hasConsent('example.com')).toBe(true)
    expect(listConsent().map((g) => g.host)).toEqual(['example.com'])
    revokeConsent('example.com')
    expect(hasConsent('example.com')).toBe(false)
    expect(listConsent()).toEqual([])
  })
  test('grants persist to disk across a cache reset (a real file round-trip)', () => {
    grantConsent('example.com')
    grantConsent('another.test')
    _resetConsentCache()
    expect(hasConsent('example.com')).toBe(true)
    expect(listConsent().map((g) => g.host)).toEqual(['another.test', 'example.com'])
  })
  test('revoking a host that was never granted is a quiet no-op', () => {
    revokeConsent('never.granted')
    expect(listConsent()).toEqual([])
  })
})

// The gate the agent loop consults before every mutating action.
//
// It used to FAIL OPEN: the loop read `if (host && !hasConsent(host)) ask()`,
// so when the host could not be determined the prompt was skipped and the
// click went ahead with nobody asked. These pin the replacement down.
describe('consentGate — fails closed', () => {
  test('asks on a site with no standing grant', () => {
    expect(consentGate('https://example.com/checkout')).toEqual({
      ask: true,
      host: 'example.com',
      label: 'example.com',
      rememberable: true
    })
  })

  test('lets a granted site through without asking', () => {
    grantConsent('example.com')
    expect(consentGate('https://www.example.com/anything')).toEqual({ ask: false })
  })

  test('ASKS when the page has no identifiable site — the old hole', () => {
    // Each of these returned a null host, which the old condition read as
    // "no consent needed". A data: URL can carry a live form.
    for (const url of ['', 'about:blank', 'data:text/html,<form>', 'file:///Users/x/page.html', 'not a url']) {
      const g = consentGate(url)
      expect(g.ask, `${JSON.stringify(url)} must not slip through`).toBe(true)
    }
  })

  test('never remembers a grant for a page with no site', () => {
    // There is no stable key to store it under; inventing one would let a
    // grant made on one blank page cover the next.
    const g = consentGate('about:blank')
    expect(g).toMatchObject({ ask: true, rememberable: false, host: '' })
  })

  test('tells the human plainly that the page has no address', () => {
    const g = consentGate('')
    expect(g.ask && g.label).toContain('no web address')
  })

  test('a blank page stays ungated-by-default even after other grants exist', () => {
    // Granting real sites must never widen into "anything without a host".
    grantConsent('example.com')
    grantConsent('another.test')
    expect(consentGate('about:blank').ask).toBe(true)
  })
})

describe('grants never widen past the site they were given for', () => {
  test('a subdomain does not inherit its parent\'s grant', () => {
    // Stripping www is deliberate; stripping any other label would let a
    // grant for example.com cover pay.evil.example.com.
    grantConsent('example.com')
    expect(consentGate('https://pay.example.com/').ask).toBe(true)
    expect(consentGate('https://evil.example.com/').ask).toBe(true)
  })

  test('a lookalike domain gets its own key', () => {
    // Cyrillic "а" normalises to punycode, so it cannot borrow example.com's grant.
    grantConsent('example.com')
    const host = consentHostOf('https://ex\u0430mple.com/')
    expect(host).not.toBe('example.com')
    expect(consentGate('https://ex\u0430mple.com/').ask).toBe(true)
  })

  test('a corrupt consent file grants nothing', () => {
    // Unreadable state must start clean, never half-parse into permissions.
    writeFileSync(join(userData, 'browser-consent.json'), '{ "v": 1, "grants": ')
    _resetConsentCache()
    expect(listConsent()).toEqual([])
    expect(consentGate('https://example.com').ask).toBe(true)
  })

  test('a file from a future schema grants nothing', () => {
    writeFileSync(
      join(userData, 'browser-consent.json'),
      JSON.stringify({ v: 2, grants: { 'example.com': { grantedAt: '2026-01-01' } } })
    )
    _resetConsentCache()
    expect(hasConsent('example.com')).toBe(false)
  })
})
