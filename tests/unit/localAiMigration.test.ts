// @vitest-environment node
// 4.3.39: local AI ships inside the app and becomes the default where a model
// is actually here. The one-time, versioned AI-source migration
// (settingsStore.migrateAiMode), run against real settings files, and the
// credits → device fallback for one request.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let USERDATA = ''
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getName: () => 'plexii', isPackaged: false, on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

async function freshStore(envelope: unknown | null, raw?: string) {
  USERDATA = mkdtempSync(join(tmpdir(), 'plexii-mig-'))
  if (raw !== undefined) writeFileSync(join(USERDATA, 'secrets.json'), raw)
  else if (envelope !== null) writeFileSync(join(USERDATA, 'secrets.json'), JSON.stringify(envelope))
  vi.resetModules()
  return import('../../src/main/settingsStore')
}
const onDisk = () => JSON.parse(readFileSync(join(USERDATA, 'secrets.json'), 'utf8'))

// 4.3.40: the switch to Local happens only when a usable model is HERE. The
// Mac update zip, Windows and low-memory Macs have none; moving those people to
// Local left their AI unable to answer. Without a model the previous source is
// kept, the switch waits (localAiPending) and the one-time card offers the
// download; the switch completes once the model is downloaded and verified.
describe('migrateAiMode (pure)', () => {
  it.each([
    [undefined, 'local'],
    ['auto', 'local'],
    ['local', 'local'],
    ['byok', 'byok'],
    ['openai', 'openai'],
    ['credits', 'credits']
  ] as const)('model ready: stored %s → %s, with the one-time notice and nothing pending', async (before, after) => {
    const { migrateAiMode, AI_MODE_MIGRATION } = await freshStore(null)
    const env: Parameters<typeof migrateAiMode>[0] = before ? { aiMode: before } : {}
    expect(migrateAiMode(env, 'ready')).toBe(true)
    expect(env.aiMode).toBe(after)
    expect(env.aiModeMigration).toBe(AI_MODE_MIGRATION)
    expect(env.localAiIntro).toEqual({ pending: true, from: before ?? null })
    expect(env.localAiPending).toBeUndefined()
  })

  it.each(['absent', 'unverified', 'unsupported'] as const)('model %s: unset and auto keep their engine (auto), and the switch waits', async (readiness) => {
    const { migrateAiMode } = await freshStore(null)
    for (const before of [undefined, 'auto'] as const) {
      const env: Parameters<typeof migrateAiMode>[0] = before ? { aiMode: before } : {}
      expect(migrateAiMode(env, readiness)).toBe(true)
      expect(env.aiMode).toBe('auto')
      expect(env.localAiPending).toEqual({ kept: 'auto', from: before ?? null })
      expect(env.localAiIntro).toEqual({ pending: true, from: before ?? null })
    }
  })

  it.each(['byok', 'openai', 'credits', 'local'] as const)('model absent: an explicit %s choice is left alone, nothing pending', async (mode) => {
    const { migrateAiMode } = await freshStore(null)
    const env: Parameters<typeof migrateAiMode>[0] = { aiMode: mode }
    migrateAiMode(env, 'absent')
    expect(env.aiMode).toBe(mode)
    expect(env.localAiPending).toBeUndefined()
  })

  it('the default with no probe registered is "absent": never a switch to Local on an unknown model', async () => {
    const { migrateAiMode } = await freshStore(null)
    const env: Parameters<typeof migrateAiMode>[0] = { aiMode: 'auto' }
    migrateAiMode(env)
    expect(env.aiMode).toBe('auto')
  })

  it('a 4.3.39-local.x profile (version 1) moved to local with no model goes back to its recorded source, or auto', async () => {
    const { migrateAiMode, AI_MODE_MIGRATION } = await freshStore(null)
    const fromAuto: Parameters<typeof migrateAiMode>[0] = { aiMode: 'local', aiModeMigration: 1, localAiIntro: { pending: false, from: 'auto' } }
    expect(migrateAiMode(fromAuto, 'absent')).toBe(true)
    expect(fromAuto).toMatchObject({ aiMode: 'auto', aiModeMigration: AI_MODE_MIGRATION, localAiPending: { kept: 'auto', from: 'auto' }, localAiIntro: { pending: true, from: 'auto' } })
    const fromNone: Parameters<typeof migrateAiMode>[0] = { aiMode: 'local', aiModeMigration: 1, localAiIntro: { pending: false, from: null } }
    migrateAiMode(fromNone, 'absent')
    expect(fromNone.aiMode).toBe('auto')
    // Someone who was on their own key and took the intro's "Use local AI".
    const fromKey: Parameters<typeof migrateAiMode>[0] = { aiMode: 'local', aiModeMigration: 1, localAiIntro: { pending: false, from: 'byok' } }
    migrateAiMode(fromKey, 'unsupported')
    expect(fromKey.aiMode).toBe('byok')
  })

  it('a version-1 profile whose model is here, or that is not on local, is unchanged', async () => {
    const { migrateAiMode } = await freshStore(null)
    const ready: Parameters<typeof migrateAiMode>[0] = { aiMode: 'local', aiModeMigration: 1, localAiIntro: { pending: false, from: 'auto' } }
    migrateAiMode(ready, 'ready')
    expect(ready).toMatchObject({ aiMode: 'local', localAiIntro: { pending: false, from: 'auto' } })
    expect(ready.localAiPending).toBeUndefined()
    const switched: Parameters<typeof migrateAiMode>[0] = { aiMode: 'credits', aiModeMigration: 1, localAiIntro: { pending: false, from: 'auto' } }
    migrateAiMode(switched, 'absent')
    expect(switched).toMatchObject({ aiMode: 'credits', localAiIntro: { pending: false } })
    expect(switched.localAiPending).toBeUndefined()
  })

  it('runs once: a migrated profile that later chose credits keeps credits', async () => {
    const { migrateAiMode } = await freshStore(null)
    const env: Parameters<typeof migrateAiMode>[0] = { aiMode: 'auto' }
    migrateAiMode(env, 'ready')
    env.aiMode = 'auto' // the person switched back to credits after the notice
    expect(migrateAiMode(env, 'ready')).toBe(false)
    expect(env.aiMode).toBe('auto')
  })

  it('the deferred switch completes only with a verified model, and only if the source was not changed meanwhile', async () => {
    const { migrateAiMode, completeLocalAiMigrationIn } = await freshStore(null)
    const env: Parameters<typeof migrateAiMode>[0] = { aiMode: 'auto' }
    migrateAiMode(env, 'absent')
    env.localAiIntro = { pending: false, from: 'auto' } // they closed the offer
    expect(completeLocalAiMigrationIn(env, 'unverified')).toBe(false)
    expect(completeLocalAiMigrationIn(env, 'absent')).toBe(false)
    expect(env.aiMode).toBe('auto')
    expect(completeLocalAiMigrationIn(env, 'ready')).toBe(true)
    expect(env.aiMode).toBe('local')
    expect(env.localAiPending).toBeUndefined()
    // The "now built in" card, with its switch back to what they had.
    expect(env.localAiIntro).toEqual({ pending: true, from: 'auto' })

    const changed: Parameters<typeof migrateAiMode>[0] = { aiMode: 'auto' }
    migrateAiMode(changed, 'absent')
    changed.aiMode = 'byok'
    expect(completeLocalAiMigrationIn(changed, 'ready')).toBe(true)
    expect(changed.aiMode).toBe('byok')
    expect(changed.localAiPending).toBeUndefined()
  })
})

describe('on real settings files', () => {
  beforeEach(() => {
    USERDATA = ''
  })

  async function storeWith(envelope: unknown | null, readiness: 'ready' | 'unverified' | 'absent' | 'unsupported') {
    const s = await freshStore(envelope)
    s.setLocalModelReadinessProbe(() => readiness)
    return s
  }

  it('an update with NO model: a credits-on-auto profile stays on auto, keeps keys and routes, and is offered the download', async () => {
    const s = await storeWith({ v: 1, keys: { anthropic: 'ENC' }, aiMode: 'auto', aiFeatureRoutes: { office: 'anthropic', writing: 'cloud' } }, 'absent')
    expect(s.getAiMode()).toBe('auto')
    const disk = onDisk()
    expect(disk.aiMode).toBe('auto')
    expect(disk.aiModeMigration).toBe(2)
    expect(disk.localAiPending).toEqual({ kept: 'auto', from: 'auto' })
    expect(disk.keys).toEqual({ anthropic: 'ENC' })
    expect(disk.aiFeatureRoutes).toEqual({ office: 'anthropic', writing: 'cloud' })
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: 'auto', mode: 'auto' })
    expect(s.localAiMigrationPending()).toBe(true)
    // The model arrives (downloaded and verified): the switch completes, written to disk.
    expect(s.completeLocalAiMigration()).toBe(true)
    expect(s.getAiMode()).toBe('local')
    expect(onDisk().aiMode).toBe('local')
    expect(onDisk().localAiPending).toBeUndefined()
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: 'auto', mode: 'local' })
    expect(s.completeLocalAiMigration()).toBe(false)
  })

  it('an update WITH the model: a credits-on-auto profile moves to local, keeps keys and per-feature routes, and is written once', async () => {
    const s = await storeWith({ v: 1, keys: { anthropic: 'ENC' }, aiMode: 'auto', aiFeatureRoutes: { office: 'anthropic', writing: 'cloud' } }, 'ready')
    expect(s.getAiMode()).toBe('local')
    const disk = onDisk()
    expect(disk.aiMode).toBe('local')
    expect(disk.aiModeMigration).toBe(2)
    expect(disk.keys).toEqual({ anthropic: 'ENC' })
    expect(disk.aiFeatureRoutes).toEqual({ office: 'anthropic', writing: 'cloud' })
    expect(s.getAiFeatureRoutes()).toEqual({ office: 'anthropic', writing: 'cloud' })
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: 'auto', mode: 'local' })
    s.dismissLocalAiIntro()
    expect(onDisk().localAiIntro.pending).toBe(false)
  })

  it('choosing a source by hand ends a pending switch: a later download does not override the choice', async () => {
    const s = await storeWith({ v: 1, keys: {}, aiMode: 'auto' }, 'absent')
    expect(s.localAiMigrationPending()).toBe(true)
    s.setAiMode('byok')
    expect(s.localAiMigrationPending()).toBe(false)
    expect(onDisk().localAiPending).toBeUndefined()
    expect(s.completeLocalAiMigration()).toBe(false)
    expect(s.getAiMode()).toBe('byok')
  })

  it('a local.x test-build profile stuck on local with no model is moved back to its previous engine on load', async () => {
    const s = await storeWith({ v: 1, keys: {}, aiMode: 'local', aiModeMigration: 1, localAiIntro: { pending: false, from: 'credits' } }, 'absent')
    expect(s.getAiMode()).toBe('credits')
    expect(onDisk()).toMatchObject({ aiMode: 'credits', aiModeMigration: 2, localAiPending: { kept: 'credits', from: 'credits' } })
    expect(s.getLocalAiIntro().pending).toBe(true)
  })

  it.each(['byok', 'openai', 'credits'] as const)('an explicit %s choice is left alone (and still gets the notice)', async (mode) => {
    const s = await storeWith({ v: 1, keys: {}, aiMode: mode }, 'ready')
    expect(s.getAiMode()).toBe(mode)
    expect(onDisk().aiMode).toBe(mode)
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: mode, mode })
  })

  it('a profile already set to local by hand reads as migrated, unchanged', async () => {
    const s = await storeWith({ v: 1, keys: {}, aiMode: 'local' }, 'ready')
    expect(s.getAiMode()).toBe('local')
    expect(onDisk().aiModeMigration).toBe(2)
  })

  it('an already-migrated profile is not migrated again', async () => {
    const s = await storeWith({ v: 1, keys: {}, aiMode: 'auto', aiModeMigration: 2, localAiIntro: { pending: false, from: 'auto' } }, 'ready')
    expect(s.getAiMode()).toBe('auto')
    expect(s.getLocalAiIntro().pending).toBe(false)
  })

  it('a fresh install with a verified model is local, with the notice', async () => {
    const s = await storeWith(null, 'ready')
    expect(s.getAiMode()).toBe('local')
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: null, mode: 'local' })
  })

  it('a fresh install without one (Windows, or the bundled model not yet checked) is on auto, the switch pending', async () => {
    for (const r of ['absent', 'unverified'] as const) {
      const s = await storeWith(null, r)
      expect(s.getAiMode()).toBe('auto')
      expect(s.localAiMigrationPending()).toBe(true)
      expect(s.getLocalAiIntro()).toEqual({ pending: true, from: null, mode: 'auto' })
    }
  })

  it('a settings file that cannot be read is never written over (it may hold keys)', async () => {
    const s = await freshStore(null, '{ not json')
    s.setLocalModelReadinessProbe(() => 'ready')
    expect(s.getAiMode()).toBe('local')
    expect(readFileSync(join(USERDATA, 'secrets.json'), 'utf8')).toBe('{ not json')
    expect(existsSync(join(USERDATA, 'secrets.json'))).toBe(true)
  })
})

describe('credits that cannot serve a request: answered on the device, choice unchanged', () => {
  it('out of credits → the local answer, a "top up" note; any other error still throws', async () => {
    vi.resetModules()
    const router = await import('../../src/main/ai/local/providerRouter')
    const { creditRefusalNote } = await import('../../src/main/ai/creditMode')
    let mode: 'credits' = 'credits'
    router.setRouterSettings({ aiMode: () => mode, featureRoutes: () => ({}) })
    router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
    let localCalls = 0
    router.setLocalRuntime({
      installed: () => true,
      modelLabel: () => 'test',
      engine: async () =>
        ({
          generate: async () => {
            localCalls++
            return { text: 'A local answer.', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ttftMs: 1, totalMs: 1 }
          }
        }) as never
    })
    const notes: Array<{ m: string; a?: string }> = []
    router.setNoticeSink((_f, m, a) => notes.push({ m, a }))
    let next: Error = Object.assign(new Error('402 {"error":"out_of_credits"}'), { status: 402 })
    const credits = {
      baseURL: 'https://signal.example/ai/anthropic',
      messages: {
        create: async () => {
          throw next
        }
      }
    }
    router.setCreditFallback({ isCredits: (c) => (c as unknown as { baseURL: string }).baseURL.includes('/ai/anthropic'), refusal: creditRefusalNote })
    const client = router.routedClient(credits as never)!
    const m = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] } as never)
    expect(m.content[0]).toMatchObject({ type: 'text', text: 'A local answer.' })
    expect(localCalls).toBe(1)
    expect(notes[0]).toEqual({ m: 'Out of Plexii AI credits, so this was answered by the on-device AI.', a: 'topup' })
    expect(mode).toBe('credits')

    // Proxy down (503) and unverified email are the same story; a 400 is not.
    expect(creditRefusalNote(Object.assign(new Error('x'), { status: 503 }))).toMatch(/unavailable/)
    expect(creditRefusalNote(Object.assign(new Error('403 email_not_verified'), { status: 403 }))).toMatch(/verified email/)
    next = Object.assign(new Error('400 bad request'), { status: 400 })
    await expect(client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [] } as never)).rejects.toThrow(/bad request/)
    expect(localCalls).toBe(1)

    // No on-device model installed: the credits refusal stands.
    router.setLocalRuntime({ installed: () => false, modelLabel: () => 'none', engine: async () => { throw new Error('none') } })
    next = Object.assign(new Error('402 out_of_credits'), { status: 402 })
    await expect(client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [] } as never)).rejects.toThrow(/out_of_credits/)
  })
})
