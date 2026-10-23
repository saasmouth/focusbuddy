// @vitest-environment node
//
// A new comment must not write to the document.
//
// That is the whole point of viewer comments, and it is a one-line regression:
// `editor.chain().setTextSelection(...).setComment(id).run()` reads as the
// obvious way to highlight a passage, it is what both hosts used to do, and
// re-adding it would break three things at once — a live document would
// propagate the mark to every peer and the signal server would refuse a
// viewer's write, a local document would swallow it in DocEditor's readOnly
// guard so the highlight vanished on reload, and a span carrying both a mark
// and a decoration renders fb-comment twice: rgba(250,204,21,.22) over .22 and
// a doubled border.
//
// None of those is caught by a type, and the first two only appear for a
// viewer — which is precisely the person nobody tests as. So this is a source
// guard, in the shape of d8's documentOps guard, and it is cheap.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const HOSTS = [
  'src/renderer/src/components/views/DocumentEditorView.tsx',
  'src/renderer/src/components/views/LiveDocEditorView.tsx'
]

/** Source with comments stripped, so prose about setComment does not trip it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('neither host applies a comment mark', () => {
  it('reads the files at all, or this guard means nothing', () => {
    for (const h of HOSTS) expect(code(h).length).toBeGreaterThan(500)
  })

  it('calls no setComment', () => {
    const offenders = HOSTS.filter((h) => /\bsetComment\b/.test(code(h)))
    expect(offenders).toEqual([])
  })

  it('pushes ranges instead', () => {
    // The other half: absence of the write is only right if the highlight
    // arrives another way. Without this, deleting the comment feature
    // altogether would pass the test above.
    for (const h of HOSTS) expect(code(h)).toContain('setCommentRanges')
  })

  it('goes through the shared write-back rule rather than its own', () => {
    // The yjs guard lives in commentWriteBack.ts. A host that rolled its own
    // persist would be the place that rule gets forgotten.
    for (const h of HOSTS) expect(code(h)).toContain('anchorToPersist')
  })
})

describe('clearing a mark is narrowed to the threads that have one', () => {
  // Resolving or deleting a thread called unsetComment unconditionally, so
  // resolving a comment EDITED THE DOCUMENT — refused for a viewer in a live
  // document, exactly like adding one.
  //
  // It cannot simply go, though: a LEGACY mark-anchored comment has a real mark
  // in the body, and that mark is its only highlight. Leaving it would mean a
  // resolved comment still looks commented. So the call stays for exactly those
  // threads and is guarded by markAnchored().
  //
  // That is a narrowing a source scan cannot verify on its own, so this asserts
  // the guard is PRESENT and never called bare. Deliberately recorded rather
  // than left looking like an oversight.
  it('never unsets a mark without first checking the thread has one', () => {
    for (const h of HOSTS) {
      const src = code(h)
      for (const line of src.split('\n')) {
        if (!/\bunsetComment\b/.test(line)) continue
        expect(line).toMatch(/markAnchored|legacy/)
      }
    }
  })

  it('and the check reads the stored anchor rather than guessing', () => {
    const live = code(HOSTS[1]!)
    if (!/\bunsetComment\b/.test(live)) return
    expect(live).toMatch(/function markAnchored/)
    expect(live).toMatch(/row\.anchor == null/)
  })
})
