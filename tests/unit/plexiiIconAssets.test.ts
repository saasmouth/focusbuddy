// The generated Plexii icon assets exist, are real WebP files, and stay small.
//
// scripts/build-plexii-icons.mjs writes them from the owner's source set (which
// lives outside git, in marketing/brand-assets). This checks what is committed:
// every URL the index hands out has a file behind it, nothing on disk is
// orphaned, and the set keeps to a byte budget so a careless re-export at
// lossless quality cannot quietly add megabytes to every install.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const ASSETS = join(ROOT, 'src/renderer/src/assets/plexii-icons')
const INDEX = join(ROOT, 'src/renderer/src/lib/plexiiIconAssets.generated.ts')

/** Whole set, all sizes. 0.49 MB when built; the budget leaves room for a few more icons. */
const TOTAL_BUDGET_BYTES = 640 * 1024
/** Any one file. The largest 128px tile is ~6 KB. */
const FILE_BUDGET_BYTES = 12 * 1024

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listFiles(p, `${prefix}${name}/`))
    else out.push(`${prefix}${name}`)
  }
  return out.sort()
}

const indexSrc = readFileSync(INDEX, 'utf8')
const imported = [...indexSrc.matchAll(/from '\.\.\/assets\/plexii-icons\/([^']+)'/g)].map((m) => m[1]).sort()
const onDisk = listFiles(ASSETS)

describe('generated Plexii icon assets', () => {
  it('imports only files that exist, and every file on disk is imported', () => {
    expect(imported.length).toBeGreaterThan(250)
    expect(onDisk).toEqual(imported)
  })

  it('are WebP files at the size their name says', () => {
    for (const f of onDisk) {
      const buf = readFileSync(join(ASSETS, f))
      expect(buf.subarray(0, 4).toString('ascii'), f).toBe('RIFF')
      expect(buf.subarray(8, 12).toString('ascii'), f).toBe('WEBP')
      const size = Number(f.match(/\.(\d+)\.webp$/)?.[1])
      expect([32, 64, 128], f).toContain(size)
      // VP8X carries the canvas size (24-bit, minus one) at bytes 24-29; VP8L
      // (lossless) packs 14-bit width/height after its signature byte.
      const chunk = buf.subarray(12, 16).toString('ascii')
      let w = 0
      let h = 0
      if (chunk === 'VP8X') {
        w = 1 + buf.readUIntLE(24, 3)
        h = 1 + buf.readUIntLE(27, 3)
      } else if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        w = 1 + (bits & 0x3fff)
        h = 1 + ((bits >> 14) & 0x3fff)
      } else if (chunk === 'VP8 ') {
        w = buf.readUInt16LE(26) & 0x3fff
        h = buf.readUInt16LE(28) & 0x3fff
      }
      expect([w, h], f).toEqual([size, size])
    }
  })

  it('keep to the size budget', () => {
    let total = 0
    for (const f of onDisk) {
      const bytes = statSync(join(ASSETS, f)).size
      expect(bytes, `${f} is ${bytes} bytes`).toBeLessThanOrEqual(FILE_BUDGET_BYTES)
      total += bytes
    }
    console.log(`Plexii icon assets: ${onDisk.length} files, ${total} bytes`)
    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET_BYTES)
  })

  it('never upscale: the 64px Google marks have no 128px file', () => {
    for (const slug of ['google-doc', 'google-sheet', 'google-slides']) {
      expect(onDisk).toContain(`widgets/${slug}.64.webp`)
      expect(onDisk).not.toContain(`widgets/${slug}.128.webp`)
    }
  })

  it('records the five truncated source PNGs as needing re-export', () => {
    for (const key of ['apps/plexiichat', 'widgets/attention', 'widgets/browser', 'widgets/custom-block', 'widgets/markdown']) {
      expect(indexSrc).toContain(`'${key}',`)
      expect(indexSrc).toMatch(new RegExp(`'${key}': \\{[^\\n]*recovered: true`))
    }
  })
})
