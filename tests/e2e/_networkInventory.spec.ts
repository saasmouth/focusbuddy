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
  /^(www\.)?plexiidesk\.com$/,
  /^tile\.openstreetmap\.org$/ // map work widget tiles, once a place is set
]

// Our own hosts. Anything else is a third party, and with default settings,
// typical use must contact none (4.3.34: icons from the linked site itself,
// fonts bundled, web search off, background AI off).
const PLEXII = /^((www|api|dl|view)\.)?plexiidesk\.com$/

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

// Only events that are real outbound work count: a request starting, a stream
// being opened for it, or a DNS lookup. Response headers also carry URLs (a
// report-uri, a content-location) that the app never contacts, so a textual
// scan over-reports; this reads the log's own event types instead.
const REQUEST_EVENTS = new Set(['URL_REQUEST_START_JOB', 'REQUEST_ALIVE', 'HTTP_STREAM_JOB_CONTROLLER'])
const DNS_EVENTS = new Set(['HOST_RESOLVER_MANAGER_REQUEST', 'HOST_RESOLVER_MANAGER_JOB'])

function parseNetLog(file: string): { hosts: Set<string>; urls: Set<string> } {
  const hosts = new Set<string>()
  const urls = new Set<string>()
  if (!existsSync(file)) return { hosts, urls }
  const raw = readFileSync(file, 'utf8')
  // Chromium leaves the log unterminated when the process is killed; close it.
  let log: { constants: { logEventTypes: Record<string, number> }; events: Array<{ type: number; params?: Record<string, unknown> }> }
  try {
    log = JSON.parse(raw)
  } catch {
    log = JSON.parse(raw.trimEnd().replace(/,$/, '') + ']}')
  }
  const typeName = new Map(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]))
  for (const e of log.events) {
    const t = typeName.get(e.type) ?? ''
    const p = e.params ?? {}
    if (REQUEST_EVENTS.has(t) && typeof p.url === 'string' && /^(https?|wss?):/.test(p.url)) {
      urls.add(p.url)
      const h = hostOf(p.url)
      if (h) hosts.add(h)
    } else if (DNS_EVENTS.has(t) && typeof p.host === 'string') {
      const h = p.host.includes('://') ? hostOf(p.host) : p.host.replace(/:\d+$/, '')
      if (h) hosts.add(h)
    }
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
  if (process.env.PLEXII_NETAUDIT_KEEP) console.log(`[netaudit] raw logs kept in ${dir}`)
  else rmSync(dir, { recursive: true, force: true })
  return obs
}

function unknown(obs: Observed, alsoAllowed: RegExp[] = []): string[] {
  return [...new Set([...obs.chromium, ...obs.node])].filter(
    (h) => ![...KNOWN_HOSTS, ...alsoAllowed].some((re) => re.test(h))
  )
}

function thirdParty(obs: Observed): string[] {
  return [...new Set([...obs.chromium, ...obs.node])].filter((h) => !PLEXII.test(h)).sort()
}

test.describe.configure({ mode: 'serial' })

test('NET-1 signed out, idle at the account gate: only the documented hosts', async () => {
  test.setTimeout(120_000)
  const obs = await runPhase('signed-out-idle', { PLEXI_E2E_REQUIRE_ACCOUNT: '1' }, async (l) => {
    await l.window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object')
    // The gate really is up (a packaged build's first screen), not the harness's
    // anonymous desk.
    await expect(l.window.locator('[data-testid="account-required-note"]')).toBeVisible({ timeout: 15_000 })
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
  expect(thirdParty(obs)).toEqual([])
})

// Content that reaches out by design: a map work widget with a place set, and a
// file work widget holding a web link. The first loads OpenStreetMap tiles; the
// second fetches the linked site's own icon from that site (4.3.34: no longer
// Google's favicon service). This observes both rows rather than inferring them.
test('NET-3 a map and a web link: OpenStreetMap tiles, and the icon from the linked site only', async () => {
  test.setTimeout(120_000)
  const obs = await runPhase('map-and-link', {}, async (l) => {
    const w = l.window
    await waitForReady(w)
    const deskId = await openNewDesk(w, 'Map and link desk')
    await w.evaluate(async (taskId) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.create({
        taskId,
        kind: 'location-map',
        title: 'Office',
        content: JSON.stringify({ query: 'London', lat: 51.5072, lon: -0.1276, label: 'London', zoom: 12 }),
        x: 40,
        y: 40,
        width: 420,
        height: 320
      })
      await api.widgets.create({
        taskId,
        kind: 'file',
        title: 'Reading',
        content: 'https://en.wikipedia.org/wiki/Local-first_software',
        x: 520,
        y: 40,
        width: 320,
        height: 240
      })
      const s = (window as unknown as { __fbWidgets?: { getState: () => { load?: (id: string) => Promise<void> } } })
        .__fbWidgets
      await s?.getState().load?.(taskId)
    }, deskId)
    await w.reload()
    await waitForReady(w)
    await w.evaluate((i) => {
      const v = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
      v.__fbView?.getState().goTask(i)
    }, deskId)
    await w.waitForTimeout(15_000)
  })
  const all = [...obs.chromium, ...obs.node]
  expect(all).toContain('tile.openstreetmap.org')
  // The icon comes from the site the person linked, from the main process
  // (siteIcons.ts), and from nowhere else.
  expect(obs.node).toContain('en.wikipedia.org')
  expect(all.filter((h) => /google\.com$|gstatic\.com$/.test(h))).toEqual([])
  // The renderer never loads the page itself; showing a link is not opening it.
  expect(obs.chromiumUrls.filter((u) => u.includes('wikipedia.org'))).toEqual([])
  expect(unknown(obs, [/^en\.wikipedia\.org$/])).toEqual([])
})
