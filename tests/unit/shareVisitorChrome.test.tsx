// What a visitor on a shared desk does not see (found by 23 on the owner's live
// link "1 · All Widgets Tour", 2026-11-08): the sender's load meter (a red
// "42 Overloaded" pill reads as an error to a stranger), the Pro upgrade card (a
// visitor has no account; "Download this desk" is their door) and the desk's
// AI suggestions ("You have a table but no agent. Set it up": an AI action the
// page would gate anyway). Each is rendered as it always was everywhere else.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'

let recipient = true
vi.mock('../../src/renderer/src/lib/shareMode', () => ({
  isShareRecipient: () => recipient,
  shareCanAdd: () => !recipient
}))
// The inner components read stores; a visitor's never gets that far, and the
// sender's case below only needs them to render SOMETHING.
vi.mock('../../src/renderer/src/stores/capabilities', () => ({ useStoredTier: () => 'free' }))
vi.mock('../../src/renderer/src/lib/planDisplay', () => ({ showsProUpsell: () => true }))

import LoadMeter from '../../src/renderer/src/components/LoadMeter'
import UpgradeCard from '../../src/renderer/src/components/UpgradeCard'
import DeskSuggestionChip from '../../src/renderer/src/components/DeskSuggestionChip'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  recipient = true
})

function render(c: ComponentType<Record<string, unknown>>, props: Record<string, unknown> = {}): void {
  act(() => root.render(createElement(c, props)))
}

describe('a visitor on a shared desk', () => {
  it('sees no load meter, however loaded the desk', () => {
    render(LoadMeter as ComponentType<Record<string, unknown>>, { variant: 'header' })
    expect(host.innerHTML).toBe('')
  })
  it('sees no upgrade card', () => {
    render(UpgradeCard as ComponentType<Record<string, unknown>>, { label: 'Desk' })
    expect(host.innerHTML).toBe('')
  })
  it('sees no desk suggestion', () => {
    render(DeskSuggestionChip as ComponentType<Record<string, unknown>>)
    expect(host.innerHTML).toBe('')
  })
})

describe('the person whose desk it is', () => {
  it('still sees the load meter and the upgrade card', () => {
    recipient = false
    render(LoadMeter as ComponentType<Record<string, unknown>>, { variant: 'header' })
    expect(host.querySelector('[data-testid="load-meter"]')).not.toBeNull()
    act(() => root.render(createElement(UpgradeCard, { label: 'Desk' })))
    expect(host.querySelector('[data-testid="upgrade-card"]')).not.toBeNull()
  })
})
