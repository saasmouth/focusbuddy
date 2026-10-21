import { defineConfig } from '@playwright/test'

// Electron E2E config. We rely on @playwright/test's _electron API to launch
// the built app; tests live in tests/e2e/ and each test isolates its DB via
// FB_TEST_USER_DATA. No browser projects — only Electron.

// Specs named `_something.spec.ts` are ad-hoc sweeps: screenshot passes,
// one-off verifications, probes that need a live server. They are not part of
// `npm run test:e2e`. Name one on the command line and it runs as before
// (`npx playwright test _liveDeskSharingSmoke`); set PLEXII_E2E_SWEEPS=1 to
// include them all. The decision is made once, in the runner, and handed to
// the workers through the environment, so both sides load the same file set.
const namesASweep = process.argv
  .slice(2)
  .some((arg) => !arg.startsWith('-') && /(^|[\\/])_[^\\/]*$/.test(arg))
if (namesASweep) process.env.PLEXII_E2E_SWEEPS = '1'
const includeSweeps = process.env.PLEXII_E2E_SWEEPS === '1'

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: includeSweeps ? [] : ['**/_*.spec.ts'],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // Each Electron instance grabs a lot of resources
  workers: 1,
  retries: 0,
  reporter: [['list']]
})
