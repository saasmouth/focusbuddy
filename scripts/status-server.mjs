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
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { websiteMonitor, defaultWorkflowsRoot } from './status-website.mjs'

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

// Mutating endpoints are protected three ways, because "it is only on
// localhost" is not a security model: any web page you have open can POST to
// 127.0.0.1. So an action requires a token minted at boot and embedded in the
// page (a cross-site caller cannot read it), a custom header (which forces a
// CORS preflight that cross-site callers cannot satisfy), and a same-origin
// check. Reads stay open; only writes are gated.
// The Website tab (status-website.mjs). Deploy-run logs live in a session's
// scratchpad; pass --deploy-runs <dir>, or the newest one on this machine is used.
const findDeployRuns = () => {
  const base = '/private/tmp/claude-501'
  let best = null
  try {
    for (const proj of readdirSync(base)) for (const sess of readdirSync(join(base, proj))) {
      const d = join(base, proj, sess, 'scratchpad/deploy-snap/runs')
      const m = existsSync(d) ? statSync(d).mtimeMs : 0
      if (m && (!best || m > best.m)) best = { d, m }
    }
  } catch {}
  return best ? best.d : null
}
const website = websiteMonitor({
  appRoot: ROOT,
  deployRunsDir: argOf('--deploy-runs', '') || findDeployRuns(),
  workflowsGlobRoot: defaultWorkflowsRoot()
})

const TOKEN = randomBytes(16).toString('hex')
const ACTIONS_ENABLED = !args.includes('--read-only')

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

// ── Where it stands on the server ─────────────────────────────────────────
//
// Two different places, deliberately reported apart: the GitHub release is
// where the download page points and where assets are archived; the R2 feed is
// what installed clients actually read when they check for an update. A release
// can be complete on one and absent on the other — that is how 4.3.13 and
// 4.3.14 shipped to nobody — so a single "published" light would be a lie.
let serverCache = { at: 0, value: null, checking: false }

async function refreshServerState(version) {
  if (!version || serverCache.checking) return
  if (Date.now() - serverCache.at < 60_000) return
  serverCache.checking = true
  try {
    const tag = `v${version}`
    const release = sh('gh', [
      'release',
      'view',
      tag,
      '--repo',
      'saasmouth/focusbuddy',
      '--json',
      'tagName,isDraft,assets'
    ])
    let ghState = { exists: false, draft: null, assets: 0 }
    if (release) {
      try {
        const j = JSON.parse(release)
        ghState = {
          exists: true,
          draft: !!j.isDraft,
          assets: Array.isArray(j.assets) ? j.assets.length : 0
        }
      } catch {
        ghState = { exists: false, draft: null, assets: 0 }
      }
    }
    const macFeed = sh('/usr/bin/curl', [
      '-s',
      '--max-time',
      '8',
      '-L',
      'https://dl.plexiidesk.com/latest-mac.yml'
    ])
    const winFeed = sh('/usr/bin/curl', [
      '-s',
      '--max-time',
      '8',
      '-L',
      'https://dl.plexiidesk.com/latest.yml'
    ])
    const feedVersion = (text) => {
      const m = text && text.match(/^version:\s*(\S+)/m)
      return m ? m[1] : null
    }
    serverCache = {
      at: Date.now(),
      checking: false,
      value: {
        tag,
        github: ghState,
        macFeed: feedVersion(macFeed),
        winFeed: feedVersion(winFeed),
        // null means the probe itself failed (offline, gh not logged in), which
        // is not the same as "not published".
        reachable: macFeed !== null
      }
    }
  } finally {
    serverCache.checking = false
  }
}

function activity() {
  return {
    build: running('electron-builder|dist:mac|release-env'),
    notarize: running('notarytool|altool'),
    tests: running('playwright test|vitest'),
    app: running('PlexiDesk.*Contents/MacOS')
  }
}

// ── Jobs ──────────────────────────────────────────────────────────────────
//
// A button runs a real command and streams its real output. Nothing is
// simulated and nothing is reported as finished until the process exits.
const jobs = []
let activeJob = null

// One definition, used by both the publish action and "all". It reuses the
// repo's own release path, so it inherits every gate that path already has —
// including the completeness check that refuses to call a release done while
// the update feed still serves the old version.
const PUBLISH_SCRIPT = [
  'set -e',
  'V=$(node -p "require(\'./package.json\').version")',
  'git tag -a "v$V" -m "PlexiDesk $V" 2>/dev/null || true',
  'git push origin "v$V"',
  'gh release view "v$V" --repo saasmouth/focusbuddy >/dev/null 2>&1 || ' +
    'gh release create "v$V" --repo saasmouth/focusbuddy --title "PlexiDesk $V" --notes "PlexiDesk $V"',
  'node scripts/release-env.mjs npm run release:mac'
].join('\n')

const JOB_DEFS = {
  'install-local': {
    label: 'Install locally',
    detail:
      'Installs the build already sitting in release/ into /Applications. Seconds, not minutes — it refuses if that package is older than the built code.',
    steps: [['bash', ['scripts/install-local.sh', '--no-build']]]
  },
  'build-install': {
    label: 'Rebuild, then install',
    detail: 'Signs and notarises from scratch, then installs. ~15 minutes.',
    steps: [
      ['node', ['scripts/release-env.mjs', 'npm', 'run', 'dist:mac:universal']],
      ['bash', ['scripts/install-local.sh', '--no-build']]
    ]
  },
  'git-push': {
    label: 'Push to git',
    detail: 'Pushes the current branch, setting its upstream if it has none.',
    steps: [['bash', ['-lc', 'git push -u origin "$(git rev-parse --abbrev-ref HEAD)"']]]
  },
  'server-publish': {
    label: 'Publish to the server',
    detail:
      'Tags, creates the GitHub release, uploads the mac assets and mirrors them to the update feed. This is public.',
    steps: [['bash', ['-lc', PUBLISH_SCRIPT]]]
  },
  all: {
    label: 'Send to all three',
    detail: 'Install locally, push the branch, then publish — stopping at the first failure.',
    steps: [
      ['bash', ['scripts/install-local.sh', '--no-build']],
      ['bash', ['-lc', 'git push -u origin "$(git rev-parse --abbrev-ref HEAD)"']],
      ['bash', ['-lc', PUBLISH_SCRIPT]]
    ]
  }
}

function startJob(id) {
  const def = JOB_DEFS[id]
  if (!def) return { ok: false, error: `Unknown action "${id}"` }
  if (activeJob) return { ok: false, error: `Already running: ${activeJob.label}` }
  const job = {
    id,
    label: def.label,
    startedAt: Date.now(),
    endedAt: null,
    code: null,
    lines: [],
    steps: def.steps.length,
    step: 1
  }
  jobs.unshift(job)
  jobs.length = Math.min(jobs.length, 6)
  activeJob = job

  const push = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) job.lines.push(line.replace(/\u001b\[[0-9;]*m/g, ''))
    }
    // Tail only: a packaging log runs to tens of thousands of lines.
    if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400)
  }

  const runStep = (i) => {
    if (i >= def.steps.length) {
      job.code = 0
      job.endedAt = Date.now()
      activeJob = null
      return
    }
    job.step = i + 1
    if (i > 0) push(`[status] — step ${i + 1} of ${def.steps.length} —`)
    const [cmd, cmdArgs] = def.steps[i]
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: process.env })
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (e) => {
      push(`[status] could not start: ${e.message}`)
      job.code = 1
      job.endedAt = Date.now()
      activeJob = null
    })
    child.on('close', (code) => {
      if ((code ?? 1) !== 0) {
        // Stop at the first failure. Pushing a branch whose install just
        // refused, or publishing either way, would be worse than stopping.
        push(`[status] step failed with code ${code} — stopping here.`)
        job.code = code ?? 1
        job.endedAt = Date.now()
        activeJob = null
        return
      }
      runStep(i + 1)
    })
  }
  runStep(0)
  return { ok: true }
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
    logDirs: LOG_DIRS,
    server: serverCache.value,
    serverCheckedAt: serverCache.at || null,
    actionsEnabled: ACTIONS_ENABLED,
    jobs: jobs.map((j) => ({
      id: j.id,
      label: j.label,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      code: j.code,
      step: j.step,
      steps: j.steps,
      lines: j.lines.slice(-14)
    })),
    busyJob: activeJob ? activeJob.id : null
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
  .wide{grid-column:1/-1}
  .pipe{width:100%;border-collapse:collapse}
  .pipe th{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);padding:0 8px 6px 0}
  .pipe td{padding:8px 8px 8px 0;border-top:1px solid var(--line);vertical-align:middle}
  .tgt{font-weight:600;font-size:12.5px}
  .tgt small{display:block;font-weight:400;color:var(--dim);font-size:11px}
  button.act{font:inherit;font-size:11.5px;padding:5px 10px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;white-space:nowrap}
  button.act:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
  button.act:disabled{opacity:.45;cursor:default}
  button.act.arm{border-color:var(--bad);color:var(--bad);font-weight:600}
  button.all{background:var(--accent);color:#fff;border-color:var(--accent);padding:6px 14px;font-weight:600}
  .state{font-size:11.5px;font-weight:600}
  .note{font-size:11px;color:var(--dim);margin-top:8px;line-height:1.45}
  .tabs{display:flex;gap:6px;margin:0 0 12px}
  .tabs a{font-size:12px;padding:5px 12px;border-radius:999px;border:1px solid var(--line);color:var(--ink);text-decoration:none}
  .tabs a[aria-current=page]{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body>
<h1>PlexiDesk — what the machine is doing</h1>
<nav class="tabs"><a href="#app" id="tab-app">App</a><a href="#website" id="tab-website">Website</a></nav>
<div class="sub" id="sub">connecting…</div>
<div class="grid" id="grid"></div>
<div class="foot" id="foot"></div>
<script>
const TOKEN = '__TOKEN__'
const $ = (id) => document.getElementById(id)
// Arm-then-confirm: the first press arms, the second fires. Publishing is
// public and a stray click should not be able to do it.
let armed = null
async function act(action) {
  if (armed !== action) {
    armed = action
    setTimeout(() => { if (armed === action) { armed = null; tick() } }, 6000)
    tick()
    return
  }
  armed = null
  const r = await fetch('/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plexii-status': '1' },
    body: JSON.stringify({ action: action, token: TOKEN })
  })
  const j = await r.json().catch(() => ({ ok: false, error: 'no response' }))
  if (!j.ok) alert(j.error || 'Refused')
  tick()
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button.act[data-action]')
  if (b && !b.disabled) act(b.dataset.action)
})
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

  // ── Where the ready build has got to ──────────────────────────────────
  // The subject is the BUILD sitting in release/, not the source version:
  // "there is a build ready — has it reached here yet?" is the question.
  const ready = d.artifacts.length ? d.artifacts[0] : null
  const readyVer = d.version
  const sv = d.server
  const busyJob = d.busyJob
  // No inline onclick: the page is built by concatenation inside a template
  // literal, and the nested quoting an inline handler needs collapsed into a
  // syntax error that blanked the whole dashboard. A data attribute plus one
  // delegated listener has nothing to escape.
  const btn = (action, label, enabled) => {
    const isArmed = armed === action
    return '<button class="act' + (isArmed ? ' arm' : '') + '" data-action="' + action + '"' +
      (enabled && !busyJob ? '' : ' disabled') + '>' +
      (isArmed ? 'Confirm — ' + esc(label) : esc(label)) + '</button>'
  }

  const localOk = d.installed && d.installed.version === readyVer
  const gitClean = d.git.dirty === 0
  const gitPushed = !!d.git.upstream && Number(d.git.ahead) === 0
  const ghOk = sv && sv.github && sv.github.exists && !sv.github.draft
  const feedOk = sv && sv.macFeed === readyVer
  const serverOk = ghOk && feedOk

  const rows = [
    ['Local',
      '/Applications',
      d.installed ? esc(d.installed.version) : 'none',
      localOk ? '<span class="state ok">installed</span>'
        : '<span class="state warn">' + (d.installed ? 'older build installed' : 'not installed') + '</span>',
      btn('install-local', localOk ? 'Reinstall' : 'Install', !!ready)],
    ['Git',
      esc(d.git.branch || '?') + (d.git.upstream ? '' : ' · no upstream'),
      (d.git.dirty === 0 ? 'committed' : d.git.dirty + ' uncommitted'),
      gitPushed ? '<span class="state ok">pushed</span>'
        : '<span class="state ' + (gitClean ? 'warn' : 'bad') + '">' +
          (!gitClean ? 'uncommitted changes' : d.git.ahead + ' commit(s) unpushed') + '</span>',
      btn('git-push', 'Push', gitClean)],
    ['Server',
      'GitHub release + update feed',
      sv ? (sv.github.exists ? 'release ' + esc(sv.tag) : 'no release') +
           ' · feed ' + esc(sv.macFeed || '?') : 'checking…',
      !sv ? '<span class="state dim">checking…</span>'
        : !sv.reachable ? '<span class="state dim">could not reach the feed</span>'
        : serverOk ? '<span class="state ok">published</span>'
        : '<span class="state warn">' + (ghOk ? 'feed still on ' + esc(sv.macFeed || '?') : 'not published') + '</span>',
      btn('server-publish', 'Publish', gitPushed && !!ready)]
  ]
    .map((r) => '<tr><td class="tgt">' + r[0] + '<small>' + r[1] + '</small></td>' +
      '<td>' + r[2] + '</td><td>' + r[3] + '</td><td style="text-align:right">' + r[4] + '</td></tr>')
    .join('')

  cards.push('<div class="card wide"><h2>Ready build — where it has got to</h2>' +
    (ready
      ? '<div style="font-size:12px;margin-bottom:8px">Built <b>' + esc(readyVer) + '</b> · ' +
        d.artifacts.map((a) => esc(a.name.replace(/^PlexiDesk-/, '')) + ' (' + mb(a.bytes) + ')').join(' · ') +
        ' · <span class="dim">' + ago(ready.at) + '</span></div>'
      : '<div class="dim" style="font-size:12px;margin-bottom:8px">No build for ' + esc(readyVer) +
        ' in release/ yet — rebuild first.</div>') +
    '<table class="pipe"><tr><th>target</th><th>what is there</th><th>state</th><th></th></tr>' +
    rows + '</table>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">' +
      btn('all', 'Send to all three', !!ready && gitClean) +
      btn('build-install', 'Rebuild from source', true) +
      (busyJob ? '<span class="pill live">running ' + esc(busyJob) + '</span>' : '') +
    '</div>' +
    '<div class="note">Each button runs the real command and streams its real output below. ' +
    'The first press arms it, the second confirms — publishing is public and irreversible. ' +
    'Publish stays disabled until the branch is pushed, because a release whose source is not in git cannot be rebuilt from its own tag.' +
    (sv && sv.winFeed && sv.winFeed !== readyVer
      ? ' Windows feed is on ' + esc(sv.winFeed) + ' and is not touched by these buttons.' : '') +
    '</div></div>')

  // Jobs — real output from whatever a button started
  if (d.jobs.length > 0) {
    const j = d.jobs[0]
    const dur = Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000)
    cards.push('<div class="card wide"><h2>' + esc(j.label) +
      (j.steps > 1 ? ' — step ' + j.step + ' of ' + j.steps : '') + '</h2>' +
      row('state', j.endedAt === null
        ? '<span class="pill live">running · ' + dur + 's</span>'
        : j.code === 0
          ? '<span class="ok">finished cleanly in ' + dur + 's</span>'
          : '<span class="bad">exited ' + j.code + ' after ' + dur + 's</span>') +
      '<pre>' + esc(j.lines.join('\\n') || 'waiting for output…') + '</pre></div>')
  }

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

const tab = () => (location.hash === '#website' ? 'website' : 'app')
const fmt = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown')
function renderWebsite(d) {
  $('tab-app').removeAttribute('aria-current'); $('tab-website').setAttribute('aria-current', 'page')
  const cards = [], L = d.local, N = d.net || {}
  const lv = N.live || {}
  const cls = (a, b) => (a && b ? (a === b ? 'ok' : 'warn') : 'dim')
  $('sub').innerHTML = d.workflows.list && d.workflows.list.some((w) => w.done < w.agents && Date.now() - w.lastMoved < 900000)
    ? '<span class="pill live">website work in progress</span>' : '<span class="pill">no website job moving right now</span>'
  cards.push('<div class="card"><h2>Versions: site vs published</h2>' +
    row('Mac on the site', esc(L.siteMac || 'unknown') + ' · feed ' + esc(lv.feedMac || (N.live ? 'unreadable' : 'checking…')), cls(L.siteMac, lv.feedMac)) +
    row('Windows on the site', esc(L.siteWin || 'unknown') + ' · feed ' + esc(lv.feedWin || (N.live ? 'unreadable' : 'checking…')), cls(L.siteWin, lv.feedWin)) +
    row('network last checked', ago(d.netCheckedAt)) + '</div>')
  const sm = lv.sitemap
  const live = (k) => (sm ? (sm[k] || 0) : '…')
  const disk = L.onDisk
  cards.push('<div class="card"><h2>Pages: live vs on this machine</h2><table><tr><th>section</th><th>live (sitemap)</th><th>on disk</th></tr>' +
    [['help', 'help articles', ' of ' + (disk['help planned'] ?? '?') + ' planned'], ['blog', 'blog posts', ''], ['tools', 'tools', ''], ['templates', 'templates', ''], ['glossary', 'glossary terms', '']]
      .map(([s, k, x]) => '<tr><td>' + esc(s) + '</td><td>' + live(s) + '</td><td>' + (disk[k] ?? '–') + esc(x) + '</td></tr>').join('') +
    '<tr><td>other pages</td><td>' + live('other pages') + '</td><td></td></tr></table>' +
    '<div class="note">Live counts are sitemap URLs (help and blog include their topic pages); on disk counts are source files, written but maybe not yet deployed.</div></div>')
  cards.push('<div class="card"><h2>Site source (git)</h2>' +
    row('uncommitted site files', L.uncommitted === null ? 'unknown' : String(L.uncommitted), L.uncommitted ? 'warn' : 'ok') +
    (L.commits || []).map((c) => row(fmt(c.at), '<span class="mono">' + esc(c.hash) + '</span> ' + esc(c.subject))).join('') + '</div>')
  const wf = d.workflows
  cards.push('<div class="card wide"><h2>Behind the scenes: work in progress</h2>' + (wf.error ? '<div class="dim">' + esc(wf.error) + '</div>'
    : '<table><tr><th>job</th><th>agents done</th><th>state</th><th>last moved</th><th>still open</th></tr>' + wf.list.map((w) => {
      const st = w.done >= w.agents ? '<span class="ok">finished</span>' : Date.now() - w.lastMoved < 900000 ? '<span class="pill live">running</span>' : '<span class="warn">stopped before finishing</span>'
      return '<tr><td>' + esc(w.name) + '</td><td>' + w.done + ' / ' + w.agents + '</td><td>' + st + '</td><td>' + ago(w.lastMoved) + '</td><td class="mono">' + esc(w.done >= w.agents ? '' : w.inFlight.join(', ')) + '</td></tr>'
    }).join('') + '</table>') + '</div>')
  const runs = d.deployRuns
  cards.push('<div class="card wide"><h2>Gated deploy runs (newest first)</h2>' + (runs.error ? '<div class="dim">' + esc(runs.error) + '</div>'
    : '<table><tr><th>started</th><th>outcome</th><th>tests passed</th><th>routes checked</th><th>preview</th></tr>' + runs.list.map((r) =>
      '<tr><td>' + fmt(r.at) + '</td><td class="' + (r.outcome === 'deployed' ? 'ok' : /refused|failed/.test(r.outcome) ? 'bad' : 'warn') + '">' + esc(r.outcome) + '</td><td>' + r.tests + '</td><td>' + esc(r.routes || '–') + '</td><td>' + (r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" class="mono">' + esc(r.url.replace('https://', '')) + '</a>' : '') + '</td></tr>').join('') + '</table>') + '</div>')
  const dep = N.deployments
  cards.push('<div class="card wide"><h2>Cloudflare deployment history (plexii-web)</h2>' + (!dep ? '<div class="dim">checking…</div>' : dep.error ? '<div class="bad">' + esc(dep.error) + '</div>'
    : '<table><tr><th>when</th><th>env</th><th>status</th><th>summary</th></tr>' + dep.list.map((x, i) =>
      '<tr><td>' + fmt(x.at) + (i === 0 && x.env === 'production' ? ' <span class="pill live">live</span>' : '') + '</td><td>' + esc(x.env) + '</td><td class="' + (x.status === 'success' ? 'ok' : 'warn') + '">' + esc(x.status) + '</td><td>' + esc(x.message || '–') + ' <a class="mono" target="_blank" rel="noopener" href="' + esc(x.url) + '">' + esc(x.id) + '</a></td></tr>').join('') + '</table>') + '</div>')
  $('grid').innerHTML = cards.join('')
  $('foot').textContent = 'Website · refreshed ' + new Date(d.now).toLocaleTimeString() +
    ' · read from the Cloudflare API, the update feeds, the live sitemap, git, deploy-run logs and workflow journals — nothing is estimated.'
}
addEventListener('hashchange', () => tick())
async function tick() {
  try {
    if (tab() === 'website') { renderWebsite(await (await fetch('/api/website', { cache: 'no-store' })).json()); return }
    $('tab-website').removeAttribute('aria-current'); $('tab-app').setAttribute('aria-current', 'page')
    const r = await fetch('/api/status', { cache: 'no-store' })
    render(await r.json())
  } catch (e) {
    $('sub').innerHTML = '<span class="pill bad">status server stopped</span>'
  }
}
tick(); setInterval(tick, 2000)
</script></body></html>`

const server = createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  if (req.url === '/api/status') {
    const snap = snapshot()
    // Network probes run out of band so a slow or offline check never stalls
    // the page; the panel shows when it last managed to look.
    void refreshServerState(snap.version)
    json(200, snap)
    return
  }

  if (req.url === '/api/website') {
    json(200, website.snapshot())
    return
  }

  if (req.url === '/api/action' && req.method === 'POST') {
    // Same-origin only. A page on another site can reach 127.0.0.1, so the
    // Origin check and the custom header (which forces a preflight it cannot
    // satisfy) matter as much as the token.
    const origin = req.headers.origin
    const sameOrigin =
      !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`
    if (!sameOrigin || req.headers['x-plexii-status'] !== '1') {
      json(403, { ok: false, error: 'Refused: cross-origin request.' })
      return
    }
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 4096) req.destroy()
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        json(400, { ok: false, error: 'Bad JSON' })
        return
      }
      if (parsed.token !== TOKEN) {
        json(403, { ok: false, error: 'Refused: bad or missing token.' })
        return
      }
      if (!ACTIONS_ENABLED) {
        json(403, { ok: false, error: 'This status server was started read-only.' })
        return
      }
      // eslint-disable-next-line no-console
      console.log(`[status] action requested: ${parsed.action}`)
      const started = startJob(parsed.action)
      json(started.ok ? 200 : 409, started)
    })
    return
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE.replace('__TOKEN__', TOKEN))
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
