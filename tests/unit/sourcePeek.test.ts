// @vitest-environment node
//
// Which references open in place, and which still take you to them.
//
// The classification has to be exhaustive and deliberate. A new reference kind
// that defaults to either side is a bug with no symptom: default to peeking and
// the viewer renders nothing; default to navigating and a kind that could have
// been shown in place silently keeps costing the user their place.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canPeek, PEEKABLE_KINDS } from '../../src/renderer/src/lib/sourcePeek'
import type { SourceTarget } from '../../src/renderer/src/lib/sourceTarget'

const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

/** Every kind in the SourceTarget union, read from the type itself. */
function allKinds(): string[] {
  const src = read('src/renderer/src/lib/sourceTarget.ts')
  const start = src.indexOf('export type SourceTarget =')
  expect(start, 'SourceTarget union not found — did it move?').toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('export function targetForSource', start))
  return [...new Set([...body.matchAll(/\|\s*\{\s*kind:\s*'([a-z-]+)'/g)].map((m) => m[1]))]
}

describe('canPeek', () => {
  const kinds = allKinds()

  it('parses the reference kinds', () => {
    // Vacuity guard: the exhaustiveness check below is satisfied for free by an
    // empty parse.
    expect(kinds.length).toBeGreaterThanOrEqual(10)
    expect(kinds).toContain('widget')
    expect(kinds).toContain('document')
  })

  it('classifies every kind — none defaults in', () => {
    const unclassified = kinds.filter(
      (k) => !PEEKABLE_KINDS.includes(k as (typeof PEEKABLE_KINDS)[number]) && !NAVIGATES.includes(k)
    )
    expect(
      unclassified,
      'a new reference kind must be added to PEEKABLE_KINDS (and given a renderer) ' +
        'or listed in NAVIGATES here with the reason it cannot be shown in place'
    ).toEqual([])
  })

  // The kinds that still navigate, each because it has a full editor or view
  // rather than an embeddable one. Showing a stand-in would mean previewing
  // something that is not the thing.
  const NAVIGATES = ['document', 'knowledge', 'desk', 'url', 'file', 'chat', 'meeting']

  it('peeks exactly the kinds with an inline renderer behind them', () => {
    expect([...PEEKABLE_KINDS].sort()).toEqual(['email', 'table', 'widget'])
  })

  it('says yes for a peekable reference', () => {
    expect(canPeek({ kind: 'widget', widgetId: 'w1' })).toBe(true)
    expect(canPeek({ kind: 'table', tableId: 't1' })).toBe(true)
    expect(canPeek({ kind: 'email', uid: 41 })).toBe(true)
  })

  it('says no for one that has to be navigated to', () => {
    expect(canPeek({ kind: 'document', documentId: 'd1' })).toBe(false)
    expect(canPeek({ kind: 'meeting', meetingId: 'm1' })).toBe(false)
    expect(canPeek({ kind: 'url', url: 'https://example.test' })).toBe(false)
  })

  it('says no for a reference that did not resolve', () => {
    // targetForSource returns null for anything it cannot open; a null must
    // never reach the viewer as an empty dialog.
    expect(canPeek(null as SourceTarget)).toBe(false)
  })
})

describe('the viewer and the router', () => {
  it('routes every kind from ONE place', () => {
    // It lived in ChatPanel with a single caller. A second appeared (the peek's
    // "Open where it lives"), and two hand-written switches over the same ten
    // kinds is the drift this codebase keeps paying for.
    const router = read('src/renderer/src/lib/goToSourceTarget.ts')
    for (const k of allKinds()) {
      expect(router, `the router does not handle '${k}'`).toContain(`case '${k}':`)
    }
    const panel = read('src/renderer/src/components/ChatPanel.tsx')
    expect(panel, 'ChatPanel should delegate, not re-route').not.toMatch(/case 'meeting':/)
    expect(panel).toContain('goToSourceTarget')
  })

  it('keeps a way to the thing itself', () => {
    // Peeking REPLACES navigation as the default, and must not remove it: the
    // reference you are reading is often the one you then want to work in.
    const modal = read('src/renderer/src/components/SourcePeekModal.tsx')
    expect(modal).toContain('source-peek-go')
    expect(modal).toContain('Open where it lives')
    expect(modal).toContain('goToSourceTarget')
  })
})
