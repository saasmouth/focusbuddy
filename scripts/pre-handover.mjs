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

import { execSync, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const specs = argv.flatMap((a, i) => (argv[i - 1] === '--specs' ? [a] : []))

// Both streams, always, and a buffer far larger than anything here produces.
//
// `playwright test --list` is ~200KB for this suite and grows with it, and the
// "Total: N tests" line it is parsed for comes LAST — so any truncation removes
// precisely the line that matters and leaves a listing that looks complete.
// execSync's default maxBuffer would eventually do that silently as the suite
// grows, and on a non-zero exit the old code read only stdout, losing an error
// Playwright had written to stderr.
const run = (label, cmd, { capture = true } = {}) => {
  process.stdout.write(`\n### ${label}\n    $ ${cmd}\n`)
  if (!capture) {
    try {
      execSync(cmd, { stdio: 'inherit' })
      return { ok: true, out: '', status: 0 }
    } catch (e) {
      return { ok: false, out: '', status: e.status ?? 1 }
    }
  }
  const r = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // A spawn that was killed or hit the buffer reports it here rather than
  // looking like a clean run with odd output.
  const trouble = r.error ? `${r.error.code ?? r.error.message}` : r.signal ? `killed by ${r.signal}` : null
  return { ok: !trouble && r.status === 0, out, status: r.status, trouble }
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
//    collection — a rebase duplicating a helper in tests/e2e/_helpers.ts does
//    this — reads as a passing run.
//
//    Two counts, labelled, because one of them is easy to misread. The first is
//    ONLY the spec files named on the command line, so a small number there is
//    normal and means nothing about the suite; d1 saw "6 test(s) collected" and
//    reasonably wondered whether that was gating anything. The second is the
//    whole suite, which is the number that catches a helper breaking collection
//    everywhere.
/**
 * The count Playwright reported, or null when it did not report one.
 *
 * These are DIFFERENT and the old version returned 0 for both — which is how
 * this gate came to report a confident "0 collected" for a run that had simply
 * failed before printing a total, and why it looked flaky rather than broken.
 * Null means "could not tell"; 0 means Playwright said zero.
 */
const collected = (out) => {
  const m = out.match(/Total: (\d+) tests?/)
  return m ? Number(m[1]) : null
}

/** The last few lines, for when the total is missing and the reason is not. */
const tail = (out, n = 12) =>
  out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .map((l) => `        ${l}`)
    .join('\n')

/**
 * Report a collection run, distinguishing the three outcomes that the old
 * version flattened into one number.
 *
 * A missing total is NOT zero tests. d1 saw this gate say "0 collected" on one
 * run and 1,820 on the next, which reads as a flaky gate — and a gate that
 * cries wolf gets ignored, which is worse than not having it. The cause is that
 * a run which failed before printing its total parsed identically to a run that
 * genuinely found nothing. So an unreadable run now says so, prints why, and
 * still fails.
 */
const reportCollection = (label, r, note, zeroHint) => {
  const total = collected(r.out)
  if (r.trouble) {
    record(label, false, `could not run it: ${r.trouble}`)
    console.log(tail(r.out))
    return
  }
  if (total === null) {
    record(label, false, `no "Total: N tests" line — exit ${r.status}, output NOT a collection`)
    console.log('      This is not the same as zero tests: Playwright did not get as far as')
    console.log('      reporting a total. Its last lines were:')
    console.log(tail(r.out))
    return
  }
  record(label, total > 0, note(total))
  if (total === 0) {
    console.log(`      ${zeroHint}`)
    console.log('      Playwright exits 0 on "No tests found", so this is NOT a pass.')
  }
}

if (specs.length) {
  const r = run('named-spec collection', `npx playwright test ${specs.join(' ')} --list`)
  reportCollection(
    'named-spec collection',
    r,
    (n) => `${n} test(s) in the ${specs.length} spec file(s) named here — NOT a suite total`,
    'Zero collected: either a path above is wrong, or the spec died at collection.'
  )
  for (const sp of specs) console.log(`        ${sp}`)
}

reportCollection(
  'whole-suite collection',
  run('whole-suite collection', 'npx playwright test --list'),
  (n) => `${n} test(s) across the whole e2e suite`,
  'The SUITE collects nothing. A duplicated helper in _helpers.ts does this, and every spec then "passes" by running none of itself.'
)

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
