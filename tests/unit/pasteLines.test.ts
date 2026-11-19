// Several pasted lines become several list items (lib/pasteLines).
import { describe, it, expect } from 'vitest'
import { pastedListItems } from '../../src/renderer/src/lib/pasteLines'

describe('pastedListItems', () => {
  it('one item per line, list marks gone, ticked lines done, blank lines skipped', () => {
    expect(pastedListItems('- Buy milk\n* Call Ann\n\n1. Book flights\n2) Pack\n[x] Renew passport\n- [ ] Print tickets\n☑ Pay rent\n• Water plants')).toEqual([
      { title: 'Buy milk', done: false },
      { title: 'Call Ann', done: false },
      { title: 'Book flights', done: false },
      { title: 'Pack', done: false },
      { title: 'Renew passport', done: true },
      { title: 'Print tickets', done: false },
      { title: 'Pay rent', done: true },
      { title: 'Water plants', done: false }
    ])
  })
  it('a spreadsheet column reads its tabs as spaces; Windows line ends work', () => {
    expect(pastedListItems('Ann\tNYC\r\nBob\tLA')).toEqual([
      { title: 'Ann NYC', done: false },
      { title: 'Bob LA', done: false }
    ])
  })
  it('one line is not a list', () => {
    expect(pastedListItems('Just one task')).toBeNull()
    expect(pastedListItems('Just one task\n\n')).toBeNull()
    expect(pastedListItems('- \n- real')).toBeNull()
  })
  it('a number that is the task is kept', () => {
    expect(pastedListItems('2026 budget\n10 push-ups')).toEqual([
      { title: '2026 budget', done: false },
      { title: '10 push-ups', done: false }
    ])
  })
})
