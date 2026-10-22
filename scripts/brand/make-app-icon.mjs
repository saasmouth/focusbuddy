#!/usr/bin/env node
// The OS app icons (build/icon.png, build/icon.ico, build/icon.icns) from the
// owner's Plexii icon set: the PlexiiDesk app tile
// (Plexii-Icons-SVG-PNG/Apps/PlexiiDesk/PlexiiDesk--Icon.png, 2026-10-22),
// which replaces the earlier blue-ii-on-navy dock tile
// (scripts/brand/make-app-icon.py, kept for the record).
//
//   node scripts/brand/make-app-icon.mjs [--source <Plexii-Icons-SVG-PNG dir>]
//
// The supplied 1254px tile has speckle and fringe in its transparent margin
// (marketing/brand-assets/KNOWN-ISSUES.txt). It is cleaned with the same
// routine the in-app icons use (scripts/build-plexii-icons.mjs cleanTile:
// largest opaque component plus its holes, grown 2px), cropped to the tile,
// then placed on the macOS icon grid the previous icon used: an 832px body at
// 96px in a 1024px canvas, so the dock shows it at the same optical size as
// every other app. Nothing is recoloured or redrawn.
//
// Outputs: icon.png (1024), icon.ico (16-256, PNG-compressed entries) and,
// on macOS, icon.icns via iconutil (10 entries, 16-1024). The browser build's
// tab icons come from the same tile without the dock margin:
// src/web/public/favicon.png (64) and apple-touch-icon.png (180).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { cleanTile, strayPixels, defaultSource } from '../build-plexii-icons.mjs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const args = process.argv.slice(2)
const i = args.indexOf('--source')
const SOURCE = resolve(i >= 0 ? args[i + 1] : defaultSource())
const SRC = join(SOURCE, 'Apps', 'PlexiiDesk', 'PlexiiDesk--Icon.png')

const CANVAS = 1024
const BODY = 832
const INSET = (CANVAS - BODY) / 2

async function master() {
  const { data, info } = await sharp(readFileSync(SRC)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const cleaned = cleanTile(data, info.width, info.height)
  const { bbox } = cleaned
  const side = Math.max(bbox.width, bbox.height)
  const tile = await sharp(cleaned.data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract(bbox)
    .extend({
      left: Math.floor((side - bbox.width) / 2),
      right: Math.ceil((side - bbox.width) / 2),
      top: Math.floor((side - bbox.height) / 2),
      bottom: Math.ceil((side - bbox.height) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .resize(BODY, BODY, { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  // lanczos rings a faint halo past the edge; drop specks with no coverage.
  strayPixels(tile.data, tile.info.width, tile.info.height, true)
  const body = await sharp(tile.data, { raw: { width: BODY, height: BODY, channels: 4 } }).png().toBuffer()
  return sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, left: INSET, top: INSET }])
    .png()
    .toBuffer()
}

async function sized(png, size) {
  const { data, info } = await sharp(png).resize(size, size, { kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true })
  strayPixels(data, info.width, info.height, true)
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()
}

/** An ICO whose entries are PNG streams (supported since Windows Vista). */
function ico(entries) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ size, png }, n) => {
    const o = n * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([head, dir, ...entries.map((e) => e.png)])
}

async function main() {
  const png = await master()
  writeFileSync(join(ROOT, 'build', 'icon.png'), png)

  // Browser tab: the tile edge to edge (a favicon has no dock grid).
  const body = await sharp(png).extract({ left: INSET, top: INSET, width: BODY, height: BODY }).png().toBuffer()
  writeFileSync(join(ROOT, 'src', 'web', 'public', 'favicon.png'), await sized(body, 64))
  writeFileSync(join(ROOT, 'src', 'web', 'public', 'apple-touch-icon.png'), await sized(body, 180))

  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const icoEntries = []
  for (const size of icoSizes) icoEntries.push({ size, png: await sized(png, size) })
  writeFileSync(join(ROOT, 'build', 'icon.ico'), ico(icoEntries))

  if (process.platform === 'darwin') {
    const tmp = mkdtempSync(join(tmpdir(), 'plexii-icns-'))
    const set = join(tmp, 'icon.iconset')
    mkdirSync(set)
    for (const s of [16, 32, 128, 256, 512]) {
      writeFileSync(join(set, `icon_${s}x${s}.png`), await sized(png, s))
      writeFileSync(join(set, `icon_${s}x${s}@2x.png`), s * 2 === CANVAS ? png : await sized(png, s * 2))
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', join(ROOT, 'build', 'icon.icns')])
    rmSync(tmp, { recursive: true, force: true })
    console.log('wrote build/icon.png, build/icon.ico, build/icon.icns')
  } else {
    console.log('wrote build/icon.png, build/icon.ico (icon.icns needs macOS iconutil)')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
