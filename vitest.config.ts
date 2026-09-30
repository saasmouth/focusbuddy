import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { availableParallelism } from 'os'

// Unit tests cover the deterministic pieces: pure sorts, builders, hostname
// matchers — and, since the environment is already a DOM, mounting a single leaf
// component with its stores mocked. Anything that needs the app running, a real
// database, Electron main, or more than one component wired together belongs in
// Playwright (see playwright.config.ts).
//
// The line is drawn at cost, not at "no UI": a mocked leaf mount is a few
// milliseconds and catches the one class of bug no logic test can see, which is
// a component that renders nothing at all. Both of this suite's blank-render
// bugs -- a conditional hook after an early return, and an unhandled widget
// kind falling through to `return null` -- were invisible to every unit test of
// the pieces involved.
export default defineConfig({
  // JSX has to be compiled here or a .tsx test -- and any .tsx it imports --
  // fails to load at all. The renderer's tsconfig leaves the transform to a
  // plugin, which electron-vite supplies for the app build and this config does
  // not.
  //
  // It is set on `oxc` and NOT via @vitejs/plugin-react, which looks like the
  // obvious answer and silently does nothing: vitest 4 ships rolldown-vite,
  // which transforms with oxc, and the plugin configures `esbuild` instead --
  // vite says so plainly ("esbuild options will be ignored") and then reports
  // the failure as "invalid JS syntax" pointing at the component, with a hint
  // about a tsconfig jsx setting that is not the cause. Two different wrong
  // trails from one missing line.
  oxc: { jsx: 'automatic' },
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
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
