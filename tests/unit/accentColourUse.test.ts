// --accent is stored as an "R G B" triple so Tailwind can add opacity to it. On
// its own, var(--accent) is therefore not a colour, the browser drops the rule,
// and a button styled with it shows white text on nothing (found on the Inbox
// filter editor's Done button, 2026-11-10).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', 'src', 'renderer', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(ts|tsx|css)$/.test(name) ? [p] : []
  })
}

describe('the accent colour', () => {
  it('is never used as a bare var(--accent)', () => {
    const bad = files(ROOT).flatMap((p) => {
      const hits = readFileSync(p, 'utf8').match(/(?<!rgb\()(?<!rgba\()var\(--accent\)/g)
      return hits ? [`${p.slice(ROOT.length + 1)} (${hits.length})`] : []
    })
    expect(bad).toEqual([])
  })
})
