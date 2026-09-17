import { describe, it, expect } from 'vitest'
import { normalizeMailboxPath, pickSpecialBox } from '../../src/main/mail/imap'

describe('normalizeMailboxPath', () => {
  it('keeps an ordinary name as-is', () => {
    expect(normalizeMailboxPath('Receipts')).toBe('Receipts')
    expect(normalizeMailboxPath('  Receipts  ')).toBe('Receipts')
  })

  it('strips leading and trailing separators that would nest it elsewhere', () => {
    // On a server whose hierarchy separator is '.', '.Receipts' is not a
    // folder called Receipts.
    expect(normalizeMailboxPath('.Receipts')).toBe('Receipts')
    expect(normalizeMailboxPath('Receipts/')).toBe('Receipts')
    expect(normalizeMailboxPath('/Receipts/')).toBe('Receipts')
    expect(normalizeMailboxPath('..Receipts..')).toBe('Receipts')
  })

  it('leaves a deliberate interior hierarchy alone', () => {
    expect(normalizeMailboxPath('Clients/Dolan')).toBe('Clients/Dolan')
  })

  it('refuses a name that is only separators or whitespace', () => {
    expect(() => normalizeMailboxPath('   ')).toThrow(/needs a name/)
    expect(() => normalizeMailboxPath('...')).toThrow(/needs a name/)
    expect(() => normalizeMailboxPath('')).toThrow(/needs a name/)
  })
})

describe('pickSpecialBox', () => {
  const TRASH = /^(trash|deleted items|bin)$/i

  it('prefers the server’s own SPECIAL-USE flag over any name', () => {
    // The localised case: trusting the name would create an English "Trash"
    // beside the real one and split the mailbox in two.
    const boxes = [
      { path: 'Papierkorb', name: 'Papierkorb', specialUse: '\\Trash' },
      { path: 'Trash', name: 'Trash' }
    ]
    expect(pickSpecialBox(boxes, '\\Trash', TRASH, 'Trash')).toEqual({
      path: 'Papierkorb',
      needsCreate: false
    })
  })

  it('falls back to a name match when the server flags nothing', () => {
    const boxes = [{ path: 'Deleted Items', name: 'Deleted Items' }]
    expect(pickSpecialBox(boxes, '\\Trash', TRASH, 'Trash')).toEqual({
      path: 'Deleted Items',
      needsCreate: false
    })
  })

  it('matches a name case-insensitively', () => {
    const boxes = [{ path: 'BIN', name: 'BIN' }]
    expect(pickSpecialBox(boxes, '\\Trash', TRASH, 'Trash').path).toBe('BIN')
  })

  it('only asks for a new folder when nothing matched at all', () => {
    expect(pickSpecialBox([], '\\Trash', TRASH, 'Trash')).toEqual({
      path: 'Trash',
      needsCreate: true
    })
    const unrelated = [{ path: 'Archive', name: 'Archive', specialUse: '\\Archive' }]
    expect(pickSpecialBox(unrelated, '\\Trash', TRASH, 'Trash').needsCreate).toBe(true)
  })

  it('does not mistake one special use for another', () => {
    // A Junk lookup must never land in Trash, however alphabetically close the
    // flags are -- these are different outcomes for the person.
    const boxes = [{ path: 'Trash', name: 'Trash', specialUse: '\\Trash' }]
    const junk = pickSpecialBox(boxes, '\\Junk', /^(junk|spam|bulk mail)$/i, 'Junk')
    expect(junk).toEqual({ path: 'Junk', needsCreate: true })
  })

  it('respects a nested path the server reports', () => {
    const boxes = [{ path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash' }]
    expect(pickSpecialBox(boxes, '\\Trash', TRASH, 'Trash').path).toBe('INBOX.Trash')
  })
})
