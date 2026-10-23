#!/usr/bin/env node
// The unit suite, run again in two fixed SHUFFLED orders.
//
//   npm run test:shuffle                 # the two fixed seeds below
//   SHUFFLE_SEEDS=7,99 npm run test:shuffle
//   npm run test:shuffle -- tests/unit/deskBundle.test.ts   # extra vitest args pass through
//
// WHY. A test that passes only because of the test that happens to run before
// it is a test of the order, not of the code. Seven files here did exactly that
// (shareBootFlow, deskBundle, applyRemoteOrdering, localAiNoNetwork,
// filesMissingBytes, plxAiOrchestrator, plxPrdObjectModel): a shared in-memory
// database, a blob map one test cleared, a window another test navigated away,
// router and registry state set by one test and inherited by the next. Every
// one was green in the default order and red in some shuffled one. The normal
// run cannot see this class of bug at all, so this runs after it.
//
// WHY THESE SEEDS. Between them, 20261023 and 99 reproduced all seven of those
// failures at integration-l8 cd8e6161 (20261023: five files; 99: deskBundle
// and plxPrdObjectModel). Fixed, not random, so a red here is reproducible and
// a green is not luck. Shuffle covers both file order and test order within a
// file.
//
// REPRODUCING A FAILURE. The seed is printed with the failure. Re-run just that
// file in that order:
//
//   npx vitest run tests/unit/<file>.test.ts --sequence.shuffle --sequence.seed=<seed>
//
// Within-file order for one file is the same whether it runs alone or in the
// full suite, so that is usually enough. Add --reporter=verbose to see the
// order the tests ran in: the polluter is a test that ran BEFORE the first red
// one. Fix the leak (reset state in the file's beforeEach/afterEach, or give
// the product module a way to undo what it registers) -- never pin the order
// or skip the test.

import { spawnSync } from 'node:child_process'

const DEFAULT_SEEDS = [20261023, 99]
const seeds = (process.env.SHUFFLE_SEEDS ?? DEFAULT_SEEDS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const passthrough = process.argv.slice(2)

const failed = []
for (const seed of seeds) {
  if (!/^\d+$/.test(seed)) {
    console.error(`test:shuffle: seed "${seed}" is not a whole number`)
    process.exit(2)
  }
  const args = ['vitest', 'run', '--sequence.shuffle', `--sequence.seed=${seed}`, ...passthrough]
  console.log(`\n### unit suite, shuffled, seed ${seed}\n    $ npx ${args.join(' ')}\n`)
  const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) failed.push({ seed, status: r.status ?? r.signal })
}

const bar = '='.repeat(68)
console.log(`\n${bar}`)
if (failed.length) {
  for (const f of failed) console.log(`  FAILED under seed ${f.seed} (exit ${f.status})`)
  console.log('  A test here depends on the order it runs in. Reproduce one file with:')
  console.log('    npx vitest run tests/unit/<file>.test.ts --sequence.shuffle --sequence.seed=<seed> --reporter=verbose')
  console.log('  and look at the tests that ran BEFORE the first failure. See scripts/test-shuffle.mjs.')
  console.log(`${bar}\n`)
  process.exit(1)
}
console.log(`  Unit suite passed under shuffled seeds ${seeds.join(', ')}.`)
console.log(`${bar}\n`)
