import { defineConfig, devices } from '@playwright/test'

// The widget host (src/web/widgetHost), tested in headless Chromium against
// the BUILT page -- the same files PlexiiLite vendors -- served by Vite's
// preview server. Electron is not needed: PlexiiLite shows the page in a
// <webview>, which is Chromium, and talks to it through window 'message'
// events, which these tests drive the same way.
//
//   npm run widget-host:build && npm run test:widget-host
export default defineConfig({
  testDir: 'tests/widget-host',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], headless: true, baseURL: 'http://127.0.0.1:5191', viewport: { width: 640, height: 480 } },
  webServer: {
    command: 'npx vite preview --config vite.widgethost.config.ts --port 5191 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5191/index.html',
    reuseExistingServer: false,
    timeout: 60_000
  }
})
