// The Website tab of the status page: where plexiidesk.com work stands, read
// from real sources only, in the same spirit as status-server.mjs. Nothing is
// estimated; anything that cannot be read says so.
//
//   Live          Cloudflare Pages deployments of project plexii-web (API),
//                 the update feeds on dl.plexiidesk.com, the live sitemap.
//   This machine  pages on disk per section, uncommitted site files, the last
//                 site commits (git), the gated deploy runs (their log files).
//   Behind it     workflow runs (their journal files): agents started, done,
//                 failed, and when each last moved.
//
// The Cloudflare token is read from focusbuddy/.env on the server side and is
// never sent to the page. Network reads are cached and refreshed out of band.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const ACCOUNT = '082d6c67fde32e9820cde09d444c1dbc'
const PROJECT = 'plexii-web'

export function websiteMonitor({ appRoot, deployRunsDir, workflowsGlobRoot }) {
  const projects = join(appRoot, '..')
  const site = join(projects, 'plexii-site')
  const cache = { value: null, at: 0, pending: false }

  const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
  const mtime = (p) => { try { return statSync(p).mtimeMs } catch { return null } }
  const ls = (d) => { try { return readdirSync(d) } catch { return null } }
  const git = (args) => {
    try { return execFileSync('git', args, { cwd: projects, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() } catch { return null }
  }
  const token = () => {
    const env = read(join(appRoot, '.env')) || ''
    const m = /^CLOUDFLARE_API_TOKEN=(.*)$/m.exec(env)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
  }
  const fetchText = async (url, headers = {}) => {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      return r.ok ? await r.text() : null
    } catch { return null }
  }

  async function deployments() {
    const t = token()
    if (!t) return { error: 'no Cloudflare token in focusbuddy/.env' }
    const body = await fetchText(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/${PROJECT}/deployments?per_page=25`,
      { authorization: `Bearer ${t}` })
    if (!body) return { error: 'Cloudflare API did not answer' }
    try {
      const d = JSON.parse(body)
      if (!d.success) return { error: 'Cloudflare API refused: ' + JSON.stringify(d.errors).slice(0, 160) }
      return {
        list: d.result.map((x) => ({
          at: Date.parse(x.created_on),
          id: x.short_id,
          env: x.environment,
          url: x.url,
          message: (x.deployment_trigger?.metadata?.commit_message || '').split('\n')[0].slice(0, 140),
          status: x.latest_stage?.status || 'unknown'
        }))
      }
    } catch { return { error: 'unreadable Cloudflare response' } }
  }

  async function live() {
    const [mac, win, sitemap] = await Promise.all([
      fetchText('https://dl.plexiidesk.com/latest-mac.yml'),
      fetchText('https://dl.plexiidesk.com/latest.yml'),
      fetchText('https://plexiidesk.com/sitemap.xml')
    ])
    const ver = (y) => (y && /^version:\s*(\S+)/m.exec(y)?.[1]) || null
    let sections = null
    if (sitemap) {
      sections = {}
      for (const [, path] of sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)) {
        const s = (/^\/(help|blog|tools|templates|glossary|widgets)\b/.exec(path) || [, 'other pages'])[1]
        sections[s] = (sections[s] || 0) + 1
      }
    }
    return { feedMac: ver(mac), feedWin: ver(win), sitemap: sections }
  }

  async function refresh() {
    if (cache.pending || Date.now() - cache.at < 60_000) return
    cache.pending = true
    try {
      const [dep, lv] = await Promise.all([deployments(), live()])
      cache.value = { deployments: dep, live: lv }
      cache.at = Date.now()
    } finally { cache.pending = false }
  }

  function local() {
    const count = (d, f = () => true) => { const x = ls(d); return x === null ? null : x.filter(f).length }
    const release = read(join(projects, 'haptyx-web/src/lib/release.ts')) || ''
    const status = git(['status', '--porcelain', '--', 'plexii-site', 'haptyx-web'])
    const commits = git(['log', '-8', '--format=%ct%x09%h%x09%s', '--', 'plexii-site', 'haptyx-web'])
    return {
      siteMac: /APP_VERSION = '([^']+)'/.exec(release)?.[1] || null,
      siteWin: /WIN_VERSION = '([^']+)'/.exec(release)?.[1] || null,
      onDisk: {
        'help articles': count(join(site, 'help/articles'), (f) => f.endsWith('.md')),
        'help planned': (() => { try { const t = JSON.parse(read(join(site, 'help/taxonomy.json'))); return t.categories.reduce((n, c) => n + c.subcategories.reduce((m, s) => m + s.articles.length, 0), 0) } catch { return null } })(),
        'blog posts': count(join(site, 'blog/posts'), (f) => f.endsWith('.md')),
        tools: count(join(site, 'tools'), (f) => !f.startsWith('.')),
        templates: count(join(site, 'templates'), (f) => f.endsWith('.md')),
        'glossary terms': count(join(site, 'glossary'), (f) => f.endsWith('.md'))
      },
      uncommitted: status === null ? null : status.split('\n').filter(Boolean).length,
      commits: commits === null ? null : commits.split('\n').filter(Boolean).map((l) => {
        const [t, h, s] = l.split('\t'); return { at: Number(t) * 1000, hash: h, subject: s }
      })
    }
  }

  // One row per gated deploy run: which gates it passed, and what it shipped.
  function deployRuns() {
    if (!deployRunsDir || !existsSync(deployRunsDir)) return { error: 'no deploy run logs found' }
    const runs = (ls(deployRunsDir) || []).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort().reverse().slice(0, 20)
    return {
      list: runs.map((n) => {
        const dir = join(deployRunsDir, n)
        const files = ls(dir) || []
        const has = (f) => files.includes(f)
        const tests = files.filter((f) => f.endsWith('_test.log')).length
        const deploy = read(join(dir, 'deploy.log')) || ''
        const routes = read(join(dir, 'routes.log')) || ''
        const trust = read(join(dir, 'trust.log')) || ''
        const at = Date.parse(n.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))
        let outcome
        if (/Deployment complete/.test(deploy)) outcome = 'deployed'
        else if (has('deploy.log')) outcome = 'deploy failed'
        else if (/^HIT /m.test(trust)) outcome = 'refused: trust scan'
        else if (/^BAD /m.test(routes)) outcome = 'refused: routes'
        else if (has('routes.log') || has('trust.log')) outcome = 'stopped at checks'
        else if (tests) outcome = 'stopped at tests'
        else if (has('compose.log')) outcome = 'stopped at compose'
        else outcome = 'no logs'
        return {
          at, outcome, tests,
          routes: /checked (\d+) routes/.exec(routes)?.[1] || null,
          url: /https:\/\/[a-z0-9]+\.plexii-web\.pages\.dev/.exec(deploy)?.[0] || null,
          lastWrite: Math.max(...files.map((f) => mtime(join(dir, f)) || 0), 0) || null
        }
      })
    }
  }

  // Workflow runs this machine's Claude sessions started: from their journals.
  function workflows() {
    const root = workflowsGlobRoot
    if (!root || !existsSync(root)) return { error: 'no workflow journals found' }
    const out = []
    for (const session of ls(root) || []) {
      const wfDir = join(root, session, 'subagents/workflows')
      const scriptsDir = join(root, session, 'workflows/scripts')
      const scripts = ls(scriptsDir) || []
      for (const run of ls(wfDir) || []) {
        const j = join(wfDir, run, 'journal.jsonl')
        const m = mtime(j)
        if (!m || Date.now() - m > 14 * 86400_000) continue
        const started = new Map(); const done = new Set(); const failed = new Set()
        for (const line of (read(j) || '').split('\n')) {
          let e; try { e = JSON.parse(line) } catch { continue }
          if (e.type === 'started') started.set(e.agentId, e.label)
          else if (e.type === 'result') done.add(e.agentId)
          else if (e.type === 'error' || e.type === 'failed') failed.add(e.agentId)
        }
        const labels = new Set(started.values())
        const doneLabels = new Set([...done].map((a) => started.get(a)).filter(Boolean))
        const script = scripts.find((s) => s.endsWith(run + '.js'))
        out.push({
          run,
          name: script ? basename(script, '.js').replace('-' + run, '') : run,
          agents: labels.size,
          done: [...labels].filter((l) => doneLabels.has(l)).length,
          inFlight: [...labels].filter((l) => !doneLabels.has(l)).slice(0, 8),
          lastMoved: m
        })
      }
    }
    return { list: out.sort((a, b) => b.lastMoved - a.lastMoved).slice(0, 12) }
  }

  return {
    snapshot() {
      void refresh()
      return { now: Date.now(), net: cache.value, netCheckedAt: cache.at || null, local: local(), deployRuns: deployRuns(), workflows: workflows() }
    }
  }
}

// Where Claude Code keeps this project's sessions, for the workflow journals.
export function defaultWorkflowsRoot() {
  const base = join(homedir(), '.claude/projects')
  const dir = (ls2(base) || []).find((d) => d.includes('Agentic-Starter-Kit'))
  return dir ? join(base, dir) : null
}
function ls2(d) { try { return readdirSync(d) } catch { return null } }
