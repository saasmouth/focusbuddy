#!/usr/bin/env node
// Drive the REAL site-picture loader (src/main/sitePreviewLoader.ts) in Electron
// against pages whose framing behaviour is known, and check each verdict.
//
//   node scripts/verify-site-pictures.mjs            local cases only (no internet)
//   node scripts/verify-site-pictures.mjs --live URL [URL...]   also report real sites
//
// Unit tests cover the decisions with a fake loader (tests/unit/sitePreviewCore
// .test.ts). What they cannot cover is the hidden window itself: that a framed
// look really is framed (Sec-Fetch-Dest: iframe, the share origin as referrer),
// that the browser's own refusal is heard, and that a picture comes back. This
// does, with a local server standing in for the sites:
//
//   allow           no framing headers                    -> live
//   xfo-deny        X-Frame-Options: DENY                 -> picture
//   fa-none         frame-ancestors 'none'                -> picture
//   frame-only-xfo  X-Frame-Options only when requested AS A FRAME
//                   (a headers-only check of an ordinary visit says "allowed")
//                                                         -> picture
//   referer-403     403 to a request whose referrer is the share page
//                   (anti-hotlinking; an unreferred visit is fine)
//                                                         -> picture
//   bot-401         401 everywhere (a bot wall)           -> link
//   challenge       200, titled "Just a moment..."        -> live is refused? no:
//                   framed fine, but a picture of a challenge is no picture
//                                                         -> live (framing allowed)
//
// Exits non-zero if any local case comes out differently.
import { build } from 'esbuild'
import { spawn } from 'child_process'
import { createServer } from 'http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const live = process.argv.includes('--live') ? process.argv.slice(process.argv.indexOf('--live') + 1) : []
const EMBEDDER = 'https://plexiidesk.com'

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body style="font:24px sans-serif;background:#e8f0ff"><h1>${title}</h1><p>${body}</p></body></html>`

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const dest = req.headers['sec-fetch-dest']
  const referer = req.headers.referer ?? ''
  const send = (status, headers, html) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(html)
  }
  if (path === '/allow') return send(200, {}, page('Allowed page', 'Frame me.'))
  if (path === '/xfo-deny') return send(200, { 'x-frame-options': 'DENY' }, page('Denied page', 'Never framed.'))
  if (path === '/fa-none') return send(200, { 'content-security-policy': "frame-ancestors 'none'" }, page('No ancestors', 'Never framed.'))
  if (path === '/frame-only-xfo')
    return send(200, dest === 'iframe' ? { 'x-frame-options': 'SAMEORIGIN' } : {}, page('Frame-only refusal', `dest=${dest}`))
  if (path === '/referer-403')
    return referer.startsWith(EMBEDDER) ? send(403, {}, page('Forbidden', 'Hotlink')) : send(200, {}, page('Referer page', 'Fine on its own.'))
  if (path === '/bot-401') return send(401, {}, page('Verifying the device...', 'Bot wall'))
  if (path === '/challenge') return send(200, {}, page('Just a moment...', 'Checking your browser'))
  send(404, {}, page('Not found', path))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const CASES = [
  ['allow', 'live', true],
  ['xfo-deny', 'picture', true],
  ['fa-none', 'picture', true],
  ['frame-only-xfo', 'picture', true],
  ['referer-403', 'picture', true],
  ['bot-401', 'link', false],
  ['challenge', 'live', false]
]

const dir = mkdtempSync(join(tmpdir(), 'site-pictures-'))
try {
  // The loader and its decisions, bundled for Electron's main process.
  await build({
    stdin: {
      contents: `
        export { electronPageLoader } from ${JSON.stringify(join(root, 'src/main/sitePreviewLoader.ts'))}
        export { createSitePreviewer, decideShow, availableShows } from ${JSON.stringify(join(root, 'src/main/sitePreviewCore.ts'))}
      `,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    alias: { '@shared': join(root, 'src/shared') },
    outfile: join(dir, 'loader.cjs'),
    logLevel: 'warning'
  })
  const targets = [...CASES.map(([name]) => `${base}/${name}`), ...live]
  writeFileSync(
    join(dir, 'main.cjs'),
    `
    const { app } = require('electron')
    const { electronPageLoader, createSitePreviewer, decideShow, availableShows } = require('./loader.cjs')
    const fs = require('fs')
    app.whenReady().then(async () => {
      const p = createSitePreviewer(electronPageLoader, { concurrency: 3 })
      const urls = ${JSON.stringify(targets)}
      const out = await Promise.all(urls.map(async (url) => {
        const t0 = Date.now()
        const c = await p.check(url, { width: 1280, height: 800 }, ${JSON.stringify(EMBEDDER)})
        return { url, framing: c.framing, show: decideShow('auto', c), options: availableShows(c), refusal: c.refusal,
                 pictureBytes: c.picture ? c.picture.bytes.byteLength : 0, ms: Date.now() - t0 }
      }))
      fs.writeFileSync(${JSON.stringify(join(dir, 'out.json'))}, JSON.stringify(out, null, 1))
      app.quit()
    })
    app.on('window-all-closed', () => {})
    `
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = join(root, 'node_modules/.bin/electron')
  const code = await new Promise((r) => {
    const child = spawn(electron, [join(dir, 'main.cjs')], { env, stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('exit', r)
  })
  if (code !== 0) throw new Error(`electron exited ${code}`)
  const results = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))
  let bad = 0
  for (const r of results) {
    const name = r.url.startsWith(base) ? r.url.slice(base.length + 1) : r.url
    const expected = CASES.find(([n]) => r.url === `${base}/${n}`)
    const verdict = expected
      ? expected[1] === r.show && (expected[2] ? r.pictureBytes > 0 : true)
        ? 'ok  '
        : 'FAIL'
      : 'live'
    if (verdict === 'FAIL') bad++
    console.log(
      `${verdict} ${name.padEnd(expected ? 16 : 60)} shows=${r.show.padEnd(7)} framing=${r.framing.padEnd(7)} picture=${String(r.pictureBytes).padStart(7)}B ${r.ms}ms${r.refusal ? `  (${r.refusal})` : ''}${expected && verdict === 'FAIL' ? `  expected ${expected[1]}${expected[2] ? ' with a picture' : ''}` : ''}`
    )
  }
  console.log(bad ? `\n${bad} case(s) did not come out as expected.` : `\nAll ${CASES.length} local cases came out as expected.`)
  process.exitCode = bad ? 1 : 0
} finally {
  server.close()
  rmSync(dir, { recursive: true, force: true })
}
