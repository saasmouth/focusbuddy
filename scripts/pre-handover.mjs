#!/usr/bin/env node
// Run before sending ANY branch SHA to the aggregator.
//
//   node scripts/pre-handover.mjs [--specs tests/e2e/<file>.spec.ts ...]
//
// This exists because remembering the list demonstrably does not work. The
// snippets branch was handed over having passed typecheck:web, a clean build
// log, 43 unit tests and 5/5 e2e — and still needed two integration fixes:
//
//   - tsconfig.NODE failed TS4076 on an inferred better-sqlite3 parameter.
//     Only the web config had been run, deliberately, to spare machine load
//     during another measurement. That was the wrong trade for a handover.
//   - lint:hooks flagged a hook sitting after an early return. The rule was
//     already written down — in the OTHER worktree's handoff file, which is
//     why it did not travel across branches.
//
// Note what a green build does NOT tell you: esbuild strips types without
// checking them, so a successful `npm run build` is not evidence of a clean
// typecheck. The converse also holds — a clean typecheck is not evidence the
// renderer bundles, since it will not catch a bad named import.

import { execSync } from 'node:child_process'

const argv = process.argv.slice(2)
const specs = argv.flatMap((a, i) => (argv[i - 1] === '--specs' ? [a] : []))

const run = (label, cmd, { capture = true } = {}) => {
  process.stdout.write(`\n### ${label}\n    $ ${cmd}\n`)
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
    return { ok: true, out: out ?? '' }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const results = []
const record = (name, ok, note = '') => {
  results.push({ name, ok, note })
  console.log(`    ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`)
}

// 1. EVERY typecheck config, not just the one covering the code you touched.
for (const cfg of ['typecheck:node', 'typecheck:web', 'typecheck:webruntime']) {
  const r = run(cfg, `npm run ${cfg}`)
  const errs = (r.out.match(/error TS\d+/g) ?? []).length
  record(cfg, r.ok && errs === 0, errs ? `${errs} error(s)` : '')
  if (errs) console.log(r.out.split('\n').filter((l) => l.includes('error TS')).slice(0, 6).map((l) => `      ${l}`).join('\n'))
}

// 2. Rules of Hooks. A restructure moves hooks, and a hook below an early
//    return is invisible to typecheck.
{
  const r = run('lint:hooks', 'npm run lint:hooks')
  const v = r.out.split('\n').filter((l) => l.includes('hook after early return'))
  record('lint:hooks', r.ok, v.length ? `${v.length} violation(s)` : '')
  for (const l of v) console.log(`      ${l.trim()}`)
  if (v.length) {
    console.log('      Check whether each exists at your BASE before assuming it is yours —')
    console.log('      an inherited violation is resolved by rebasing, not by editing here.')
  }
}

// 3. Collection. Playwright exits 0 on "No tests found", so a spec that dies at
//    collection — a rebase duplicating a helper in _helpers.ts does this —
//    reads as a passing run.
if (specs.length) {
  const r = run('spec collection', `npx playwright test ${specs.join(' ')} --list`)
  const m = r.out.match(/Total: (\d+) test/)
  const total = m ? Number(m[1]) : 0
  record('spec collection', total > 0, `${total} test(s) collected`)
  if (total === 0) console.log('      Zero collected. Playwright exits 0 on "No tests found" — this is NOT a pass.')
}

const failed = results.filter((r) => !r.ok)
const bar = '='.repeat(68)
console.log(`\n${bar}`)
if (failed.length) {
  console.log(`  DO NOT HAND OVER. ${failed.length} gate(s) failed: ${failed.map((f) => f.name).join(', ')}`)
  console.log(`${bar}\n`)
  process.exit(1)
}
console.log('  All gates pass. Build and run the tests separately — these are')
console.log('  the checks that get skipped, not a substitute for them.')
console.log(`${bar}\n`)
