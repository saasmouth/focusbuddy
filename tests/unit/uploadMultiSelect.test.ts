// @vitest-environment node
//
// Picking files one at a time is laborious, and the laboriousness was invisible
// in review: a `<input type="file">` without `multiple` looks identical to one
// with it, and the handler reading `files[0]` looks like ordinary code. Six of
// the eight upload surfaces in the app were single-file, and nobody had decided
// that — they had simply each been written that way.
//
// So this makes the choice explicit. Every file input is either multi-select, or
// it is listed below WITH A REASON. A new upload surface cannot be added without
// landing in one list or the other, which is the only way "all of them" stays
// true after today.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..', 'src', 'renderer', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

/** Every `<input type="file">` in the renderer, with whether it allows multiple. */
function fileInputs(): Array<{ file: string; multiple: boolean }> {
  const found: Array<{ file: string; multiple: boolean }> = []
  for (const path of walk(SRC)) {
    const src = readFileSync(path, 'utf8')
    let i = src.indexOf('type="file"')
    while (i !== -1) {
      // The surrounding JSX element: back to the opening '<', forward to '>'.
      const open = src.lastIndexOf('<', i)
      const close = src.indexOf('>', i)
      const tag = src.slice(open, close === -1 ? i : close)
      found.push({
        file: path.slice(SRC.length + 1),
        multiple: /\bmultiple\b/.test(tag)
      })
      i = src.indexOf('type="file"', i + 1)
    }
  }
  return found
}

/**
 * Upload surfaces that take exactly one file ON PURPOSE.
 *
 * Each entry is a decision, not an oversight. If you are adding to this list,
 * the question to answer is "would a user ever want to pick two here?" — and for
 * most upload surfaces the answer is yes.
 */
const DELIBERATELY_SINGLE: Record<string, string> = {
  'components/views/OrgAdminView.tsx':
    'a profile photo — a person has one, and picking two would mean silently discarding one',
  'components/widgets/StreamDeckWidget.tsx':
    'the icon for one Stream Deck button; the button is the unit, not the file',
  'components/widgets/streamdeck/StreamDeckButtonConfig.tsx':
    'the icon for a single button being configured; a second file has nowhere to go',
  'components/views/chat/ChatComposer.tsx':
    'the chat protocol carries ONE attachment per message (onSend takes `attachment: MessageAttachment | null`), so `multiple` here would drop every file after the first. Needs a protocol change, not an attribute.'
}

describe('upload surfaces', () => {
  const inputs = fileInputs()

  it('finds the file inputs at all', () => {
    // Vacuity guard: every assertion below is "none are wrong", which an empty
    // scan satisfies for free.
    expect(inputs.length).toBeGreaterThanOrEqual(6)
  })

  it('lets the user pick more than one file, or says why not', () => {
    const singles = inputs.filter((i) => !i.multiple).map((i) => i.file)
    const undeclared = singles.filter((f) => !(f in DELIBERATELY_SINGLE))
    expect(
      undeclared,
      'these upload surfaces take one file at a time. Add `multiple` and make the ' +
        'handler loop, or add the path to DELIBERATELY_SINGLE with the reason.'
    ).toEqual([])
  })

  it('keeps the single-file list honest', () => {
    // A path that has since gained `multiple`, or been deleted, should not keep
    // sitting in the exemption list implying a decision that no longer holds.
    const singles = new Set(inputs.filter((i) => !i.multiple).map((i) => i.file))
    const stale = Object.keys(DELIBERATELY_SINGLE).filter((f) => !singles.has(f))
    expect(stale, 'these are no longer single-file — drop them from DELIBERATELY_SINGLE').toEqual([])
  })

  it('every exemption gives a real reason', () => {
    for (const [path, reason] of Object.entries(DELIBERATELY_SINGLE)) {
      expect(reason.length, `${path} needs a real reason, not a placeholder`).toBeGreaterThan(30)
    }
  })
})

describe('the handlers behind the multi-select inputs actually loop', () => {
  // `multiple` on the input is cosmetic if the handler still reads files[0]:
  // the picker would let you choose ten and the app would take one, which is
  // worse than not offering it.
  const MUST_LOOP = [
    'components/fields/FieldEditor.tsx',
    'components/widgets/DiagramWidget.tsx'
  ]

  it.each(MUST_LOOP)('%s reads every picked file', (rel) => {
    const src = readFileSync(join(SRC, rel), 'utf8')
    expect(src, `${rel} still reads only the first file`).not.toMatch(
      /e\.target\.files\?\.\[0\]|e\.currentTarget\.files\?\.\[0\]/
    )
    expect(src, `${rel} does not take the whole FileList`).toMatch(
      /Array\.from\(\s*e\.(target|currentTarget)\.files/
    )
  })
})
