import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_FILES_PANEL_PREFS,
  FILES_PANEL_MAX_W,
  FILES_PANEL_MIN_W,
  clampPanelWidth,
  filesPanelStorageKey,
  mergeRemoteFilesPanelPrefs,
  parseFilesPanelPrefs,
  readFilesPanelPrefs,
  syncedPart,
  writeFilesPanelPrefs
} from '../../src/renderer/src/lib/filesPanelPrefs'

describe('filesPanelPrefs', () => {
  beforeEach(() => localStorage.clear())

  it('defaults when storage is empty', () => {
    expect(readFilesPanelPrefs('acc-1')).toEqual(DEFAULT_FILES_PANEL_PREFS)
    expect(DEFAULT_FILES_PANEL_PREFS).toMatchObject({ open: false, mode: 'beside', pinned: false, width: 320, view: 'list' })
  })

  it('clamps width to 240–560, and to 45% of the content when known', () => {
    expect(clampPanelWidth(10)).toBe(FILES_PANEL_MIN_W)
    expect(clampPanelWidth(9999)).toBe(FILES_PANEL_MAX_W)
    expect(clampPanelWidth('wide')).toBe(320)
    expect(clampPanelWidth(NaN)).toBe(320)
    expect(clampPanelWidth(500, 800)).toBe(360) // 45% of 800
    expect(clampPanelWidth(500, 300)).toBe(FILES_PANEL_MIN_W) // never below the minimum
  })

  it('keys per account, signed-out is "local"', () => {
    expect(filesPanelStorageKey('abc')).toBe('fb.filesPanel.abc')
    expect(filesPanelStorageKey(null)).toBe('fb.filesPanel.local')
    writeFilesPanelPrefs('a', { ...DEFAULT_FILES_PANEL_PREFS, width: 400, pinned: true })
    writeFilesPanelPrefs('b', { ...DEFAULT_FILES_PANEL_PREFS, width: 260 })
    expect(readFilesPanelPrefs('a')).toMatchObject({ width: 400, pinned: true })
    expect(readFilesPanelPrefs('b')).toMatchObject({ width: 260, pinned: false })
  })

  it('survives storage that throws or holds rubbish', () => {
    localStorage.setItem('fb.filesPanel.x', '{not json')
    expect(readFilesPanelPrefs('x')).toEqual(DEFAULT_FILES_PANEL_PREFS)
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => localStorage.getItem('any')).toThrow() // the seam really throws
    expect(readFilesPanelPrefs('x')).toEqual(DEFAULT_FILES_PANEL_PREFS)
    expect(() => writeFilesPanelPrefs('x', DEFAULT_FILES_PANEL_PREFS)).not.toThrow()
    get.mockRestore()
    set.mockRestore()
  })

  it('parses field by field: bad values fall back, good ones stay', () => {
    const p = parseFilesPanelPrefs({ open: 'yes', mode: 'sideways', pinned: true, width: 700, view: 'grid', float: { x: 10, y: 20, w: 100, h: 900 }, updatedAt: 5 })
    expect(p).toEqual({ open: false, mode: 'beside', pinned: true, width: 560, view: 'grid', float: { x: 10, y: 20, w: 260, h: 900 }, updatedAt: 5 })
    expect(parseFilesPanelPrefs({ float: { x: 'a' } }).float).toBeNull()
  })

  it('the synced part leaves open and the float position on this device', () => {
    const local = { ...DEFAULT_FILES_PANEL_PREFS, open: true, float: { x: 1, y: 2, w: 300, h: 300 }, updatedAt: 10 }
    expect(syncedPart(local)).toEqual({ mode: 'beside', pinned: false, width: 320, view: 'list', updatedAt: 10 })
    const newer = mergeRemoteFilesPanelPrefs(local, { mode: 'float', pinned: true, width: 400, view: 'grid', updatedAt: 20, open: false, float: null })
    expect(newer.next).toEqual({ ...local, mode: 'float', pinned: true, width: 400, view: 'grid', updatedAt: 20 })
    expect(newer.push).toBe(false)
  })

  it('an older or missing account copy keeps this device, and pushes it when it has one', () => {
    const local = { ...DEFAULT_FILES_PANEL_PREFS, width: 300, updatedAt: 50 }
    expect(mergeRemoteFilesPanelPrefs(local, { width: 500, updatedAt: 10 })).toEqual({ next: null, push: true })
    expect(mergeRemoteFilesPanelPrefs(local, null)).toEqual({ next: null, push: true })
    expect(mergeRemoteFilesPanelPrefs(DEFAULT_FILES_PANEL_PREFS, null)).toEqual({ next: null, push: false })
  })
})
