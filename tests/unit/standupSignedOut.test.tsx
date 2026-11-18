// Signed out, Home's Standup tile says why it is empty (4.3.50).
//
// StandupHome rendered nothing without an account, but Home still draws its
// glass tile, so a signed-out Home showed a blank Standup card (seen capturing
// 4.3.48 screens, 2026-11-17). Signed out, the card now keeps its title and
// says that the standup needs an account, as the chat work widget does. It
// asks the server for nothing.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StandupHome from '../../src/renderer/src/components/views/StandupHome'
import { useAccountStore } from '../../src/renderer/src/stores/account'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const standup = vi.fn()

beforeEach(() => {
  standup.mockReset()
  ;(window as unknown as { api: unknown }).api = { ai: { standup } }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Standup on Home, signed out', () => {
  it('shows its title and that it needs an account, not a blank card', () => {
    useAccountStore.setState({ account: null, sessionToken: null } as never)
    act(() => root.render(<StandupHome />))
    const card = host.querySelector('[data-testid="standup-home"]')
    expect(card, 'the Standup card renders something').not.toBeNull()
    expect(card!.textContent).toContain('Your standup')
    expect(card!.textContent).toContain('Sign in to get your daily standup')
    expect(standup).not.toHaveBeenCalled()
  })
})
