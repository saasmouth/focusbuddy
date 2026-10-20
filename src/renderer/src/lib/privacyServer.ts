// Tells the account what this person chose for usage data and crash reports.
//
// The server enforces the same opt-in the app does (4.3.34): it refuses
// /telemetry and /crash posts from an account that has not opted in, and it
// records a day of account activity only for accounts that opted in to usage
// data. So the choice is sent to `PUT /account/privacy` whenever a switch
// changes, and after sign-in only if it differs from what the server last heard
// from this device. The server starts every account at off/off, so a person who
// never turned anything on sends nothing at all. Only the two booleans go.

import { signalConfig } from './signalConfig'
import { crashReportsEnabled, telemetryEnabled } from './telemetryPrefs'

const LAST_PUSHED_KEY = 'plexii.privacy.lastPushed'

export interface PrivacyChoices {
  usageReporting: boolean
  crashReports: boolean
}

export function currentPrivacyChoices(): PrivacyChoices {
  return { usageReporting: telemetryEnabled(), crashReports: crashReportsEnabled() }
}

// What the server holds before this device ever told it anything.
const SERVER_DEFAULT = JSON.stringify({ usageReporting: false, crashReports: false })

function lastPushed(accountKey: string): string {
  try {
    return localStorage.getItem(`${LAST_PUSHED_KEY}:${accountKey}`) ?? SERVER_DEFAULT
  } catch {
    return SERVER_DEFAULT
  }
}

function rememberPushed(accountKey: string, value: string): void {
  try {
    localStorage.setItem(`${LAST_PUSHED_KEY}:${accountKey}`, value)
  } catch {
    /* a repeat push next sign-in is harmless */
  }
}

/**
 * Send the current choices. `force` sends even if unchanged (a switch was just
 * flipped). Resolves true when the server accepted them.
 */
export async function pushPrivacyChoices(
  token: string,
  opts: { force?: boolean; accountKey?: string; fetchImpl?: typeof fetch; httpUrl?: string } = {}
): Promise<boolean> {
  const choices = currentPrivacyChoices()
  const value = JSON.stringify(choices)
  const accountKey = opts.accountKey ?? token.slice(-12)
  if (!opts.force && lastPushed(accountKey) === value) return true
  try {
    const base = (opts.httpUrl ?? signalConfig.httpUrl).replace(/\/+$/, '')
    const res = await (opts.fetchImpl ?? fetch)(`${base}/account/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: value
    })
    if (!res.ok) return false
    rememberPushed(accountKey, value)
    return true
  } catch {
    return false
  }
}
