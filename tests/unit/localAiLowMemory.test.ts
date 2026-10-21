// @vitest-environment node
//
// On a computer with less memory than the smallest on-device model needs,
// using AI with the source set to Local said "The on-device model is not
// downloaded yet. Open Settings → AI and download it ...". That was false and
// unhelpful: activeTier() returns null when no tier fits the memory, and the
// runtime's engine() threw LocalModelMissingError for a null tier exactly as
// for a tier that is not downloaded. A download could never fix it (Settings
// already disables Download for a tier this computer cannot run).
//
// Now the runtime throws noLocalModelError(ramGB, tiers), which names the real
// reason and the sources that work instead, and offers no download.
import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LocalModelMissingError,
  LocalModelNoMemoryError,
  noLocalModelError,
  routedClient,
  setLocalRuntime,
  setRouterSettings,
  setGateResolver,
  resetNotices
} from '../../src/main/ai/local/providerRouter'
import { LOCAL_MODEL_TIERS } from '../../src/shared/localModelCatalog'
import type { LocalGateInfo } from '../../src/shared/localAi'

const smallest = Math.min(...LOCAL_MODEL_TIERS.map((t) => t.minRamGB))

describe('noLocalModelError', () => {
  it('below the smallest tier: the memory reason, the alternatives, and no download', () => {
    const e = noLocalModelError(smallest - 4, LOCAL_MODEL_TIERS)
    expect(e).toBeInstanceOf(LocalModelNoMemoryError)
    expect(e.message).toContain(`This computer has ${smallest - 4} GB of memory`)
    expect(e.message).toContain(`needs at least ${smallest} GB`)
    expect(e.message).toMatch(/your own Anthropic or OpenAI key, or Plexii AI credits/)
    expect(e.message).not.toMatch(/download/i)
    expect(e.message).not.toContain('—')
  })

  it('enough memory: still the honest "not downloaded yet"', () => {
    expect(noLocalModelError(smallest, LOCAL_MODEL_TIERS)).toBeInstanceOf(LocalModelMissingError)
    expect(noLocalModelError(64, LOCAL_MODEL_TIERS)).toBeInstanceOf(LocalModelMissingError)
  })

  it('no tiers in this build: not blamed on memory', () => {
    expect(noLocalModelError(4, [])).toBeInstanceOf(LocalModelMissingError)
  })
})

describe('a request on a low-memory computer', () => {
  beforeEach(() => {
    resetNotices()
    setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first' })
    setGateResolver((): LocalGateInfo => ({ gate: 'ok', localPassRate: 1, cloudPassRate: 1, family: 'assistant' }))
  })

  it('fails with the memory reason, not "not downloaded yet"', async () => {
    setLocalRuntime({
      engine: async () => {
        throw noLocalModelError(4, LOCAL_MODEL_TIERS)
      },
      modelLabel: () => 'none',
      installed: () => false
    })
    const p = routedClient(null)!.messages.create({ model: 'local:chat', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })
    await expect(p).rejects.toThrow(/has 4 GB of memory/)
    await expect(p).rejects.not.toThrow(/not downloaded/)
  })

  it('the app runtime throws it when no tier fits this computer', () => {
    const svc = readFileSync(join(__dirname, '../../src/main/ai/local/localAiService.ts'), 'utf8')
    const start = svc.indexOf('setLocalRuntime({')
    expect(start).toBeGreaterThan(-1)
    const runtime = svc.slice(start, svc.indexOf('\n  })', start))
    expect(runtime).toContain('if (!t) throw noLocalModelError(ramGB(), LOCAL_MODEL_TIERS)')
    expect(runtime).not.toMatch(/if \(!t \|\| !host\) throw new LocalModelMissingError\(\)/)
    // "Try it" says the same.
    const tryIt = svc.slice(svc.indexOf("ipcMain.handle('localAi:tryIt'"))
    expect(tryIt.slice(0, 400)).toContain('noLocalModelError(ramGB(), LOCAL_MODEL_TIERS).message')
  })
})
