// The e2e net guard's MAIN-PROCESS half. Loaded with `-r` ahead of the app path
// by _netGuard.ts (launchGuarded), so it runs before the app's own main script.
// It does three things, all before the app can open a window or a socket:
//
//  1. HOLDS THE FIRST WINDOW. Playwright's Electron loader (loaded just before
//     this file) holds app 'ready' until the test client calls
//     __playwright_run(); this wraps that call so 'ready' waits a second time,
//     until _netGuard.ts has installed its context routes and calls
//     globalThis.__plexiiNetGuardRelease(). So no page exists, and no document
//     runs, before the renderer routes are in place. This is the fix for the
//     _fakeSignal leak: a route installed after the first document is created
//     never sees that document's sockets.
//
//  2. REFUSES PRODUCTION AT THE SESSION. Every Electron session (default,
//     partitions, webviews) gets a webRequest.onBeforeRequest filter for the
//     production hosts, installed on 'session-created' — before any request
//     exists. That covers the whole Chromium network stack: renderer fetch/XHR,
//     native WebSockets, images, webviews, and Electron's net module in main.
//     It is the backstop for anything the renderer routes do not see.
//
//     ONE MEASURED SUBTLETY: webRequest runs BEFORE Playwright's request
//     interception (CDP Fetch). Cancelling everything here would cancel the
//     requests a spec's page.route was about to fulfil locally (_fakeSignal's
//     /conversations, say) — measured in netGuard.spec.ts NG-6's first run. So
//     once the test side reports its context route is installed
//     (__plexiiNetGuardRoutesReady), plain HTTP from an app WINDOW is passed on
//     to that route, which fulfils it locally or aborts it and fails the spec.
//     Everything else is still cancelled here: every WebSocket (a routed socket
//     never reaches the network, so one that does was missed by the routes —
//     the original leak), every request from main, a webview, a service
//     worker, or anything without a window, and ALL window HTTP before the
//     routes are reported ready.
//
//  2b. BLACK-HOLES PRODUCTION DNS IN CHROMIUM. --host-resolver-rules maps every
//     production host to ~NOTFOUND inside the network service — AFTER
//     Playwright's interception, so a request a route fulfils never gets here,
//     while one that does go to the network (a page route that continue()s a
//     production URL, which nothing above sees) cannot resolve. It records
//     nothing; it is the floor under the other layers, not a reporter.
//
//  3. REFUSES PRODUCTION IN NODE. net.Socket#connect and dns.lookup are wrapped,
//     so main-process fetch (undici), http/https, ws, tls and IMAP/SMTP to a
//     production host fail before a packet leaves.
//
// Every refusal is one JSON line in $PLEXII_E2E_NETGUARD_LOG and one
// "[net-guard] BLOCKED" line on stderr; _netGuard.ts turns either into a test
// failure naming the spec and the URL. With PLEXII_E2E_NETGUARD_ALLOW=1 (an
// allowlisted live spec) traffic is recorded and let through instead.
//
// The host rules come from the test side (_netGuardHosts.ts, derived from
// src/shared/productDomains.ts) in $PLEXII_E2E_NETGUARD_RULES, so this file
// carries no host literal of its own.
//
// WHAT THIS CANNOT SEE: child processes the app spawns (a local model server,
// a helper binary) run their own networking outside this process, and native
// OS networking that bypasses both Chromium and Node (Squirrel.Mac's updater,
// which only runs in packaged builds). Neither talks to a production host in an
// unpackaged e2e build today.

'use strict'
const fs = require('fs')
const net = require('net')
const dns = require('dns')

let rules = []
try {
  rules = JSON.parse(process.env.PLEXII_E2E_NETGUARD_RULES || '[]')
} catch {
  rules = []
}
const logFile = process.env.PLEXII_E2E_NETGUARD_LOG || ''
const allow = process.env.PLEXII_E2E_NETGUARD_ALLOW === '1'

if (rules.length === 0) {
  // Fail closed: a guard with nothing to refuse is a guard that is off.
  process.stderr.write('[net-guard] BLOCKED ' + JSON.stringify({ stack: 'guard', url: 'no host rules were passed to the guard' }) + '\n')
}

function hostRefused(host) {
  if (!host || typeof host !== 'string') return false
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return rules.some((r) => h === r || h.endsWith('.' + r))
}

function urlRefused(url) {
  try {
    return hostRefused(new URL(url).hostname)
  } catch {
    return false
  }
}

function record(rec) {
  const line = JSON.stringify({ t: Date.now(), allowed: allow, ...rec })
  try {
    if (logFile) fs.appendFileSync(logFile, line + '\n')
  } catch {
    /* the stderr line below still carries it */
  }
  try {
    process.stderr.write((allow ? '[net-guard] ALLOWED ' : '[net-guard] BLOCKED ') + line + '\n')
  } catch {
    /* nothing more to do */
  }
}

// ── 3. Node: sockets and DNS ────────────────────────────────────────────────
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  let opts = args[0]
  if (Array.isArray(opts)) opts = opts[0]
  let host = null
  let port = null
  if (opts && typeof opts === 'object') {
    // TLS sockets carry the SNI name, which is the real destination when the
    // socket itself was handed a resolved IP.
    host = opts.servername || opts.host || opts.hostname || null
    port = opts.port || null
  } else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) {
    port = Number(opts)
    host = typeof args[1] === 'string' ? args[1] : null
  }
  if (hostRefused(host)) {
    record({ stack: 'node', url: `tcp://${host}${port ? ':' + port : ''}` })
    if (!allow) {
      const err = Object.assign(new Error(`[net-guard] e2e refused a connection to production host ${host}`), {
        code: 'ECONNREFUSED'
      })
      process.nextTick(() => this.destroy(err))
      return this
    }
  }
  return origConnect.apply(this, args)
}

const origLookup = dns.lookup
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (hostRefused(hostname)) {
    record({ stack: 'node-dns', url: `dns://${hostname}` })
    if (!allow) {
      const cb = rest.find((a) => typeof a === 'function')
      const err = Object.assign(new Error(`[net-guard] e2e refused to resolve production host ${hostname}`), {
        code: 'ENOTFOUND',
        hostname
      })
      if (cb) process.nextTick(() => cb(err))
      return undefined
    }
  }
  return origLookup.call(this, hostname, ...rest)
}
if (dns.promises && typeof dns.promises.lookup === 'function') {
  const origPLookup = dns.promises.lookup
  dns.promises.lookup = function guardedPLookup(hostname, ...rest) {
    if (hostRefused(hostname)) {
      record({ stack: 'node-dns', url: `dns://${hostname}` })
      if (!allow) {
        return Promise.reject(
          Object.assign(new Error(`[net-guard] e2e refused to resolve production host ${hostname}`), {
            code: 'ENOTFOUND',
            hostname
          })
        )
      }
    }
    return origPLookup.call(this, hostname, ...rest)
  }
}

// ── Electron: sessions and the first window ─────────────────────────────────
let electron = null
try {
  electron = require('electron')
} catch {
  electron = null
}

if (electron && electron.app) {
  const { app } = electron

  if (!allow && rules.length > 0) {
    app.commandLine.appendSwitch(
      'host-resolver-rules',
      rules.map((r) => `MAP ${r} ~NOTFOUND, MAP *.${r} ~NOTFOUND`).join(', ')
    )
  }

  // Chromium match patterns, one per scheme: `*://` covers http/https only, and
  // a WebSocket is ws/wss.
  const urlPatterns = []
  for (const r of rules) {
    for (const scheme of ['http', 'https', 'ws', 'wss']) {
      urlPatterns.push(`${scheme}://${r}/*`, `${scheme}://*.${r}/*`)
    }
  }

  // Set by the test side once context.route is installed (launchGuarded).
  let routesReady = false
  globalThis.__plexiiNetGuardRoutesReady = () => {
    routesReady = true
    return true
  }
  function fromAppWindow(details) {
    try {
      const wc = details.webContents
      if (!wc || wc.isDestroyed()) return false
      const type = wc.getType()
      return type === 'window' || type === 'browserView'
    } catch {
      return false
    }
  }

  const guarded = new WeakSet()
  function guardSession(ses) {
    if (!ses || guarded.has(ses)) return
    guarded.add(ses)
    const wr = ses.webRequest
    const install = wr.onBeforeRequest.bind(wr)
    install({ urls: urlPatterns }, (details, callback) => {
      // The pattern is the coarse filter; the host check is the decision.
      if (!urlRefused(details.url)) return callback({})
      if (routesReady && details.resourceType !== 'webSocket' && fromAppWindow(details)) {
        // The context route sees this next and decides (see the header).
        return callback({})
      }
      record({ stack: 'session', url: details.url, resourceType: details.resourceType })
      callback(allow ? {} : { cancel: true })
    })
    // Electron keeps ONE onBeforeRequest listener per session; a later call
    // replaces this one and the guard would be silently off for that session.
    // The app does not register one today. If it ever does, say so loudly
    // rather than lose the guard: the spec fails and this file needs to learn
    // to compose the two listeners.
    wr.onBeforeRequest = function displaced() {
      record({ stack: 'guard', url: 'the app registered its own webRequest.onBeforeRequest, which would displace the e2e net guard (extend tests/e2e/_netGuardMain.cjs to compose them)' })
      return install(...arguments)
    }
  }
  app.on('session-created', guardSession)
  app.whenReady().then(() => guardSession(electron.session.defaultSession))

  // Hold 'ready' until the test side has installed its routes.
  const run = globalThis.__playwright_run
  if (process.env.PLEXII_E2E_NETGUARD_GATE === '1' && typeof run === 'function') {
    let release
    const released = new Promise((resolve) => {
      release = resolve
    })
    let state = 'held'
    globalThis.__plexiiNetGuardRelease = () => {
      const was = state
      state = 'released'
      release()
      return was
    }
    globalThis.__playwright_run = async (...a) => {
      await released
      return run(...a)
    }
  } else if (process.env.PLEXII_E2E_NETGUARD_GATE === '1') {
    // Asked to hold the first window but Playwright's loader is not there to
    // wrap: say so, so the test side fails instead of trusting a late route.
    globalThis.__plexiiNetGuardRelease = () => 'not-held'
  }
}
