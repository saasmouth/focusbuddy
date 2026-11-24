import { defineConfig, devices } from '@playwright/test'

// The browser runtime (the share page plexiidesk.com serves under /share/),
// tested in headless Chromium against the BUILT app -- out/web, what
// haptyx-web's build-share-app.mjs ships -- served by Vite's preview server.
// Signal is not needed: each test answers the share link's calls itself and
// refuses every other request off the page, so nothing reaches a real server.
//
//   npm run web:build && npm run test:web
export default defineConfig({
  testDir: 'tests/web',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], headless: true, baseURL: 'http://127.0.0.1:5193', viewport: { width: 1600, height: 1000 } },
  webServer: {
    command: 'npx vite preview --config vite.web.config.ts --port 5193 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5193/index.html',
    reuseExistingServer: false,
    timeout: 60_000
  }
})
