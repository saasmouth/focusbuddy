// A `group-hover/name:` utility does nothing unless some ancestor carries
// `group/name`. Nothing errors when it does not — the styled element simply
// never changes, which for an `opacity-0` control means it is invisible forever.
//
// That happened: the custom widget's Change and refine buttons used
// `group-hover/slot:opacity-100`, but `group/slot` exists only in
// HomeDashboard's tile wrapper. On a desk canvas there was no such ancestor, so
// the buttons were permanently transparent and the user reported, correctly,
// that there was no way to edit the widget.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..', '..', 'src', 'renderer', 'src')

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...files(p))
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const NAMED_GROUP_HOVER = /\bgroup-(?:hover|focus-within|has)\/([a-zA-Z0-9_-]+):/g
const NAMED_GROUP = /\bgroup\/([a-zA-Z0-9_-]+)\b/g

describe('named group utilities', () => {
  it('every group-hover/name has a group/name in the same file', () => {
    // Same file is the right scope: a group defined in another component is not
    // something this file can rely on, which is exactly the bug.
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf-8')
      const declared = new Set([...text.matchAll(NAMED_GROUP)].map((m) => m[1]))
      for (const m of text.matchAll(NAMED_GROUP_HOVER)) {
        if (!declared.has(m[1])) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${m[0]} with no group/${m[1]}`)
        }
      }
    }
    expect(
      offenders,
      'these never fire — the styled element silently never changes:\n' + offenders.join('\n')
    ).toEqual([])
  })

  it('catches the exact shape of the bug it was written for', () => {
    // Non-vacuity.
    const bad = '<div className="group-hover/slot:opacity-100">'
    const good = '<div className="group/slot"><b className="group-hover/slot:opacity-100">'
    const declaredBad = new Set([...bad.matchAll(NAMED_GROUP)].map((m) => m[1]))
    const declaredGood = new Set([...good.matchAll(NAMED_GROUP)].map((m) => m[1]))
    expect([...bad.matchAll(NAMED_GROUP_HOVER)].some((m) => !declaredBad.has(m[1]))).toBe(true)
    expect([...good.matchAll(NAMED_GROUP_HOVER)].every((m) => declaredGood.has(m[1]))).toBe(true)
  })
})
