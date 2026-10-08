// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXPIRY_CHOICES,
  PUBLIC_MODES,
  expiryAt,
  publicMode
} from '../../src/renderer/src/components/share/shareAudience'

// ── 2026-10-09 — "it feels confusing and like there is duplication" ────────
//
// Sharing a desk offered FIVE link-minting controls in one dialog. Three of
// them produced a public link to a copy of the desk, and two of those three
// were literally the same call to the same transport. The dialog also carried a
// paragraph of prose warning that the link below was frozen while the section
// above was live — which is the tell: controls that need prose to be told apart
// cannot be told apart by looking.
//
// It is now two questions. These tests pin the SHAPE of that, and the property
// that matters most: that nothing was quietly dropped on the way.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const dialog = read('renderer/src/components/ShareDialog.tsx')
const sheet = read('renderer/src/components/share/DeskShareSheet.tsx')
const live = read('renderer/src/components/LiveDeskSharing.tsx')

describe('the public modes are distinct, and ordered for the demo case', () => {
  it('there are exactly three, each appearing once', () => {
    expect(PUBLIC_MODES.map((m) => m.id)).toEqual(['use', 'watch', 'read'])
  })

  it('"a desk they can use" leads, because that is the demo path', () => {
    // The whole point of revisiting this was demo desks. A desk someone can
    // actually drive is the one that sells the product, so it is first and it
    // is the default in the sheet.
    expect(PUBLIC_MODES[0].id).toBe('use')
    expect(PUBLIC_MODES[0].blurb).toMatch(/demo/i)
    expect(sheet).toContain("useState<PublicMode>('use')")
  })

  it('each mode says what the RECIPIENT gets, not what the feature is called', () => {
    for (const m of PUBLIC_MODES) {
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.blurb.length).toBeGreaterThan(40)
      // No internal vocabulary leaking into the choice.
      expect(m.label.toLowerCase()).not.toMatch(/ephemeral|snapshot link|projection|scope/)
    }
  })

  it('publicMode refuses an id it does not know rather than guessing', () => {
    expect(() => publicMode('nope' as never)).toThrow(/unknown public share mode/)
  })
})

describe('expiry', () => {
  it('never is the default choice and is first', () => {
    // A demo link that dies in 48 hours dies in the middle of someone's trial.
    expect(EXPIRY_CHOICES[0]).toEqual({ label: 'Never', ms: null })
    expect(sheet).toContain('useState<number | null>(null)')
  })

  it('keeps 48 hours, which used to be the only behaviour available', () => {
    expect(EXPIRY_CHOICES.some((c) => c.ms === 48 * 60 * 60 * 1000)).toBe(true)
  })

  it('resolves to an absolute time, and null stays null', () => {
    expect(expiryAt(null)).toBeNull()
    expect(expiryAt(1000, 5_000)).toBe(6_000)
  })
})

describe('the dialog asks who, then what', () => {
  it('a desk renders only the sheet', () => {
    expect(dialog).toContain('<DeskShareSheet')
    expect(dialog).toContain("const isDesk = kind === 'folder' || kind === 'task'")
    expect(dialog).toContain('{isDesk && (')
    // The snapshot flow is still there for documents, widgets and files.
    expect(dialog).toContain('{!isDesk && (')
  })

  it('the five stacked desk controls are gone from the dialog', () => {
    // Each of these was its own section competing with the others.
    expect(dialog).not.toContain('<LiveDeskSharing')
    expect(dialog).not.toContain('<LiveWebViewPanel')
    expect(dialog).not.toContain('Copy a public link anyone can duplicate')
  })

  it('the prose that existed only to disambiguate two controls is gone', () => {
    expect(dialog).not.toContain('Or send a read-only snapshot link.')
    expect(dialog).not.toMatch(/Guardrail: on a desk\/room both paths are offered/)
  })

  it('the stale "the hosted viewer does not exist yet" banner is gone', () => {
    // It told users the link would not resolve. It does resolve — this shipped.
    expect(dialog).not.toContain('v1 note:')
    expect(dialog).not.toContain('once the PlexiDesk share service ships')
  })
})

describe('nothing was dropped', () => {
  it('the 48-hour usable link moved up a level rather than disappearing', () => {
    // It used to be nested under "live sharing with named people" while being
    // neither live nor to a named person.
    expect(live).not.toContain('<EphemeralDeskShare')
    expect(sheet).toContain('mintEphemeralShare')
  })

  it('all three transports are still reachable from the sheet', () => {
    expect(sheet).toContain('<LiveDeskSharing')      // specific people, two-way
    expect(sheet).toContain('<LiveWebViewPanel')     // the live public page
    expect(sheet).toContain('mintEphemeralShare')    // the usable browser desk
    expect(sheet).toContain('createFor(')            // the frozen snapshot
  })

  it('read-only-with-no-copy survives as a checkbox, not a lost option', () => {
    // The old picker could mint a view-scope snapshot. That is still possible.
    expect(sheet).toContain("scope: allowCopy ? 'copy' : 'view'")
    expect(sheet).toContain('data-testid="share-allow-copy"')
  })

  it('emailing a desk survives — it was a capability, not a section', () => {
    // The old dialog had an "Invite by email" heading of its own, which read as
    // a fourth way to share. It is delivery: one row, for whichever link is on
    // screen. Dropping it while collapsing the sections would have been a
    // regression, and this is the assertion that would have caught it.
    expect(sheet).toContain('data-testid="share-email"')
    expect(sheet).toContain('data-testid="share-send"')
  })

  it('the email pipe matches what the link can actually do', () => {
    // A snapshot is a server-addressable record, so it emails AND lands in the
    // recipient's Shared-with-me. A usable-desk token is a read capability in a
    // URL with no recipient model, so there is nothing to send server-side.
    expect(sheet).toContain("if (mode === 'read' && token)")
    expect(sheet).toContain('await invite(token, to)')
    expect(sheet).toContain('mailto:')
  })

  it('revoking either kind of link is still possible, from one list', () => {
    expect(sheet).toContain('data-testid="share-revoke-ephemeral"')
    expect(sheet).toContain('data-testid="share-revoke-snapshot"')
  })
})

describe('a link on screen always matches the description above it', () => {
  it('changing the mode, expiry or copy setting clears the minted URL', () => {
    // Showing a "desk they can use" URL under the "snapshot" description is how
    // someone sends the wrong thing to a client.
    expect(sheet).toContain('}, [mode, expiryMs, allowCopy])')
    expect(sheet).toContain('setUrl(null)')
  })
})
