import { expect, type Page } from '@playwright/test'
import { ACTIVE } from '../../src/shared/productDomains'

// A signed-in PlexiiChat session for e2e, with NOTHING reaching the real server.
//
// The built app talks to the production signal server (shared/productDomains
// ACTIVE). A spec that seeds a session token and lets the renderer use it would
// send that token to production: conversation refreshes, the realtime socket,
// attachment uploads. So every renderer request to the signal origin is answered
// here, from the conversations and messages the spec seeds, and the socket is
// accepted locally and kept silent. Unmatched paths get an honest empty
// `{ ok: true }` and are recorded, so a spec can see what the app asked for.
//
// The session is seeded into the RENDERER's stores only (__fbAccount and
// __fbMessaging, thin handles to the real stores). The main process never
// learns the token, so it never syncs with any server.

export interface FakeConversation {
  id: string
  kind?: 'dm' | 'space' | 'channel'
  title: string
}

export interface FakeSignal {
  /** Every signal path the renderer requested, in order ("GET /conversations"). */
  requests: string[]
  /** Attachment uploads the composer sent (kind query parameter, byte length). */
  uploads: Array<{ kind: string | null; bytes: number }>
}

const API = new URL(ACTIVE.api)
const isSignal = (u: URL): boolean => u.origin === API.origin

/**
 * The signed-in account the fixture seeds.
 *
 * NAMES ARE OPTIONAL HERE, AND THAT MATTERS BOTH WAYS. From 4.3.41 an account
 * must carry a first and last name, and LaunchSignInModal puts an account
 * without both behind the un-skippable "Add your name" wall at z-280 — which
 * covers the whole app, so a spec seeded without names can reach nothing. A
 * spec that needs to BE somebody therefore passes `name`.
 *
 * Left out, the account stays nameless, exactly as the five existing callers
 * have it. They test PlexiiChat surfaces that never render the wall, and
 * changing the default under them would alter what their assertions see.
 */
export interface FakeName {
  firstName: string
  lastName: string
}

export async function signInWithFakeSignal(
  window: Page,
  seed: {
    conversation?: FakeConversation
    messages?: object[]
    name?: FakeName
    /**
     * Play the server's part on the realtime socket (a spec that needs the
     * live-document room, say). Default: accepted and silent. NOTE the route
     * only takes effect for a socket the page opens after a navigation that
     * follows this call (Playwright installs it with the page's init script),
     * so a spec that needs it reloads and signs in again.
     */
    onSocket?: Parameters<Page['routeWebSocket']>[1]
  }
): Promise<FakeSignal> {
  // No conversation seeded = a signed-in account with an empty conversation list.
  const conv = seed.conversation
    ? {
        id: seed.conversation.id,
        kind: seed.conversation.kind ?? 'dm',
        title: seed.conversation.title,
        lastMessageAt: Date.now(),
        unreadCount: 0,
        members: [{ accountId: 'acc_other', handle: 'other' }],
        lastMessage: null
      }
    : null
  const messages = seed.messages ?? []
  const name = seed.name ?? null
  const fake: FakeSignal = { requests: [], uploads: [] }

  await window.route(
    (u) => isSignal(u),
    async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const path = url.pathname
      fake.requests.push(`${req.method()} ${path}`)
      const json = (body: unknown): Promise<void> =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      if (req.method() === 'GET' && path === '/conversations') return json({ ok: true, conversations: conv ? [conv] : [] })
      if (conv && req.method() === 'GET' && path === `/conversations/${conv.id}/messages`) return json({ ok: true, messages })
      if (conv && req.method() === 'POST' && path === `/conversations/${conv.id}/attachments`) {
        const bytes = req.postDataBuffer()?.length ?? 0
        fake.uploads.push({ kind: url.searchParams.get('kind'), bytes })
        return json({ ok: true, attachment: { id: `blob-${fake.uploads.length}`, sizeBytes: bytes } })
      }
      if (req.method() === 'GET' && /\/attachments\/[^/]+$/.test(path)) {
        // An attachment blob (image/voice/video src): nothing to play, but no 404 noise.
        return route.fulfill({ status: 204, body: '' })
      }
      return json({ ok: true })
    }
  )
  await window.routeWebSocket(
    (u) => u.host === API.host,
    seed.onSocket ??
      (() => {
        // Accepted and silent: no server is connected, so nothing is sent or received.
      })
  )

  const ok = await window.evaluate(
    ({ conv, messages, name }) => {
      type Store = { setState: (s: object) => void }
      const w = window as unknown as { __fbAccount?: Store; __fbMessaging?: Store }
      if (!w.__fbAccount || !w.__fbMessaging) return false
      w.__fbAccount.setState({
        account: {
          id: 'acc_e2e',
          email: 'e2e@test.local',
          handle: 'e2e',
          // Spread, so a nameless seed leaves the fields ABSENT rather than
          // setting them to null — which is what the five existing callers
          // have always had, and what keeps "Add your name" appearing for them
          // if any of them ever starts asserting on it.
          ...(name ? { firstName: name.firstName, lastName: name.lastName } : {})
        },
        sessionToken: 'e2e-fake-token'
      })
      // The messaging store keeps its own token (normally set by connect(), which
      // would open the realtime socket); desk chat widgets read it.
      w.__fbMessaging.setState(
        conv
          ? { token: 'e2e-fake-token', conversations: [conv], activeId: conv.id, messagesByConv: { [conv.id]: messages } }
          : { token: 'e2e-fake-token', conversations: [], activeId: null, messagesByConv: {} }
      )
      return true
    },
    { conv, messages, name }
  )
  expect(ok, 'the renderer exposes __fbAccount and __fbMessaging').toBe(true)
  return fake
}
