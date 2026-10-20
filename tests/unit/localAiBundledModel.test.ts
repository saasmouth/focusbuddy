// @vitest-environment node
// The bundled on-device model: where the app finds it, and how the Mac updater
// keeps it when the update zip arrives without it. These run the real code on
// real files (small stand-in models with real sha256s) in temp directories.
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, linkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { locateModel, verifyLocated, bundledPath, canonicalPath, sameFile } from '../../src/main/ai/local/modelLocator'
import { parseModelManifest, formatModelManifest, readModelManifest, expectedSha } from '../../src/main/ai/local/modelManifest'
import { execFileSync } from 'node:child_process'
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
  writeFileSync(join(oldBundle, SPEC.bundleId, 'manifest.sha256'), formatModelManifest({ [SPEC.file]: SPEC.sha256 }))
})
const plenty = async (): Promise<number> => 100e9

describe('resolution order', () => {
  it('uses the bundle in place when userData has nothing, and userData first when it has a verified copy', async () => {
    // Paths come back canonical (tmpdir is itself a symlink on macOS: /var → /private/var).
    expect(locateModel(SPEC, { userDir, bundleDir: oldBundle })).toEqual({ path: realpathSync(bundledPath(oldBundle, SPEC)), where: 'bundle' })
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, SPEC.file), BODY)
    writeFileSync(join(userDir, `${SPEC.file}.verified`), SPEC.sha256 + '\n')
    expect(locateModel(SPEC, { userDir, bundleDir: oldBundle })).toEqual({ path: realpathSync(join(userDir, SPEC.file)), where: 'userData' })
  })

  it('finds nothing when neither has it (the "needs a one-time download" state)', () => {
    expect(locateModel(SPEC, { userDir, bundleDir: newBundle })).toBeNull()
    expect(locateModel(SPEC, { userDir, bundleDir: null })).toBeNull()
  })

  it('checks a bundled file against the manifest beside it once, remembers it in userData, and refuses a wrong one', async () => {
    const cache = join(userDir, 'bundle-verified.json')
    const loc = locateModel(SPEC, { userDir, bundleDir: oldBundle })!
    expect(await verifyLocated(SPEC, loc, cache)).toBe(true)
    expect(JSON.parse(readFileSync(cache, 'utf8'))[loc.path].ok).toBe(true)
    // Nothing was written into the bundle.
    expect(readdirSync(join(oldBundle, SPEC.bundleId)).sort()).toEqual(['manifest.sha256', 'model.gguf'])
    // A catalog pin the manifest disagrees with: not loaded.
    const why: string[] = []
    const wrong = { ...SPEC, sha256: 'f'.repeat(64) }
    expect(await verifyLocated(wrong, loc, cache, (w) => why.push(w))).toBe(false)
    expect(why[0]).toMatch(/not the one this version of PlexiiDesk expects/)
  })

  it('refuses a bundled model with no manifest, an unparseable one, or weights that do not match it', async () => {
    const cache = join(userDir, 'bundle-verified.json')
    const loc = locateModel(SPEC, { userDir, bundleDir: oldBundle })!
    const mf = join(oldBundle, SPEC.bundleId, 'manifest.sha256')
    const why: string[] = []
    writeFileSync(mf, 'garbage\n')
    expect(await verifyLocated(SPEC, loc, cache, (w) => why.push(w))).toBe(false)
    expect(why.pop()).toMatch(/unparseable/)
    rmSync(mf)
    expect(await verifyLocated(SPEC, loc, cache, (w) => why.push(w))).toBe(false)
    expect(why.pop()).toMatch(/no manifest/)
    // Manifest and pin agree, but the bytes on disk are not those bytes.
    writeFileSync(mf, formatModelManifest({ [SPEC.file]: SPEC.sha256 }))
    const corrupt = Buffer.from(BODY)
    corrupt[10] = 0
    writeFileSync(bundledPath(oldBundle, SPEC), corrupt)
    expect(await verifyLocated(SPEC, loc, cache, (w) => why.push(w))).toBe(false)
    expect(why.pop()).toMatch(/does not match its manifest checksum/)
  })
})

describe('the manifest format (one format end to end)', () => {
  it('reads exactly what `shasum -a 256 <files>` writes, and the JSON form', () => {
    const d = mkdtempSync(join(tmpdir(), 'plexii-manifest-'))
    writeFileSync(join(d, 'model.gguf'), BODY)
    writeFileSync(join(d, 'LICENSE.txt'), 'licence')
    const out = execFileSync('shasum', ['-a', '256', 'LICENSE.txt', 'model.gguf'], { cwd: d, encoding: 'utf8' })
    const e = parseModelManifest(out, 'manifest.sha256')
    expect(e['model.gguf']).toBe(SPEC.sha256)
    expect(Object.keys(e).sort()).toEqual(['LICENSE.txt', 'model.gguf'])
    // What fetch-bundled-models.mjs writes is byte-identical to shasum's output.
    expect(formatModelManifest(e)).toBe(out)
    expect(parseModelManifest(JSON.stringify({ files: e }), 'manifest.json')).toEqual(e)
    expect(parseModelManifest(JSON.stringify(e), 'model.manifest.json')).toEqual(e)
    writeFileSync(join(d, 'model.manifest.json'), JSON.stringify({ files: e }))
    expect(readModelManifest(d)?.name).toBe('model.manifest.json')
  })

  it('an unparseable or empty manifest is an error, never a skip', () => {
    expect(() => parseModelManifest('not a hash  file\n', 'manifest.sha256')).toThrow(/unparseable/)
    expect(() => parseModelManifest('\n# only a comment\n', 'manifest.sha256')).toThrow(/lists no files/)
    expect(() => parseModelManifest('{"files":{"a":"nothex"}}', 'manifest.json')).toThrow(/bad sha256/)
    expect(() => parseModelManifest('{', 'manifest.json')).toThrow(/not valid JSON/)
    expect(expectedSha({ 'a.gguf': SPEC.sha256 }, 'b.gguf', SPEC.sha256)).toMatchObject({ ok: false })
  })

  it('the staged build input, when present, carries a manifest listing every file with the catalog checksum', async () => {
    const { LOCAL_MODEL_TIERS, LOCAL_EMBED_MODEL } = await import('../../src/shared/localModelCatalog')
    const models = join(__dirname, '../../resources/models')
    for (const m of [...LOCAL_MODEL_TIERS, LOCAL_EMBED_MODEL]) {
      const d = join(models, m.bundleId)
      if (!existsSync(d)) continue // not staged in this checkout (CI): the release gate checks the build
      const mf = readModelManifest(d)
      expect(mf, `${m.bundleId}/manifest.sha256`).not.toBeNull()
      expect(expectedSha(mf!.entries, m.file, m.sha256).ok).toBe(true)
      const files = readdirSync(d).filter((f) => !f.startsWith('.') && !['manifest.sha256', 'manifest.json', 'model.manifest.json'].includes(f))
      expect(Object.keys(mf!.entries).sort()).toEqual(files.sort())
    }
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

// userData reached through a symlink: on the owner's Mac Application
// Support/focusbuddy is a symlink to …/plexii and installed builds start with
// --user-data-dir=…/focusbuddy. One model, two spellings: nothing may treat it
// as two files, copy it again, re-hash it per spelling, or delete either.
describe('symlinked userData (focusbuddy → plexii)', () => {
  let real: string
  let link: string
  beforeEach(() => {
    const appSupport = join(root, 'Application Support')
    real = join(appSupport, 'plexii')
    link = join(appSupport, 'focusbuddy')
    mkdirSync(join(real, 'models'), { recursive: true })
    symlinkSync(real, link)
    writeFileSync(join(real, 'models', SPEC.file), BODY)
    writeFileSync(join(real, 'models', `${SPEC.file}.verified`), SPEC.sha256 + '\n')
  })

  it('finds the one installed copy through either spelling, under its real path', () => {
    const viaLink = locateModel(SPEC, { userDir: join(link, 'models'), bundleDir: oldBundle })
    const viaReal = locateModel(SPEC, { userDir: join(real, 'models'), bundleDir: oldBundle })
    expect(viaLink).toEqual(viaReal)
    expect(viaLink?.where).toBe('userData')
    expect(viaLink?.path).toBe(realpathSync(join(real, 'models', SPEC.file)))
    expect(canonicalPath(join(link, 'models', 'not-yet', 'x.part'))).toBe(join(realpathSync(real), 'models', 'not-yet', 'x.part'))
  })

  it('the updater sees the model as already kept through the symlink, copies nothing and deletes nothing', async () => {
    let copied = false
    const r = await preserveBundledModels([SPEC], {
      userDir: join(link, 'models'),
      oldBundleDir: oldBundle,
      newBundleDir: newBundle,
      freeBytes: async () => 0, // would refuse if it tried to copy
      copy: () => {
        copied = true
      }
    })
    expect(r).toEqual({ ok: true, copied: [], skipped: [SPEC.file] })
    expect(copied).toBe(false)
    expect(readFileSync(join(real, 'models', SPEC.file)).equals(BODY)).toBe(true)
    expect(readFileSync(bundledPath(oldBundle, SPEC)).equals(BODY)).toBe(true)
  })

  it('a bundle file that IS the userData file (same inode) is not copied onto itself', async () => {
    // No .verified marker, so only the inode check can recognise it.
    rmSync(join(real, 'models', `${SPEC.file}.verified`))
    rmSync(bundledPath(oldBundle, SPEC))
    linkSync(join(real, 'models', SPEC.file), bundledPath(oldBundle, SPEC))
    let copied = false
    const r = await preserveBundledModels([SPEC], {
      userDir: join(link, 'models'),
      oldBundleDir: oldBundle,
      newBundleDir: newBundle,
      freeBytes: plenty,
      copy: () => {
        copied = true
      }
    })
    expect(r.ok).toBe(true)
    expect(copied).toBe(false)
    expect(readFileSync(join(real, 'models', SPEC.file)).equals(BODY)).toBe(true)
  })

  it('a bundled model reached by two spellings is hashed and cached once', async () => {
    const bundleLink = join(root, 'BundleLink')
    symlinkSync(oldBundle, bundleLink)
    const cache = join(link, 'models', 'bundle-verified.json')
    const a = locateModel(SPEC, { userDir: join(root, 'empty'), bundleDir: oldBundle })!
    const b = locateModel(SPEC, { userDir: join(root, 'empty'), bundleDir: bundleLink })!
    expect(a.path).toBe(b.path)
    expect(await verifyLocated(SPEC, a, cache)).toBe(true)
    expect(await verifyLocated(SPEC, b, cache)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(join(real, 'models', 'bundle-verified.json'), 'utf8')))).toHaveLength(1)
  })

  it('sameFile compares inodes, not spellings', () => {
    expect(sameFile(join(link, 'models', SPEC.file), join(real, 'models', SPEC.file))).toBe(true)
    expect(sameFile(bundledPath(oldBundle, SPEC), join(real, 'models', SPEC.file))).toBe(false)
  })
})
