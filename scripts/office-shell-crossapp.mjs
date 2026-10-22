#!/usr/bin/env node
// Office shell cross-app consistency tooling (SPEC §8).
//
//   node scripts/office-shell-crossapp.mjs report [dir]
//     Reads the per-app style fingerprints officeShellLayout.spec writes
//     (default test-results/office-shell-fp) and, for every theme and size,
//     compares the apps on the properties the shared shell should make
//     identical. A value that differs from the majority is a divergence.
//     Exit 1 if any divergence is found.
//
//   node scripts/office-shell-crossapp.mjs diff <base.json> <head.json>
//     Compares two Playwright JSON reports (PLAYWRIGHT_JSON_OUTPUT_NAME=… npx
//     playwright test --reporter=json) BY TEST TITLE, never file:line: line
//     numbers shift whenever a spec is edited, so line-keyed diffs mislabel
//     tests (3e's finding). Exit 1 if anything passed in base and fails in head.

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const [cmd, ...args] = process.argv.slice(2)

// Properties the shared shell owns. Each is compared across apps within one theme and size.
const SAME = {
  'rail width': (f) => f.rail?.w,
  'rail background': (f) => f.rail?.bg,
  'rail border': (f) => f.rail?.border,
  'rail button size': (f) => (f.railButton ? `${f.railButton.w}x${f.railButton.h}` : null),
  'rail pressed background': (f) => f.railPressedBg,
  'Row 1 height': (f) => f.row1,
  'Row 2 height': (f) => f.row2,
  'bar background': (f) => f.barBg,
  'active tab font': (f) => f.tabActive?.font,
  'active tab colour': (f) => f.tabActive?.color,
  'active tab background': (f) => f.tabActive?.bg,
  'inactive tab font': (f) => f.tabInactive?.font,
  'inactive tab colour': (f) => f.tabInactive?.color,
  'Undo size': (f) => (f.undo ? `${f.undo.w}x${f.undo.h}` : null),
  // Only apps that have content panes render one (SPEC §2.5a); compare those that do.
  'side pane width (collapsed)': (f) => (f.sidePane?.collapsed ? f.sidePane.w : undefined),
  'side pane width (open)': (f) => (f.sidePane && !f.sidePane.collapsed ? f.sidePane.w : undefined)
}

function report(dir = join(process.cwd(), 'test-results', 'office-shell-fp')) {
  if (!existsSync(dir)) {
    console.error(`No fingerprints in ${dir}. Run: npx playwright test tests/e2e/officeShellLayout.spec.ts`)
    process.exit(2)
  }
  const fps = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  if (!fps.length) {
    console.error(`No fingerprints in ${dir}.`)
    process.exit(2)
  }
  const apps = [...new Set(fps.map((f) => f.app))].sort()
  const groups = new Map()
  for (const f of fps) {
    const k = `${f.theme} · ${f.size}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(f)
  }
  console.log(`Office shell cross-app report: ${apps.length} apps (${apps.join(', ')}), ${fps.length} fingerprints\n`)
  let divergences = 0
  for (const [k, list] of [...groups].sort()) {
    const missing = apps.filter((a) => !list.some((f) => f.app === a))
    const lines = []
    for (const [prop, get] of Object.entries(SAME)) {
      const vals = list.map((f) => [f.app, get(f)]).filter(([, v]) => v !== undefined)
      if (vals.length < 2) continue
      const counts = new Map()
      for (const [, v] of vals) counts.set(JSON.stringify(v), (counts.get(JSON.stringify(v)) ?? 0) + 1)
      if (counts.size === 1) continue
      const [majority, n] = [...counts].sort((a, b) => b[1] - a[1])[0]
      const tie = [...counts.values()].filter((c) => c === n).length > 1
      const odd = vals.filter(([, v]) => tie || JSON.stringify(v) !== majority)
      divergences += odd.length
      lines.push(`  ✗ ${prop}: ${tie ? 'no majority' : `most apps ${majority}`}; ${odd.map(([a, v]) => `${a} ${JSON.stringify(v)}`).join(', ')}`)
    }
    for (const f of list) {
      const c = f.contrast ?? {}
      if (c.railIcon < 3) lines.push(`  ✗ ${f.app}: rail icon contrast ${c.railIcon}:1 (< 3:1)`)
      if (c.tabActive < 4.5) lines.push(`  ✗ ${f.app}: active tab contrast ${c.tabActive}:1 (< 4.5:1)`)
      if (c.tabInactive && c.tabInactive < 4.5) lines.push(`  ✗ ${f.app}: inactive tab contrast ${c.tabInactive}:1 (< 4.5:1)`)
      const oldIds = (f.railToolIds ?? []).filter((id) => id && !/-tool-/.test(id))
      if (oldIds.length) lines.push(`  · ${f.app}: rail tools without a -tool- id (fine if their meaning is unchanged, SPEC §4.1): ${oldIds.join(', ')}`)
    }
    console.log(`${k}${missing.length ? `   (no fingerprint: ${missing.join(', ')})` : ''}`)
    console.log(lines.length ? lines.join('\n') : '  ✓ consistent')
    console.log('')
  }
  console.log(divergences ? `${divergences} divergence(s).` : 'No divergences.')
  process.exit(divergences ? 1 : 0)
}

function results(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const out = new Map()
  const walk = (suite, path) => {
    const here = suite.title ? [...path, suite.title] : path
    for (const s of suite.suites ?? []) walk(s, here)
    for (const spec of suite.specs ?? []) {
      // Keyed by the file name and the title path only: no line or column.
      const key = [...here, spec.title].join(' › ')
      const runs = spec.tests.flatMap((t) => t.results)
      const status = spec.tests.every((t) => t.status === 'skipped') ? 'skipped' : spec.ok ? (runs.some((r) => r.status !== 'passed') ? 'flaky' : 'passed') : 'failed'
      out.set(key, status)
    }
  }
  for (const s of json.suites ?? []) walk(s, [])
  return out
}

function diff(baseFile, headFile) {
  if (!baseFile || !headFile) {
    console.error('usage: office-shell-crossapp.mjs diff <base.json> <head.json>')
    process.exit(2)
  }
  const base = results(baseFile)
  const head = results(headFile)
  const regressions = []
  const fixed = []
  const added = []
  const removed = []
  const stillRed = []
  for (const [k, s] of head) {
    const b = base.get(k)
    if (b === undefined) added.push(`${k} [${s}]`)
    else if (b === 'passed' && s === 'failed') regressions.push(k)
    else if (b === 'failed' && s === 'passed') fixed.push(k)
    else if (b === 'failed' && s === 'failed') stillRed.push(k)
  }
  for (const k of base.keys()) if (!head.has(k)) removed.push(k)
  const section = (title, list) => console.log(`${title} (${list.length})${list.length ? '\n  ' + list.join('\n  ') : ''}\n`)
  section('REGRESSIONS: passed in base, fail in head', regressions)
  section('Fixed: failed in base, pass in head', fixed)
  section('Red in both (pre-existing)', stillRed)
  section('New tests (no base result)', added)
  section('Gone from head', removed)
  process.exit(regressions.length ? 1 : 0)
}

if (cmd === 'report') report(args[0])
else if (cmd === 'diff') diff(args[0], args[1])
else {
  console.error('usage: office-shell-crossapp.mjs report [dir] | diff <base.json> <head.json>')
  process.exit(2)
}
