// "Paste a share link" in Shared with me (SharedView.tsx). Found by 23
// (2026-11-07): plexiidesk.com/share/c/<token>, the address a snapshot
// recipient's browser shows once the viewer forwards their link, was read as
// the token "c" -- and a live link's dsk_ token as "dsk".
import { describe, it, expect } from 'vitest'
import { parsePastedShareLink } from '../../src/renderer/src/lib/shareTokens'

const READ = 'wyhjhvrwckbfzqkt'
const LIVE = 'dsk_80375edef54b39e65855eb11f6d882cb7aacfcad'

describe('what a pasted link is', () => {
  it('a read link, as sent and as the browser shows it after the viewer forwards it', () => {
    expect(parsePastedShareLink(`https://view.plexiidesk.com/share/${READ}`)).toEqual({ kind: 'read', token: READ })
    expect(parsePastedShareLink(`https://view.plexiidesk.com/share/${READ}?classic=1`)).toEqual({ kind: 'read', token: READ })
    expect(parsePastedShareLink(`https://plexiidesk.com/share/c/${READ}`)).toEqual({ kind: 'read', token: READ })
    expect(parsePastedShareLink(`  plexiidesk.com/share/c/${READ}/  `)).toEqual({ kind: 'read', token: READ })
    expect(parsePastedShareLink(READ)).toEqual({ kind: 'read', token: READ })
  })

  it('a desk to use, and a live desk: named, not added', () => {
    expect(parsePastedShareLink('https://plexiidesk.com/share/s/abcdefghijklmnopqrstuvwxyz012345')).toEqual({ kind: 'use' })
    expect(parsePastedShareLink(`https://view.plexiidesk.com/share/${LIVE}`)).toEqual({ kind: 'live' })
    expect(parsePastedShareLink(`https://plexiidesk.com/share/l/${LIVE}`)).toEqual({ kind: 'live' })
  })

  it('anything else is not a share link', () => {
    expect(parsePastedShareLink('https://plexiidesk.com/pricing')).toBeNull()
    expect(parsePastedShareLink('hello')).toBeNull()
    expect(parsePastedShareLink('')).toBeNull()
  })
})
