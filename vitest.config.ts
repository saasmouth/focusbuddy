import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { availableParallelism } from 'os'

// Unit tests cover the deterministic, framework-free pieces: pure sorts, builders,
// hostname matchers. UI + Electron integration is handled by Playwright (see
// playwright.config.ts) — keep those concerns separated so vitest stays fast.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
    globals: true,
    // A TIMEOUT CATCHES A HANG. IT SHOULD NOT MEASURE HOW BUSY THE MACHINE IS.
    //
    // The 5s default charged cold module transform to the test: 25 files import
    // heavy modules inside the test body (`await import(...)`), and one of them
    // pulls in the whole Anthropic client. On a quiet machine that is well under
    // a second; with other work running it passed 5s, and the merge gate failed
    // on code that was correct — three times in one week, each forcing a
    // judgement call about whether to skip the gate. The same files pass in
    // full at a longer timeout. 30s still catches a genuine hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // WORKERS: half the cores, not all but one.
    //
    // The default spawned nine workers here, and this machine has only four
    // performance cores: five landed on efficiency cores, every one loading
    // heavy modules into its own happy-dom, and under load the run was killed
    // for memory (exit 137). Half keeps the suite quick on a quiet machine and
    // survivable on a busy one — and it gives the spec §58 performance budgets
    // a less contended CPU to measure, which is fairer to them than raising
    // their thresholds would be.
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2))
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  }
})
