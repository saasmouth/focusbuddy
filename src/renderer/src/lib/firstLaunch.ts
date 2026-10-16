// The `first_launch` funnel event (growth spec section 8: "first_launch (from
// app telemetry)"). Sent once per account per device, the first time the app
// runs signed in as that account, and only when usage sharing is on.
//
// Transport: POST /telemetry/event { event: 'first_launch', props }. The
// spec names the event but not the route; this is the route the app assumes
// the server provides (reported to the server workstream). A 404 is recorded
// as "not delivered" and retried on a later launch, never marked as sent.

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
    const props = await d.props()
    const at = (d.now ?? Date.now)()
    const res = await d.fetchImpl(`${d.httpUrl.replace(/\/+$/, '')}/telemetry/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${d.token}` },
      body: JSON.stringify({ event: 'first_launch', at, props })
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
