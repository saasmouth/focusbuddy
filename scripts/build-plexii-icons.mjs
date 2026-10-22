#!/usr/bin/env node
// Builds the Plexii entity icon set the renderer ships (apps, work widgets,
// tools, connected apps) from the owner-supplied source folder.
//
//   node scripts/build-plexii-icons.mjs [--source <dir>] [--strict-truncated] [--check]
//
// Source: "Plexii-Icons-SVG-PNG" (Asset-Index.csv + <Category>/<Name>/<Name>--Icon|Logo.png|svg).
// Default location is marketing/brand-assets/Plexii-Icons-SVG-PNG in the MAIN
// checkout (found through git's common dir, so it also works from a worktree;
// marketing/ is gitignored and lives only there). Override with --source <dir>
// or $PLEXII_ICON_SOURCE. The source folder is read-only to this script;
// marketing/brand-assets/KNOWN-ISSUES.txt lists the known-bad files.
//
// Output (committed):
//   src/renderer/src/assets/plexii-icons/<category>/<slug>.<size>.webp   (32, 64, 128)
//   src/renderer/src/lib/plexiiIconAssets.generated.ts                    (slug -> URLs)
//
// What it does to each asset, by kind:
//   tile  (the 1254px rounded-square colour tiles, "Embedded original PNG")
//         The transparent margin carries speckle/fringe artifacts. Keep only the
//         largest connected opaque component (the tile) plus its holes, grow it
//         by 2px so the tile's own anti-aliased edge survives, zero every other
//         pixel, crop to the tile, centre it on a square, then downsample with
//         lanczos3 (premultiplied), which is what anti-aliases the final edge.
//   glyph (true-vector SVG line/fill glyphs in the owner's #c4b5fd)
//         Rendered from the SVG itself at each size, never from the 512px PNG.
//         The renderer uses these as an alpha MASK coloured by a per-theme token,
//         so the light theme gets a legible violet without a recoloured file.
//   logo  (Connected-Apps third-party marks) — resized only. Never cleaned,
//         recoloured or cropped: a brand mark is kept exactly as supplied. The
//         rounded tile look is a CSS mask in the component, not baked in.
//
// Unreadable PNGs (truncated exports): the matching SVG is used when it is a true
// vector. When it is an "Embedded original PNG" SVG, the embedded PNG is used
// ONLY if the truncated .png file is a byte-exact prefix of it — proof that it is
// the very file the broken copy was cut from, not a look-alike — and it decodes.
// Those are reported as "recovered" and still need a re-export of the .png.
// --strict-truncated turns recovery off: the item is then omitted and the app
// keeps its current icon for it. Nothing is ever approximated.
//
// --check rebuilds into a temp dir and fails if the committed output differs
// (stale assets or a hand-edited index).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync, mkdtempSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let sharp
try {
  // sharp arrives with @xenova/transformers; the build does not need its own copy.
  sharp = require('sharp')
} catch {
  console.error('build-plexii-icons: sharp is not installed (it ships with @xenova/transformers). Run npm install.')
  process.exit(1)
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const OUT_ASSETS_REL = 'src/renderer/src/assets/plexii-icons'
const OUT_INDEX_REL = 'src/renderer/src/lib/plexiiIconAssets.generated.ts'
const SIZES = [32, 64, 128]

/** Source category folder -> output category. Brand is not an entity icon. */
const CATEGORY = {
  Apps: 'apps',
  Tools: 'tools',
  'Work-Widgets': 'widgets',
  'Connected-Apps': 'connected'
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function defaultSource() {
  if (process.env.PLEXII_ICON_SOURCE) return process.env.PLEXII_ICON_SOURCE
  let repo = ROOT
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd: ROOT, encoding: 'utf8' }).trim()
    repo = dirname(common)
  } catch {
    /* not a git checkout: fall back to this tree */
  }
  return resolve(repo, 'marketing', 'brand-assets', 'Plexii-Icons-SVG-PNG')
}

const SOURCE = resolve(opt('--source') ?? defaultSource())
const STRICT = flag('--strict-truncated')
const CHECK = flag('--check')

// ── CSV ──────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

/** Folder name -> slug: lower-case, spaces/underscores to hyphens. */
export const slugOf = (folder) => folder.toLowerCase().replace(/[\s_]+/g, '-')

// ── Tile cleaning ────────────────────────────────────────────────────────────

/**
 * Keep the largest connected opaque component (with its holes) grown by `grow`
 * px; zero everything else. Returns the cleaned RGBA buffer and the kept bbox.
 */
function cleanTile(data, W, H, grow = 2) {
  const N = W * H
  const core = new Uint8Array(N)
  for (let i = 0; i < N; i++) core[i] = data[i * 4 + 3] >= 128 ? 1 : 0

  // Largest 8-connected component of the core.
  const label = new Int32Array(N)
  const queue = new Int32Array(N)
  let best = 0
  let bestSize = 0
  let next = 0
  for (let s = 0; s < N; s++) {
    if (!core[s] || label[s]) continue
    next++
    let head = 0
    let tail = 0
    queue[tail++] = s
    label[s] = next
    while (head < tail) {
      const p = queue[head++]
      const x = p % W
      const y = (p - x) / W
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const q = yy * W + xx
          if (core[q] && !label[q]) {
            label[q] = next
            queue[tail++] = q
          }
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail
      best = next
    }
  }
  if (!best) throw new Error('no opaque component')

  // Region = component plus its holes: flood the outside (4-connected) from the
  // border through everything that is not the component; whatever the flood
  // cannot reach is enclosed by the tile.
  const outside = new Uint8Array(N)
  let head = 0
  let tail = 0
  const seed = (p) => {
    if (!outside[p] && label[p] !== best) {
      outside[p] = 1
      queue[tail++] = p
    }
  }
  for (let x = 0; x < W; x++) {
    seed(x)
    seed((H - 1) * W + x)
  }
  for (let y = 0; y < H; y++) {
    seed(y * W)
    seed(y * W + W - 1)
  }
  while (head < tail) {
    const p = queue[head++]
    const x = p % W
    const y = (p - x) / W
    if (x > 0) seed(p - 1)
    if (x < W - 1) seed(p + 1)
    if (y > 0) seed(p - W)
    if (y < H - 1) seed(p + W)
  }
  let region = new Uint8Array(N)
  for (let i = 0; i < N; i++) region[i] = outside[i] ? 0 : 1

  // Grow by `grow` px (8-neighbour dilation per step) to keep the AA edge.
  for (let step = 0; step < grow; step++) {
    const grown = region.slice()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (region[y * W + x]) continue
        let hit = 0
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx >= 0 && xx < W && region[yy * W + xx]) {
              hit = 1
              break
            }
          }
        }
        if (hit) grown[y * W + x] = 1
      }
    }
    region = grown
  }

  const out = Buffer.from(data)
  let minX = W
  let minY = H
  let maxX = -1
  let maxY = -1
  let zeroed = 0
  for (let i = 0; i < N; i++) {
    if (!region[i] || out[i * 4 + 3] === 0) {
      if (out[i * 4 + 3] !== 0) zeroed++
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4 + 3] = 0
      continue
    }
    const x = i % W
    const y = (i - x) / W
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { data: out, bbox: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, zeroed }
}

/**
 * Speckle check on a finished RGBA image: a pixel with alpha that has no pixel
 * of real coverage (alpha >= 64) among its 8 neighbours is a stray. Edge
 * anti-aliasing always sits next to coverage; specks and the faint halo a
 * lanczos downscale rings out past the edge do not.
 */
function strayPixels(data, W, H, zero = false) {
  let strays = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] === 0) continue
      let covered = false
      for (let dy = -1; dy <= 1 && !covered; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && data[(yy * W + xx) * 4 + 3] >= 64) {
            covered = true
            break
          }
        }
      }
      if (!covered) {
        strays++
        if (zero) data[(y * W + x) * 4] = data[(y * W + x) * 4 + 1] = data[(y * W + x) * 4 + 2] = data[(y * W + x) * 4 + 3] = 0
      }
    }
  }
  return strays
}

// ── Source loading ───────────────────────────────────────────────────────────

async function decodes(buf) {
  try {
    await sharp(buf).raw().toBuffer()
    return true
  } catch {
    return false
  }
}

/** Resolve the best usable source for an item, or why there is none. */
async function loadSource(item) {
  const png = item.png ? readFileSync(join(SOURCE, item.png)) : null
  const svgText = item.svg ? readFileSync(join(SOURCE, item.svg), 'utf8') : null
  const svgType = item.svgType

  if (svgType === 'True vector' && svgText) {
    return { kind: 'svg', buf: Buffer.from(svgText), note: 'true vector' }
  }
  if (png && (await decodes(png))) return { kind: 'png', buf: png, note: 'png' }

  // The PNG is unreadable.
  const problem = `PNG unreadable (${png ? png.length : 0} bytes, truncated)`
  if (svgText && svgType !== 'True vector') {
    const m = svgText.match(/xlink:href="data:image\/png;base64,([^"]+)"|href="data:image\/png;base64,([^"]+)"/)
    const embedded = m ? Buffer.from(m[1] ?? m[2], 'base64') : null
    const isPrefix = !!(embedded && png && png.length > 0 && embedded.length > png.length && embedded.subarray(0, png.length).equals(png))
    if (embedded && isPrefix && (await decodes(embedded))) {
      if (STRICT) return { kind: 'none', problem, recoverable: true }
      return {
        kind: 'png',
        buf: embedded,
        note: 'recovered from the SVG-embedded original (truncated .png is a byte-exact prefix of it)',
        recovered: true,
        problem
      }
    }
    return { kind: 'none', problem: `${problem}; SVG is not a true vector and its embedded PNG is not provably the same file` }
  }
  return { kind: 'none', problem }
}

// ── Build ────────────────────────────────────────────────────────────────────

async function encode(pipeline, style) {
  if (style === 'glyph') return pipeline.webp({ lossless: true, effort: 6 }).toBuffer()
  if (style === 'logo') return pipeline.webp({ quality: 92, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer()
  return pipeline.webp({ quality: 88, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer()
}

async function buildItem(item, outDir) {
  const src = await loadSource(item)
  if (src.kind === 'none') return { ...item, missing: true, problem: src.problem, recoverable: !!src.recoverable }

  const style = item.category === 'connected' ? 'logo' : src.kind === 'svg' ? 'glyph' : 'tile'
  let master // { input, raw?, srcSize }
  let cleanInfo = null
  if (style === 'glyph') {
    master = { srcSize: Infinity }
  } else {
    const { data, info } = await sharp(src.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    if (style === 'tile' && info.width >= 256) {
      const cleaned = cleanTile(data, info.width, info.height)
      const side = Math.max(cleaned.bbox.width, cleaned.bbox.height)
      const cropped = await sharp(cleaned.data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .extract(cleaned.bbox)
        .raw()
        .toBuffer()
      const padX = side - cleaned.bbox.width
      const padY = side - cleaned.bbox.height
      const squared = await sharp(cropped, { raw: { width: cleaned.bbox.width, height: cleaned.bbox.height, channels: 4 } })
        .extend({
          left: Math.floor(padX / 2),
          right: Math.ceil(padX / 2),
          top: Math.floor(padY / 2),
          bottom: Math.ceil(padY / 2),
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .raw()
        .toBuffer()
      master = { raw: squared, w: side, h: side, srcSize: side }
      cleanInfo = { zeroedPixels: cleaned.zeroed, tileBox: `${cleaned.bbox.width}x${cleaned.bbox.height}` }
    } else {
      // Small raster tiles (the 64px Google marks) and every connected-app logo:
      // resized only.
      master = { raw: data, w: info.width, h: info.height, srcSize: Math.min(info.width, info.height) }
    }
  }

  const sizes = {}
  const checks = {}
  mkdirSync(join(outDir, item.category), { recursive: true })
  for (const size of SIZES) {
    // Never upscale a raster: a 64px source does not get a fake 128px file.
    if (size > master.srcSize) continue
    let pipeline
    if (style === 'glyph') {
      const density = Math.max(72, Math.ceil((72 * size) / item.svgViewBox) * 2)
      pipeline = sharp(src.buf, { density }).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    } else {
      pipeline = sharp(master.raw, { raw: { width: master.w, height: master.h, channels: 4 } }).resize(size, size, {
        fit: 'contain',
        kernel: 'lanczos3',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
    }
    if (style === 'tile') {
      // lanczos3 rings: a downscaled edge leaves alpha 1-3 specks a few px out.
      // Same rule as the check below, applied before encoding.
      const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })
      strayPixels(data, info.width, info.height, true)
      pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    }
    const buf = await encode(pipeline, style)
    const file = `${item.slug}.${size}.webp`
    writeFileSync(join(outDir, item.category, file), buf)
    sizes[size] = { file, bytes: buf.length }
    if (style === 'tile') {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      checks[size] = strayPixels(data, info.width, info.height)
    }
  }
  return { ...item, style, sizes, source: src.note, recovered: !!src.recovered, problem: src.problem, clean: cleanInfo, strays: checks }
}

function svgViewBoxWidth(svgText) {
  const m = svgText.match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/)
  if (m) return Math.max(Number(m[1]), Number(m[2]))
  const w = svgText.match(/width="([\d.]+)"/)
  return w ? Number(w[1]) : 24
}

function collectItems() {
  const csvPath = join(SOURCE, 'Asset-Index.csv')
  if (!existsSync(csvPath)) {
    console.error(`build-plexii-icons: no Asset-Index.csv in ${SOURCE}. Pass --source <dir> or set PLEXII_ICON_SOURCE.`)
    process.exit(1)
  }
  const rows = parseCsv(readFileSync(csvPath, 'utf8'))
  const byKey = new Map()
  for (const r of rows) {
    const category = CATEGORY[r.category]
    if (!category) continue
    const folder = r.file.split('/')[1]
    const key = `${category}/${slugOf(folder)}`
    const item = byKey.get(key) ?? { key, category, slug: slugOf(folder), title: r.name, folder }
    if (r.format === 'PNG') item.png = r.file
    if (r.format === 'SVG') {
      item.svg = r.file
      item.svgType = r.svg_type
    }
    byKey.set(key, item)
  }
  for (const item of byKey.values()) {
    if (item.svg) item.svgViewBox = svgViewBoxWidth(readFileSync(join(SOURCE, item.svg), 'utf8'))
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function ident(key, size) {
  return `${key.replace(/[^a-z0-9]+/gi, '_')}_${size}`
}

function writeIndex(results, indexPath, assetsDir) {
  const built = results.filter((r) => !r.missing)
  const missing = results.filter((r) => r.missing)
  const rel = relative(dirname(indexPath), assetsDir).split('\\').join('/')
  const lines = []
  lines.push('// GENERATED by scripts/build-plexii-icons.mjs from the owner-supplied Plexii icon set.')
  lines.push('// Do not edit by hand: re-run `node scripts/build-plexii-icons.mjs`.')
  lines.push('// `--check` fails when this file or the assets drift from the source.')
  lines.push('')
  for (const r of built) {
    for (const size of Object.keys(r.sizes)) {
      lines.push(`import ${ident(r.key, size)} from '${rel}/${r.category}/${r.sizes[size].file}'`)
    }
  }
  lines.push('')
  lines.push("export type PlexiiIconCategory = 'apps' | 'widgets' | 'tools' | 'connected'")
  lines.push('/** tile: full-colour rounded tile. glyph: single-colour mark used as a mask. logo: third-party brand mark. */')
  lines.push("export type PlexiiIconStyle = 'tile' | 'glyph' | 'logo'")
  lines.push('export interface PlexiiIconAsset {')
  lines.push('  category: PlexiiIconCategory')
  lines.push('  slug: string')
  lines.push('  title: string')
  lines.push('  style: PlexiiIconStyle')
  lines.push('  /** Pixel width -> URL. Sizes above the source resolution are not generated. */')
  lines.push('  src: Partial<Record<32 | 64 | 128, string>>')
  lines.push('  /** Recovered from the SVG-embedded original because the supplied PNG is truncated. */')
  lines.push('  recovered?: true')
  lines.push('}')
  lines.push('')
  lines.push('export const PLEXII_ICON_ASSETS: Readonly<Record<string, PlexiiIconAsset>> = {')
  for (const r of built) {
    const src = Object.keys(r.sizes)
      .map((s) => `${s}: ${ident(r.key, s)}`)
      .join(', ')
    lines.push(
      `  '${r.key}': { category: '${r.category}', slug: '${r.slug}', title: ${JSON.stringify(r.title)}, style: '${r.style}', src: { ${src} }${r.recovered ? ', recovered: true' : ''} },`
    )
  }
  lines.push('}')
  lines.push('')
  lines.push('/** Items in the source set with no usable file, and why. They render their declared fallback. */')
  lines.push('export const PLEXII_ICON_MISSING: Readonly<Record<string, string>> = {')
  for (const r of missing) lines.push(`  '${r.key}': ${JSON.stringify(r.problem)},`)
  lines.push('}')
  lines.push('')
  lines.push('/** Items whose supplied PNG is truncated and needs re-exporting by the owner. */')
  lines.push('export const PLEXII_ICON_NEEDS_REEXPORT: readonly string[] = [')
  for (const r of results.filter((x) => x.recovered || x.missing)) lines.push(`  '${r.key}',`)
  lines.push(']')
  lines.push('')
  writeFileSync(indexPath, lines.join('\n'))
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listFiles(p).map((f) => `${name}/${f}`))
    else out.push(name)
  }
  return out.sort()
}

async function main() {
  const items = collectItems()
  const target = CHECK ? mkdtempSync(join(tmpdir(), 'plexii-icons-')) : ROOT
  const assetsDir = join(target, OUT_ASSETS_REL)
  const indexPath = join(target, OUT_INDEX_REL)
  rmSync(assetsDir, { recursive: true, force: true })
  mkdirSync(assetsDir, { recursive: true })
  mkdirSync(dirname(indexPath), { recursive: true })

  const results = []
  for (const item of items) results.push(await buildItem(item, assetsDir))
  writeIndex(results, indexPath, assetsDir)

  let total = 0
  let strayTotal = 0
  for (const r of results) {
    if (r.missing) {
      console.log(`MISSING   ${r.key.padEnd(30)} ${r.problem}`)
      continue
    }
    const bytes = Object.values(r.sizes).reduce((n, s) => n + s.bytes, 0)
    total += bytes
    const strays = Object.entries(r.strays ?? {})
      .map(([s, n]) => `${s}:${n}`)
      .join(' ')
    strayTotal += Object.values(r.strays ?? {}).reduce((n, v) => n + v, 0)
    const tag = r.recovered ? 'RECOVERED' : 'ok       '
    console.log(
      `${tag} ${r.key.padEnd(30)} ${r.style.padEnd(5)} ${Object.keys(r.sizes).join('/').padEnd(10)} ${String(bytes).padStart(6)} B` +
        (r.clean ? `  tile ${r.clean.tileBox}, ${r.clean.zeroedPixels} stray px zeroed, strays after: ${strays}` : '')
    )
  }
  console.log(`\n${results.filter((r) => !r.missing).length} icons, ${results.filter((r) => r.missing).length} missing, ${total} bytes of assets.`)

  if (strayTotal > 0) {
    console.error(`build-plexii-icons: ${strayTotal} stray pixels survived cleaning.`)
    process.exit(1)
  }

  if (CHECK) {
    const committedAssets = join(ROOT, OUT_ASSETS_REL)
    const a = listFiles(committedAssets)
    const b = listFiles(assetsDir)
    const diffs = []
    if (a.join('\n') !== b.join('\n')) diffs.push('asset file list differs')
    for (const f of b) {
      const p = join(committedAssets, f)
      if (!existsSync(p) || !readFileSync(p).equals(readFileSync(join(assetsDir, f)))) diffs.push(`asset differs: ${f}`)
    }
    const committedIndex = existsSync(join(ROOT, OUT_INDEX_REL)) ? readFileSync(join(ROOT, OUT_INDEX_REL), 'utf8') : ''
    if (committedIndex !== readFileSync(indexPath, 'utf8')) diffs.push(`${OUT_INDEX_REL} differs`)
    rmSync(target, { recursive: true, force: true })
    if (diffs.length) {
      console.error(`build-plexii-icons --check: committed output is stale:\n  ${diffs.slice(0, 20).join('\n  ')}`)
      process.exit(1)
    }
    console.log('build-plexii-icons --check: committed output matches the source.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
