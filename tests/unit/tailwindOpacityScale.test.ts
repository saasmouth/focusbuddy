// An opacity modifier Tailwind does not generate produces NO class at all, and
// the element renders with no background whatsoever.
//
// Found the hard way: a widget overlay written as `bg-white/98` was completely
// see-through, with the content it was supposed to cover reading straight
// through it. The same bug was already sitting in the custom widget's "My
// widgets" and "Generated source" overlays as `bg-white/97` — invisible in
// review because the class LOOKS right, and invisible in the diff because
// nothing errors. Tailwind 3 only emits opacity modifiers from its scale;
// anything else needs the arbitrary form, `/[0.97]`.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..', '..', 'src', 'renderer', 'src')

// Tailwind's default opacity scale.
const SCALE = new Set([
  0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100
])

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...files(p))
    else if (/\.(tsx?|css)$/.test(entry)) out.push(p)
  }
  return out
}

// A colour utility with a bare numeric opacity modifier. The arbitrary form
// (`/[0.97]`) and CSS-variable alpha (`rgb(var(--x)/0.3)`) are both fine and are
// deliberately not matched here.
const MODIFIER = /\b(?:bg|text|border|ring|divide|from|via|to|shadow|outline|decoration|placeholder|accent|caret|fill|stroke)-(?:[a-z]+)(?:-\d{2,3})?\/(\d{1,3})\b/g

describe('tailwind opacity modifiers', () => {
  it('only uses values Tailwind actually generates', () => {
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf-8')
      for (const m of text.matchAll(MODIFIER)) {
        const value = Number(m[1])
        if (!SCALE.has(value)) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${m[0]}`)
        }
      }
    }
    expect(
      offenders,
      'these emit no CSS at all — use a scale value, or the arbitrary form like bg-white/[0.97]:\n' +
        offenders.join('\n')
    ).toEqual([])
  })

  it('catches the exact shape of the bug it was written for', () => {
    // Non-vacuity: the matcher must flag bg-white/98 and pass bg-white/95.
    const bad = [...'<div class="bg-white/98">'.matchAll(MODIFIER)].map((m) => Number(m[1]))
    const good = [...'<div class="bg-white/95">'.matchAll(MODIFIER)].map((m) => Number(m[1]))
    expect(bad.some((v) => !SCALE.has(v))).toBe(true)
    expect(good.every((v) => SCALE.has(v))).toBe(true)
  })

  it('does not flag CSS-variable alpha, which is a different mechanism', () => {
    const sample = 'shadow-[0_1px_2px_rgb(var(--accent)/0.25)] bg-[rgb(var(--accent)/0.08)]'
    const hits = [...sample.matchAll(MODIFIER)].map((m) => Number(m[1]))
    expect(hits.every((v) => SCALE.has(v))).toBe(true)
  })
})
