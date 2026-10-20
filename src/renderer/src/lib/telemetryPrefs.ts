// The user's consent for anything the app reports about itself. Two separate,
// opt-in switches, both OFF unless the person turned them on:
//
//   - usage reporting: the aggregate snapshot (counts of work widgets, desks,
//     folders, focus sessions, AI calls/tokens, onboarding progress, app version,
//     platform) posted to the signal server's /telemetry while signed in, which
//     also records the first_launch funnel event;
//   - crash reports: locally captured renderer errors (message, stack, app
//     version, a short locator) posted to /crash while signed in.
//
// Opt-in, not opt-out. A stored 'on' is the only value that enables reporting:
// a person who never chose has nothing stored and is off, and so is anyone who
// chose 'off'. Until 4.3.34 usage reporting defaulted ON (anything but 'off'
// counted as consent) and crash reports rode along with it; people who never
// touched the switch therefore become off with this release, while people who
// explicitly turned usage on keep it. Crash reports were never a separate
// choice, so nobody has consented to them yet: they start off for everyone.
//
// Every transport (telemetryReport, crashReport, firstLaunch) checks these at
// send time, not only its caller, so no code path can post without consent.
// tests/unit/telemetryOptIn.test.ts holds that line.

export const USAGE_KEY = 'plexi.telemetry.enabled'
export const CRASH_KEY = 'plexi.crashReports.enabled'

export type ReportingChoice = 'on' | 'off' | 'unset'

function read(key: string): ReportingChoice {
  try {
    const v = localStorage.getItem(key)
    return v === 'on' ? 'on' : v === 'off' ? 'off' : 'unset'
  } catch {
    return 'unset'
  }
}

function write(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'on' : 'off')
  } catch {
    /* storage unavailable: the choice cannot persist, and unset means off */
  }
}

// What the person chose for usage reporting ('unset' = never chose = off).
export function telemetryChoice(): ReportingChoice {
  return read(USAGE_KEY)
}

// True only when the person explicitly turned usage reporting on.
export function telemetryEnabled(): boolean {
  return read(USAGE_KEY) === 'on'
}

export function setTelemetryEnabled(on: boolean): void {
  write(USAGE_KEY, on)
}

export function crashReportsChoice(): ReportingChoice {
  return read(CRASH_KEY)
}

// True only when the person explicitly turned crash reports on.
export function crashReportsEnabled(): boolean {
  return read(CRASH_KEY) === 'on'
}

export function setCrashReportsEnabled(on: boolean): void {
  write(CRASH_KEY, on)
}
