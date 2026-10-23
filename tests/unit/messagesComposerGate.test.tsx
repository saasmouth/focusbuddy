// PlexiiChat (MessagesView) gates its thread pane and composer on `activeId`,
// not on the conversation summary being loaded (57c37f6). A conversation opened
// from a link, a bell or another device has an id before its summary arrives in
// `conversations`; gating on the summary left that person looking at "Pick a
// conversation" with nowhere to type. The e2e spec cannot sign in, so it only
// reaches the signed-out gate; this mounts the real view with an account.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Every window.api call the view (and the stores it loads) makes resolves to an
// empty result; subscriptions hand back an unsubscribe.
const anyApi = (): unknown =>
  new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' ? undefined : anyApi()),
    apply: () => Object.assign(Promise.resolve([]), { unsubscribe: () => {} })
  })
;(window as unknown as { api: unknown }).api = anyApi()

import MessagesView from '../../src/renderer/src/components/views/MessagesView'
import { useAccountStore } from '../../src/renderer/src/stores/account'
import { useMessagingStore } from '../../src/renderer/src/stores/messaging'

let host: HTMLDivElement
let root: Root
const composer = (): Element | null => host.querySelector('[data-testid="message-composer"]')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useAccountStore.setState({ sessionToken: 'test-token', account: { id: 'u1', handle: 'me', displayName: 'Me', email: 'me@example.com' } as never })
  useMessagingStore.setState({ conversations: [], activeId: null })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAccountStore.setState({ account: null, sessionToken: null })
  useMessagingStore.setState({ conversations: [], activeId: null })
})

describe('PlexiiChat composer gate (57c37f6)', () => {
  it('no conversation open: the empty state, no composer', () => {
    act(() => root.render(<MessagesView />))
    expect(host.textContent).toContain('Pick a conversation, or start a new one.')
    expect(composer()).toBeNull()
  })

  it('an open conversation whose summary has not loaded yet still gets the composer', () => {
    useMessagingStore.setState({ activeId: 'conv-not-in-the-list', conversations: [] })
    act(() => root.render(<MessagesView />))
    expect(host.textContent).not.toContain('Pick a conversation, or start a new one.')
    expect(composer()).not.toBeNull()
  })

  it('signed out: the sign-in gate, never the composer', () => {
    useAccountStore.setState({ account: null, sessionToken: null })
    useMessagingStore.setState({ activeId: 'conv-1', conversations: [] })
    act(() => root.render(<MessagesView />))
    expect(host.querySelector('h1')?.textContent).toBe('Messages')
    expect(composer()).toBeNull()
  })
})
