#!/usr/bin/env node
// Diff an e2e run against a stable baseline, and refuse to answer when the
// inputs cannot support an answer.
//
//   node scripts/e2e-baseline-diff.mjs <baselineA.log> <baselineB.log> <after.log>
//
// Two things make a naive diff lie, and both have already cost real time on
// this repo:
//
// 1. A single run is not a comparator. Several agent sessions share this
//    machine and load has been seen at 49 on 10 cores; at that load the
//    failure set differs between two runs of the SAME commit. So the baseline
//    is the intersection of two passes, and only a test that failed in both is
//    treated as a known red.
//
// 2. Keys must be file + test TITLE, never file:line. Converting a surface
//    means editing its specs, which shifts every line below the edit, and a
//    line-keyed diff then reports one test as both a regression and a fix.
//
// The gates exist because a run that measured NOTHING prints the same
// confident "0 regressions" as a run that measured everything: Playwright
// exits 0 with "No tests found" when a spec dies at collection — a rebase that
// duplicates a helper in tests/e2e/_helpers.ts does exactly that — and an
// empty failure set then reads as a clean sweep.

const [a, b, after] = process.argv.slice(2)
if (!a || !b || !after) {
  console.error('usage: e2e-baseline-diff.mjs <baselineA.log> <baselineB.log> <after.log>')
  process.exit(2)
}

const { readFileSync } = await import('node:fs')
const lines = (p) => readFileSync(p, 'utf8').split('\n')

/** How many tests the run said it collected: a number, or null if it never said. */
function collected(path) {
  for (const line of lines(path)) {
    const m = line.match(/Running (\d+) tests?/)
    if (m) return Number(m[1])
    if (line.includes('No tests found')) return 0
  }
  return null
}

/** Did the run reach its own summary, i.e. finish rather than being killed? */
function finished(path) {
  return lines(path).some((l) => /^\s+\d+ (passed|failed|skipped|flaky)/.test(l))
}

/** How many failures the run reported in its own summary. */
function reportedFailures(path) {
  let n = 0
  for (const line of lines(path)) {
    const m = line.match(/^\s+(\d+) failed/)
    if (m) n = Number(m[1])
  }
  return n
}

/**
 * The `# fingerprint` header that scripts/e2e-pass.mjs writes, if present.
 * Two passes are comparable only when they ran the same spec code against the
 * same bundle — collection counts cannot see the difference, and the
 * intersection of two passes that ran different spec code silently SHRINKS
 * the baseline, which excuses real regressions as known reds.
 */
function fingerprint(path) {
  const fp = {}
  for (const line of lines(path)) {
    if (!line.startsWith('# fingerprint')) {
      if (fp.specs || fp.bundle) break
      continue
    }
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) fp[m[1]] = m[2]
  }
  return fp.specs || fp.bundle ? fp : null
}

const NUM = /^\s+\d+\) (tests\/e2e\/\S+:\d+:\d+) › (.+?)\s*$/
const TICK = /^\s+✘\s+\d+ (tests\/e2e\/\S+:\d+:\d+) › (.+?)\s*$/

function ids(path, pattern) {
  const out = new Set()
  for (const line of lines(path)) {
    const m = line.match(pattern)
    if (!m) continue
    const file = m[1].split(':')[0]
    const title = m[2].replace(/\s*\(\d+(\.\d+)?s\)\s*$/, '').trim()
    out.add(`${file} :: ${title}`)
  }
  return out
}

const refuse = (problems) => {
  // Loud on purpose. The whole failure mode this guards is a result that LOOKS
  // like a clean verdict, so the refusal must not look like a passing run with
  // a note attached.
  const bar = '='.repeat(72)
  console.log(`\n${bar}`)
  console.log('  NO VERDICT. These logs cannot support one.')
  console.log(`${bar}`)
  for (const p of problems) console.log(`\n  !! ${p}`)
  console.log(`\n  Nothing below this line was computed. Do not report a result from this run.`)
  console.log(`${bar}\n`)
  process.exit(1)
}

const counts = {}
const problems = []
for (const [label, path] of [['baseline A', a], ['baseline B', b], ['after', after]]) {
  const c = (counts[label] = collected(path))
  if (c === null) {
    problems.push(`${label} (${path}): no 'Running N tests' line — the run never started, or the log is truncated.`)
  } else if (c === 0) {
    problems.push(`${label} (${path}): collected 0 tests. Playwright exits 0 on 'No tests found', so this is NOT a pass.`)
  } else if (!finished(path)) {
    // A killed run that had not failed anything yet parses as zero failures,
    // which would report every known red as newly FIXED.
    problems.push(
      `${label} (${path}): no summary line, so the run did not finish — it was killed or is still going. ` +
        'Its failure set is incomplete, not empty.'
    )
  }
}
if (counts['baseline A'] && counts['baseline B'] && counts['baseline A'] !== counts['baseline B']) {
  problems.push(
    `baselines disagree on collection: A=${counts['baseline A']} vs B=${counts['baseline B']}. ` +
      'Same commit and same spec list must collect the same tests; one pass lost a spec at collection.'
  )
}
// Fingerprints, when both baselines carry them.
const fpA = fingerprint(a)
const fpB = fingerprint(b)
if (fpA && fpB) {
  for (const k of ['specs', 'bundle']) {
    if (fpA[k] && fpB[k] && fpA[k] !== fpB[k]) {
      problems.push(
        `baselines ran different ${k} (A=${fpA[k]} B=${fpB[k]}). They are not two passes of one state, ` +
          'so intersecting them would shrink the baseline and excuse real regressions. Re-take the pair.'
      )
    }
  }
} else {
  console.log(
    'note: no fingerprint header on ' +
      [!fpA && 'baseline A', !fpB && 'baseline B'].filter(Boolean).join(' and ') +
      ' — cannot verify the two passes ran the same specs and bundle.\n' +
      '      Take passes with scripts/e2e-pass.mjs so this is checked rather than assumed.\n'
  )
}

if (problems.length) refuse(problems)

const stableSet = ids(a, NUM)
const bSet = ids(b, NUM)
const stable = new Set([...stableSet].filter((x) => bSet.has(x)))
const cur = ids(after, TICK)

// A pattern that silently matches nothing would report every baseline red as
// "FIXED". Hold the parsed set against the number the run reported itself.
const said = reportedFailures(after)
if (said !== cur.size) {
  refuse([
    `after-run reported ${said} failed but ${cur.size} were parsed out of the log.`,
    'The failure-line format changed; fix the TICK pattern before trusting any diff.'
  ])
}

const regressions = [...cur].filter((x) => !stable.has(x)).sort()
const fixed = [...stable].filter((x) => !cur.has(x)).sort()

console.log(`collected: A=${counts['baseline A']} B=${counts['baseline B']} after=${counts['after']}`)
console.log(`stable baseline: ${stable.size}   this run: ${cur.size}`)
console.log(`\nREGRESSIONS (${regressions.length}):`)
for (const r of regressions) console.log('   ', r.slice(0, 110))
console.log(`\nFIXED (${fixed.length}):`)
for (const f of fixed) console.log('   ', f.slice(0, 110))
