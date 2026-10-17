// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CHANGELOG } from '../../src/renderer/src/lib/changelog'

// The lexicon standard (owner, 4.3.32): every USER-FACING mention of a desk /
// canvas widget says "work widget" / "work widgets" — "a work widget", "Work
// widgets" at the start of a sentence. Code identifiers, kind ids, data fields,
// IPC channels, file-type ids (.plexii-*), test ids and settings keys keep
// their names; only words a person reads change.
//
// This scans the renderer's UI text — string literals and JSX text — for a bare
// "widget"/"Widget" used as a word, and fails on any that is not "work widget".
// A new toast that says "widget" fails here rather than shipping.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src', 'renderer', 'src')

/**
 * Files whose "widget" means something else, and so are exempt.
 *
 * - The Home dashboard has its own tiles, which it calls "home widgets"; the
 *   owner asked for those to stay as they are.
 * - changelog.ts is history: entries before 4.3.32 are left as they shipped.
 *   The 4.3.32 entry IS checked, separately, below.
 */
const ALLOWLIST_FILES = new Set([
  'components/views/HomeDashboard.tsx',
  'components/views/homeWidgets.tsx',
  'components/views/homeWidgetDefs.ts',
  'components/views/DashboardWizardOverlay.tsx',
  'components/views/dashboardEmbeds.tsx',
  'lib/changelog.ts'
])

/** A literal that is a code id, not prose: no spaces, or a known identifier shape. */
function isProse(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/^Widgets?$/.test(t)) return true // a lone visible label
  if (!/\s/.test(t)) return false // 'widget', 'widgets', test ids, kinds, icon names
  // CSS classes, SQL, query strings and log tags are not UI text.
  if (/^\[/.test(t) || /\b(SELECT|UPDATE|INSERT)\b/.test(t)) return false
  if (/^[\w\s:/[\]().%#&>-]+$/.test(t) && /\b(text|bg|flex|grid|rounded|px|py|border)-/.test(t)) return false
  return true
}

// A bare word: not part of an identifier (widgetId, sidemenu-widget-x,
// widget_files) and not already "work widget(s)".
const BARE = /(?<![\w-])(?<!work |Work )[Ww]idgets?(?![\w-])/

/** Strip comments, keeping string contents intact (a light tokenizer). */
function uiTexts(src: string, tsx: boolean): string[] {
  const out: string[] = []
  let i = 0
  const n = src.length
  let code = ''
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      let j = i + 1
      let body = ''
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') {
          body += src[j] + (src[j + 1] ?? '')
          j += 2
          continue
        }
        if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
          // Skip a template expression, braces balanced.
          let depth = 0
          while (j < n) {
            if (src[j] === '{') depth++
            else if (src[j] === '}') {
              depth--
              if (depth === 0) break
            }
            j++
          }
          body += '{}'
          j++
          continue
        }
        if (q !== '`' && src[j] === '\n') break // not a string after all (apostrophe in JSX text)
        body += src[j]
        j++
      }
      if (q !== '`' && src[j] !== q) {
        code += c
        i++
        continue
      }
      out.push(body)
      code += q + q
      i = j + 1
      continue
    }
    code += c
    i++
  }
  if (tsx) {
    // JSX text: between a closing '>' and the next '<', outside braces.
    // A '>' after '=' is an arrow, and text holding code tokens is TypeScript
    // between generics, not JSX text.
    for (const m of code.matchAll(/(?<!=)>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
      const t = m[1]
      if (/[;=]|\bconst\b|\?\.|&&|\|\|/.test(t)) continue
      out.push(t.replace(/\s+/g, ' '))
    }
  }
  return out
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

describe('the work-widget lexicon', () => {
  it('renderer UI text never says a bare "widget"', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/')
      if (ALLOWLIST_FILES.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      // A pluralising ternary hides the word in two one-word strings, which the
      // prose rule (spaces required) would otherwise let through.
      for (const m of src.matchAll(/=== 1 \? (['"`])[Ww]idget\1 : (['"`])[Ww]idgets\2/g)) {
        offenders.push(`${rel}: ${m[0]}`)
      }
      for (const t of uiTexts(src, file.endsWith('.tsx'))) {
        if (isProse(t) && BARE.test(t)) offenders.push(`${rel}: ${t.trim().slice(0, 120)}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('the 4.3.32 What’s New speaks it too', () => {
    const entry = CHANGELOG.find((e) => e.version === '4.3.32')!
    const text = [entry.title, entry.summary ?? '', ...entry.highlights].join('\n')
    expect(text).toMatch(/work widget/i)
    expect(text, text).not.toMatch(BARE)
  })

  it('the scanner itself catches a bare widget and lets the right forms through', () => {
    const sample = `const a = 'Add a widget'; const b = 'Add a work widget'; const c = 'sidemenu-widget-x'
      const d = <p>Drag a widget here</p>; const e = \`\${n} widgets\`; const f = 'Work widgets'`
    const found = uiTexts(sample, true).filter((t) => isProse(t) && BARE.test(t))
    expect(found.map((t) => t.trim()).sort()).toEqual(['Add a widget', 'Drag a widget here', '{} widgets'].sort())
  })
})
