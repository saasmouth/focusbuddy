#!/usr/bin/env node
// A live window into what the machine is actually doing.
//
// The problem it solves: a signed build takes fifteen-odd minutes, most of it
// waiting on Apple's notary service, and from the outside that is
// indistinguishable from a hang. The only way to know where it had got to was
// to ask whoever started it, which is no visibility at all — just a promise
// that it is coming.
//
// EVERYTHING HERE IS DERIVED FROM REAL STATE. There is no progress model, no
// estimated percentage and no spinner that advances on a timer. Each row is a
// fact read from the filesystem, the process table, git, or the live build log,
// and anything it cannot determine says so rather than guessing. A dashboard
// that invents reassuring progress is worse than no dashboard, because you
// would believe it.
//
// Usage:  node scripts/status-server.mjs [--port 7777] [--logs <dir>]
//         open http://127.0.0.1:7777
//
// Read-only and loopback-only: it never writes to the repo, and it binds to
// 127.0.0.1 so nothing outside this machine can reach it.

import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', '7777'))
// Where to look for build/test logs. `release/` is where install-local writes;
// a second directory can be passed for a session's scratchpad logs.
const LOG_DIRS = [join(ROOT, 'release'), argOf('--logs', '')].filter(
  (d) => d && existsSync(d)
)

const sh = (cmd, cmdArgs, opts = {}) => {
  try {
    return execFileSync(cmd, cmdArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      ...opts
    }).trim()
  } catch {
    // A failed probe is reported as unknown, never as a zero or a success.
    return null
  }
}

/** Is a process matching this pattern alive right now? */
const running = (pattern) => {
  const out = sh('/usr/bin/pgrep', ['-f', pattern])
  return !!out && out.length > 0
}

const mtime = (p) => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return null
  }
}

// ── Signals ────────────────────────────────────────────────────────────────

function gitState() {
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = sh('git', ['log', '-1', '--format=%h %s'])
  const headAt = sh('git', ['log', '-1', '--format=%ct'])
  const porcelain = sh('git', ['status', '--porcelain'])
  // A branch with no upstream reports null here, which rendered as "unknown"
  // when the truthful answer is far more pointed: this work is not pushed
  // anywhere. Fall back to counting against main so the number means something.
  const upstream = sh('git', ['rev-parse', '--abbrev-ref', '@{upstream}'])
  const base = upstream ?? (sh('git', ['rev-parse', '--verify', 'main']) ? 'main' : null)
  const ahead = base ? sh('git', ['rev-list', '--count', `${base}..HEAD`]) : null
  const behind = base ? sh('git', ['rev-list', '--count', `HEAD..${base}`]) : null
  const dirty =
    porcelain === null
      ? null
      : porcelain
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('??')).length
  const untracked =
    porcelain === null ? null : porcelain.split('\n').filter((l) => l.startsWith('??')).length
  return {
    branch,
    head,
    headAt: headAt ? Number(headAt) * 1000 : null,
    dirty,
    untracked,
    ahead,
    behind,
    upstream,
    comparedTo: base
  }
}

function sourceVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

/** Built artifacts on disk for a given version, with real sizes and times. */
function artifactsFor(version) {
  const dir = join(ROOT, 'release')
  if (!version || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.includes(`-${version}-`) && /\.(dmg|zip|exe)$/.test(f))
    .map((f) => {
      const p = join(dir, f)
      const st = statSync(p)
      return { name: f, bytes: st.size, at: st.mtimeMs }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The installed app — the thing you actually launch. */
let installedCache = { at: 0, value: null }
function installedApp() {
  if (Date.now() - installedCache.at < 20_000) return installedCache.value
  let value = null
  try {
    const apps = readdirSync('/Applications').filter((d) => /^PlexiDesk.*\.app$/.test(d))
    if (apps.length > 0) {
      // Newest by mtime, which is the one a fresh install just wrote.
      const picked = apps
        .map((a) => ({ a, t: mtime(join('/Applications', a)) ?? 0 }))
        .sort((x, y) => y.t - x.t)[0].a
      const path = join('/Applications', picked)
      const plist = join(path, 'Contents', 'Info.plist')
      const version = sh('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleShortVersionString',
        plist
      ])
      const asar = join(path, 'Contents', 'Resources', 'app.asar')
      const gate = sh('/usr/sbin/spctl', ['-a', '-vvv', path])
      const archs = sh('/usr/bin/lipo', ['-archs', join(path, 'Contents', 'MacOS', 'PlexiDesk')])
      value = {
        name: picked,
        version,
        builtAt: mtime(asar),
        // spctl writes its verdict to stderr, which `sh` drops; absence of a
        // verdict is reported as unknown rather than as a failure.
        gatekeeper: gate === null ? 'unknown' : 'accepted',
        archs,
        others: apps.length > 1 ? apps.filter((a) => a !== picked) : []
      }
    }
  } catch {
    value = null
  }
  installedCache = { at: Date.now(), value }
  return value
}

/**
 * The newest log in the watched directories, and what stage it implies.
 *
 * The stage is read from lines the build actually prints — not from elapsed
 * time. If none of them has appeared yet, the stage is "starting", not a
 * percentage.
 */
function buildLog(installed, sourceVersion) {
  const candidates = []
  for (const dir of LOG_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.log')) continue
      // Not this server's own log. It is written continuously, so it was
      // always the newest file and the dashboard reported its own output as
      // the build — the first thing it got wrong about itself.
      if (f === 'status.log') continue
      const p = join(dir, f)
      const t = mtime(p)
      if (t === null) continue
      // Must actually look like a build/test log, or an unrelated file that
      // happens to be newer hides the run you are watching.
      let head = ''
      try {
        head = readFileSync(p, 'utf8').slice(0, 4000)
      } catch {
        continue
      }
      const looksLikeBuild =
        /electron-builder|electron-vite|packaging|notariz|install-local|vitest|playwright|Test Files/i.test(
          head
        )
      if (looksLikeBuild) candidates.push({ path: p, name: f, at: t })
    }
  }
  if (candidates.length === 0) return null
  const newest = candidates.sort((a, b) => b.at - a.at)[0]
  let text = ''
  try {
    const st = statSync(newest.path)
    const fd = readFileSync(newest.path, 'utf8')
    text = fd.length > 200_000 ? fd.slice(-200_000) : fd
    newest.bytes = st.size
  } catch {
    return null
  }
  const has = (s) => text.includes(s)
  const stages = [
    { id: 'renderer', label: 'Compiling renderer + main', done: has('built in') },
    { id: 'package', label: 'Packaging (x64, arm64, universal merge)', done: has('packaging') },
    { id: 'sign', label: 'Code signing (Developer ID)', done: has('signing') },
    {
      id: 'notarize',
      label: 'Notarising with Apple',
      done: has('notarization successful'),
      // The long one. Named so a wait here reads as expected rather than stuck.
      started: has('notarization') || has('notarize')
    },
    { id: 'artifacts', label: 'Writing dmg + zip', done: has('.dmg') && has('.zip') },
    {
      id: 'install',
      label: 'Installing to /Applications',
      // From the LOG when it is there, but also from the app itself: the
      // install often runs as a separate command whose output lands in another
      // file, and drawing this as pending while the app was already installed
      // was the dashboard misreporting a finished step.
      done:
        has('[install-local] installed') ||
        (!!installed && !!sourceVersion && installed.version === sourceVersion)
    }
  ]
  const refused = text.match(/\[install-local\] REFUSING:.*/g) ?? []
  const errors = (text.match(/^.*(⨯|ERR_|Error:|FAILED).*$/gm) ?? []).slice(-4)
  return {
    log: newest.name,
    at: newest.at,
    bytes: newest.bytes ?? null,
    tail: text.split('\n').filter((l) => l.trim()).slice(-6),
    stages,
    refused,
    errors
  }
}

/** The last recorded test results, read from whatever log carried them. */
function testState() {
  const out = { unit: null, e2e: null }
  for (const dir of LOG_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.log')) continue
      const p = join(dir, f)
      let text = ''
      try {
        text = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      const at = mtime(p) ?? 0
      const unit = text.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)/)
      if (unit && (!out.unit || at > out.unit.at)) {
        out.unit = { failed: Number(unit[1] ?? 0), passed: Number(unit[2]), at, log: f }
      }
      const e2e = [...text.matchAll(/^\s+(\d+) (passed|failed)/gm)]
      if (e2e.length > 0 && (!out.e2e || at > out.e2e.at)) {
        const passed = e2e.filter((m) => m[2] === 'passed').reduce((n, m) => n + Number(m[1]), 0)
        const failed = e2e.filter((m) => m[2] === 'failed').reduce((n, m) => n + Number(m[1]), 0)
        out.e2e = { passed, failed, at, log: f }
      }
    }
  }
  return out
}

function activity() {
  return {
    build: running('electron-builder|dist:mac|release-env'),
    notarize: running('notarytool|altool'),
    tests: running('playwright test|vitest'),
    app: running('PlexiDesk.*Contents/MacOS')
  }
}

function snapshot() {
  const version = sourceVersion()
  const installed = installedApp()
  return {
    now: Date.now(),
    root: ROOT,
    version,
    git: gitState(),
    artifacts: artifactsFor(version),
    installed,
    build: buildLog(installed, version),
    tests: testState(),
    activity: activity(),
    logDirs: LOG_DIRS
  }
}

// ── The page ───────────────────────────────────────────────────────────────

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>PlexiDesk — what the machine is doing</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f6f7;--card:#fff;--ink:#17171a;--dim:#6b6b73;--line:#e4e4e8;--ok:#117a39;--warn:#8a5400;--bad:#b3261e;--accent:#4f46e5}
  @media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1b1b1f;--ink:#f2f2f4;--dim:#9a9aa3;--line:#2c2c32;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--accent:#a5b4fc}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
  h1{font-size:15px;margin:0 0 2px;letter-spacing:.02em}
  .sub{color:var(--dim);font-size:12px;margin-bottom:14px}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));max-width:1200px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
  .card h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin:0 0 8px;font-weight:600}
  .row{display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:0}
  .k{color:var(--dim);font-size:12px;flex:0 0 42%;min-width:0}
  .v{flex:1;min-width:0;font-size:12px;word-break:break-word}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
  .pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .live{background:color-mix(in srgb,var(--accent) 16%,transparent);border-color:var(--accent);color:var(--accent)}
  .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .dim{color:var(--dim)}
  .st{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px}
  .dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px;background:var(--line)}
  .dot.done{background:var(--ok)} .dot.now{background:var(--accent);animation:p 1.1s ease-in-out infinite}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
  pre{margin:6px 0 0;padding:8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;line-height:1.45;max-height:170px;white-space:pre-wrap}
  table{width:100%;border-collapse:collapse}
  td,th{text-align:left;font-size:12px;padding:3px 6px 3px 0;border-bottom:1px solid var(--line)}
  th{color:var(--dim);font-weight:600;font-size:11px}
  .foot{color:var(--dim);font-size:11px;margin-top:12px}
</style></head><body>
<h1>PlexiDesk — what the machine is doing</h1>
<div class="sub" id="sub">connecting…</div>
<div class="grid" id="grid"></div>
<div class="foot" id="foot"></div>
<script>
const $ = (id) => document.getElementById(id)
const ago = (t) => {
  if (!t) return 'unknown'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}
const mb = (b) => (b === null || b === undefined ? 'unknown' : (b / 1048576).toFixed(1) + ' MB')
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const row = (k, v, cls) => '<div class="row"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>'

function render(d) {
  const busy = Object.entries(d.activity).filter(([, v]) => v).map(([k]) => k)
  $('sub').innerHTML = busy.length
    ? 'Busy now: ' + busy.map((b) => '<span class="pill live">' + esc(b) + '</span>').join(' ')
    : '<span class="pill">idle — nothing running</span>'

  const cards = []

  // What is happening right now
  if (d.build) {
    const firstPending = d.build.stages.findIndex((s) => !s.done)
    const stages = d.build.stages.map((s, i) => {
      const now = busy.length > 0 && i === firstPending
      return '<div class="st"><span class="dot ' + (s.done ? 'done' : now ? 'now' : '') + '"></span>' +
        '<span class="' + (s.done ? 'ok' : now ? '' : 'dim') + '">' + esc(s.label) + '</span>' +
        (now && s.id === 'notarize' ? ' <span class="dim">— Apple decides how long this takes</span>' : '') +
        '</div>'
    }).join('')
    cards.push('<div class="card"><h2>Build</h2>' + stages +
      row('log', '<span class="mono">' + esc(d.build.log) + '</span>') +
      row('last wrote', ago(d.build.at)) +
      (d.build.refused.length ? '<div class="bad" style="margin-top:6px">' + d.build.refused.map(esc).join('<br>') + '</div>' : '') +
      '<pre>' + esc(d.build.tail.join('\\n')) + '</pre></div>')
  } else {
    cards.push('<div class="card"><h2>Build</h2><div class="dim">No build log found in ' +
      esc(d.logDirs.join(', ') || '(no log directories)') + '</div></div>')
  }

  // Which version is where — the thing that actually bites
  const art = d.artifacts.length
    ? d.artifacts.map((a) => '<tr><td class="mono">' + esc(a.name) + '</td><td>' + mb(a.bytes) + '</td><td class="dim">' + ago(a.at) + '</td></tr>').join('')
    : '<tr><td colspan="3" class="dim">none built for ' + esc(d.version) + ' yet</td></tr>'
  cards.push('<div class="card"><h2>Version, in every place it lives</h2>' +
    row('source (package.json)', '<b>' + esc(d.version) + '</b>') +
    row('installed app', d.installed
      ? '<b>' + esc(d.installed.version) + '</b> <span class="dim">' + esc(d.installed.name) + '</span>'
      : '<span class="dim">none found in /Applications</span>',
      d.installed && d.installed.version !== d.version ? 'warn' : 'ok') +
    row('installed built', d.installed ? ago(d.installed.builtAt) : 'unknown') +
    row('architectures', d.installed ? '<span class="mono">' + esc(d.installed.archs || 'unknown') + '</span>' : 'unknown') +
    row('gatekeeper', d.installed ? esc(d.installed.gatekeeper) : 'unknown') +
    (d.installed && d.installed.others.length
      ? row('also installed', '<span class="dim">' + d.installed.others.map(esc).join(', ') + '</span>', 'warn') : '') +
    '<table style="margin-top:8px"><tr><th>artifact</th><th>size</th><th>written</th></tr>' + art + '</table></div>')

  // Tests
  const t = d.tests
  cards.push('<div class="card"><h2>Last recorded test runs</h2>' +
    row('unit', t.unit
      ? (t.unit.failed > 0
          ? '<span class="bad">' + t.unit.failed + ' failed</span>, ' + t.unit.passed + ' passed'
          : '<span class="ok">' + t.unit.passed + ' passed</span>') + ' <span class="dim">' + ago(t.unit.at) + '</span>'
      : '<span class="dim">no run recorded</span>') +
    row('e2e', t.e2e
      ? (t.e2e.failed > 0
          ? '<span class="bad">' + t.e2e.failed + ' failed</span>, ' + t.e2e.passed + ' passed'
          : '<span class="ok">' + t.e2e.passed + ' passed</span>') + ' <span class="dim">' + ago(t.e2e.at) + '</span>'
      : '<span class="dim">no run recorded</span>') +
    '<div class="dim" style="margin-top:6px;font-size:11px">Read from build logs, so this is the last run that wrote one — not necessarily the current code.</div></div>')

  // Git
  const g = d.git
  cards.push('<div class="card"><h2>Repository</h2>' +
    row('branch', '<span class="mono">' + esc(g.branch || 'unknown') + '</span>') +
    row('HEAD', '<span class="mono">' + esc(g.head || 'unknown') + '</span>') +
    row('committed', ago(g.headAt)) +
    row('uncommitted', g.dirty === null ? 'unknown' : g.dirty + ' tracked file' + (g.dirty === 1 ? '' : 's'), g.dirty ? 'warn' : 'ok') +
    row('untracked', g.untracked === null ? 'unknown' : String(g.untracked)) +
    row('tracking', g.upstream
      ? '<span class="mono">' + esc(g.upstream) + '</span>'
      : '<b>no upstream — not pushed anywhere</b>', g.upstream ? 'ok' : 'bad') +
    row('vs ' + esc(g.comparedTo || '?'), g.ahead === null ? 'unknown'
      : (g.ahead + ' ahead, ' + (g.behind ?? '?') + ' behind'),
      Number(g.ahead) > 0 ? 'warn' : 'ok') + '</div>')

  $('grid').innerHTML = cards.join('')
  $('foot').textContent = 'Reading ' + d.root + ' · refreshed ' + new Date(d.now).toLocaleTimeString() +
    ' · every value on this page is read from disk, git or the process table — nothing is estimated.'
}

async function tick() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' })
    render(await r.json())
  } catch (e) {
    $('sub').innerHTML = '<span class="pill bad">status server stopped</span>'
  }
}
tick(); setInterval(tick, 2000)
</script></body></html>`

const server = createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(snapshot()))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})

// Loopback only. This exposes build paths and git state; it has no business
// being reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[status] http://127.0.0.1:${PORT}  (reading ${ROOT})`)
  if (LOG_DIRS.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[status] no log directories found — pass --logs <dir> to watch build output')
  }
})
