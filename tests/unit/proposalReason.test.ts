import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ACTION_KINDS_CATALOG, REASON_CONTRACT } from '../../src/main/ai/anthropic'
import { attributedNotes } from '../../src/renderer/src/lib/proposalReason'

// "reason" is the field the user decides from, and it was taught to be worthless.
//
// The plumbing was always complete: every one of the 31 proposal kinds carries
// `reason?: string`, parseChatJson reads it, and the card renders it. What was
// missing was any expectation of CONTENT. Thirty of the catalog's own examples
// read `"reason": "..."`, which demonstrates to the model thirty times over that
// a placeholder is acceptable; the single concrete one restated the title
// ("checklist for launch"); and nothing anywhere said what a reason is for. The
// user-visible result was the report that Plexii cannot explain the value of
// what it suggests — it was never asked to.
//
// That failure mode is invisible to every other test in this suite, because
// nothing here is type-incorrect. Hence this file.

const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const ANTHROPIC = 'src/main/ai/anthropic.ts'
const CARDS = 'src/renderer/src/components/ProposalCards.tsx'

/** Every action exemplar in the shared catalog, as the model is shown it. */
function catalogExemplars(): Array<{ kind: string; reason: string | null }> {
  const out: Array<{ kind: string; reason: string | null }> = []
  for (const line of ACTION_KINDS_CATALOG.split('\n')) {
    const kind = /"kind"\s*:\s*"([a-z-]+)"/.exec(line)
    if (!kind) continue
    const reason = /"reason"\s*:\s*"([^"]*)"/.exec(line)
    out.push({ kind: kind[1], reason: reason ? reason[1] : null })
  }
  return out
}

describe('the catalog teaches what a reason is for', () => {
  const exemplars = catalogExemplars()

  // Vacuity guard: every assertion below is "none of them are bad", which an
  // empty parse satisfies for free.
  it('parses a plausible set of exemplars out of the catalog', () => {
    expect(exemplars.length).toBeGreaterThan(25)
    const kinds = exemplars.map((e) => e.kind)
    for (const known of ['create-task', 'create-table', 'compose-mail', 'update-widget']) {
      expect(kinds, `'${known}' missing — the catalog parse is broken`).toContain(known)
    }
  })

  it('shows a reason on every action it advertises', () => {
    const missing = exemplars.filter((e) => e.reason === null).map((e) => e.kind)
    expect(missing, 'these kinds are advertised with no "reason" at all').toEqual([])
  })

  it('never demonstrates a placeholder reason', () => {
    // The specific regression. An example reading "..." does not merely fail to
    // help — it actively teaches the model that the field can be skipped.
    const PLACEHOLDERS = [/^\.{2,}$/, /^$/, /^why this helps$/i, /^reason$/i, /^tbd$/i, /^n\/?a$/i]
    const bad = exemplars
      .filter((e) => e.reason !== null && PLACEHOLDERS.some((re) => re.test(e.reason!.trim())))
      .map((e) => `${e.kind}: "${e.reason}"`)
    expect(bad, 'replace these with a reason that states why it helps the user').toEqual([])
  })

  it('never demonstrates a reason that merely restates the mechanics', () => {
    // "creates a table" is not a reason. A reason names the user's situation.
    const MECHANICAL = /^(creates?|makes?|adds?|opens?|sets?|updates?|deletes?) /i
    const bad = exemplars
      .filter((e) => e.reason && MECHANICAL.test(e.reason.trim()))
      .map((e) => `${e.kind}: "${e.reason}"`)
    expect(bad, 'these describe what the action does, not why the user wants it').toEqual([])
  })

  it('gives each kind its own reason rather than one copied everywhere', () => {
    // A single reason pasted across every kind would satisfy the checks above
    // while teaching the model nothing about tailoring it.
    const reasons = exemplars.map((e) => e.reason).filter((r): r is string => !!r)
    const unique = new Set(reasons.map((r) => r.toLowerCase()))
    expect(unique.size).toBeGreaterThan(reasons.length * 0.8)
  })
})

describe('the reason contract', () => {
  it('states the things that actually change the output', () => {
    const c = REASON_CONTRACT.toLowerCase()
    // Decide-from-it framing, not a field description.
    expect(c).toMatch(/decide/)
    // The two instructions that do the work: don't restate, and don't propose
    // what you cannot justify.
    expect(c).toMatch(/restate/)
    expect(c).toMatch(/do not propose/)
  })

  it('reaches every prompt that advertises a reason', () => {
    // Three prompt families emit these cards: the shared catalog (chat + agent
    // loop), the post-answer proposal prompt, and the meeting wrap-up. The
    // contract rides inside the catalog itself so the first two cannot drift —
    // the same reasoning that made the catalog shared in the first place.
    expect(ACTION_KINDS_CATALOG).toContain(REASON_CONTRACT)
    const src = read(ANTHROPIC)
    const uses = src.split('\n').filter((l) => /REASON_CONTRACT/.test(l) && !/^export const/.test(l.trim()))
    expect(uses.length, 'a prompt family is missing the contract').toBeGreaterThanOrEqual(3)
  })
})

describe('a missing reason is visible on the card', () => {
  it('does not silently render nothing', () => {
    // It used to be `{p.reason && (...)}` — so an omitted reason produced a card
    // asking for approval with no sign anything was absent.
    const src = read(CARDS)
    expect(src).toContain('proposal-no-reason')
    expect(src).not.toMatch(/\{p\.reason && \(/)
  })
})

describe('attributedNotes — the reason survives being accepted', () => {
  it('keeps the reason, attributed to Plexii', () => {
    const out = attributedNotes(undefined, 'the launch has seven moving parts')
    expect(out).toBe('Why Plexii suggested this: the launch has seven moving parts')
  })

  it("puts the user's own notes first", () => {
    const out = attributedNotes('Ring the vendor', 'they quoted a price that expires Friday')
    expect(out).toBe(
      'Ring the vendor\n\nWhy Plexii suggested this: they quoted a price that expires Friday'
    )
  })

  it('never claims a reason the model did not give', () => {
    // The No-Fakery line: no reason means no attribution line, not an invented one.
    expect(attributedNotes('Ring the vendor', undefined)).toBe('Ring the vendor')
    expect(attributedNotes('Ring the vendor', '   ')).toBe('Ring the vendor')
    expect(attributedNotes(undefined, undefined)).toBeUndefined()
    expect(attributedNotes('', '')).toBeUndefined()
  })

  it('does not grow the note each time it is carried', () => {
    const once = attributedNotes('Ring the vendor', 'price expires Friday')!
    const twice = attributedNotes(once, 'price expires Friday')
    expect(twice).toBe(once)
  })
})
