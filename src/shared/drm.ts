// Protected video (DRM) in desk web pages: the pure decisions.
//
// Netflix and most paid streaming play through Widevine, Google's DRM module
// (the CDM). Stock Electron has none, which is why Netflix showed error
// M7701-1003 in a desk page. PlexiiDesk runs on castLabs' Electron for Content
// Security (ECS), which installs the Widevine CDM through Chromium's component
// updater (src/main/widevine.ts), so `requestMediaKeySystemAccess` works in
// every web page.
//
// Having the CDM is not the whole story. Commercial services also check a
// Verified Media Path (VMP) signature on the app binary, which castLabs' EVS
// service issues (build/vmp.cjs). A build without that signature plays
// Widevine test streams but is refused by Netflix and its peers.
//
// When a page wants protected video and it cannot play here, the person sees a
// calm notice saying WHY and offering their own browser. This file decides
// whether something a page did is evidence of that, and what the notice says.
// It never blocks the page: the notice sits above it.
//
// Evidence comes from a small script in each web page (src/shared/
// drmMainWorldProbe.ts, injected by src/preload/drmProbe.ts). Pages are
// untrusted, so every report is validated here before main acts on it
// (sanitizeDrmEvidence), and the worst a forged report can do is show this
// notice on the forging page itself.

/** The Widevine key system, and its experiment-suffixed variants. */
export const WIDEVINE_KEY_SYSTEM = 'com.widevine.alpha'

export function isWidevineKeySystem(keySystem: unknown): boolean {
  return (
    typeof keySystem === 'string' &&
    (keySystem === WIDEVINE_KEY_SYSTEM || keySystem.startsWith(`${WIDEVINE_KEY_SYSTEM}.`))
  )
}

/**
 * Where the Widevine CDM stands in this process.
 *  - ready:       installed and registered; pages can use it.
 *  - installing:  the component updater is still fetching it (a first launch).
 *  - failed:      the component updater gave up (offline, blocked, a Google error).
 *  - unsupported: this Electron has no component updater (stock Electron).
 */
export type CdmState = 'ready' | 'installing' | 'failed' | 'unsupported'

export interface CdmStatus {
  state: CdmState
  /** The installed CDM version, when known. */
  version?: string | null
  /** Why it failed, in the updater's words, when it did. */
  error?: string
}

/**
 * The app binary's Verified Media Path signature, as the build recorded it
 * (build/vmp.cjs writes Resources/vmp.json):
 *  - production:  EVS-signed; commercial services can accept it.
 *  - development: castLabs' development signature (an unpackaged run of ECS);
 *                 Widevine's test servers accept it, commercial services do not.
 *  - none:        packaged without a VMP signature (no EVS account yet).
 *  - unknown:     no record (an older build, or the record is unreadable).
 */
export type VmpState = 'production' | 'development' | 'none' | 'unknown'

/** Read the marker build/vmp.cjs writes. Anything unexpected is 'unknown'. */
export function parseVmpMarker(raw: string | null | undefined): VmpState {
  if (!raw) return 'unknown'
  try {
    const v = (JSON.parse(raw) as { vmp?: unknown }).vmp
    return v === 'production' || v === 'none' || v === 'development' ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Why protected video cannot play here — the three things the notice can say. */
export type DrmReason = 'widevine-missing' | 'vmp-refused' | 'licence-error'

/** What a page did that says something about protected video. */
export type DrmEvidence =
  /** requestMediaKeySystemAccess for Widevine was refused. */
  | { kind: 'mksa-rejected'; keySystem: string; name?: string; message?: string }
  /** A Widevine licence never arrived, or was refused when applied. */
  | {
      kind: 'licence-failed'
      how: 'update-rejected' | 'no-licence' | 'key-status'
      status?: string
      message?: string
    }
  /** The site's own error screen named a DRM error code (Netflix's M77xx / M7121). */
  | { kind: 'site-error'; site: 'netflix'; code: string }

export interface DrmVerdict {
  reason: DrmReason
  /** A short, plain clause on what was seen, e.g. "Netflix error M7121-1331". */
  detail: string
}

// ── Netflix ──────────────────────────────────────────────────────────────────
//
// Netflix's browser player shows codes like "M7701-1003" on its error screen.
// Only two families are read, both observed in this exact situation:
//   - M7701, M7702, M7703: Widevine missing, disabled or blocked. Stock
//     Electron shows M7701-1003 (the owner's report, and stackoverflow
//     #69984831).
//   - M7121: the licence was refused. castLabs' DEVELOPMENT-signed build shows
//     M7121-1331 (castlabs/electron-releases issue #122): no production VMP.
// Every other M7xxx code (VPN, region, a bad link) is the site's own business
// and gets no notice from us.

/** Netflix hosts, including country domains (netflix.ca, netflix.co.uk …). */
export function isNetflixHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return /(^|\.)netflix\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(h)
}

export const NETFLIX_CODE_SOURCE = String.raw`\bM(7\d{3})-(\d{4})(?:-[A-Z0-9]{1,8})?\b`
export const NETFLIX_WIDEVINE_FAMILIES: readonly string[] = ['7701', '7702', '7703']
export const NETFLIX_LICENCE_FAMILIES: readonly string[] = ['7121']
export const NETFLIX_DRM_FAMILIES: readonly string[] = [...NETFLIX_WIDEVINE_FAMILIES, ...NETFLIX_LICENCE_FAMILIES]

export interface NetflixCode {
  code: string
  family: 'widevine' | 'licence'
}

/** The first DRM-family Netflix error code in some page text, if any. */
export function netflixDrmCode(text: string): NetflixCode | null {
  const re = new RegExp(NETFLIX_CODE_SOURCE, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const family = NETFLIX_WIDEVINE_FAMILIES.includes(m[1])
      ? 'widevine'
      : NETFLIX_LICENCE_FAMILIES.includes(m[1])
        ? 'licence'
        : null
    if (family) return { code: m[0], family }
  }
  return null
}

// ── The decision ─────────────────────────────────────────────────────────────

function cdmClause(cdm: CdmStatus): string {
  switch (cdm.state) {
    case 'installing':
      return 'Widevine is still downloading'
    case 'failed':
      return cdm.error ? `Widevine could not be installed: ${cdm.error}` : 'Widevine could not be installed'
    case 'unsupported':
      return 'this copy of PlexiiDesk has no Widevine'
    default:
      return 'Widevine is missing'
  }
}

/**
 * Turn one piece of evidence into a notice, or null when it is not one.
 *
 * Deliberately quiet: a refused requestMediaKeySystemAccess while the CDM IS
 * ready is not a failure (sites probe several configurations and keep the one
 * that works), so it says nothing. Only the CDM being absent, a licence that
 * did not arrive, or the site's own DRM error screen raise a notice.
 */
export function classifyDrm(e: DrmEvidence, ctx: { cdm: CdmStatus; vmp: VmpState }): DrmVerdict | null {
  const cdmReady = ctx.cdm.state === 'ready'
  // When the CDM is ready, a refusal further down the line is the site
  // judging this app: without a production signature that is almost certainly
  // VMP, and with one (or no record either way) it is a licence error.
  const refusal = (detail: string): DrmVerdict =>
    ctx.vmp === 'production' || ctx.vmp === 'unknown'
      ? { reason: 'licence-error', detail }
      : { reason: 'vmp-refused', detail }

  switch (e.kind) {
    case 'mksa-rejected':
      if (!isWidevineKeySystem(e.keySystem) || cdmReady) return null
      return { reason: 'widevine-missing', detail: cdmClause(ctx.cdm) }
    case 'licence-failed': {
      if (!cdmReady) return { reason: 'widevine-missing', detail: cdmClause(ctx.cdm) }
      const what =
        e.how === 'no-licence'
          ? 'no licence arrived'
          : e.how === 'update-rejected'
            ? 'the licence was refused'
            : `the licence reported "${e.status ?? 'an error'}"`
      return refusal(what)
    }
    case 'site-error': {
      const parsed = netflixDrmCode(e.code)
      if (!parsed) return null
      const detail = `Netflix error ${parsed.code}`
      if (!cdmReady) return { reason: 'widevine-missing', detail: `${detail}; ${cdmClause(ctx.cdm)}` }
      return refusal(detail)
    }
    default:
      return null
  }
}

// ── What the person reads ────────────────────────────────────────────────────

/** The notice text: why it fell back, in plain words, then the way that works. */
export function drmNoticeText(verdict: DrmVerdict, host: string): string {
  const site = host || 'This site'
  switch (verdict.reason) {
    case 'widevine-missing':
      return `This page plays protected video, which needs Google’s Widevine module, and PlexiiDesk can’t use it right now (${verdict.detail}). Watch it in your own browser instead.`
    case 'vmp-refused':
      return `${site} refused to play protected video here (${verdict.detail}). This build of PlexiiDesk doesn’t carry the production DRM signature (VMP) that ${site} checks for. Watch it in your own browser instead.`
    case 'licence-error':
      return `${site} wouldn’t give PlexiiDesk a licence to play this protected video (${verdict.detail}). Watch it in your own browser instead.`
  }
}

/** What main sends the app window for one page. */
export interface DrmNoticePayload {
  webContentsId: number
  reason: DrmReason
  detail: string
  /** The page's address when it happened (the "Open in your browser" target). */
  url: string
  text: string
}

// ── Validating what a page sent ──────────────────────────────────────────────

const clip = (v: unknown, n: number): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, n) : undefined

/** A page's report, checked field by field. Anything malformed is dropped. */
export function sanitizeDrmEvidence(raw: unknown): DrmEvidence | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.kind) {
    case 'mksa-rejected': {
      const keySystem = clip(r.keySystem, 80)
      if (!keySystem || !isWidevineKeySystem(keySystem)) return null
      return { kind: 'mksa-rejected', keySystem, name: clip(r.name, 60), message: clip(r.message, 200) }
    }
    case 'licence-failed': {
      if (r.how !== 'update-rejected' && r.how !== 'no-licence' && r.how !== 'key-status') return null
      return { kind: 'licence-failed', how: r.how, status: clip(r.status, 40), message: clip(r.message, 200) }
    }
    case 'site-error': {
      const code = clip(r.code, 40)
      if (r.site !== 'netflix' || !code || !netflixDrmCode(code)) return null
      return { kind: 'site-error', site: 'netflix', code }
    }
    default:
      return null
  }
}
