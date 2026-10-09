import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_MODE,
  MODE_META,
  MODE_ORDER,
  getDefaultBodyDoubleMode,
  isBodyDoubleMode,
  setDefaultBodyDoubleMode
} from '../../src/renderer/src/lib/bodyDoubleModes'

const KEY = 'fb.bodyDouble.defaultMode'

describe('body double modes', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('describes every mode, quietest first', () => {
    expect(MODE_ORDER).toEqual(['silent', 'greetings', 'light', 'open'])
    for (const m of MODE_ORDER) {
      expect(MODE_META[m].label.length).toBeGreaterThan(0)
      expect(MODE_META[m].tagline.length).toBeGreaterThan(0)
      expect(MODE_META[m].icon.length).toBeGreaterThan(0)
    }
  })

  it('defaults to the quietest mode when nothing is saved', () => {
    expect(FALLBACK_MODE).toBe('silent')
    expect(getDefaultBodyDoubleMode()).toBe('silent')
  })

  it('round-trips a saved choice', () => {
    setDefaultBodyDoubleMode('light')
    expect(localStorage.getItem(KEY)).toBe('light')
    expect(getDefaultBodyDoubleMode()).toBe('light')
  })

  it('falls back rather than trusting a corrupted value', () => {
    // This is read during render, so it must never throw or return nonsense.
    localStorage.setItem(KEY, 'loudest-possible')
    expect(getDefaultBodyDoubleMode()).toBe('silent')
    expect(isBodyDoubleMode('loudest-possible')).toBe(false)
    expect(isBodyDoubleMode('open')).toBe(true)
  })

  it('survives localStorage throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(getDefaultBodyDoubleMode()).toBe('silent')
    spy.mockRestore()

    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    // Must not throw: the chosen mode still drives the session in front of them.
    expect(() => setDefaultBodyDoubleMode('open')).not.toThrow()
    setSpy.mockRestore()
  })

  it('announces a change so other open surfaces follow', () => {
    const seen: string[] = []
    const onChange = (e: Event): void => {
      seen.push((e as CustomEvent<{ mode: string }>).detail.mode)
    }
    window.addEventListener('fb:body-double-mode-changed', onChange)
    setDefaultBodyDoubleMode('greetings')
    window.removeEventListener('fb:body-double-mode-changed', onChange)
    expect(seen).toEqual(['greetings'])
  })
})
