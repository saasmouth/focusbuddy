// Runtime check of docs/network-inventory.md: launch the real built app on a
// throwaway profile, signed out, and record every host it contacts.
//
// Two stacks are captured, because one alone misses traffic:
//   - Chromium (renderer fetch/XHR/WebSocket, <img>, webviews, Electron net):
//     the --log-net-log switch, parsed for every request URL and DNS lookup;
//   - Node in the main process (global fetch, https, IMAP/SMTP, ws): the
//     _netAuditHook.cjs module, loaded with `-r` ahead of the app path, which
//     logs every socket connect + DNS lookup.
//
// Never signs in, never creates an account, never opens plexii:// or haptyx://
// links, never touches the live profile (launchApp mints a temp userData).
// The host set each phase observed is written to
// test-results/network-inventory/<phase>.json and printed; the spec fails if a
// host appears that the inventory does not list (KNOWN_HOSTS below mirrors the
// doc's table) — so a new destination cannot ship without being written down.
//
// Underscore-prefixed: a diagnostic, not part of the default suite run. Run with
//   npm run build && npx playwright test tests/e2e/_networkInventory.spec.ts

import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, waitForReady, openNewDesk, addWidgetToDesk, type LaunchedApp } from './_helpers'

// Every host the inventory documents that a signed-out app may contact. A
// host outside this list fails the spec until docs/network-inventory.md (and
// this list) say what it is.
const KNOWN_HOSTS: RegExp[] = [
  /^api\.plexiidesk\.com$/, // signal server (account gate, capabilities, sync)
  /^dl\.plexiidesk\.com$/, // update feed (packaged builds only)
  /^view\.plexiidesk\.com$/,
  /^(www\.)?plexiidesk\.com$/
]

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0)$/

interface Observed {
  chromium: string[]
  node: string[]
  chromiumUrls: string[]
}

function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname
  } catch {
    return null
  }
}

function parseNetLog(file: string): { hosts: Set<string>; urls: Set<string> } {
  const hosts = new Set<string>()
  const urls = new Set<string>()
  if (!existsSync(file)) return { hosts, urls }
  const raw = readFileSync(file, 'utf8')
  // The net-log is JSON, but Chromium leaves it unterminated if the process is
  // killed, so scan it textually rather than JSON.parse it.
  for (const m of raw.matchAll(/"(?:url|original_url|new_location)":"((?:https?|wss?):\/\/[^"]+)"/g)) {
    urls.add(m[1])
    const h = hostOf(m[1])
    if (h) hosts.add(h)
  }
  for (const m of raw.matchAll(/"host":"([^"]+)"/g)) {
    const h = m[1].replace(/:\d+$/, '')
    if (h && !/^\d+$/.test(h)) hosts.add(h)
  }
  return { hosts, urls }
}

function parseNodeLog(file: string): Set<string> {
  const hosts = new Set<string>()
  if (!existsSync(file)) return hosts
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as { host?: string | null; path?: string | null }
      if (r.host) hosts.add(r.host)
    } catch {
      /* partial last line */
    }
  }
  return hosts
}

async function runPhase(
  name: string,
  env: Record<string, string>,
  drive: (l: LaunchedApp) => Promise<void>
): Promise<Observed> {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-netaudit-'))
  const netLog = join(dir, 'chromium-netlog.json')
  const nodeLog = join(dir, 'node-sockets.jsonl')
  const hook = join(__dirname, '_netAuditHook.cjs')
  const l = await launchApp({
    env: {
      PLEXI_APP: 'preview3',
      PLEXII_NETAUDIT_FILE: nodeLog,
      ...env
    },
    preArgs: ['-r', hook],
    extraArgs: [`--log-net-log=${netLog}`, '--net-log-capture-mode=Default']
  })
  try {
    await drive(l)
  } finally {
    await l.dispose()
  }
  const chromium = parseNetLog(netLog)
  const node = parseNodeLog(nodeLog)
  const obs: Observed = {
    chromium: [...chromium.hosts].filter((h) => !LOCAL.test(h)).sort(),
    node: [...node].filter((h) => !LOCAL.test(h)).sort(),
    // URLs without query strings, so nothing token-shaped lands in the report.
    chromiumUrls: [...chromium.urls]
      .filter((u) => !LOCAL.test(hostOf(u) ?? ''))
      .map((u) => u.split('?')[0])
      .filter((u, i, a) => a.indexOf(u) === i)
      .sort()
  }
  const outDir = join(process.cwd(), 'test-results', 'network-inventory')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(obs, null, 2))
  console.log(`[netaudit] ${name}:`, JSON.stringify(obs, null, 2))
  rmSync(dir, { recursive: true, force: true })
  return obs
}

function unknown(obs: Observed): string[] {
  return [...new Set([...obs.chromium, ...obs.node])].filter((h) => !KNOWN_HOSTS.some((re) => re.test(h)))
}

test.describe.configure({ mode: 'serial' })

test('NET-1 signed out, idle at the account gate: only the documented hosts', async () => {
  test.setTimeout(120_000)
  const obs = await runPhase('signed-out-idle', { PLEXI_E2E_REQUIRE_ACCOUNT: '1' }, async (l) => {
    await l.window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object')
    // Sit idle at the sign-in gate, as a person who has not signed in would.
    await l.window.waitForTimeout(60_000)
  })
  expect(unknown(obs)).toEqual([])
})

// The harness must SEE traffic before an empty result means anything: one known
// request from each stack has to show up, or every other phase is vacuous.
test('NET-0 the capture sees both stacks (positive control)', async () => {
  test.setTimeout(90_000)
  const obs = await runPhase('control', {}, async (l) => {
    await l.window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object')
    await l.app.evaluate(async () => {
      await fetch('https://example.com/').catch(() => {})
    })
    await l.window.evaluate(async () => {
      await fetch('https://example.org/', { mode: 'no-cors' }).catch(() => {})
    })
    await l.window.waitForTimeout(2_000)
  })
  expect(obs.node).toContain('example.com')
  expect(obs.chromium).toContain('example.org')
})

// Typical use without an account. A packaged build cannot run signed out past
// the gate (account.ts anonymousLaunchAllowed), so this uses the e2e harness's
// anonymous profile to stand in for "using the app with nothing connected":
// first-run onboarding, the home view, a desk with everyday work widgets, a map,
// and every Settings tab including Data > Privacy. API keys are stripped by
// launchApp, so no AI provider is reachable by design; that row of the inventory
// is verified by code, not here.
test('NET-2 typical use, nothing connected: only the documented hosts', async () => {
  test.setTimeout(240_000)
  const done: string[] = []
  const obs = await runPhase('typical-use', {}, async (l) => {
    const w = l.window
    await waitForReady(w)
    done.push('onboarding')
    await w.waitForTimeout(3_000)
    await openNewDesk(w, 'Network audit desk')
    done.push('new desk')
    for (const kind of ['sticky', 'note', 'task-list', 'chart', 'location-map']) {
      try {
        await addWidgetToDesk(w, kind)
        done.push(`work widget: ${kind}`)
      } catch {
        done.push(`work widget: ${kind} (not reachable from the side menu)`)
      }
    }
    await w.waitForTimeout(5_000)
    try {
      await w.getByRole('button', { name: /appearance settings/i }).click({ timeout: 5_000 })
      for (const tab of ['general', 'ai', 'templates', 'data', 'advanced']) {
        const t = w.locator(`[data-testid="settings-tab-${tab}"]`)
        if (await t.isVisible().catch(() => false)) {
          await t.click()
          await w.waitForTimeout(1_000)
          done.push(`settings: ${tab}`)
        }
      }
      await w.keyboard.press('Escape')
    } catch {
      done.push('settings (could not open)')
    }
    // Idle past every boot timer (calendar/flows 20 s, sweeps 45 s, mail 90 s).
    await w.waitForTimeout(100_000)
    done.push('idle 100 s')
  })
  console.log('[netaudit] typical-use actions:', done.join(' | '))
  expect(unknown(obs)).toEqual([])
})
