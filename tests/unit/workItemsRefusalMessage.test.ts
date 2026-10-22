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

  it('never says Focus tasks are personal-only (DEC-145: team workspaces hold tasks)', () => {
    const src = readFileSync(join(__dirname, '../../src/renderer/src/stores/workItems.ts'), 'utf-8')
    expect(src).not.toMatch(/personal for now/i)
    // An error that merely mentions "personal" is not rewritten into that claim.
    const e = new Error('Could not open the personal workspace database')
    expect(friendlyWorkItemError(e)).toBe(e)
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
  //
  // The office-shell conversion fixed that by construction rather than by
  // sticky positioning: OfficeShellLayout renders the bar as the first child of
  // an `h-full flex flex-col`, with the canvas in a `flex-1 min-h-0` below it.
  // The bar is outside the scroller, so there is nothing to come apart and no
  // `sticky` anywhere. These tests therefore assert the new guarantee — Doc now
  // has the same shape the other five editors always had — instead of the
  // sticky block that used to provide it. Toolbar.tsx itself is gone; its
  // controls are ContextBar tabs in writeRibbon.tsx.
  const src = readFileSync(
    join(__dirname, '..', '..', 'src/renderer/src/components/documents/DocEditor.tsx'),
    'utf8'
  )
  const shell = readFileSync(
    join(__dirname, '..', '..', 'src/renderer/src/components/office/shell/OfficeShellLayout.tsx'),
    'utf8'
  )

  it('no longer pins chrome with sticky positioning', () => {
    // The bug was two separately-pinned rows. With the bar outside the
    // scroller there is nothing left to pin, so a reappearance of the chrome
    // block means someone has rebuilt the thing that broke. Matched by its own
    // signature — `sticky top-0 z-20` over the opaque paper background — and
    // not by `sticky` alone: the page-view horizontal ruler is legitimately
    // `sticky top-0 z-30` so it stays above the sheet while the page scrolls.
    expect(src).not.toMatch(/sticky top-0 z-20/)
    expect(src).not.toMatch(/sticky[^"]*bg-paper/)
  })

  it('mounts the whole editor in the office shell, not a bespoke column', () => {
    expect(src).toMatch(/<WriteChrome/)
    // The menu bar goes in as the shell's menuBar, which is what puts it on one
    // row with the tabs (owner ruling D2) and inside the same unscrolling bar.
    expect(src).toMatch(/menuBar=\{/)
    expect(src).toMatch(/<DocMenuBar/)
  })

  it('keeps the bar outside the scrolling canvas, which is what cannot come apart', () => {
    // bar first, then the canvas row: the bar is a flex sibling of the body.
    const bar = shell.indexOf('{bar}')
    const canvas = shell.indexOf('{children}')
    expect(bar).toBeGreaterThan(-1)
    expect(canvas).toBeGreaterThan(bar)
    // The shell's canvas slot owns no scrolling, so Doc supplies its own.
    expect(src).toMatch(/relative h-full overflow-auto/)
  })

  it('still gives the document the full width it formats', () => {
    // Full width was the half that bought the vertical space back: capped at
    // max-w-3xl the toolbar was narrower than the 900-1040px text column it
    // formats, so it wrapped onto three rows on a window wide enough for one.
    // The shell bar is full width by construction; what matters now is that
    // nobody has re-capped the chrome.
    expect(src).not.toMatch(/sticky[^"]*max-w-3xl/)
  })
})
