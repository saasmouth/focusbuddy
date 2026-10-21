// @vitest-environment node
//
// The AI-source migration as the running app does it (localAiService): the
// readiness probe the settings store asks while loading, the deferred switch
// to Local that completes once the model is verified, and what the one-time
// card is told about the model. Real settings files and real model folders;
// the model files are sparse (the catalog size, no real bytes), so nothing
// here reads gigabytes.
//
// The cases are the 4.3.40 ones: a fresh DMG install (bundled model, checked
// once in the background), an update with no model (the Mac update zip,
// Windows), the same profile after the model is downloaded, and a Mac with
// too little memory for any model.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, openSync, ftruncateSync, closeSync, statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let USERDATA = ''
let RAM_BYTES = 16 * 2 ** 30
vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  return { ...real, default: { ...real, totalmem: () => RAM_BYTES }, totalmem: () => RAM_BYTES }
})
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getName: () => 'plexii', getVersion: () => '0.0.0-test', getAppPath: () => USERDATA, isPackaged: false, on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: () => undefined, on: () => undefined },
  utilityProcess: { fork: () => ({}) },
  shell: { openExternal: async () => undefined },
  net: {},
  default: {}
}))

const CATALOG = JSON.parse(readFileSync(join(__dirname, '../../resources/local-models.json'), 'utf8'))
const TIER = CATALOG.models[0]

/** A sparse file of exactly `size` bytes: the right size, no real contents. */
function sparse(path: string, size: number): void {
  const fd = openSync(path, 'w')
  ftruncateSync(fd, size)
  closeSync(fd)
}

/** A downloaded, verified model in userData/models (what the downloader leaves). */
function installInUserData(): void {
  const dir = join(USERDATA, 'models')
  mkdirSync(dir, { recursive: true })
  sparse(join(dir, TIER.file), TIER.sizeBytes)
  writeFileSync(join(dir, `${TIER.file}.verified`), TIER.sha256 + '\n')
}

/** A bundle stand-in (PLEXII_BUNDLED_MODELS_DIR) carrying the model and its manifest. */
function bundle(): string {
  const b = mkdtempSync(join(tmpdir(), 'plexii-bundle-'))
  const d = join(b, TIER.bundleId)
  mkdirSync(d, { recursive: true })
  sparse(join(d, TIER.file), TIER.sizeBytes)
  writeFileSync(join(d, 'manifest.sha256'), `${TIER.sha256}  ${TIER.file}\n`)
  return b
}

async function app(envelope: unknown | null, opts: { bundleDir?: string; before?: () => void } = {}) {
  USERDATA = mkdtempSync(join(tmpdir(), 'plexii-migsvc-'))
  if (envelope !== null) writeFileSync(join(USERDATA, 'secrets.json'), JSON.stringify(envelope))
  opts.before?.()
  process.env.PLEXII_BUNDLED_MODELS_DIR = opts.bundleDir ?? mkdtempSync(join(tmpdir(), 'plexii-nobundle-'))
  delete process.env.PLEXII_MODEL_VERIFY_CACHE
  vi.resetModules()
  // Importing the service registers the probe, as main start-up does.
  const svc = await import('../../src/main/ai/local/localAiService')
  const store = await import('../../src/main/settingsStore')
  return { svc, store }
}
const onDisk = () => JSON.parse(readFileSync(join(USERDATA, 'secrets.json'), 'utf8'))

beforeEach(() => {
  RAM_BYTES = 16 * 2 ** 30
})

describe('the AI-source migration in the running app', () => {
  it('update with no model: the previous engine is kept, and the card offers the download with its size', async () => {
    const { svc, store } = await app({ v: 1, keys: {}, aiMode: 'auto' })
    expect(store.getAiMode()).toBe('auto')
    expect(svc.localModelReadiness()).toBe('absent')
    const m = svc.introModelState()
    expect(m.state).toBe('absent')
    expect(m.tierId).toBe(TIER.id)
    expect(m.bytes).toBe(TIER.sizeBytes + CATALOG.embedding.sizeBytes)
    expect(await svc.settleLocalAiMigration()).toBe(false)
    expect(store.getAiMode()).toBe('auto')
  })

  it('…then after the model has been downloaded, the switch completes', async () => {
    const { svc, store } = await app({ v: 1, keys: {}, aiMode: 'auto' })
    expect(store.getAiMode()).toBe('auto')
    installInUserData()
    expect(svc.localModelReadiness()).toBe('ready')
    expect(await svc.settleLocalAiMigration()).toBe(true)
    expect(store.getAiMode()).toBe('local')
    expect(onDisk().aiMode).toBe('local')
    expect(store.getLocalAiIntro()).toEqual({ pending: true, from: 'auto', mode: 'local' })
    expect(svc.introModelState().state).toBe('ready')
  })

  it('a settle that finds nothing (start-up, no model yet) does not stop the one after the download from completing', async () => {
    const { svc, store } = await app({ v: 1, keys: {}, aiMode: 'auto' })
    // Start-up: nothing here, returns before any await.
    expect(await svc.settleLocalAiMigration()).toBe(false)
    expect(await svc.settleLocalAiMigration()).toBe(false)
    installInUserData()
    // After the download: must really check again, and complete.
    expect(await svc.settleLocalAiMigration()).toBe(true)
    expect(store.getAiMode()).toBe('local')
  })

  it('update when the model is already downloaded: straight to local, nothing pending', async () => {
    const { svc, store } = await app({ v: 1, keys: {}, aiMode: 'auto' }, { before: installInUserData })
    expect(store.getAiMode()).toBe('local')
    expect(store.localAiMigrationPending()).toBe(false)
    expect(svc.introModelState().state).toBe('ready')
  })

  it('fresh install with the bundled model: checking first (card hidden), then verified once and switched to local', { timeout: 60_000 }, async () => {
    const b = bundle()
    const { svc, store } = await app(null, { bundleDir: b })
    expect(store.getAiMode()).toBe('auto')
    expect(svc.introModelState().state).toBe('checking')
    // The background check: a sparse stand-in does not match the real sha256,
    // so it is refused and nothing switches (a corrupt bundle is never used)…
    expect(await svc.settleLocalAiMigration()).toBe(false)
    expect(store.getAiMode()).toBe('auto')
    expect(svc.localModelReadiness()).toBe('absent')
    // …while a bundle whose check passed (remembered by path, size and mtime)
    // completes the switch.
    const p = realpathSync(join(b, TIER.bundleId, TIER.file))
    const st = statSync(p)
    writeFileSync(join(USERDATA, 'models', 'bundle-verified.json'), JSON.stringify({ [p]: { size: st.size, mtimeMs: st.mtimeMs, sha256: TIER.sha256, ok: true } }))
    expect(svc.localModelReadiness()).toBe('ready')
    expect(await svc.settleLocalAiMigration()).toBe(true)
    expect(store.getAiMode()).toBe('local')
  })

  it('a low-memory Mac: unsupported, kept on its engine, and no download is offered', async () => {
    RAM_BYTES = 4 * 2 ** 30
    const { svc, store } = await app({ v: 1, keys: {}, aiMode: 'auto' })
    expect(svc.localModelReadiness()).toBe('unsupported')
    expect(store.getAiMode()).toBe('auto')
    const m = svc.introModelState()
    expect(m.state).toBe('unsupported')
    expect(m.tierId).toBeNull()
    expect(await svc.settleLocalAiMigration()).toBe(false)
  })

  it('a local.x test-build profile on local with no model is moved back to its engine at start-up', async () => {
    const { store } = await app({ v: 1, keys: {}, aiMode: 'local', aiModeMigration: 1, localAiIntro: { pending: false, from: 'auto' } })
    expect(store.getAiMode()).toBe('auto')
    expect(onDisk().aiModeMigration).toBe(2)
  })
})
