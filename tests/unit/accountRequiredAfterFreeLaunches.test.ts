// @vitest-environment node
//
// Three opens without an account are free. The fourth requires one.
//
// The thing that makes this worth a test is that a gate is only as good as its
// weakest exit, and this modal had three: "Continue without account", a close
// X, and a per-session dismiss — plus a week-long skip memory. Closing two of
// three would look correct in a screenshot and leak every user straight past.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const MODAL = 'src/renderer/src/components/LaunchSignInModal.tsx'
const STORE = 'src/main/db/account.ts'

describe('the free-launch allowance', () => {
  it('is three, in both the gate and the copy', () => {
    const modal = read(MODAL)
    expect(modal).toMatch(/const FREE_LAUNCHES = 3/)
    // The user-facing number is interpolated, not typed twice — a hardcoded
    // "3" in the sentence would drift the moment the allowance changed.
    expect(modal).toMatch(/\{FREE_LAUNCHES\}/)
  })

  it('fires on the fourth open, not the third', () => {
    const modal = read(MODAL)
    // Strictly greater than: at anonLaunches === 3 the user is on their third
    // open and still free. `>=` here would charge them a launch early.
    expect(modal).toMatch(/const required = anonLaunches > FREE_LAUNCHES/)
  })
})

describe('every way past the modal closes', () => {
  const modal = read(MODAL)

  it('ignores the skip, the weekly throttle and the session dismiss', () => {
    expect(modal).toMatch(/if \(!manualOpen && !required\)/)
  })

  it('removes "Continue without account"', () => {
    // Guarded by `required ?`, with an honest note in its place rather than a
    // disabled control that reads as a bug.
    expect(modal).toMatch(/required \? \(/)
    expect(modal).toContain('account-required-note')
  })

  it('removes the close button, with exactly one exception', () => {
    // The gate is inescapable past the free launches — except when the server
    // cannot be reached. The app is local-first and the session is no longer
    // kept across launches, so without that exception a single outage locks
    // every user out of their own local desks.
    //
    // Pinned as an exact expression on purpose: a third condition added here
    // would be a new way past the gate, and should fail this test until someone
    // justifies it the way the offline case is justified above.
    expect(modal).toMatch(/\{\(!required \|\| serverUnreachable\) && \(/)
    expect(modal).toContain('data-testid="signin-close"')
  })

  it('opens that exception only for an unreachable server', () => {
    // Not for a rejected password, not for a 2FA prompt, not for an unexpected
    // response — any of which would turn "wrong password" into a free pass.
    expect(modal).toMatch(/result\.code === 'NETWORK'[\s\S]{0,200}setServerUnreachable\(true\)/)
    const sets = modal.match(/setServerUnreachable\(true\)/g) ?? []
    expect(sets.length, 'the offline escape is unlocked from more than one place').toBe(1)
  })
})

describe('the counter', () => {
  const store = read(STORE)

  it('lives beside the session, not in the renderer', () => {
    // localStorage would be resettable by clearing site data, which turns the
    // allowance into a suggestion.
    expect(store).toContain('export function recordAnonLaunch')
    expect(store).toContain('anonLaunches')
  })

  it('does not count a start made while signed in', () => {
    expect(store).toMatch(/if \(state\.encryptedToken\) return state\.anonLaunches/)
  })

  it('survives being absent on an older install', () => {
    // A missing field must read as "new user", never as "already over".
    expect(store).toMatch(/parsed\.anonLaunches \?\? 0/)
    expect(store).toMatch(/state\.anonLaunches \?\? 0/)
  })

  it('is preserved by EVERY write, not just most of them', () => {
    // Otherwise sign in, sign out, and the allowance refills forever.
    //
    // Counted rather than matched. The first version of this asserted the
    // expression merely appeared, which stays true when one of the four write
    // sites resets the count and the other three preserve it — exactly the
    // mutation that has to fail here.
    // Checked per site rather than by arithmetic. Counting
    // `anonLaunches: cur.anonLaunches` against the number of write({ calls
    // broke the moment a write preserved the field by spreading the previous
    // state instead — a legitimate second idiom that the count read as a
    // dropped counter. Each site is now inspected for either form.
    const sites: string[] = []
    for (let i = 0; i < store.length; ) {
      const at = store.indexOf('write({', i)
      if (at === -1) break
      // Balance braces from the opening one so nested objects are included.
      let depth = 0
      let end = store.indexOf('{', at)
      for (let j = end; j < store.length; j++) {
        if (store[j] === '{') depth++
        else if (store[j] === '}') {
          depth--
          if (depth === 0) {
            end = j
            break
          }
        }
      }
      sites.push(store.slice(at, end + 1))
      i = end + 1
    }
    expect(sites.length, 'no write sites found — the matcher is broken').toBeGreaterThan(1)
    for (const site of sites) {
      const carries =
        /anonLaunches:/.test(site) || /\.\.\.(state|cur|current)\b/.test(site)
      expect(carries, `a write site neither spreads nor names anonLaunches:\n${site}`).toBe(
        true
      )
    }
    expect(store, 'a write site zeroes the count').not.toMatch(
      /anonLaunches: 0\s*\n\s*\}\)/
    )
  })
})

describe('what the user is told', () => {
  const modal = read(MODAL)

  it('uses the asked-for line', () => {
    expect(modal).toContain('You seem to like us')
    expect(modal).toContain('protect your work on Plexii')
  })

  it('does not promise a backup that is opt-in', () => {
    // Sync is opt-in, so "protect your work" alone would promise something the
    // product does not do on its own. The sentence says what an account
    // actually enables.
    expect(modal).toMatch(/recovered, synced and shared/)
  })
})
