import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The status dashboard's page is built by string concatenation inside a
// template literal, which is a shape that breaks in ways `node --check` on the
// server file cannot see: it twice shipped a page whose inline script did not
// parse, because an escape collapsed on its way through the template. A blank
// dashboard is worse than no dashboard, so the page is rendered here against a
// realistic snapshot and asserted.

const SERVER = join(__dirname, '..', '..', 'scripts', 'status-server.mjs')

/** The PAGE template literal, with the token placeholder already filled. */
function pageHtml(): string {
  const src = readFileSync(SERVER, 'utf8')
  const start = src.indexOf('const PAGE = `')
  expect(start, 'PAGE template not found').toBeGreaterThan(-1)
  const open = src.indexOf('`', start)
  // The template contains no backticks of its own; it ends at the next one.
  const end = src.indexOf('`', open + 1)
  const raw = src.slice(open + 1, end)
  // Evaluate the template the way the server does, so escapes resolve
  // identically to what is actually served.
  // eslint-disable-next-line no-new-func
  const evaluated = new Function('return `' + raw.replace(/\\/g, '\\\\') + '`')() as string
  return evaluated.replace('__TOKEN__', 'test-token')
}

const SNAPSHOT = {
  now: Date.now(),
  root: '/repo',
  version: '4.3.28',
  git: {
    branch: '4.3.26b',
    head: 'abc1234 a commit',
    headAt: Date.now() - 60_000,
    dirty: 0,
    untracked: 2,
    ahead: '4',
    behind: '0',
    upstream: null,
    comparedTo: 'main'
  },
  artifacts: [
    { name: 'PlexiDesk-4.3.28-mac-universal.dmg', bytes: 394_000_000, at: Date.now() - 300_000 },
    { name: 'PlexiDesk-4.3.28-mac-universal.zip', bytes: 381_000_000, at: Date.now() - 280_000 }
  ],
  installed: {
    name: 'PlexiDesk 4.3.28.app',
    version: '4.3.28',
    builtAt: Date.now() - 400_000,
    gatekeeper: 'accepted',
    archs: 'x86_64 arm64',
    others: []
  },
  build: {
    log: 'build-28.log',
    at: Date.now() - 100_000,
    bytes: 1234,
    tail: ['• notarization successful'],
    stages: [
      { id: 'renderer', label: 'Compiling renderer + main', done: true },
      { id: 'package', label: 'Packaging', done: true },
      { id: 'sign', label: 'Code signing (Developer ID)', done: true },
      { id: 'notarize', label: 'Notarising with Apple', done: true, started: true },
      { id: 'artifacts', label: 'Writing dmg + zip', done: true },
      { id: 'install', label: 'Installing to /Applications', done: true }
    ],
    refused: [],
    errors: []
  },
  tests: { unit: { failed: 0, passed: 7201, at: Date.now(), log: 'u6.log' }, e2e: null },
  activity: { build: false, notarize: false, tests: false, app: false },
  logDirs: ['/repo/release'],
  server: {
    tag: 'v4.3.28',
    github: { exists: false, draft: null, assets: 0 },
    macFeed: '4.3.26',
    winFeed: '4.3.22',
    reachable: true
  },
  serverCheckedAt: Date.now(),
  actionsEnabled: true,
  jobs: [],
  busyJob: null
}

let body = ''

beforeAll(async () => {
  const html = pageHtml()
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '')
  // The page polls /api/status; serve it the snapshot above.
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    ({ json: async () => SNAPSHOT }) as unknown as Response
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  expect(script.length, 'inline script missing').toBeGreaterThan(500)
  // Throws on a syntax error, which is the failure that shipped twice.
  // eslint-disable-next-line no-new-func
  new Function(script)()
  await new Promise((r) => setTimeout(r, 30))
  body = document.body.innerHTML
})

describe('the page actually renders', () => {
  it('its inline script parses and runs', () => {
    expect(body.length).toBeGreaterThan(400)
  })

  it('renders the ready-build header with the real version', () => {
    expect(body).toContain('Ready build')
    expect(body).toContain('4.3.28')
  })
})

describe('the three targets are reported independently', () => {
  it('lists Local, Git and Server as separate rows', () => {
    for (const target of ['Local', 'Git', 'Server']) {
      expect(body, `${target} row`).toContain(target)
    }
  })

  it('says the local install is done, because that version IS installed', () => {
    expect(body).toContain('installed')
  })

  it('says git is NOT pushed, because the branch has no upstream', () => {
    expect(body).toContain('unpushed')
  })

  it('says the server is NOT published, and names what the feed still serves', () => {
    // The feed being behind is the fact that matters; "published" as a single
    // light would have hidden it.
    expect(body).toContain('4.3.26')
  })

  it('reports the Windows feed separately rather than implying it moved', () => {
    expect(body).toContain('4.3.22')
  })
})

describe('the buttons', () => {
  it('renders one per target plus the two batch actions', () => {
    for (const a of ['install-local', 'git-push', 'server-publish', 'all', 'build-install']) {
      expect(body, `${a} button`).toContain('data-action="' + a + '"')
    }
  })

  it('disables Publish while the branch is unpushed', () => {
    // A release whose source is not in git cannot be rebuilt from its own tag.
    const m = body.match(/data-action="server-publish"[^>]*/)
    expect(m, 'publish button').toBeTruthy()
    expect(m![0]).toContain('disabled')
  })

  it('uses delegation rather than inline handlers', () => {
    // The nested quoting an inline onclick needs is exactly what collapsed.
    expect(body).not.toContain('onclick=')
  })
})
