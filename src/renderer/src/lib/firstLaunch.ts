// The `first_launch` funnel event (growth spec section 8: "first_launch (from
// app telemetry)"). Sent once per account per device, the first time the app
// runs signed in as that account, and only when usage sharing is on.
//
// Transport: the signal server records first_launch from the first usage
// snapshot an account ever posts to POST /telemetry (recordFunnelOnce). The
// regular TelemetryReporter waits 8 s and then 6 hours between reports; this
// sends that same snapshot straight away on an account's first run here, so a
// person who opens the app and closes it within seconds still counts. A failed
// send is not marked as sent and is retried on a later launch.

export const FIRST_LAUNCH_KEY_PREFIX = 'fb.funnel.firstLaunch.'

export interface FirstLaunchDeps {
  httpUrl: string
  token: string
  accountId: string
  enabled: () => boolean
  storage: Pick<Storage, 'getItem' | 'setItem'>
  fetchImpl: typeof fetch
  props: () => Promise<Record<string, unknown>>
  now?: () => number
}

export type FirstLaunchOutcome = 'sent' | 'already-sent' | 'disabled' | 'failed'

export async function reportFirstLaunch(d: FirstLaunchDeps): Promise<FirstLaunchOutcome> {
  const key = FIRST_LAUNCH_KEY_PREFIX + d.accountId
  let seen: string | null = null
  try {
    seen = d.storage.getItem(key)
  } catch {
    seen = null
  }
  if (seen) return 'already-sent'
  if (!d.enabled()) return 'disabled'
  try {
    const snapshot = await d.props()
    const at = (d.now ?? Date.now)()
    const res = await d.fetchImpl(`${d.httpUrl.replace(/\/+$/, '')}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${d.token}` },
      body: JSON.stringify({ ...snapshot, consent: true })
    })
    if (!res.ok) return 'failed'
    try {
      d.storage.setItem(key, String(at))
    } catch {
      /* cannot remember it; the server dedupes a repeat */
    }
    return 'sent'
  } catch {
    return 'failed'
  }
}
