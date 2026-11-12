// @vitest-environment node
// The script injected into every desk web page (src/shared/drmMainWorldProbe.ts).
//
// It is run here FROM ITS SOURCE TEXT, the way Electron delivers it
// (contextBridge.executeInMainWorld serializes the function): anything it
// reached for outside its own body would be missing and fail here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drmMainWorldProbe, type DrmProbeConfig } from '../../src/shared/drmMainWorldProbe'
import { NETFLIX_CODE_SOURCE, NETFLIX_DRM_FAMILIES } from '../../src/shared/drm'

type Probe = typeof drmMainWorldProbe
const fromSource = (): Probe => new Function(`return (${drmMainWorldProbe.toString()})`)() as Probe

const cfg = (over: Partial<DrmProbeConfig> = {}): DrmProbeConfig => ({
  watchNetflix: false,
  netflixCodeSource: NETFLIX_CODE_SOURCE,
  netflixFamilies: [...NETFLIX_DRM_FAMILIES],
  licenceWaitMs: 15_000,
  ...over
})

/** A page's world: just the EME surface the probe touches. */
function fakePage(opts: { mksa?: (ks: string) => Promise<unknown>; update?: () => Promise<void> } = {}) {
  const calls: string[] = []
  class Navigator {
    requestMediaKeySystemAccess(ks: string): Promise<unknown> {
      calls.push(`mksa:${ks}`)
      return opts.mksa ? opts.mksa(ks) : Promise.resolve(new MediaKeySystemAccess(ks))
    }
  }
  class MediaKeySession extends EventTarget {
    keyStatuses = new Map<string, string>()
    closed = new Promise<void>(() => undefined)
    update(): Promise<void> {
      calls.push('update')
      return opts.update ? opts.update() : Promise.resolve()
    }
  }
  class MediaKeys {
    createSession(): MediaKeySession {
      return new MediaKeySession()
    }
  }
  class MediaKeySystemAccess {
    constructor(public keySystem: string) {}
    createMediaKeys(): Promise<MediaKeys> {
      return Promise.resolve(new MediaKeys())
    }
  }
  const scope = {
    Promise,
    Navigator,
    MediaKeys,
    MediaKeySystemAccess,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t)
  }
  return { scope, calls, navigator: new Navigator(), MediaKeySession }
}

const message = (type: string): Event => Object.assign(new Event('message'), { messageType: type })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('requestMediaKeySystemAccess for Widevine', () => {
  it('waits for the CDM before the real call, then hands the page the real result', async () => {
    const page = fakePage()
    let releaseCdm!: () => void
    const wait = vi.fn(() => new Promise<void>((r) => (releaseCdm = r)))
    const report = vi.fn()
    expect(fromSource()(wait, report, cfg(), page.scope)).toContain('mksa')

    const result = page.navigator.requestMediaKeySystemAccess('com.widevine.alpha') as Promise<{ keySystem: string }>
    await vi.advanceTimersByTimeAsync(0)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(page.calls).toEqual([]) // held until the CDM settles
    releaseCdm()
    expect((await result).keySystem).toBe('com.widevine.alpha')
    expect(page.calls).toEqual(['mksa:com.widevine.alpha'])
    expect(report).not.toHaveBeenCalled()
  })

  it('reports a refusal and still gives the page the real error', async () => {
    const err = Object.assign(new Error('Unsupported keySystem or supportedConfigurations.'), { name: 'NotSupportedError' })
    const page = fakePage({ mksa: () => Promise.reject(err) })
    const report = vi.fn()
    fromSource()(() => undefined, report, cfg(), page.scope)
    await expect(page.navigator.requestMediaKeySystemAccess('com.widevine.alpha')).rejects.toBe(err)
    expect(report).toHaveBeenCalledWith({
      kind: 'mksa-rejected',
      keySystem: 'com.widevine.alpha',
      name: 'NotSupportedError',
      message: 'Unsupported keySystem or supportedConfigurations.'
    })
  })

  it('still calls through when asking main fails (no wait, never a hang)', async () => {
    const page = fakePage()
    fromSource()(() => Promise.reject(new Error('bridge gone')), vi.fn(), cfg(), page.scope)
    await expect(page.navigator.requestMediaKeySystemAccess('com.widevine.alpha')).resolves.toBeTruthy()
  })

  it('passes every other key system straight through, without waiting or reporting', async () => {
    const page = fakePage({ mksa: () => Promise.reject(new Error('no')) })
    const wait = vi.fn()
    const report = vi.fn()
    fromSource()(wait, report, cfg(), page.scope)
    await expect(page.navigator.requestMediaKeySystemAccess('org.w3.clearkey')).rejects.toThrow('no')
    expect(wait).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('still reads as a native function to a page that inspects it', () => {
    const page = fakePage()
    fromSource()(vi.fn(), vi.fn(), cfg(), page.scope)
    const fn = page.scope.Navigator.prototype.requestMediaKeySystemAccess
    expect(Function.prototype.toString.call(fn)).toMatch(/\[native code\]/)
    expect(fn.name).toBe('requestMediaKeySystemAccess')
  })
})

describe('Widevine licences', () => {
  async function widevineSession(page: ReturnType<typeof fakePage>, keySystem = 'com.widevine.alpha') {
    const access = (await page.navigator.requestMediaKeySystemAccess(keySystem)) as {
      createMediaKeys(): Promise<{ createSession(): InstanceType<typeof page.MediaKeySession> }>
    }
    const keys = await access.createMediaKeys()
    return keys.createSession()
  }

  it('a licence request that is never answered is reported after the wait', async () => {
    const page = fakePage()
    const report = vi.fn()
    fromSource()(() => undefined, report, cfg({ licenceWaitMs: 15_000 }), page.scope)
    const s = await widevineSession(page)
    s.dispatchEvent(message('license-request'))
    await vi.advanceTimersByTimeAsync(14_999)
    expect(report).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(report).toHaveBeenCalledWith({ kind: 'licence-failed', how: 'no-licence' })
  })

  it('an answered licence is not a failure', async () => {
    const page = fakePage()
    const report = vi.fn()
    fromSource()(() => undefined, report, cfg(), page.scope)
    const s = await widevineSession(page)
    s.dispatchEvent(message('license-request'))
    await s.update()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(report).not.toHaveBeenCalled()
    expect(page.calls).toContain('update')
  })

  it('a licence the CDM refuses is reported, and the page still gets the rejection', async () => {
    const page = fakePage({ update: () => Promise.reject(new Error('license rejected')) })
    const report = vi.fn()
    fromSource()(() => undefined, report, cfg(), page.scope)
    const s = await widevineSession(page)
    await expect(s.update()).rejects.toThrow('license rejected')
    expect(report).toHaveBeenCalledWith({ kind: 'licence-failed', how: 'update-rejected', message: 'license rejected' })
  })

  it('every key unusable is reported; one usable key (SD while HD is held back) is not', async () => {
    const page = fakePage()
    const report = vi.fn()
    fromSource()(() => undefined, report, cfg(), page.scope)
    const mixed = await widevineSession(page)
    mixed.keyStatuses.set('hd', 'output-restricted').set('sd', 'usable')
    mixed.dispatchEvent(new Event('keystatuseschange'))
    expect(report).not.toHaveBeenCalled()
    const dead = await widevineSession(page)
    dead.keyStatuses.set('hd', 'output-restricted').set('sd', 'output-restricted')
    dead.dispatchEvent(new Event('keystatuseschange'))
    expect(report).toHaveBeenCalledWith({ kind: 'licence-failed', how: 'key-status', status: 'output-restricted' })
  })

  it('leaves sessions of other key systems alone', async () => {
    const page = fakePage()
    const report = vi.fn()
    fromSource()(() => undefined, report, cfg(), page.scope)
    const s = await widevineSession(page, 'org.w3.clearkey')
    s.dispatchEvent(message('license-request'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(report).not.toHaveBeenCalled()
  })
})

describe("Netflix's error screen", () => {
  function netflixPage(text: string) {
    let onMutate: () => void = () => undefined
    const body = { innerText: text }
    const scope = {
      ...fakePage().scope,
      document: { body },
      MutationObserver: class {
        constructor(cb: () => void) {
          onMutate = cb
        }
        observe(): void {}
      }
    }
    return { scope, body, mutate: () => onMutate() }
  }

  it('reports a DRM code once it appears, once per code', async () => {
    const page = netflixPage('Loading…')
    const report = vi.fn()
    expect(fromSource()(() => undefined, report, cfg({ watchNetflix: true }), page.scope)).toContain('netflix')
    await vi.advanceTimersByTimeAsync(1000)
    expect(report).not.toHaveBeenCalled()
    page.body.innerText = "Oops, something went wrong… We're having trouble playing this title right now. Error Code: M7701-1003"
    page.mutate()
    page.mutate()
    await vi.advanceTimersByTimeAsync(1000)
    page.mutate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith({ kind: 'site-error', site: 'netflix', code: 'M7701-1003' })
  })

  it('does not report Netflix codes outside the DRM families', async () => {
    const page = netflixPage('You seem to be using an unblocker or proxy. Error Code: M7111-5059')
    const report = vi.fn()
    fromSource()(() => undefined, report, cfg({ watchNetflix: true }), page.scope)
    await vi.advanceTimersByTimeAsync(2000)
    expect(report).not.toHaveBeenCalled()
  })

  it('does not watch page text at all off Netflix', () => {
    const page = netflixPage('M7701-1003')
    expect(fromSource()(() => undefined, vi.fn(), cfg({ watchNetflix: false }), page.scope)).not.toContain('netflix')
  })
})
