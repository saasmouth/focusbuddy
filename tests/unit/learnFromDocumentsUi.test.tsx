// The "Learn from my documents automatically" switch and what Memory says about
// it (4.3.50). See learnFromDocumentsSwitch.test.ts for the sweep itself.
//
//  - Settings › AI › Local has the switch; it reads and writes the main
//    process's privacy pref learnFromDocuments.
//  - The Memory panel says what is happening: on, PlexiiDesk also learns from
//    your documents on this computer while it is open; off, it says so. Either
//    way "Settings › AI › Local" opens that tab.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LearnFromDocumentsSwitch from '../../src/renderer/src/components/settings/LearnFromDocumentsSwitch'
import MemoryPanel from '../../src/renderer/src/components/brain/MemoryPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let prefs = { autoUpdateChecks: true, backgroundAi: false, learnFromDocuments: true }
const setPrefs = vi.fn(async (patch: Partial<typeof prefs>) => (prefs = { ...prefs, ...patch }))

beforeEach(() => {
  prefs = { autoUpdateChecks: true, backgroundAi: false, learnFromDocuments: true }
  setPrefs.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    privacy: { getPrefs: async () => prefs, setPrefs },
    memory: { list: async () => [], remember: async () => ({}), forget: async () => ({}), extractDocuments: async () => ({ added: 0, scanned: 0 }) },
    localAi: { getStatus: async () => null }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
}

describe('Settings › AI › Local: Learn from my documents automatically', () => {
  it('shows the saved state and turning it off saves off', async () => {
    act(() => root.render(<LearnFromDocumentsSwitch />))
    await settle()
    const box = host.querySelector<HTMLInputElement>('[data-testid="learn-from-documents"]')!
    expect(host.textContent).toContain('Learn from my documents automatically')
    expect(box.checked).toBe(true)
    await act(async () => box.click())
    await settle()
    expect(setPrefs).toHaveBeenCalledWith({ learnFromDocuments: false })
    expect(box.checked).toBe(false)
  })
})

describe('Memory says whether it learns by itself', () => {
  it('on: says PlexiiDesk also learns from your documents, and where to turn it off', async () => {
    act(() => root.render(<MemoryPanel />))
    await settle()
    const line = host.querySelector('[data-testid="memory-auto-learn"]')
    expect(line?.textContent).toContain('PlexiiDesk also learns from your documents on this computer while it is open.')
    expect(line?.textContent).toContain('Turn this off in Settings › AI › Local.')
  })

  it('off: says it is off, and where to turn it on', async () => {
    prefs.learnFromDocuments = false
    act(() => root.render(<MemoryPanel />))
    await settle()
    const line = host.querySelector('[data-testid="memory-auto-learn"]')
    expect(line?.textContent).toContain('Learning from your documents by itself is off.')
    expect(line?.textContent).not.toContain('also learns')
  })

  it('"Settings › AI › Local" opens Settings on the AI tab', async () => {
    const opened: unknown[] = []
    const on = (e: Event): void => void opened.push((e as CustomEvent).detail)
    window.addEventListener('fb:open-settings', on)
    act(() => root.render(<MemoryPanel />))
    await settle()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-auto-learn-settings"]')!.click())
    window.removeEventListener('fb:open-settings', on)
    expect(opened).toEqual([{ tab: 'ai' }])
  })
})
