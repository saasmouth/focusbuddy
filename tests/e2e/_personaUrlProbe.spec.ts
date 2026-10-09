// Load every browser-widget URL of the named persona specs inside the built
// app's own Chromium, on the session the browser widget uses, and record what
// actually comes back. This is the ground truth verify-urls.cjs cannot give:
// many .gov.au sites (Fair Work, cyber.gov.au, the Style Manual, the ATO…) serve a
// plain fetch and desktop Chrome but refuse Electron's browser with
// ERR_HTTP2_PROTOCOL_ERROR or an "Access Denied" page.
//
//   PERSONA_FILES=03-software-developers.json[,…] npx playwright test tests/e2e/_personaUrlProbe.spec.ts
// Writes scripts/persona-demos/checks/<file>.inapp.json and fails if any URL fails.

import { test, expect } from '@playwright/test'
import { launchApp } from './_helpers'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const DIR = resolve(__dirname, '..', '..', 'scripts', 'persona-demos')
const FILES = (process.env.PERSONA_FILES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const BAD_TITLE = /access denied|just a moment|attention required|captcha|are you a robot|verify you are|request rejected|forbidden|not found|error/i

test('persona URLs load in the app browser', async () => {
  test.setTimeout(20 * 60_000)
  if (!FILES.length) throw new Error('set PERSONA_FILES')
  const l = await launchApp({ env: { FB_SIGNAL_URL: 'http://127.0.0.1:9', PLEXI_APP: 'preview3' } })
  const failures: string[] = []
  try {
    for (const file of FILES) {
      const spec = require(join(DIR, 'personas', file))
      const out: Record<string, unknown> = {}
      for (const [di, d] of (spec.desks as any[]).entries())
        for (const [bi, b] of ((d.browsers ?? []) as any[]).entries()) {
          const r = await l.app.evaluate(async ({ BrowserWindow, session }, url) => {
            const w = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition('persist:webview-default') } })
            try {
              await Promise.race([w.loadURL(url), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 30s')), 30_000))])
              return { ok: true, title: w.webContents.getTitle(), finalUrl: w.webContents.getURL() }
            } catch (e: any) {
              return { ok: false, error: String(e.message).slice(0, 160) }
            } finally {
              w.destroy()
            }
          }, b.url)
          const good = r.ok && !BAD_TITLE.test(r.title ?? '') && r.finalUrl === b.url
          out[b.url] = { ...r, where: `desks[${di}].browsers[${bi}]`, pass: good }
          console.log(`${good ? '✓' : '✗'} ${file} desks[${di}].browsers[${bi}] ${b.url}\n    ${r.ok ? `title: ${r.title}${r.finalUrl !== b.url ? `  → landed on ${r.finalUrl}` : ''}` : r.error}`)
          if (!good) failures.push(`${file} ${b.url}`)
        }
      mkdirSync(join(DIR, 'checks'), { recursive: true })
      writeFileSync(join(DIR, 'checks', file.replace(/\.json$/, '.inapp.json')), JSON.stringify(out, null, 2) + '\n')
    }
  } finally {
    await l.dispose()
  }
  expect(failures, failures.join('\n')).toEqual([])
})
