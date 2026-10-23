// @vitest-environment node
//
// A className that resolves to nothing is invisible to every other check.
//
// I wrote `fb-btn` and `fb-btn-primary` in the snippet session and the inline
// editor, and they have never existed in this repo — not in any CSS file, not in
// any inline <style>, not at any point in the history. The buttons rendered as
// bare text with sizing utilities: no fill, no border, no hover. Typecheck,
// lint, the unit suite and the e2e specs were all green, because nothing checks
// that a class name means anything. Three more call sites had the same bug with
// `btn-secondary` and `btn-soft`, shipped since July and August.
//
// Scoped to the btn- family on purpose. A general "every class must exist" scan
// is noisy — plenty of fb- names are defined in inline <style> blocks or used
// as querySelector targets rather than styles — and a noisy guard gets muted. A
// button that does not look like a button is a user-visible defect with a
// one-token fix, which is exactly what a cheap guard should cover.
//
// Tokens come from real className attributes, split on whitespace, so a name
// like `fb-btn-surface` is not mistaken for `btn-surface`. That substring trap
// is what made my first count of this bug wrong in both directions.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER = 'src/renderer/src'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Every button-class selector defined anywhere: `.btn-…` and `.fb-btn…`.
 *
 * BOTH families, because the bug that prompted this was `fb-btn` — and a first
 * version of this test checked only `btn-` and therefore passed when I put
 * `fb-btn-primary` back. A guard that cannot fail for the reason it exists is
 * worse than none: it certifies the thing it never looked at.
 */
function definedButtonClasses(): Set<string> {
  const out = new Set<string>()
  const add = (src: string): void => {
    for (const m of src.matchAll(/\.((?:fb-)?btn-[a-z0-9-]+)/g)) out.add(m[1]!)
    // `.fb-btn` with no suffix, which is what I wrote and never defined.
    for (const m of src.matchAll(/\.(fb-btn)(?![-a-z0-9])/g)) out.add(m[1]!)
  }
  for (const f of walk(RENDERER)) {
    if (f.endsWith('.ts') || f.endsWith('.tsx')) add(readFileSync(f, 'utf8'))
  }
  for (const f of walk(RENDERER)) void f
  for (const name of ['globals.css', 'plexi-kit.css', 'tokens.css']) {
    try {
      add(readFileSync(join(RENDERER, 'styles', name), 'utf8'))
    } catch {
      /* a stylesheet that no longer exists is not this test's business */
    }
  }
  return out
}

/** The button classes actually applied to elements, by file. */
function usedButtonClasses(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>()
  for (const f of walk(RENDERER)) {
    const src = readFileSync(f, 'utf8')
    // className="…" and className={'…'} / {`…`}, plus the ternary arms inside.
    for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|\{([\s\S]*?)\})/g)) {
      const blob = m[1] ?? m[2] ?? ''
      for (const lit of blob.matchAll(/['"`]([^'"`]*)['"`]/g)) collect(lit[1]!, f, used)
      if (m[1]) collect(m[1], f, used)
    }
  }
  return used
}

function collect(text: string, file: string, used: Map<string, Set<string>>): void {
  for (const token of text.split(/\s+/)) {
    // Strip Tailwind's important marker and any variant prefix (hover:, md:).
    const cls = token.replace(/^!/, '').split(':').pop() ?? ''
    if (!/^(?:btn-[a-z0-9-]+|fb-btn(?:-[a-z0-9-]+)?)$/.test(cls)) continue
    if (!used.has(cls)) used.set(cls, new Set())
    used.get(cls)!.add(file.replace(`${RENDERER}/`, ''))
  }
}

describe('every button class a component applies is actually defined', () => {
  it('has the house classes to begin with, or this test proves nothing', () => {
    // Without this, a bug in the scanner would read as "all classes fine".
    const defined = definedButtonClasses()
    expect(defined.has('btn-primary')).toBe(true)
    expect(defined.has('btn-ghost')).toBe(true)
    // The fb- family must be found too, or the widening did nothing.
    expect(defined.has('fb-btn-surface')).toBe(true)
  })

  it('finds the classes components use, or this test proves nothing', () => {
    const used = usedButtonClasses()
    expect(used.has('btn-primary')).toBe(true)
    expect(used.has('fb-btn-surface')).toBe(true)
    expect(used.size).toBeGreaterThan(1)
  })

  it('applies none that do not exist', () => {
    const defined = definedButtonClasses()
    const used = usedButtonClasses()
    const missing = [...used.entries()]
      .filter(([cls]) => !defined.has(cls))
      .map(([cls, files]) => `${cls} (used in ${[...files].slice(0, 3).join(', ')})`)
    expect(missing).toEqual([])
  })
})
