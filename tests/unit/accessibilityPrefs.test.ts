import { describe, it, expect, beforeEach } from 'vitest'

// A minimal in-memory localStorage, since the test env doesn't provide one.
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0
} as Storage

import { telemetryEnabled, setTelemetryEnabled } from '../../src/renderer/src/lib/telemetryPrefs'
import { loadUiScale, saveUiScale } from '../../src/renderer/src/lib/uiScale'

// The two Boomer-council fixes that are pure + storage-backed: the telemetry
// opt-out must actually stick (it used to do nothing), and the text-size must
// persist and stay in a sane range.

beforeEach(() => localStorage.clear())

describe('usage reporting opt-in', () => {
  it('defaults to off, and an explicit choice persists and is honoured', () => {
    expect(telemetryEnabled()).toBe(false) // opt-in: never chose means off
    setTelemetryEnabled(true)
    expect(telemetryEnabled()).toBe(true)
    setTelemetryEnabled(false)
    expect(telemetryEnabled()).toBe(false)
  })
})

describe('UI text size', () => {
  it('defaults to 1 and round-trips a chosen scale', () => {
    expect(loadUiScale()).toBe(1)
    saveUiScale(1.3)
    expect(loadUiScale()).toBe(1.3)
  })
  it('rejects out-of-range stored values, falling back to default', () => {
    localStorage.setItem('plexi.ui.scale', '5')
    expect(loadUiScale()).toBe(1)
    localStorage.setItem('plexi.ui.scale', 'nonsense')
    expect(loadUiScale()).toBe(1)
  })
})
