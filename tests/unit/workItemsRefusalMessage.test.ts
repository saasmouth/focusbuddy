// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { friendlyWorkItemError } from '../../src/renderer/src/stores/workItems'

// DEC-144 rewrite: this file pinned the "turned off — use the Settings switch"
// message. Focus is always on and that switch is gone, so no message may name
// it. The other refusals keep their translation. History of the original:
// the Attention layer shipped OFF — a per-device opt-in — so a work-item create
// could legitimately be refused. What reached the user was the raw IPC rejection:
//
//   Error invoking remote method 'workItems:create': Error: Work items are not
//   enabled.
//
// That names an IPC channel and an internal flag and says nothing about the
// switch in Settings that turns it on, so the only honest reading of it is
// "the app is broken". None of the five call sites that create work items
// checked the capability first, so the translation belongs in the store.

describe('a refused work-item create explains itself', () => {
  const raw = (m: string) => new Error(`Error invoking remote method 'workItems:create': Error: ${m}`)

  it('never points at a Settings switch (there is none since DEC-144)', () => {
    const src = readFileSync(join(__dirname, '../../src/renderer/src/stores/workItems.ts'), 'utf-8')
    expect(src).not.toMatch(/Turn it on in Settings/)
    expect(src).not.toMatch(/layer is turned off/i)
  })

  it('explains an un-migrated device', () => {
    const msg = friendlyWorkItemError(raw('This device has not finished updating for Focus yet. Restart Plexii and try again.')).message
    expect(msg).toMatch(/restart/i)
    expect(msg).not.toMatch(/invoking remote method/i)
  })

  it('explains the personal-only case', () => {
    const msg = friendlyWorkItemError(raw('Focus tasks are personal for now. Switch to your personal workspace to add one.')).message
    expect(msg).toMatch(/personal workspace/i)
    expect(msg).not.toMatch(/invoking remote method/i)
  })

  it('passes an unrelated error through unchanged', () => {
    // A translator that rewrites everything hides real failures.
    const e = new Error('database is locked')
    expect(friendlyWorkItemError(e)).toBe(e)
  })

  it('survives a non-Error rejection', () => {
    expect(friendlyWorkItemError('plain string').message).toBe('plain string')
  })
})

describe("the document editor's chrome stays put when the page scrolls", () => {
  // The formatting toolbar had been sticky on its own (Toolbar.tsx), which was
  // worse than neither being sticky: scrolling slid File/View/Tools out of
  // reach while the formatting row stayed behind, so the chrome came apart and
  // the menus you reach for most were the ones that left. Doc was the only
  // editor with this problem — Sheet, Slides, Design, Map and DrawStudio all
  // mount their menu bar as a flex sibling of the scrolling body, so it never
  // moved there.
  const src = readFileSync(
    join(__dirname, '..', '..', 'src/renderer/src/components/documents/DocEditor.tsx'),
    'utf8'
  )

  it('pins the whole chrome block, full width', () => {
    const sticky = /className="sticky top-0[^"]*"/.exec(src)?.[0] ?? ''
    expect(sticky).toMatch(/sticky top-0/)
    // Full width is the half that buys the vertical space back: capped at
    // max-w-3xl the toolbar was narrower than the 900-1040px text column it
    // formats, so it wrapped onto three rows on a window wide enough for one.
    expect(sticky).toMatch(/w-full/)
    expect(sticky).not.toMatch(/max-w-3xl/)
  })

  it('keeps an opaque background, because document text scrolls underneath', () => {
    const sticky = /className="sticky top-0[^"]*"/.exec(src)?.[0] ?? ''
    expect(sticky).toMatch(/bg-paper/)
  })

  it('leaves the toolbar no sticky of its own', () => {
    // Two separately-pinned rows is what came apart in the first place.
    const toolbar = readFileSync(
      join(__dirname, '..', '..', 'src/renderer/src/components/documents/editor/Toolbar.tsx'),
      'utf8'
    )
    const root = /data-testid="doc-toolbar"[\s\S]{0,400}?className="([^"]*)"/.exec(toolbar)?.[1] ?? ''
    expect(root).not.toMatch(/sticky/)
  })

  it('still mounts the menu bar inside the pinned block, above the toolbar', () => {
    const start = src.indexOf('sticky top-0 z-20 -mx-8')
    const menu = src.indexOf('<DocMenuBar', start)
    const toolbar = src.indexOf('<Toolbar', start)
    expect(menu).toBeGreaterThan(start)
    expect(toolbar).toBeGreaterThan(menu)
  })
})
