#!/usr/bin/env node
// Check every browser widget URL in the persona specs against the live web.
//
// A demo browser must open a real public page as it is, on first load, for a
// visitor with an empty cookie jar — which is exactly the state a prospect's (or
// the screenshot harness's) PlexiDesk is in. So a URL passes only when it:
//   - answers 200 text/html with no redirect (the widget rewrites its own content
//     and title to wherever a redirect lands, so the stored URL must be final),
//   - is not a bot challenge, consent wall or sign-in page, and is not served
//     through Cloudflare (which can challenge the in-app browser even when a
//     plain fetch gets the page),
//   - has a <title>, which is recorded so a reviewer can judge it is on topic.
//
// Results are written per persona to checks/<persona>.urls.json (url → status,
// page title, checkedAt), so runs for different personas never collide.
//
// Usage: node scripts/persona-demos/verify-urls.cjs [personas/NN-x.json …]

const fs = require('node:fs')
const { join } = require('node:path')
const { loadSpecs } = require('./seed.cjs')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const CHALLENGE =
  /just a moment|attention required|cf-chl|cf_chl|challenge-platform|captcha|are you a robot|verify you are (a )?human|access denied|request blocked|enable javascript and cookies to continue|unusual traffic/i
const WALL = /^(sign in|log in|login|sign up|create an account)\b|\b(sign in|log in) to (continue|view)\b/i
const CHECKS = join(__dirname, 'checks')

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

async function check(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 25_000)
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-AU,en;q=0.9' }
    })
    const type = res.headers.get('content-type') ?? ''
    // Cloudflare can answer a plain fetch with the real page and still put a
    // "Just a moment…" challenge in front of the app's embedded browser (seen on
    // datatracker.ietf.org in the harness). The challenge then renames the widget
    // after itself. A demo desk cannot take that chance, so these are refused.
    if (res.headers.get('cf-ray') || /cloudflare/i.test(res.headers.get('server') ?? ''))
      return { ok: false, status: res.status, reason: 'served through Cloudflare, which can put a bot challenge in front of the in-app browser — pick a page not behind Cloudflare' }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? ''
      let to = loc
      try {
        to = new URL(loc, url).toString()
      } catch {}
      return { ok: false, status: res.status, reason: `redirects to ${to} — store that URL instead` }
    }
    if (res.status !== 200) return { ok: false, status: res.status, reason: `HTTP ${res.status}` }
    if (!/text\/html/i.test(type)) return { ok: false, status: 200, reason: `content-type ${type || 'missing'}, not a page` }
    const html = (await res.text()).slice(0, 400_000)
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    if (!title) return { ok: false, status: 200, reason: 'page has no <title>' }
    if (CHALLENGE.test(title) || (CHALLENGE.test(html.slice(0, 20_000)) && html.length < 60_000))
      return { ok: false, status: 200, title, reason: 'bot challenge / block page' }
    if (WALL.test(title)) return { ok: false, status: 200, title, reason: 'sign-in wall' }
    return { ok: true, status: 200, title, bytes: html.length }
  } catch (e) {
    return { ok: false, status: 0, reason: e.name === 'AbortError' ? 'timed out after 25s' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.json'))
  const { specs } = loadSpecs(files)
  const jobs = []
  for (const s of specs)
    s.desks.forEach((d, di) => (d.browsers ?? []).forEach((b, bi) => jobs.push({ file: s.__file, where: `desks[${di}].browsers[${bi}]`, title: b.title, url: b.url })))
  const store = {}
  let failed = 0
  // Gentle: a few at a time, so no site sees a burst.
  for (let i = 0; i < jobs.length; i += 4) {
    const batch = jobs.slice(i, i + 4)
    const results = await Promise.all(batch.map((j) => check(j.url)))
    batch.forEach((j, k) => {
      const r = results[k]
      ;(store[j.file] ??= {})[j.url] = { ...r, where: j.where, widgetTitle: j.title, checkedAt: new Date().toISOString() }
      if (r.ok) console.log(`  ✓ ${j.file} ${j.where}  ${j.url}\n      page title: ${r.title}`)
      else {
        failed++
        console.log(`  ✗ ${j.file} ${j.where}  ${j.url}\n      ${r.reason}${r.title ? ` (title: ${r.title})` : ''}`)
      }
    })
  }
  fs.mkdirSync(CHECKS, { recursive: true })
  for (const [file, urls] of Object.entries(store))
    fs.writeFileSync(join(CHECKS, file.replace(/\.json$/, '.urls.json')), JSON.stringify(urls, null, 2) + '\n')
  if (failed) {
    console.error(`✗ ${failed} of ${jobs.length} URL(s) failed`)
    process.exit(1)
  }
  console.log(`✓ ${jobs.length} URL(s) verified`)
}

main()
