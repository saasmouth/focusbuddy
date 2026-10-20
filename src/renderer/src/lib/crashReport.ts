// Forward locally-captured crashes to the signal server (WS03). The main process
// persists crashes it hasn't sent yet; this reads them, POSTs them to /crash with
// the session token, and on success marks them forwarded so they aren't resent.
// Best-effort: a failed POST simply leaves them unforwarded for the next flush,
// and a missing bridge is a silent no-op.
//
// Opt-in: crash reports go only when the person turned them on (telemetryPrefs,
// default off). The check lives here, not only in the caller, so no path can
// post a crash without consent. Crashes are still recorded locally either way.

import { crashReportsEnabled } from './telemetryPrefs'

interface ForwardableCrash {
  id: string
  ts: number
  source: string
  kind: string
  message: string
  stack: string | null
  componentStack: string | null
  appVersion: string
  context: string | null
}

interface CrashApi {
  crash?: {
    unforwarded?: (limit?: number) => Promise<ForwardableCrash[]>
    markForwarded?: (ids: string[]) => Promise<void>
  }
}

export async function deliverCrashes(opts: {
  httpUrl: string
  token: string
  platform?: string
  // The consent check; defaults to the real opt-in preference.
  enabled?: () => boolean
  fetchImpl?: typeof fetch
}): Promise<number> {
  if (!(opts.enabled ?? crashReportsEnabled)()) return 0
  const api = (window as unknown as { api?: CrashApi }).api
  const unforwarded = api?.crash?.unforwarded
  const markForwarded = api?.crash?.markForwarded
  if (!unforwarded || !markForwarded) return 0

  let pending: ForwardableCrash[]
  try {
    pending = await unforwarded(50)
  } catch {
    return 0
  }
  if (pending.length === 0) return 0

  const crashes = pending.map((c) => ({
    ts: c.ts,
    source: c.source,
    kind: c.kind,
    message: c.message,
    stack: c.stack,
    componentStack: c.componentStack,
    appVersion: c.appVersion,
    platform: opts.platform ?? '',
    context: c.context
  }))

  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.httpUrl}/crash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ crashes, consent: true })
    })
    if (!res.ok) return 0
  } catch {
    return 0
  }

  try {
    await markForwarded(pending.map((c) => c.id))
  } catch {
    // The server has them; a failed mark just risks a re-send next flush, which
    // the server dedupes by not caring — acceptable, so swallow.
  }
  return pending.length
}
