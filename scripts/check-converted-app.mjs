#!/usr/bin/env node
// Two mechanical checks to run when an office app is converted onto the shared
// shell. Both found real bugs on PlexiiCells that a typecheck, a build and a
// click-through all passed.
//
//   node scripts/check-converted-app.mjs \
//     --surface src/renderer/src/components/documents/SheetEditor.tsx \
//     --surface src/renderer/src/components/documents/CellsChrome.tsx \
//     --surface src/renderer/src/components/documents/sheet \
//     --ribbon  src/renderer/src/components/documents/sheet/cellsRibbon.tsx \
//     --removed HEAD~1:src/renderer/src/components/documents/sheet/SheetToolbar.tsx
//
// PASS 1 (hard failure) — duplicate testids across the whole surface.
// Converting leaves bespoke controls alive beside their new ribbon
// equivalents, so one testid ends up on two elements. Playwright's strict
// locators then throw on .click(), which surfaces as a confusing timeout
// rather than an obvious duplicate. Scan everything that renders together,
// not the ids you expect to have moved: on Cells a hand-picked list found
// nothing, and the full scan found `sheet-ai-toggle` live in both the ribbon
// and the formula bar — breaking a test that passed at baseline.
//
// PASS 2 (advisory) — every callback the deleted bar took, against the actions
// the new chrome invokes. FALSE ALARMS ARE EXPECTED and must be read, not
// acted on: on Cells three of four gaps were fine (Undo/Redo moved to the
// chrome's pinned slot; the ribbon splits one "insert row above" into
// above/below). The fourth was a genuinely dropped control. Advisory on
// purpose — a check that exits 1 on expected noise gets ignored.
//
// Neither pass proves a ported handler still DOES what it did. Pass 2 only
// shows an action is referenced. Read each ported body against the original:
// Cells' ribbon referenced `namedRanges` while calling a toggle that dropped
// the selection prefill the real control performs.
//
// And note the asymmetry in pass 2's evidence. "CHECK" is a strong signal:
// that name appears nowhere, so either it moved or it was dropped. "reachable"
// is weak: a name-based match can be satisfied by something coincidental.
// `onExport -> export` reports reachable off `window.api.sheet.export(...)`,
// which is the IPC call rather than the ribbon control. So read the CHECK list
// carefully and do not treat a wall of "reachable" as a clean bill of health.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const multi = (flag) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []))
const one = (flag) => multi(flag)[0]

const surfaces = multi('--surface')
const ribbonPath = one('--ribbon')
const removedRef = one('--removed')

if (!surfaces.length) {
  console.error(
    'usage: check-converted-app.mjs --surface <file|dir> [--surface ...] [--ribbon <file>] [--removed <rev>:<path>]'
  )
  process.exit(2)
}

/** Expand a directory to its .tsx files; pass a file through unchanged. */
const expand = (p) => {
  let st
  try {
    st = statSync(p)
  } catch {
    console.error(`!! cannot read ${p}`)
    process.exit(2)
  }
  return st.isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.tsx')).map((f) => join(p, f)) : [p]
}
const files = [...new Set(surfaces.flatMap(expand))]

// Static ids only. A template literal is per-row (`sheet-name-row-${name}`)
// and is expected to repeat.
const TESTID = /(?:data-testid|testid)=(?:"([a-z0-9-]+)"|\{'([a-z0-9-]+)'\}|'([a-z0-9-]+)')/g

const seen = new Map()
for (const f of files) {
  readFileSync(f, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(TESTID)) {
        const id = m[1] ?? m[2] ?? m[3]
        if (!seen.has(id)) seen.set(id, [])
        seen.get(id).push(`${basename(f)}:${i + 1}`)
      }
    })
}
const dupes = [...seen.entries()].filter(([, where]) => where.length > 1)

console.log(`PASS 1 — duplicate testids`)
console.log(`  ${seen.size} static testids across ${files.length} files`)
if (dupes.length === 0) {
  console.log('  no duplicates')
} else {
  for (const [id, where] of dupes.sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  DUPLICATE  ${id}`)
    for (const w of where) console.log(`               ${w}`)
  }
}

let gaps = []
if (removedRef) {
  let removedSrc = ''
  try {
    removedSrc = execFileSync('git', ['show', removedRef], { encoding: 'utf8' })
  } catch {
    console.error(`\n!! cannot git show ${removedRef}`)
    process.exit(2)
  }
  // `props.onFoo` is how the old bars took their callbacks.
  const callbacks = [...new Set([...removedSrc.matchAll(/props\.(on[A-Z][A-Za-z]*)/g)].map((m) => m[1]))].sort()
  // The action is the same name without `on`, lower-camelled.
  const actionName = (cb) => cb.slice(2, 3).toLowerCase() + cb.slice(3)
  const haystack = (ribbonPath ? [ribbonPath, ...files] : files)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

  console.log(`\nPASS 2 — ${callbacks.length} callbacks of ${basename(removedRef)} vs the new chrome (ADVISORY)`)
  for (const cb of callbacks) {
    const name = actionName(cb)
    // Match only a property (`exportFile:`) or a member access (`a.exportFile`).
    // A bare word match reports `onExport -> export` as reachable off the
    // `export` keyword in every file, and a false "reachable" hides exactly
    // the gap this pass exists to find.
    const hit = new RegExp(`(?:\\.${name}\\b|\\b${name}\\s*:)`).test(haystack)
    if (!hit) gaps.push({ cb, name })
    console.log(`  ${hit ? 'reachable  ' : 'CHECK      '} ${cb}  ->  ${name}`)
  }
  if (gaps.length) {
    console.log(`\n  ${gaps.length} to read by hand. Expected reasons a name legitimately disappears:`)
    console.log('    - it moved to the chrome outside the ribbon (a pinned Undo/Redo slot)')
    console.log('    - one control became two more specific ones (insertRow -> insertRowAbove/Below)')
    console.log('    - the app genuinely dropped it, which is the bug this pass is for')
  }
}

console.log(
  `\nNeither pass checks that a ported handler still does its work. Read each\n` +
    `ported body against the original — a referenced action can still have lost\n` +
    `half of what the control it replaced performed. And "reachable" is weaker\n` +
    `evidence than "CHECK": a name match can be coincidental, so a wall of\n` +
    `"reachable" is not a clean bill of health.`
)

if (dupes.length) {
  console.log(`\nFAILED: ${dupes.length} duplicate testid(s).`)
  process.exit(1)
}
