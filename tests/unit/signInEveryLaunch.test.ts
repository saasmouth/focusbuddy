// @vitest-environment node
//
// Opening the app asks for a password again. The session is not carried across
// an app close, so whoever used PlexiDesk last is not still signed in.
//
// Two things here are easy to get subtly wrong, and both fail silently:
//
//   WHERE the clear happens. On quit looks natural and is wrong — a quit handler
//   does not run on a crash, a force-quit or a power loss, which is exactly when
//   a forgotten session matters. And inside ready-to-show, next to
//   recordAnonLaunch, is too late: the renderer can read account state before
//   that fires and would be handed the previous session for the whole launch.
//
//   The OFFLINE escape. The app is local-first and the gate is mandatory past
//   the free launches, so without an escape one unreachable server locks every
//   user out of their own local desks — while the error message tells them they
//   can continue.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const ACCOUNT = 'src/main/db/account.ts'
const MAIN = 'src/main/index.ts'
const MODAL = 'src/renderer/src/components/LaunchSignInModal.tsx'

describe('the session does not survive an app close', () => {
  it('clears the stored token on entry', () => {
    const account = read(ACCOUNT)
    expect(account).toMatch(/export function clearSessionForNewLaunch/)
    // Writes a null rather than deleting the file: the rest of the state has to
    // survive (see below).
    expect(account).toMatch(/write\(\{ \.\.\.state, encryptedToken: null \}\)/)
  })

  it('does not decrypt, so it cannot trigger a keychain prompt', () => {
    // DEC-060: a securityd prompt before the window exists blocks the main
    // thread behind a dialog with no parent and the app looks hung. This
    // function runs before any window, so it must never decrypt.
    const account = read(ACCOUNT)
    const fn = /export function clearSessionForNewLaunch[\s\S]*?\n\}/.exec(account)?.[0] ?? ''
    expect(fn).not.toMatch(/decryptString|safeStorage/)
  })

  it('keeps the email, the launch counter and the skip memory', () => {
    const account = read(ACCOUNT)
    const fn = /export function clearSessionForNewLaunch[\s\S]*?\n\}/.exec(account)?.[0] ?? ''
    // Spreading the existing state is what preserves them. Rebuilding the object
    // field by field would drop whichever one someone forgot — and losing
    // anonLaunches hands every launch a fresh set of free opens, so the
    // fourth-open requirement would never fire.
    expect(fn).toMatch(/\.\.\.state/)
  })

  it('runs at startup, not on quit', () => {
    const main = read(MAIN)
    expect(main).toMatch(/clearSessionForNewLaunch\(\)/)
    // No quit-time clearing, which would miss a crash or force-quit.
    expect(main).not.toMatch(/before-quit[\s\S]{0,200}clearSessionForNewLaunch/)
  })

  it('runs after the userData path is settled and before whenReady', () => {
    const main = read(MAIN)
    const call = main.indexOf('clearSessionForNewLaunch()')
    const lastUserData = main.lastIndexOf("app.setPath('userData'")
    // The real invocation, not a mention of it: a comment higher up says "Must
    // run BEFORE app.whenReady()/getDb()", and matching that made this assert
    // against a position 30 lines above the actual call.
    const whenReady = main.indexOf('app.whenReady().then(')
    expect(call).toBeGreaterThan(-1)
    // Before the userData path is final it would clear the WRONG profile's
    // session — PlexiOffice's, the preview build's, or a test profile's.
    expect(call).toBeGreaterThan(lastUserData)
    // After whenReady a renderer may already have read the session.
    expect(call).toBeLessThan(whenReady)
  })
})

describe('an unreachable server does not lock you out of local data', () => {
  it('records that the failure was the network, not a rejection', () => {
    const modal = read(MODAL)
    expect(modal).toMatch(/serverUnreachable/)
    expect(modal).toMatch(/result\.code === 'NETWORK'[\s\S]{0,200}setServerUnreachable\(true\)/)
  })

  it('lets the account last signed in here sign in OFFLINE, with its password', () => {
    // Owner, 2026-11-07: "Do not allow anyone to open plexii without signing
    // in first as a rule." The local-first promise still holds -- an outage
    // must not lock anyone out of their own desks -- but the way in is a
    // sign-in checked against the password last used here, never an escape.
    const modal = read(MODAL)
    expect(modal).toMatch(/const offlineEscape = serverUnreachable && !!offlineEmail\n/)
    expect(modal).toMatch(/data-testid="signin-offline"/)
    expect(modal).toMatch(/signInOffline\(email\.trim\(\), password\)/)
    expect(modal).not.toMatch(/signin-continue-offline/)
    expect(modal).not.toMatch(/Continue offline/)
  })

  it('has no close button while an account is required, outage or not', () => {
    const modal = read(MODAL)
    expect(modal).toMatch(/\{!required && \(\n\s*<button\n\s*type="button"\n\s*onClick=\{handleClose\}/)
    expect(modal).not.toMatch(/setOfflineChosen/)
  })
})
