// @vitest-environment node
// Protected video in desk web pages: when a page's DRM trouble becomes a
// notice, and what the notice says (src/shared/drm.ts).
import { describe, it, expect } from 'vitest'
import {
  classifyDrm,
  drmNoticeText,
  isNetflixHost,
  isWidevineKeySystem,
  netflixDrmCode,
  parseVmpMarker,
  sanitizeDrmEvidence,
  type CdmStatus,
  type VmpState
} from '../../src/shared/drm'

const ready: CdmStatus = { state: 'ready', version: '4.10.2934.0' }
const installing: CdmStatus = { state: 'installing' }
const failed: CdmStatus = { state: 'failed', error: 'network error' }
const unsupported: CdmStatus = { state: 'unsupported' }
const ctx = (cdm: CdmStatus, vmp: VmpState = 'none') => ({ cdm, vmp })

describe('requestMediaKeySystemAccess refused', () => {
  const rejected = { kind: 'mksa-rejected' as const, keySystem: 'com.widevine.alpha', name: 'NotSupportedError' }

  it('is "Widevine missing" when this build has no CDM at all (stock Electron)', () => {
    expect(classifyDrm(rejected, ctx(unsupported))).toEqual({
      reason: 'widevine-missing',
      detail: 'this copy of PlexiiDesk has no Widevine'
    })
  })

  it('says the CDM is still downloading, or why it failed', () => {
    expect(classifyDrm(rejected, ctx(installing))?.detail).toBe('Widevine is still downloading')
    expect(classifyDrm(rejected, ctx(failed))?.detail).toBe('Widevine could not be installed: network error')
  })

  it('says NOTHING when the CDM is ready: sites probe configurations and keep the one that works', () => {
    expect(classifyDrm(rejected, ctx(ready))).toBeNull()
  })

  it('ignores other key systems (ClearKey, PlayReady): not ours to explain', () => {
    expect(classifyDrm({ ...rejected, keySystem: 'org.w3.clearkey' }, ctx(unsupported))).toBeNull()
    expect(classifyDrm({ ...rejected, keySystem: 'com.microsoft.playready' }, ctx(unsupported))).toBeNull()
  })
})

describe('a licence that does not arrive', () => {
  const noLicence = { kind: 'licence-failed' as const, how: 'no-licence' as const }

  it('is the VMP refusal when this build has no production signature', () => {
    expect(classifyDrm(noLicence, ctx(ready, 'none'))).toEqual({ reason: 'vmp-refused', detail: 'no licence arrived' })
    expect(classifyDrm(noLicence, ctx(ready, 'development'))?.reason).toBe('vmp-refused')
  })

  it('is a licence error when the build IS production-signed, or nobody recorded either way', () => {
    expect(classifyDrm(noLicence, ctx(ready, 'production'))?.reason).toBe('licence-error')
    expect(classifyDrm(noLicence, ctx(ready, 'unknown'))?.reason).toBe('licence-error')
  })

  it('names how it failed', () => {
    expect(classifyDrm({ kind: 'licence-failed', how: 'update-rejected' }, ctx(ready))?.detail).toBe('the licence was refused')
    expect(classifyDrm({ kind: 'licence-failed', how: 'key-status', status: 'output-restricted' }, ctx(ready))?.detail).toBe(
      'the licence reported "output-restricted"'
    )
  })

  it('is "Widevine missing" when the CDM itself never became ready', () => {
    expect(classifyDrm(noLicence, ctx(installing))?.reason).toBe('widevine-missing')
  })
})

describe("Netflix's error screen", () => {
  it('finds the DRM codes: M7701/M7702/M7703 (Widevine) and M7121 (licence)', () => {
    expect(netflixDrmCode('Oops, something went wrong… Error Code: M7701-1003')).toEqual({ code: 'M7701-1003', family: 'widevine' })
    expect(netflixDrmCode('Code: M7703-1003')).toEqual({ code: 'M7703-1003', family: 'widevine' })
    expect(netflixDrmCode('M7121-1331-P7 something')).toEqual({ code: 'M7121-1331-P7', family: 'licence' })
  })

  it('leaves every other Netflix code alone (VPN, region, a bad link)', () => {
    expect(netflixDrmCode('M7111-5059')).toBeNull()
    expect(netflixDrmCode('M7111-1331-5059')).toBeNull()
    expect(netflixDrmCode('order M77019-10034 or XM7701-1003')).toBeNull()
  })

  it('M7701-1003 with no CDM is Widevine missing; with the CDM it is the site refusing this build', () => {
    const e = { kind: 'site-error' as const, site: 'netflix' as const, code: 'M7701-1003' }
    expect(classifyDrm(e, ctx(unsupported))).toEqual({
      reason: 'widevine-missing',
      detail: 'Netflix error M7701-1003; this copy of PlexiiDesk has no Widevine'
    })
    expect(classifyDrm(e, ctx(ready, 'none'))).toEqual({ reason: 'vmp-refused', detail: 'Netflix error M7701-1003' })
  })

  it("M7121 (castLabs' development-signed build, issue #122) is the VMP refusal", () => {
    const e = { kind: 'site-error' as const, site: 'netflix' as const, code: 'M7121-1331' }
    expect(classifyDrm(e, ctx(ready, 'development'))).toEqual({ reason: 'vmp-refused', detail: 'Netflix error M7121-1331' })
    expect(classifyDrm(e, ctx(ready, 'production'))?.reason).toBe('licence-error')
  })

  it('knows Netflix hosts, including country domains, and nothing that merely contains the name', () => {
    for (const h of ['netflix.com', 'www.netflix.com', 'help.netflix.com', 'www.netflix.co.uk', 'netflix.ca', 'netflix.com.au']) {
      expect(isNetflixHost(h), h).toBe(true)
    }
    for (const h of ['notnetflix.com', 'netflix.com.evil.io', 'netflix.example.com', 'localhost']) {
      expect(isNetflixHost(h), h).toBe(false)
    }
  })
})

describe('what the person reads', () => {
  it('says WHY in each case, and always offers their own browser', () => {
    const missing = drmNoticeText({ reason: 'widevine-missing', detail: 'Widevine is still downloading' }, 'netflix.com')
    const vmp = drmNoticeText({ reason: 'vmp-refused', detail: 'Netflix error M7121-1331' }, 'netflix.com')
    const licence = drmNoticeText({ reason: 'licence-error', detail: 'no licence arrived' }, 'example.tv')
    expect(missing).toContain('Widevine')
    expect(missing).toContain('still downloading')
    expect(vmp).toContain('(VMP)')
    expect(vmp).toContain('Netflix error M7121-1331')
    expect(licence).toContain('licence')
    expect(licence).toContain('example.tv')
    for (const t of [missing, vmp, licence]) expect(t).toMatch(/in your own browser/)
  })
})

describe('reports from a page are untrusted', () => {
  it('keeps well-formed evidence', () => {
    expect(sanitizeDrmEvidence({ kind: 'mksa-rejected', keySystem: 'com.widevine.alpha', name: 'NotSupportedError' })).toEqual({
      kind: 'mksa-rejected',
      keySystem: 'com.widevine.alpha',
      name: 'NotSupportedError',
      message: undefined
    })
    expect(sanitizeDrmEvidence({ kind: 'site-error', site: 'netflix', code: 'M7701-1003' })).toEqual({
      kind: 'site-error',
      site: 'netflix',
      code: 'M7701-1003'
    })
  })

  it('drops anything malformed, foreign or oversized', () => {
    expect(sanitizeDrmEvidence(null)).toBeNull()
    expect(sanitizeDrmEvidence('mksa-rejected')).toBeNull()
    expect(sanitizeDrmEvidence({ kind: 'mksa-rejected', keySystem: 'org.w3.clearkey' })).toBeNull()
    expect(sanitizeDrmEvidence({ kind: 'licence-failed', how: 'whatever' })).toBeNull()
    expect(sanitizeDrmEvidence({ kind: 'site-error', site: 'hulu', code: 'M7701-1003' })).toBeNull()
    expect(sanitizeDrmEvidence({ kind: 'site-error', site: 'netflix', code: 'M7111-5059' })).toBeNull()
    expect(sanitizeDrmEvidence({ kind: 'navigate', url: 'file:///etc/passwd' })).toBeNull()
    const long = sanitizeDrmEvidence({ kind: 'licence-failed', how: 'update-rejected', message: 'x'.repeat(5000) })
    expect(long && 'message' in long ? long.message?.length : 0).toBe(200)
  })

  it('accepts the Widevine key system and its experiment-suffixed variants only', () => {
    expect(isWidevineKeySystem('com.widevine.alpha')).toBe(true)
    expect(isWidevineKeySystem('com.widevine.alpha.experiment')).toBe(true)
    expect(isWidevineKeySystem('com.widevine.alphabet')).toBe(false)
    expect(isWidevineKeySystem(42)).toBe(false)
  })
})

describe("the build's VMP record (Resources/vmp.json)", () => {
  it('reads what build/vmp.cjs writes, and calls anything else unknown', () => {
    expect(parseVmpMarker('{"vmp":"production","kind":"streaming"}')).toBe('production')
    expect(parseVmpMarker('{"vmp":"none","reason":"no account"}')).toBe('none')
    expect(parseVmpMarker('{"vmp":"maybe"}')).toBe('unknown')
    expect(parseVmpMarker('not json')).toBe('unknown')
    expect(parseVmpMarker(null)).toBe('unknown')
  })
})
