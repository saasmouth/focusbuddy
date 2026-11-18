// Privacy-respecting activation events. These ride the existing opt-in
// telemetry snapshot (POST /telemetry) — the same pipeline that already
// records first_launch on the signal server. Nothing here is a new endpoint,
// and nothing here is a title, a desk id, an email, or any other content.
//
// Names are a closed set. Attribution is a closed set of installer / UTM
// codes, each a short token. The server can map `activation.events[].name`
// the same way it maps the first consented snapshot to `first_launch`.

export const ACTIVATION_EVENT_NAMES = [
  'app_first_launch',
  'starter_desk_loaded',
  'first_user_desk_created',
  'day2_return',
  'pro_upgrade_clicked'
] as const

export type ActivationEventName = (typeof ACTIVATION_EVENT_NAMES)[number]

export interface ActivationEventRecord {
  name: ActivationEventName
  /** First time this event happened on this install, unix ms. */
  at: number
  /** How many times it happened. Once-events stay at 1. */
  count: number
}

export interface InstallAttribution {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  /** Installer channel token, e.g. "dmg" or "winget". Never a path. */
  installer?: string
}

export interface ActivationTelemetry {
  events: ActivationEventRecord[]
  attribution: InstallAttribution | null
}

const EVENT_SET = new Set<string>(ACTIVATION_EVENT_NAMES)

const ATTR_FIELDS: Array<[string, keyof InstallAttribution]> = [
  ['utm_source', 'utmSource'],
  ['utmsource', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utmmedium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utmcampaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utmcontent', 'utmContent'],
  ['utm_term', 'utmTerm'],
  ['utmterm', 'utmTerm'],
  ['installer', 'installer']
]

// A campaign code, not a sentence, a path, or an address. Letters, digits,
// and the few characters UTM values actually use.
const TOKEN = /^[a-z0-9][a-z0-9._~+-]{0,63}$/

export function isActivationEventName(value: unknown): value is ActivationEventName {
  return typeof value === 'string' && EVENT_SET.has(value)
}

/** Keep the first occurrence time; increment the count. Unknown names are dropped. */
export function recordActivation(
  events: readonly ActivationEventRecord[],
  name: ActivationEventName,
  at: number
): ActivationEventRecord[] {
  const when = Number.isFinite(at) ? Math.trunc(at) : 0
  const next = events.map((e) => ({ ...e }))
  const hit = next.find((e) => e.name === name)
  if (hit) {
    hit.count += 1
    return next
  }
  next.push({ name, at: when, count: 1 })
  return next
}

export function hasActivation(events: readonly ActivationEventRecord[], name: ActivationEventName): boolean {
  return events.some((e) => e.name === name)
}

/** Local calendar day, so "day 2" is the user's next morning, not UTC midnight. */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isLaterLocalDay(earlierMs: number, laterMs: number): boolean {
  if (!Number.isFinite(earlierMs) || !Number.isFinite(laterMs)) return false
  return localDayKey(laterMs) > localDayKey(earlierMs)
}

function token(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (!v || v.length > 64) return undefined
  // Addresses, urls, paths and sentences are not campaign codes.
  if (/[@\s/\\]/.test(v) || v.includes('://')) return undefined
  return TOKEN.test(v) ? v : undefined
}

/**
 * Pull installer / UTM codes out of an untrusted bag (query string, argv, a
 * JSON file the installer may drop). Everything else — tokens, emails, paths —
 * is discarded.
 */
export function sanitizeAttribution(input: unknown): InstallAttribution | null {
  if (!input || typeof input !== 'object') return null
  const bag = input as Record<string, unknown>
  const out: InstallAttribution = {}
  const seen = new Set<keyof InstallAttribution>()
  for (const [rawKey, field] of ATTR_FIELDS) {
    if (seen.has(field)) continue
    const value = token(bag[rawKey] ?? bag[field])
    if (!value) continue
    out[field] = value
    seen.add(field)
  }
  return Object.keys(out).length > 0 ? out : null
}

/** First touch wins. Later captures fill only the codes that were missing. */
export function mergeAttribution(
  current: InstallAttribution | null,
  incoming: InstallAttribution | null
): InstallAttribution | null {
  if (!incoming) return current
  if (!current) return { ...incoming }
  const out: InstallAttribution = { ...current }
  for (const field of ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'installer'] as const) {
    if (!out[field] && incoming[field]) out[field] = incoming[field]
  }
  return out
}

export function attributionFromUrl(url: string): InstallAttribution | null {
  try {
    const parsed = new URL(url)
    const bag: Record<string, string> = {}
    parsed.searchParams.forEach((value, key) => {
      bag[key] = value
    })
    return sanitizeAttribution(bag)
  } catch {
    return null
  }
}

/** Read UTM / installer codes from process arguments and deep links. */
export function attributionFromArgv(argv: readonly string[]): InstallAttribution | null {
  let merged: InstallAttribution | null = null
  for (const arg of argv) {
    if (typeof arg !== 'string') continue
    if (arg.includes('://')) {
      merged = mergeAttribution(merged, attributionFromUrl(arg))
      continue
    }
    const body = arg.replace(/^--+/, '')
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    // Installers pass --utm-source=; links pass utm_source=. Same code.
    const key = body.slice(0, eq).replace(/-/g, '_')
    const value = body.slice(eq + 1)
    merged = mergeAttribution(merged, sanitizeAttribution({ [key]: value }))
  }
  return merged
}

export function attributionFromJson(text: string): InstallAttribution | null {
  try {
    return sanitizeAttribution(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

/**
 * What the next consented telemetry snapshot may carry. Desk ids, cohort and
 * any other local bookkeeping stay on the machine.
 */
export function activationForTelemetry(
  events: readonly ActivationEventRecord[],
  attribution: InstallAttribution | null
): ActivationTelemetry {
  return {
    events: events
      .filter((e) => isActivationEventName(e.name))
      .map((e) => ({ name: e.name, at: e.at, count: Math.max(1, Math.trunc(e.count || 1)) })),
    attribution: sanitizeAttribution(attribution)
  }
}
