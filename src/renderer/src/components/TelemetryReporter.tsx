// Reports this machine's usage snapshot, and separately any captured crash
// reports, to the signal server while signed in. BOTH are opt-in and off by
// default (lib/telemetryPrefs): with neither switch on, this sends nothing.
// The usage snapshot is aggregate counts only (gathered by the main process from
// the local database), never titles or content; it feeds the admin Analytics tab.
//
// Delivery is best effort but no longer fire-and-forget: a failed POST is
// retried with backoff, and beyond the initial post-sign-in report and the slow
// 6-hour interval, we also report when the window regains focus (throttled).
// That last trigger matters because a user who stays signed in for days and
// uses the app daily would otherwise only check in twice a day; the focus
// trigger means simply using the app keeps their usage current in the admin.

import { useEffect, useRef } from 'react'
import { useAccountStore } from '../stores/account'
import { signalConfig } from '../lib/signalConfig'
import { deliverTelemetry } from '../lib/telemetryReport'
import { deliverCrashes } from '../lib/crashReport'
import { crashReportsEnabled, telemetryEnabled } from '../lib/telemetryPrefs'
import { pushPrivacyChoices } from '../lib/privacyServer'

const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6 hours while open
const FOCUS_THROTTLE_MS = 10 * 60 * 1000 // at most one focus-triggered report / 10 min
const RETRY_DELAYS_MS = [1500, 5000] // retry a failed post twice, then give up until next trigger

export default function TelemetryReporter(): null {
  const sessionToken = useAccountStore((s) => s.sessionToken)
  const accountId = useAccountStore((s) => s.account?.id ?? null)
  // Guards so overlapping triggers (mount + focus + interval) don't stack
  // concurrent reports, and so focus is throttled.
  const inFlight = useRef(false)
  const lastReportAt = useRef(0)

  useEffect(() => {
    if (!sessionToken) return
    const token = sessionToken // narrowed to string for the closures below
    let cancelled = false

    // Report with retry/backoff. Coalesces concurrent callers via inFlight.
    async function report(): Promise<void> {
      if (cancelled || inFlight.current) return
      // Opt-in: with neither switch on, send nothing. Checked at call time so
      // toggling takes effect immediately; each transport re-checks its own.
      const usage = telemetryEnabled()
      const crashes = crashReportsEnabled()
      if (!usage && !crashes) return
      inFlight.current = true
      try {
        if (usage) {
          const ok = await deliverTelemetry({
            httpUrl: signalConfig.httpUrl,
            token,
            collect: () => window.api.ai.collectTelemetry(),
            retryDelaysMs: RETRY_DELAYS_MS,
            isCancelled: () => cancelled,
            enabled: telemetryEnabled
          })
          if (ok) lastReportAt.current = Date.now()
        }
        // Crash reports have their own opt-in. Independent of the usage result,
        // so a crash still forwards even if the usage snapshot failed.
        if (crashes && !cancelled) {
          await deliverCrashes({ httpUrl: signalConfig.httpUrl, token, enabled: crashReportsEnabled })
          lastReportAt.current = Math.max(lastReportAt.current, Date.now())
        }
      } finally {
        inFlight.current = false
      }
    }

    // Tell the account what this person chose (lib/privacyServer): the server
    // refuses reports from accounts that have not opted in. Only sent when it
    // differs from what the server last heard from this device.
    void pushPrivacyChoices(token, { accountKey: accountId ?? undefined })

    // Report a few seconds after sign-in settles, then on a slow interval.
    const first = window.setTimeout(() => void report(), 8000)
    const interval = window.setInterval(() => void report(), REPORT_INTERVAL_MS)

    // Report when the window regains focus, throttled, so daily use keeps the
    // admin's numbers fresh even without a new sign-in or the 6h tick.
    const onFocus = (): void => {
      if (Date.now() - lastReportAt.current >= FOCUS_THROTTLE_MS) void report()
    }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearTimeout(first)
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [sessionToken, accountId])

  return null
}
