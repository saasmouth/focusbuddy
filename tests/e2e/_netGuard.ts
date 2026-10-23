// The e2e NET GUARD: no spec reaches a production host unless it is named in
// _netGuardAllowlist.ts. Any request or socket to one is ABORTED and FAILS the
// spec, with a message naming the spec and the URL.
//
// Every Electron launch in tests/e2e goes through launchGuarded() (launchApp
// does; a unit test forbids calling electron.launch anywhere else). Production
// hosts are derived from src/shared/productDomains.ts (_netGuardHosts.ts).
//
// WHAT IS INTERCEPTED, LAYER BY LAYER, AND WHEN IT IS IN PLACE:
//
//   context.route / context.routeWebSocket (this file) — installed on the
//     app's BrowserContext while the main process is still holding 'ready'
//     (_netGuardMain.cjs), so they are in place before the first window
//     exists. Renderer fetch/XHR to a production host is aborted; a renderer
//     WebSocket to one is closed. Because Playwright's WebSocket mock is now in
//     the page from its first document, a page-level routeWebSocket added later
//     (_fakeSignal) takes effect for the very next socket, with no reload.
//
//   session webRequest (_netGuardMain.cjs) — every Electron session, from
//     'session-created'. Catches what the context routes do not see: a socket
//     opened before a route existed, any WebSocket the mock did not take,
//     webviews, service workers, Electron's net module in main, and all window
//     HTTP until the context route is reported installed. This is the layer
//     that makes the guard hold even when a route is late. (After that, window
//     HTTP is left to the context route, because webRequest runs before
//     Playwright's interception and would cancel what a spec's page.route was
//     about to fulfil.)
//
//   Node net/dns (_netGuardMain.cjs) — main-process fetch, http(s), ws, tls,
//     IMAP/SMTP.
//
// WHAT IT CANNOT REPORT, BUT STILL STOPS: a spec's own page.route handler that
// calls route.continue() on a production URL sends it to the network past the
// context route (Playwright runs page handlers first, and continue() does not
// fall back). The --host-resolver-rules floor in _netGuardMain.cjs makes it
// fail to resolve (netGuard.spec.ts NG-7), but nothing records it, so the spec
// is not failed. Use fulfill/abort/fallback there; no spec continues a
// production URL today.
//
// WHAT IT CANNOT INTERCEPT: processes the app spawns (their own network stack),
// and native OS networking outside Chromium and Node (Squirrel.Mac, packaged
// builds only). The test process's own fetches are outside the app entirely: a
// spec that calls fetch() from Node is not covered, and none may target
// production (the allowlist rule applies to them too, by review).

import { _electron as electron, expect, test, type ElectronApplication, type Route, type WebSocketRoute } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { ACTIVE } from '../../src/shared/productDomains'
import { PRODUCTION_ALLOWED_SPECS } from './_netGuardAllowlist'
import { productionHostRules, refusedUrlRegExp, urlIsRefused } from './_netGuardHosts'

export interface NetViolation {
  /** Which layer saw it: renderer-http, renderer-ws, session, node, node-dns, guard. */
  stack: string
  url: string
}

export interface NetGuard {
  /** Every production contact the guard refused (or, allowlisted, let through). */
  violations: NetViolation[]
  /** Signed-out boot calls the guard answered locally instead (see LOCAL_SIGNAL). */
  answeredLocally: string[]
  /** True when the spec is in _netGuardAllowlist.ts. */
  allowed: boolean
  /** Throws if any violation was recorded and not already reported to the test. */
  assertClean: () => void
  /** Read the main-process log once more, then remove it. */
  finish: () => void
}

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>

const HOOK = join(__dirname, '_netGuardMain.cjs')
const SIGNAL = new URL(ACTIVE.api)

/**
 * Calls the SIGNED-OUT app makes on every boot, answered here so they never
 * leave the machine — each with what the deployed server answers, read from
 * its code, not an invented body.
 *
 *   GET /public/server-features — LaunchSignInModal asks on mount
 *     (stores/capabilities.ts loadPublicServerFeatures). focusbuddy-signal has
 *     no such route (no match in src/ at signal-v126), so production answers
 *     Fastify's 404 and the app falls back to an empty list. The same 404 is
 *     answered here.
 *
 * Anything else to a production host is a violation.
 */
const LOCAL_SIGNAL: Array<{ method: string; path: string; status: number; body: unknown }> = [
  {
    method: 'GET',
    path: '/public/server-features',
    status: 404,
    body: { message: 'Route GET:/public/server-features not found', error: 'Not Found', statusCode: 404 }
  }
]

/** The failure a spec gets for one production contact. */
export function violationMessage(spec: string, title: string, v: NetViolation): string {
  return (
    `[net-guard] ${spec}${title ? ` › ${title}` : ''} reached for a PRODUCTION host ` +
    `(${v.stack}): ${v.url}. It was aborted. Route it locally, or — only if this spec really needs ` +
    `the live server — name it in tests/e2e/_netGuardAllowlist.ts with the reason.`
  )
}

function currentSpec(): string {
  try {
    return basename(test.info().file)
  } catch {
    return '(outside a test)'
  }
}

function currentTitle(): string {
  try {
    return test.info().titlePath.slice(1).join(' › ')
  } catch {
    return ''
  }
}

/**
 * Launch Electron with the net guard in place before the first window.
 * Takes the same options as `electron.launch`; the args must include the app
 * path ('.') — the guard's `-r` hook is put in front of everything.
 */
export async function launchGuarded(
  options: LaunchOptions,
  guardOptions: {
    /**
     * netGuard.spec.ts ONLY: record violations without failing the test, so the
     * guard's own spec can assert what each layer caught. Every other spec gets
     * the failing guard; the failing path is proven by mutation (see that spec).
     */
    selfTest?: boolean
  } = {}
): Promise<{ app: ElectronApplication; guard: NetGuard }> {
  const spec = currentSpec()
  if (guardOptions.selfTest && spec !== 'netGuard.spec.ts') {
    throw new Error(`[net-guard] selfTest is for netGuard.spec.ts only, not ${spec}`)
  }
  const allowed = PRODUCTION_ALLOWED_SPECS.includes(spec)
  const rules = productionHostRules()
  const dir = mkdtempSync(join(tmpdir(), 'plexii-netguard-'))
  const logFile = join(dir, 'main.jsonl')

  const violations: NetViolation[] = []
  const answeredLocally: string[] = []
  const seen = new Set<string>()
  let reported = 0

  const report = (v: NetViolation): void => {
    const key = `${v.stack} ${v.url}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push(v)
    if (allowed || guardOptions.selfTest) return
    const msg = violationMessage(spec, currentTitle(), v)
    try {
      // Soft, so it fails the RUNNING test from inside a route callback
      // without throwing into Playwright's routing.
      expect.soft(v.url, msg).toBe('(no production traffic)')
      reported++
    } catch {
      // No test is running (an afterAll, say): assertClean() throws it instead.
    }
  }

  let consumed = 0
  const readMainLog = (): void => {
    let raw = ''
    try {
      raw = readFileSync(logFile, 'utf8')
    } catch {
      return
    }
    const lines = raw.split('\n')
    for (let i = consumed; i < lines.length - 1; i++) {
      try {
        const r = JSON.parse(lines[i]) as { stack: string; url: string }
        report({ stack: r.stack, url: r.url })
      } catch {
        /* partial line */
      }
    }
    consumed = Math.max(consumed, lines.length - 1)
  }

  const args = ['-r', HOOK, ...(options.args ?? [])]
  const app = await electron.launch({
    ...options,
    args,
    env: {
      // Main's own signal base (src/main/ai/creditMode.ts SIGNAL_BASE) defaults
      // to focusbuddy-signal.fly.dev — production under its other name — and a
      // spec that signs in through the deep link hands main a real-looking
      // token, which it used to send there (/ai/credits). Main honours
      // FB_SIGNAL_URL, so point it at a closed loopback port: the call fails
      // locally, as it would offline. A spec that runs a local signal server
      // passes its own FB_SIGNAL_URL and wins.
      FB_SIGNAL_URL: 'http://127.0.0.1:9',
      ...(options.env ?? {}),
      PLEXII_E2E_NETGUARD_RULES: JSON.stringify(rules.map((r) => r.host)),
      PLEXII_E2E_NETGUARD_LOG: logFile,
      PLEXII_E2E_NETGUARD_ALLOW: allowed ? '1' : '0',
      PLEXII_E2E_NETGUARD_GATE: '1'
    }
  })

  // A direct caller (a live spec) may never call finish(): read the log one
  // last time and remove it when the app goes away.
  app.on('close', () => {
    try {
      readMainLog()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Main-process refusals arrive on stderr as they happen; the log file is
  // re-read at the end in case a line was split across chunks.
  let pending = ''
  app.process().stderr?.on('data', (b: Buffer) => {
    pending += b.toString()
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    if (parts.some((l) => l.includes('[net-guard] '))) readMainLog()
  })

  const context = app.context()
  const refused = refusedUrlRegExp(rules)
  await context.route(refused, async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const local = url.origin === SIGNAL.origin && LOCAL_SIGNAL.find((l) => l.method === req.method() && l.path === url.pathname)
    if (local) {
      answeredLocally.push(`${req.method()} ${url.pathname}`)
      return route.fulfill({ status: local.status, contentType: 'application/json', body: JSON.stringify(local.body) })
    }
    if (!urlIsRefused(req.url(), rules)) return route.fallback()
    report({ stack: 'renderer-http', url: req.url() })
    return allowed ? route.continue() : route.abort('blockedbyclient')
  })
  await context.routeWebSocket(refused, (ws: WebSocketRoute) => {
    report({ stack: 'renderer-ws', url: ws.url() })
    if (allowed) {
      ws.connectToServer()
      return
    }
    // Policy violation: nothing is sent anywhere.
    ws.close({ code: 1008, reason: 'e2e net guard: production host' })
  })

  // The context route is in place: the session layer may now hand app-window
  // HTTP to it instead of cancelling it (see _netGuardMain.cjs).
  await app.evaluate(() => {
    const g = globalThis as unknown as { __plexiiNetGuardRoutesReady?: () => boolean }
    return g.__plexiiNetGuardRoutesReady?.() ?? false
  })

  // Only now may the app create its first window.
  const was = await app.evaluate(() => {
    const g = globalThis as unknown as { __plexiiNetGuardRelease?: () => string }
    return g.__plexiiNetGuardRelease ? g.__plexiiNetGuardRelease() : 'missing'
  })
  if (was !== 'held') {
    // The hook could not hold 'ready', so a window may have loaded before the
    // routes above. Fail closed rather than run a spec whose first document
    // was never routed.
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
    throw new Error(
      `[net-guard] the main-process hook did not hold the first window (state: ${was}); routes would be late. ` +
        'Has Playwright changed its Electron loader (__playwright_run)?'
    )
  }

  const guard: NetGuard = {
    violations,
    answeredLocally,
    allowed,
    assertClean: () => {
      readMainLog()
      if (allowed || guardOptions.selfTest || violations.length === 0 || reported === violations.length) return
      throw new Error(
        `[net-guard] ${spec} reached for PRODUCTION hosts (aborted):\n` +
          violations.map((v) => `  ${v.stack}: ${v.url}`).join('\n') +
          '\nRoute them locally, or name the spec in tests/e2e/_netGuardAllowlist.ts with the reason.'
      )
    },
    finish: () => {
      readMainLog()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return { app, guard }
}
