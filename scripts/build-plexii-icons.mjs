#!/usr/bin/env node
// Builds the Plexii entity icon set the renderer ships (apps, work widgets,
// tools, connected apps) from the owner-supplied source folder.
//
//   node scripts/build-plexii-icons.mjs [--source <dir>] [--check]
//
// Source: "Plexii-Icons-SVG-PNG" (Asset-Index.csv + <Category>/<Name>/<Name>--Icon|Logo.png|svg).
// Categories built: the entity sets (Apps, Tools, Work-Widgets, Connected-Apps)
// and the place/product/action sets from the 22 Oct 2026 delivery (Side-Menu,
// Focus-Filters, Section-Headers, People, PlexiiBrain, Bring-In,
// Areas-and-Hubs, Onboarding, Suite-Products, Home-Actions). See CATEGORY.
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
//   tile  also covers the 512px "Vector tile" exports (Suite-Products,
//         Home-Actions, the newer Work-Widgets): same cleaning, from the PNG.
//   glyph (true-vector SVG line/fill glyphs in the owner's #c4b5fd)
//         Rendered from the SVG itself at each size, never from the 512px PNG.
//         The renderer uses these as an alpha MASK coloured by a per-theme token,
//         so the light theme gets a legible violet without a recoloured file.
//   logo  (Connected-Apps third-party marks) — resized only. Never cleaned,
//         recoloured or cropped: a brand mark is kept exactly as supplied. The
//         rounded tile look is a CSS mask in the component, not baked in.
//
// Unreadable PNGs (truncated exports): the matching SVG is used when it is a true
// vector. Otherwise the item is omitted, listed in PLEXII_ICON_MISSING with the
// reason, and the app keeps its declared fallback glyph for it. Nothing is ever
// approximated. (Until 22 Oct 2026 five truncated tiles were recovered from the
// copy embedded in their SVG; the owner's re-exports replaced them, and that
// workaround is gone.)
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
  'Connected-Apps': 'connected',
  'Side-Menu': 'side-menu',
  'Focus-Filters': 'focus-filters',
  'Section-Headers': 'section-headers',
  People: 'people',
  PlexiiBrain: 'plexiibrain',
  'Bring-In': 'bring-in',
  'Areas-and-Hubs': 'areas',
  Onboarding: 'onboarding',
  'Suite-Products': 'suite',
  'Home-Actions': 'home-actions'
}

/**
 * The style each newer category is drawn in. 22 Oct 2026 the place sets were
 * single-colour line icons (glyphs, tinted per theme); the owner's 23 Oct
 * revision replaced all of them with distinct symbols on opaque gradient tiles,
 * so every newer category is now a tile, like Suite-Products and Home-Actions.
 * The build fails if an item disagrees with its category, judged twice: by the
 * index's svg_type, and by the ART itself (artStyle below measures how much of
 * the mark's bounding box is opaque), so neither a mis-filed export nor a
 * mislabelled index row can change how a menu looks.
 * Apps, Tools, Work-Widgets and Connected-Apps are mixed and keep the per-item
 * rule (svg_type "True vector" -> glyph, else tile; Connected-Apps -> logo).
 */
const CATEGORY_STYLE = {
  'side-menu': 'tile',
  'focus-filters': 'tile',
  'section-headers': 'tile',
  people: 'tile',
  plexiibrain: 'tile',
  'bring-in': 'tile',
  areas: 'tile',
  onboarding: 'tile',
  suite: 'tile',
  'home-actions': 'tile'
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
  return { kind: 'none', problem: `PNG unreadable (${png ? png.length : 0} bytes, truncated); needs a re-export` }
}

// ── Build ────────────────────────────────────────────────────────────────────

async function encode(pipeline, style) {
  if (style === 'glyph') return pipeline.webp({ lossless: true, effort: 6 }).toBuffer()
  if (style === 'logo') return pipeline.webp({ quality: 92, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer()
  return pipeline.webp({ quality: 88, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer()
}

/**
 * The app's own line glyphs (components/icons/plexiiIcons.ts), keyed by their
 * inner markup. A delivered glyph whose marks are the SAME as one of these is
 * the picture the app already drew: wiring it changes the element, not what
 * anyone sees. 22 Oct 2026: 30 of the 41 delivered line icons were exactly
 * that (Home, Rooms, Desks, Trash, People, the PlexiiBrain rows...), so the
 * owner tested 4.3.41 and reported the icons "still missing". The build now
 * says so per item and lists them in PLEXII_ICON_SAME_AS_APP_GLYPH, and
 * tests/unit/plexiiIconSameArt.test.ts holds that list to a declared one.
 */
const APP_GLYPH_BY_MARKUP = (() => {
  const src = readFileSync(join(ROOT, 'src/renderer/src/components/icons/plexiiIcons.ts'), 'utf8')
  const table = src.slice(src.indexOf('export const PLEXII_ICONS'), src.indexOf('export const PLEXII_BY_MATERIAL'))
  const map = new Map()
  for (const m of table.matchAll(/'([\w-]+)':\s*'([^']+)'/g)) if (!map.has(norm(m[2]))) map.set(norm(m[2]), m[1])
  return map
})()

/** Markup compared without whitespace differences. */
function norm(markup) {
  return markup.replace(/\s+/g, ' ').replace(/> </g, '><').trim()
}

/** The app glyph a delivered SVG duplicates, or null. Delivered glyphs wrap the 24px marks in a 32px box. */
function sameAsAppGlyph(svgText) {
  const inner = svgText.match(/<g transform="translate\(4 4\)">([\s\S]*)<\/g>\s*<\/svg>/)?.[1] ?? svgText.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]
  return inner ? (APP_GLYPH_BY_MARKUP.get(norm(inner)) ?? null) : null
}

/**
 * What the art is, from its pixels: the share of the mark's bounding box that is
 * opaque. A rounded tile fills ~0.9 or more of its box (an opaque square with
 * rounded corners); a line glyph is strokes on transparency and fills well under
 * half. Anything in between is ambiguous and is not trusted either way.
 */
const TILE_MIN_FILL = 0.8
const GLYPH_MAX_FILL = 0.55
async function artStyle(src, svgViewBox) {
  const img = src.kind === 'svg' ? sharp(src.buf, { density: Math.max(72, Math.ceil((72 * 256) / (svgViewBox || 24))) }).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }) : sharp(src.buf)
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1, on = 0
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] < 128) continue
      on++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  if (maxX < 0) return { style: 'empty', fill: 0 }
  const fill = on / ((maxX - minX + 1) * (maxY - minY + 1))
  return { style: fill >= TILE_MIN_FILL ? 'tile' : fill <= GLYPH_MAX_FILL ? 'glyph' : 'ambiguous', fill }
}

async function buildItem(item, outDir) {
  const src = await loadSource(item)
  if (src.kind === 'none') return { ...item, missing: true, problem: src.problem }

  const style = item.category === 'connected' ? 'logo' : src.kind === 'svg' ? 'glyph' : 'tile'
  const declared = CATEGORY_STYLE[item.category]
  if (declared && declared !== style) {
    throw new Error(`${item.key}: category is ${declared} style but the source makes it ${style} (svg_type "${item.svgType}")`)
  }
  if (declared) {
    const art = await artStyle(src, item.svgViewBox)
    if (art.style !== declared) {
      throw new Error(`${item.key}: category is ${declared} style but the art reads as ${art.style} (${(art.fill * 100).toFixed(0)}% of its box opaque; tile >= ${Math.round(TILE_MIN_FILL * 100)}%, glyph <= ${Math.round(GLYPH_MAX_FILL * 100)}%)`)
    }
  }
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
  const sameArt = style === 'glyph' ? sameAsAppGlyph(src.buf.toString('utf8')) : null
  return { ...item, style, sizes, source: src.note, clean: cleanInfo, strays: checks, sameArt }
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
  lines.push(`export type PlexiiIconCategory = ${Object.values(CATEGORY).map((c) => `'${c}'`).join(' | ')}`)
  lines.push('/** tile: full-colour rounded tile. glyph: single-colour mark used as a mask. logo: third-party brand mark. */')
  lines.push("export type PlexiiIconStyle = 'tile' | 'glyph' | 'logo'")
  lines.push('export interface PlexiiIconAsset {')
  lines.push('  category: PlexiiIconCategory')
  lines.push('  slug: string')
  lines.push('  title: string')
  lines.push('  style: PlexiiIconStyle')
  lines.push('  /** Pixel width -> URL. Sizes above the source resolution are not generated. */')
  lines.push('  src: Partial<Record<32 | 64 | 128, string>>')
  lines.push('}')
  lines.push('')
  lines.push('export const PLEXII_ICON_ASSETS: Readonly<Record<string, PlexiiIconAsset>> = {')
  for (const r of built) {
    const src = Object.keys(r.sizes)
      .map((s) => `${s}: ${ident(r.key, s)}`)
      .join(', ')
    lines.push(
      `  '${r.key}': { category: '${r.category}', slug: '${r.slug}', title: ${JSON.stringify(r.title)}, style: '${r.style}', src: { ${src} } },`
    )
  }
  lines.push('}')
  lines.push('')
  lines.push('/** Items in the source set with no usable file, and why (a truncated PNG needs a re-export). They render their declared fallback. */')
  lines.push('export const PLEXII_ICON_MISSING: Readonly<Record<string, string>> = {')
  for (const r of missing) lines.push(`  '${r.key}': ${JSON.stringify(r.problem)},`)
  lines.push('}')
  lines.push('')
  lines.push('/**')
  lines.push(" * Delivered glyphs whose marks are IDENTICAL to an app glyph (components/icons/plexiiIcons.ts),")
  lines.push(' * key -> that glyph. Where one replaces the glyph it duplicates, nothing on screen changes.')
  lines.push(' */')
  lines.push('export const PLEXII_ICON_SAME_AS_APP_GLYPH: Readonly<Record<string, string>> = {')
  for (const r of built.filter((x) => x.sameArt)) lines.push(`  '${r.key}': '${r.sameArt}',`)
  lines.push('}')
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
    const tag = r.sameArt ? 'SAME-ART ' : 'ok       '
    console.log(
      `${tag} ${r.key.padEnd(30)} ${r.style.padEnd(5)} ${Object.keys(r.sizes).join('/').padEnd(10)} ${String(bytes).padStart(6)} B` +
        (r.clean ? `  tile ${r.clean.tileBox}, ${r.clean.zeroedPixels} stray px zeroed, strays after: ${strays}` : '') +
        (r.sameArt ? `  same marks as the app's plexii:${r.sameArt}` : '')
    )
  }
  const same = results.filter((r) => r.sameArt)
  if (same.length) {
    console.log(`\n${same.length} delivered glyphs are the app's existing glyph (SAME-ART): wiring one where that glyph already showed changes nothing on screen.`)
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
