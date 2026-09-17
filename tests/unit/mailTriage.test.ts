import { describe, it, expect } from 'vitest'
import { applyTriageRules, isUsableFolderName, type TriageContext } from '../../src/shared/mailTriage'

// The model reads an inbox well and knows nothing about what it is allowed to
// do with one. These rules are where "allowed" is decided, so they are a
// guarantee rather than a request — which a prompt could only ever be.

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  existingFolders: ['Clients', 'Receipts'],
  unsubscribable: new Set([2]),
  known: new Set([1, 2, 3, 4]),
  ...over
})

describe('applyTriageRules', () => {
  it('files into an existing folder, matching case-insensitively', () => {
    const p = applyTriageRules([{ uid: 1, action: 'file', folder: 'clients', reason: 'from a client' }], ctx())
    expect(p.suggestions[0]).toMatchObject({ uid: 1, action: 'file', folder: 'Clients', newFolder: false })
    expect(p.newFolders).toEqual([])
  })

  it('marks a folder that would be created, and lists it once', () => {
    const p = applyTriageRules(
      [
        { uid: 1, action: 'file', folder: 'Invoices', reason: 'a bill' },
        { uid: 3, action: 'file', folder: 'Invoices', reason: 'another bill' }
      ],
      ctx()
    )
    expect(p.suggestions.every((s) => s.newFolder)).toBe(true)
    expect(p.newFolders).toEqual(['Invoices'])
  })

  // The sharp one. A model will offer to unsubscribe from anything.
  it('refuses an unsubscribe the sender never offered, and says why', () => {
    const p = applyTriageRules([{ uid: 1, action: 'unsubscribe', reason: 'looks like a newsletter' }], ctx())
    expect(p.suggestions[0].action).toBe('keep')
    expect(p.rejected[0].proposed).toBe('unsubscribe')
    expect(p.rejected[0].because).toContain('List-Unsubscribe')
  })

  it('allows an unsubscribe when the sender did publish one', () => {
    const p = applyTriageRules([{ uid: 2, action: 'unsubscribe', reason: 'weekly marketing' }], ctx())
    expect(p.suggestions[0].action).toBe('unsubscribe')
    expect(p.rejected).toEqual([])
  })

  it('refuses to file into the folders the mail client owns', () => {
    for (const folder of ['Inbox', 'Trash', 'Junk', 'Sent', 'Archive', 'All Mail']) {
      const p = applyTriageRules([{ uid: 1, action: 'file', folder, reason: 'x' }], ctx())
      expect(p.suggestions, folder).toEqual([])
      expect(p.rejected[0].because).toContain('usable folder name')
    }
  })

  it('refuses folder names that would nest somewhere unintended', () => {
    for (const folder of ['Clients/Acme', 'a\\\\b', '', '   ', 'x'.repeat(61)]) {
      expect(isUsableFolderName(folder), folder).toBe(false)
    }
    expect(isUsableFolderName('Q4 Invoices')).toBe(true)
  })

  // A plan that silently drops a third of its own suggestions is one nobody
  // can reason about.
  it('reports what it refused rather than quietly dropping it', () => {
    const p = applyTriageRules(
      [
        { uid: 99, action: 'trash', reason: 'not in this batch' },
        { uid: 1, action: 'incinerate', reason: 'invented action' },
        { uid: 3, action: 'file', reason: 'no folder given' }
      ],
      ctx()
    )
    expect(p.suggestions).toEqual([])
    expect(p.rejected).toHaveLength(3)
    expect(p.rejected.map((r) => r.because)).toEqual([
      expect.stringContaining('not a message in this batch'),
      expect.stringContaining('not an action this surface offers'),
      expect.stringContaining('usable folder name')
    ])
  })

  it('keeps the first word on a uid, and survives junk input', () => {
    const p = applyTriageRules(
      [{ uid: 1, action: 'trash', reason: 'first' }, { uid: 1, action: 'spam', reason: 'second' }],
      ctx()
    )
    expect(p.suggestions).toHaveLength(1)
    expect(p.suggestions[0].action).toBe('trash')
    expect(applyTriageRules(null, ctx()).suggestions).toEqual([])
    expect(applyTriageRules(['nope', 42, null], ctx()).suggestions).toEqual([])
  })

  it('carries a reason through, so a suggestion can be checked', () => {
    const p = applyTriageRules([{ uid: 4, action: 'trash', reason: 'a delivery notice from six weeks ago' }], ctx())
    expect(p.suggestions[0].reason).toBe('a delivery notice from six weeks ago')
  })
})
