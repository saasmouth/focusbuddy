// Who a comment says it is from.
//
// The owner's complaint was that comments read "Someone". Two things were true
// at once, and only one of them was about missing names:
//
//   1. The accounts in my verification had no name, so the SERVER's honest
//      fallback for a nameless account was showing through. That is the part
//      the "require a name at sign-up" work fixes.
//   2. The client rendered `.handle`, not the name — so an account that HAD
//      entered a first and last name ALSO showed the wrong thing, and would
//      have gone on doing so after every account had a name.
//
// This file is about (2), which is the bug rather than the policy. The name was
// already present the whole time: the live-document members payload carries
// firstName/lastName beside the handle (`nameOf` on the server), and
// `collaborators()` already folds them into `.name` with personDisplayName.
// Nothing was missing but the field being read — which is exactly the sort of
// defect a test that asserts "a name appears" would miss, so every case here
// uses a person whose name and handle are DIFFERENT and asserts which one won.

import { describe, expect, it } from 'vitest'
import { collaborators, displayNameFor } from '../../src/renderer/src/lib/presence'
import { personDisplayName } from '../../src/renderer/src/lib/personName'

/** A live document's member list, as GET /livedocs/:id returns it. */
const members = [
  { accountId: 'a1', handle: 'mdean', firstName: 'Michael', lastName: 'Dean' },
  { accountId: 'a2', handle: 'sarah_k', firstName: 'Sarah', lastName: null },
  { accountId: 'a3', handle: 'legacy_user', firstName: null, lastName: null },
  { accountId: 'a4', handle: '', firstName: null, lastName: null }
]

// The REAL function the view uses, not a copy of it. My first version of this
// file re-implemented the lookup inline and so tested its own idea of the
// code — which is exactly how `.handle` got asserted as correct in the first
// place. displayNameFor is now exported from presence.ts and the view calls it.
const displayNameOf = (id: string): string => displayNameFor(collaborators(members, null, 'a1'), id)

describe('a comment is attributed to a NAME, not a routing handle', () => {
  it('shows "First Last" for someone who has entered both', () => {
    // The case the old code got wrong: a complete name, and it still showed
    // the handle. Asserting the name appears is not enough — the handle must
    // NOT, or `.handle` would satisfy a looser test.
    expect(displayNameOf('a1')).toBe('Michael Dean')
    expect(displayNameOf('a1')).not.toBe('mdean')
  })

  it('shows a first name alone when that is all there is', () => {
    expect(displayNameOf('a2')).toBe('Sarah')
  })

  it('falls back to the handle only when there is no name', () => {
    // The owner's rule: "falling back to the existing handle only where no
    // name exists yet". A legacy account keeps working and is not blanked.
    expect(displayNameOf('a3')).toBe('legacy_user')
  })

  it('never invents a name for an account with neither', () => {
    // personDisplayName's last resort. Honest rather than blank, and honest
    // rather than fabricated — it is the one case where 'Someone' is right.
    expect(displayNameOf('a4')).toBe('Someone')
  })

  it('the handle is still available for routing and mentions', () => {
    // The fix must not take the handle away: @mentions resolve by handle, and
    // keys are built from it. Only the DISPLAY changed.
    const people = collaborators(members, null, 'a1')
    expect(people.find((p) => p.accountId === 'a1')?.handle).toBe('mdean')
    expect(people.find((p) => p.accountId === 'a2')?.handle).toBe('sarah_k')
  })
})

describe('personDisplayName degrades in the owner’s order', () => {
  it('real name, then handle, then email, then the fallback', () => {
    expect(personDisplayName({ firstName: 'Ada', lastName: 'Lovelace', handle: 'al' })).toBe('Ada Lovelace')
    expect(personDisplayName({ firstName: null, lastName: null, handle: 'al' })).toBe('al')
    expect(personDisplayName({ firstName: null, lastName: null, handle: '', email: 'ada@example.com' })).toBe('ada')
    expect(personDisplayName({ firstName: null, lastName: null, handle: '' })).toBe('Someone')
    expect(personDisplayName(null)).toBe('Someone')
  })

  it('ignores whitespace-only names rather than showing a blank', () => {
    expect(personDisplayName({ firstName: '   ', lastName: '  ', handle: 'al' })).toBe('al')
  })
})
