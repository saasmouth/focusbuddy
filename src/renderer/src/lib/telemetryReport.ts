// Delivery of a telemetry snapshot to the signal server, with retry. Extracted
// from TelemetryReporter so the retry behaviour is unit-testable without
// rendering the React effect: the component wires real collect/fetch, tests
// pass fakes.
//
// Consent is checked here, at every attempt, not only by the caller: usage
// reporting is opt-in (telemetryPrefs), so with the preference unset or off this
// sends nothing, whoever calls it.

import { telemetryEnabled } from './telemetryPrefs'

export interface TelemetrySnapshotLike {
  appVersion: string
  platform: string
  widgetTotal: number
  [k: string]: unknown
}

export interface DeliverOptions {
  httpUrl: string
  token: string
  collect: () => Promise<TelemetrySnapshotLike>
  fetchImpl?: typeof fetch
  // Backoff delays between retries. One attempt is always made; each delay adds
  // one more retry after waiting. Defaults to two retries (1.5s, 5s); tests
  // pass [] for an immediate single attempt or [0, 0] to retry without waiting.
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  isCancelled?: () => boolean
  // The consent check. Defaults to the real opt-in preference; tests may
  // inject one. Re-read before every attempt so turning it off mid-retry stops.
  enabled?: () => boolean
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function postOnce(opts: DeliverOptions): Promise<boolean> {
  if (!(opts.enabled ?? telemetryEnabled)()) return false
  const f = opts.fetchImpl ?? fetch
  try {
    const snapshot = await opts.collect()
    if (opts.isCancelled?.()) return false
    const res = await f(`${opts.httpUrl}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(snapshot)
    })
    return res.ok
  } catch {
    return false
  }
}

// Make one attempt, then retry per retryDelaysMs until one succeeds or all are
// exhausted. Returns whether the snapshot was accepted (HTTP ok).
export async function deliverTelemetry(opts: DeliverOptions): Promise<boolean> {
  const delays = opts.retryDelaysMs ?? [1500, 5000]
  const sleep = opts.sleep ?? defaultSleep
  const enabled = opts.enabled ?? telemetryEnabled
  if (!enabled()) return false
  if (await postOnce(opts)) return true
  for (const delay of delays) {
    if (opts.isCancelled?.() || !enabled()) return false
    if (delay > 0) await sleep(delay)
    if (opts.isCancelled?.()) return false
    if (await postOnce(opts)) return true
  }
  return false
}
