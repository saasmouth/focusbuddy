// The contract helper must catch what it claims to catch, or every surface's
// guard is green for free.

import { describe, expect, it } from 'vitest'
import { expectMenuContract, groupsOf } from './_menuContract'

const ok = [
  { label: 'Open' },
  { separator: true },
  { label: 'Cut', shortcut: '⌘X' },
  { label: 'Copy', shortcut: '⌘C' },
  { separator: true },
  { label: 'Ask PlexiiAssist' },
  { label: 'Add to Focus…' },
  { separator: true },
  { label: 'Move to Trash', danger: true }
]

const fails = (items: unknown[]): void => {
  expect(() => expectMenuContract(items as never)).toThrow()
}

describe('expectMenuContract', () => {
  it('passes a menu that keeps the contract', () => {
    expectMenuContract(ok)
    expect(groupsOf(ok)).toEqual([['Open'], ['Cut', 'Copy'], ['Ask PlexiiAssist', 'Add to Focus…'], ['Move to Trash']])
  })
  it('asserts the groups when given', () => {
    expect(() => expectMenuContract(ok, { groups: [['Open'], ['Cut', 'Copy']] })).toThrow()
  })
  it('fails "..."', () => fails([{ label: 'Rename...' }]))
  it('fails a retired label', () => fails([{ label: 'Move to trash' }]))
  it('fails Title Case', () => fails([{ label: 'Copy Link' }]))
  it('keeps proper nouns', () => expectMenuContract([{ label: 'Ask PlexiiAssist about this' }, { label: 'Remove from Focus' }]))
  it('fails a destructive row not behind a separator', () => fails([{ label: 'Open' }, { label: 'Move to Trash', danger: true }]))
  it('fails a row after a destructive one', () => fails([{ label: 'Open' }, { separator: true }, { label: 'Move to Trash', danger: true }, { label: 'Rename' }]))
  it('fails a disabled row without a reason', () => fails([{ label: 'Paste', disabled: true }]))
  it('fails ⌘⇧ order', () => fails([{ label: 'Redo', shortcut: '⌘⇧Z' }]))
  it('fails stray separators', () => {
    fails([{ separator: true }, { label: 'Open' }])
    fails([{ label: 'Open' }, { separator: true }])
    fails([{ label: 'Open' }, { separator: true }, { separator: true }, { label: 'Rename' }])
  })
  it('fails a hint on a shared action with no bound key', () => fails([{ label: 'Rename', shortcut: '⌘R' }]))
  it('checks submenus too', () => fails([{ label: 'Share', children: [{ label: 'Copy URL' }] }]))
})
