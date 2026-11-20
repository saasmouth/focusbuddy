// @vitest-environment node
// When the widget host may write the file back (d0's F2 item 2: no echo-saves).
//
// The spike posted a save every time the widget's row changed in the store, and
// card, shape and custom-block changed it three times on load with no edit at
// all, so merely OPENING a file would have rewritten it. The file on disk is
// the only truth in PlexiiLite (it writes atomically, checks for outside
// changes and keeps Undo), so a write that changes nothing is not harmless: it
// bumps the file's date, can trip another app's "changed on disk", and spends
// an Undo step on nothing.
//
// The rule: post a save only when the file's text differs from the last text
// the embedder has (what it loaded, then each save), ignoring exportedAt, which
// is restamped on every export; and only after the person has done something
// in the page. A widget that tidies its own content on mount is not the
// person's change, so opening and closing a file never writes it.
import { describe, it, expect } from 'vitest'
import { canonicalFileText, createSaveGate } from '../../src/web/widgetHost/saveGate'

const file = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'plexii.widget.sticky', version: 1, title: 'Shopping', kind: 'sticky', content: 'milk', color: null, exportedAt: '2026-11-20T00:00:00.000Z', ...over }, null, 2)

describe('canonical file text', () => {
  it('ignores exportedAt, key order and indentation; nothing else', () => {
    const a = file()
    const b = JSON.stringify({ exportedAt: '2027-01-01T00:00:00.000Z', color: null, content: 'milk', kind: 'sticky', title: 'Shopping', version: 1, type: 'plexii.widget.sticky' })
    expect(canonicalFileText(a)).toBe(canonicalFileText(b))
    expect(canonicalFileText(file({ content: 'milk ' }))).not.toBe(canonicalFileText(a))
    expect(canonicalFileText(file({ title: 'Shopping!' }))).not.toBe(canonicalFileText(a))
    // Nested order (a table's rows, a document body) is normalised too, but array order is content.
    const t1 = file({ table: { title: 't', columns: [{ id: 'a', name: 'A' }], rows: [{ a: 1 }, { a: 2 }] } })
    const t2 = file({ table: { rows: [{ a: 1 }, { a: 2 }], columns: [{ name: 'A', id: 'a' }], title: 't' } })
    const t3 = file({ table: { title: 't', columns: [{ id: 'a', name: 'A' }], rows: [{ a: 2 }, { a: 1 }] } })
    expect(canonicalFileText(t1)).toBe(canonicalFileText(t2))
    expect(canonicalFileText(t1)).not.toBe(canonicalFileText(t3))
  })

  it('is null for text that is not JSON, so it is never mistaken for "unchanged"', () => {
    expect(canonicalFileText('not json')).toBeNull()
  })
})

describe('the save gate', () => {
  it('opening and closing a file never writes it, even when the widget tidies its content on mount', () => {
    const gate = createSaveGate(file())
    expect(gate.offer(file({ exportedAt: '2026-11-21T00:00:00.000Z' }))).toBe(false)   // an echo
    expect(gate.offer(file({ content: 'milk\n' }))).toBe(false)                         // a tidy-up, nobody touched it
    expect(gate.pending()).toBe(false)
  })

  it('after the person does something, a real difference is posted once, then not again', () => {
    const gate = createSaveGate(file())
    gate.touched()
    expect(gate.offer(file({ exportedAt: 'x' }))).toBe(false)
    expect(gate.offer(file({ content: 'milk, eggs' }))).toBe(true)
    expect(gate.offer(file({ content: 'milk, eggs', exportedAt: 'later' }))).toBe(false)
    expect(gate.offer(file({ content: 'milk, eggs, bread' }))).toBe(true)
    // Back to what the embedder already had before: that is a change from the LAST save, so it is posted.
    expect(gate.offer(file())).toBe(true)
  })

  it('a tidy-up held before any touch goes out with the first real save, never on its own', () => {
    const gate = createSaveGate(file())
    expect(gate.offer(file({ content: 'milk\n' }))).toBe(false)
    expect(gate.pending()).toBe(false)
    gate.touched()
    expect(gate.offer(file({ content: 'milk\n' }))).toBe(true)
  })

  it('read-only never posts, whatever happens', () => {
    const gate = createSaveGate(file(), { readOnly: true })
    gate.touched()
    expect(gate.offer(file({ content: 'changed' }))).toBe(false)
    expect(gate.pending()).toBe(false)
  })

  it('text that is not JSON is never posted', () => {
    const gate = createSaveGate(file())
    gate.touched()
    expect(gate.offer('{ broken')).toBe(false)
  })

  it('a baseline the host could not read still lets the first real export through', () => {
    const gate = createSaveGate('not json at all')
    gate.touched()
    expect(gate.offer(file())).toBe(true)
    expect(gate.offer(file())).toBe(false)
  })
})
