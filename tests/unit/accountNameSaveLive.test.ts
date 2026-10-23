// Can a nameless account SAVE a name against the server as deployed?
//
// 9d's safety question, and the only one that decides merge order. The "Add
// your name" step cannot be skipped and stays up when a save fails — so if the
// endpoint behind it did not exist on the live server, merging the client
// before the deploy would trap every nameless existing user behind a wall with
// no way through. That is a lockout, and it is worth more than an argument
// from reading the code.
//
// It runs the REAL client function (updateProfile, the one the store's
// updateName calls) against a real server built from the DEPLOYED tag. Opt-in,
// never silently skipped:
//
//   cd ../signal-fix && git checkout signal-v125 && cd focusbuddy-signal
//   npm run build && PORT=8799 DB_PATH=./data-test/v125p.db node dist/server.js &
//   VITE_SIGNAL_HTTP_URL=http://localhost:8799 NAME_SAVE_LIVE_BASE=http://localhost:8799 \
//     npx vitest run tests/unit/accountNameSaveLive.test.ts

import { beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.NAME_SAVE_LIVE_BASE
const live = !!BASE
const stamp = Date.now().toString(36)

describe.skipIf(!live)('saving a name against the deployed server', () => {
  let client: typeof import('../../src/renderer/src/lib/accountClient')
  let token = ''

  beforeAll(async () => {
    const configured = (import.meta as unknown as { env: Record<string, string> }).env.VITE_SIGNAL_HTTP_URL
    if (configured !== BASE) {
      throw new Error(`VITE_SIGNAL_HTTP_URL must equal NAME_SAVE_LIVE_BASE (${BASE}); it is ${configured ?? 'unset'}`)
    }
    client = await import('../../src/renderer/src/lib/accountClient')
    // A genuinely nameless account. No database surgery needed: the deployed
    // server does not require names, which IS the situation under test.
    const res = await fetch(`${BASE}/accounts/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nameless_${stamp}@example.com`, password: 'password12345' })
    })
    const json = (await res.json()) as { ok?: boolean; sessionToken?: string; account?: Record<string, unknown> }
    expect(json.ok, `the deployed server allows a nameless sign-up: ${JSON.stringify(json)}`).toBe(true)
    expect(json.account?.firstName, 'and it really has no name').toBeFalsy()
    token = json.sessionToken!
  })

  it('the step’s Save succeeds, so the client can ship before the deploy', async () => {
    const updated = await client.updateProfile(token, { firstName: 'Grace', lastName: 'Hopper' })
    expect(updated, 'updateProfile returned an account rather than null').toBeTruthy()
    expect(updated!.firstName, 'the name was stored').toBe('Grace')
    expect(updated!.lastName).toBe('Hopper')

    // And it persisted, rather than only being echoed: a fresh login sees it.
    const res = await fetch(`${BASE}/accounts/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nameless_${stamp}@example.com`, password: 'password12345' })
    })
    const json = (await res.json()) as { account?: { firstName?: string; lastName?: string } }
    expect(json.account?.firstName, 'a later sign-in sees the name').toBe('Grace')
    expect(json.account?.lastName).toBe('Hopper')
  })
})

describe.skipIf(live)('saving a name against the deployed server', () => {
  it('did NOT run: set NAME_SAVE_LIVE_BASE to verify against a deployed build', () => {
    expect(BASE).toBeUndefined()
  })
})
