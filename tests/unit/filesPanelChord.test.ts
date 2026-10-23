import { describe, it, expect } from 'vitest'
import { isFilesPanelChord, filesPanelChordLabel, type ChordKey } from '../../src/renderer/src/lib/filesPanelChord'

const k = (over: Partial<ChordKey> = {}): ChordKey => ({ code: 'KeyF', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, ...over })

describe('⌥⌘F chord matcher', () => {
  it('matches ⌥⌘F and Ctrl+Alt+F by code', () => {
    expect(isFilesPanelChord(k())).toBe(true)
    expect(isFilesPanelChord(k({ metaKey: false, ctrlKey: true }))).toBe(true)
  })
  it('needs Option/Alt AND ⌘/Ctrl', () => {
    expect(isFilesPanelChord(k({ altKey: false }))).toBe(false) // ⌘F is Find
    expect(isFilesPanelChord(k({ metaKey: false }))).toBe(false)
  })
  it('never with Shift (Draw binds ⌥⇧⌘F), never another key, never a repeat', () => {
    expect(isFilesPanelChord(k({ shiftKey: true }))).toBe(false)
    expect(isFilesPanelChord(k({ code: 'KeyG' }))).toBe(false)
    expect(isFilesPanelChord(k({ repeat: true }))).toBe(false)
  })
  it('steps aside for AltGr (a character on some Windows layouts)', () => {
    expect(isFilesPanelChord(k({ metaKey: false, ctrlKey: true, getModifierState: (m) => m === 'AltGraph' }))).toBe(false)
    expect(isFilesPanelChord(k({ getModifierState: () => false }))).toBe(true)
    expect(isFilesPanelChord(k({ getModifierState: () => { throw new Error('x') } }))).toBe(true)
  })
  it('is read on code, not key: Option turns F into ƒ on a Mac', () => {
    expect(isFilesPanelChord({ ...k(), key: 'ƒ' } as ChordKey)).toBe(true)
  })
  it('labels per platform', () => {
    expect(filesPanelChordLabel('darwin')).toBe('⌥⌘F')
    expect(filesPanelChordLabel('win32')).toBe('Ctrl+Alt+F')
  })
})
