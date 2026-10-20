// @vitest-environment node
// 4.3.39: local AI ships inside the app and becomes the default. The one-time,
// versioned AI-source migration (settingsStore.migrateAiMode), run against
// real settings files, and the credits → device fallback for one request.
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

describe('migrateAiMode (pure)', () => {
  it.each([
    [undefined, 'local'],
    ['auto', 'local'],
    ['local', 'local'],
    ['byok', 'byok'],
    ['openai', 'openai'],
    ['credits', 'credits']
  ] as const)('stored %s → %s, with the one-time notice', async (before, after) => {
    const { migrateAiMode, AI_MODE_MIGRATION } = await freshStore(null)
    const env: Parameters<typeof migrateAiMode>[0] = before ? { aiMode: before } : {}
    expect(migrateAiMode(env)).toBe(true)
    expect(env.aiMode).toBe(after)
    expect(env.aiModeMigration).toBe(AI_MODE_MIGRATION)
    expect(env.localAiIntro).toEqual({ pending: true, from: before ?? null })
  })

  it('runs once: a migrated profile that later chose credits keeps credits', async () => {
    const { migrateAiMode } = await freshStore(null)
    const env: Parameters<typeof migrateAiMode>[0] = { aiMode: 'auto' }
    migrateAiMode(env)
    env.aiMode = 'auto' // the person switched back to credits after the notice
    expect(migrateAiMode(env)).toBe(false)
    expect(env.aiMode).toBe('auto')
  })
})

describe('on real settings files', () => {
  beforeEach(() => {
    USERDATA = ''
  })

  it('a long-standing credits-on-auto profile moves to local, keeps keys and per-feature routes, and is written once', async () => {
    const s = await freshStore({ v: 1, keys: { anthropic: 'ENC' }, aiMode: 'auto', aiFeatureRoutes: { office: 'anthropic', writing: 'cloud' } })
    expect(s.getAiMode()).toBe('local')
    const disk = onDisk()
    expect(disk.aiMode).toBe('local')
    expect(disk.aiModeMigration).toBe(1)
    expect(disk.keys).toEqual({ anthropic: 'ENC' })
    expect(disk.aiFeatureRoutes).toEqual({ office: 'anthropic', writing: 'cloud' })
    expect(s.getAiFeatureRoutes()).toEqual({ office: 'anthropic', writing: 'cloud' })
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: 'auto', mode: 'local' })
    s.dismissLocalAiIntro()
    expect(onDisk().localAiIntro.pending).toBe(false)
  })

  it.each(['byok', 'openai', 'credits'] as const)('an explicit %s choice is left alone (and still gets the notice)', async (mode) => {
    const s = await freshStore({ v: 1, keys: {}, aiMode: mode })
    expect(s.getAiMode()).toBe(mode)
    expect(onDisk().aiMode).toBe(mode)
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: mode, mode })
  })

  it('a profile already set to local by hand reads as migrated, unchanged', async () => {
    const s = await freshStore({ v: 1, keys: {}, aiMode: 'local' })
    expect(s.getAiMode()).toBe('local')
    expect(onDisk().aiModeMigration).toBe(1)
  })

  it('an already-migrated profile is not migrated again', async () => {
    const s = await freshStore({ v: 1, keys: {}, aiMode: 'auto', aiModeMigration: 1, localAiIntro: { pending: false, from: 'auto' } })
    expect(s.getAiMode()).toBe('auto')
    expect(s.getLocalAiIntro().pending).toBe(false)
  })

  it('a fresh profile is local, with the notice', async () => {
    const s = await freshStore(null)
    expect(s.getAiMode()).toBe('local')
    expect(s.getLocalAiIntro()).toEqual({ pending: true, from: null, mode: 'local' })
  })

  it('a settings file that cannot be read is never written over (it may hold keys)', async () => {
    const s = await freshStore(null, '{ not json')
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
