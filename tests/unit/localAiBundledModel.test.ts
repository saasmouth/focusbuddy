// @vitest-environment node
// The bundled on-device model: where the app finds it, and how the Mac updater
// keeps it when the update zip arrives without it. These run the real code on
// real files (small stand-in models with real sha256s) in temp directories.
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { locateModel, verifyLocated, bundledPath } from '../../src/main/ai/local/modelLocator'
import { preserveBundledModels } from '../../src/main/ai/local/modelMigration'

const BODY = Buffer.from('gguf-stand-in-'.repeat(5000))
const SPEC = { bundleId: 'qwen3-4b-instruct-2507', file: 'model.gguf', sizeBytes: BODY.length, sha256: createHash('sha256').update(BODY).digest('hex') }

let root: string
let userDir: string
let oldBundle: string
let newBundle: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plexii-bundled-'))
  userDir = join(root, 'userData', 'models')
  oldBundle = join(root, 'Old.app', 'Contents', 'Resources', 'models')
  newBundle = join(root, 'New.app', 'Contents', 'Resources', 'models')
  mkdirSync(join(oldBundle, SPEC.bundleId), { recursive: true })
  mkdirSync(newBundle, { recursive: true })
  writeFileSync(bundledPath(oldBundle, SPEC), BODY)
})
const plenty = async (): Promise<number> => 100e9

describe('resolution order', () => {
  it('uses the bundle in place when userData has nothing, and userData first when it has a verified copy', async () => {
    expect(locateModel(SPEC, { userDir, bundleDir: oldBundle })).toEqual({ path: bundledPath(oldBundle, SPEC), where: 'bundle' })
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, SPEC.file), BODY)
    writeFileSync(join(userDir, `${SPEC.file}.verified`), SPEC.sha256 + '\n')
    expect(locateModel(SPEC, { userDir, bundleDir: oldBundle })).toEqual({ path: join(userDir, SPEC.file), where: 'userData' })
  })

  it('finds nothing when neither has it (the "needs a one-time download" state)', () => {
    expect(locateModel(SPEC, { userDir, bundleDir: newBundle })).toBeNull()
    expect(locateModel(SPEC, { userDir, bundleDir: null })).toBeNull()
  })

  it('checks a bundled file against the catalog once, remembers it in userData, and refuses a wrong one', async () => {
    const cache = join(userDir, 'bundle-verified.json')
    const loc = locateModel(SPEC, { userDir, bundleDir: oldBundle })!
    expect(await verifyLocated(SPEC, loc, cache)).toBe(true)
    expect(JSON.parse(readFileSync(cache, 'utf8'))[loc.path].ok).toBe(true)
    // Nothing was written into the bundle.
    expect(readdirSync(join(oldBundle, SPEC.bundleId))).toEqual(['model.gguf'])
    const wrong = { ...SPEC, sha256: 'f'.repeat(64) }
    expect(await verifyLocated(wrong, loc, cache)).toBe(false)
  })
})

describe('updater: keep the model before the bundle swap', () => {
  it('success: copies it out of the old bundle into userData, verified', async () => {
    const r = await preserveBundledModels([SPEC], { userDir, oldBundleDir: oldBundle, newBundleDir: newBundle, freeBytes: plenty })
    expect(r).toEqual({ ok: true, copied: ['model.gguf'], skipped: [] })
    expect(readFileSync(join(userDir, SPEC.file)).equals(BODY)).toBe(true)
    expect(readFileSync(join(userDir, `${SPEC.file}.verified`), 'utf8').trim()).toBe(SPEC.sha256)
    expect(locateModel(SPEC, { userDir, bundleDir: newBundle })?.where).toBe('userData')
  })

  it('skips when userData already has it, or the new bundle carries it', async () => {
    mkdirSync(join(newBundle, SPEC.bundleId), { recursive: true })
    writeFileSync(bundledPath(newBundle, SPEC), BODY)
    const r = await preserveBundledModels([SPEC], { userDir, oldBundleDir: oldBundle, newBundleDir: newBundle, freeBytes: plenty })
    expect(r).toEqual({ ok: true, copied: [], skipped: ['model.gguf'] })
    expect(existsSync(join(userDir, SPEC.file))).toBe(false)
  })

  it('checksum mismatch: aborts, leaves nothing half-copied, and says the update was not installed', async () => {
    const r = await preserveBundledModels([SPEC], {
      userDir,
      oldBundleDir: oldBundle,
      newBundleDir: newBundle,
      freeBytes: plenty,
      copy: (_a, b) => writeFileSync(b, Buffer.concat([BODY.subarray(0, BODY.length - 1), Buffer.from('X')]))
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/checksum.*not installed/)
    expect(existsSync(join(userDir, SPEC.file))).toBe(false)
    expect(existsSync(join(userDir, `${SPEC.file}.part`))).toBe(false)
  })

  it('low disk: refuses before copying anything', async () => {
    let copied = false
    const r = await preserveBundledModels([SPEC], {
      userDir,
      oldBundleDir: oldBundle,
      newBundleDir: newBundle,
      freeBytes: async () => 1000,
      marginBytes: 0,
      copy: () => {
        copied = true
      }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/disk space.*not installed/)
    expect(copied).toBe(false)
  })

  it('an I/O failure mid-copy aborts the update and cleans up', async () => {
    const r = await preserveBundledModels([SPEC], {
      userDir,
      oldBundleDir: oldBundle,
      newBundleDir: newBundle,
      freeBytes: plenty,
      copy: (_a, b) => {
        writeFileSync(b, BODY.subarray(0, 100))
        throw new Error('EIO: input/output error')
      }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/EIO.*not installed/)
    expect(readdirSync(userDir).filter((f) => f.startsWith(SPEC.file))).toEqual([])
  })

  it('the updater does not hand over to the swap helper unless the model was kept', () => {
    const src = readFileSync(join(__dirname, '../../src/main/autoUpdate.ts'), 'utf8')
    const keep = src.indexOf('await preserveBundledModels(')
    const abort = src.indexOf('if (!kept.ok) throw new Error(kept.error)')
    const swap = src.indexOf("spawn('/bin/bash', [script")
    expect(keep).toBeGreaterThan(0)
    expect(abort).toBeGreaterThan(keep)
    expect(swap).toBeGreaterThan(abort)
  })
})
