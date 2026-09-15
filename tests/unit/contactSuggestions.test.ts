import { describe, it, expect } from 'vitest'
import {
  suggestContacts,
  looksLikeAPerson,
  nameFromAddress
} from '../../src/shared/contactSuggestions'
import type { Contact } from '../../src/shared/types'

const contact = (over: Partial<Contact> & { id: string }): Contact =>
  ({
    name: 'X',
    email: null,
    phone: null,
    company: null,
    role: null,
    address: null,
    notes: null,
    kind: 'guest',
    accountId: null,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over
  }) as Contact

describe('looksLikeAPerson', () => {
  it('accepts an ordinary address', () => {
    expect(looksLikeAPerson('sarah@ljhooker.com.au')).toBe(true)
  })
  it('rejects the addresses no human reads', () => {
    // Suggesting these is the fastest way to make the feature feel careless.
    for (const a of [
      'noreply@stripe.com',
      'no-reply@x.com',
      'do-not-reply@bank.com',
      'notifications@github.com',
      'billing@aws.com',
      'newsletter@substack.com',
      'postmaster@mail.com',
      'automated@ci.example'
    ]) {
      expect(looksLikeAPerson(a), a).toBe(false)
    }
  })
  it('rejects a person-looking address with a robot display name', () => {
    expect(looksLikeAPerson('mail@acme.com', 'Acme Notifications')).toBe(false)
  })
  it('rejects things that are not addresses', () => {
    expect(looksLikeAPerson('')).toBe(false)
    expect(looksLikeAPerson('sarah')).toBe(false)
  })
})

describe('nameFromAddress', () => {
  it('makes a readable name out of a local part', () => {
    expect(nameFromAddress('sarah.whitfield@x.com')).toBe('Sarah Whitfield')
    expect(nameFromAddress('david_chen@x.com')).toBe('David Chen')
  })
  it('falls back to the address when there is nothing to read', () => {
    expect(nameFromAddress('123@x.com')).toBe('123@x.com')
  })
})

describe('suggestContacts', () => {
  const mail = [
    { fromName: 'Sarah Whitfield', fromAddress: 'sarah@x.com' },
    { fromName: 'Sarah Whitfield', fromAddress: 'sarah@x.com' },
    { fromName: 'Sarah Whitfield', fromAddress: 'sarah@x.com' },
    { fromName: 'David Chen', fromAddress: 'david@x.com' },
    { fromName: 'Stripe', fromAddress: 'noreply@stripe.com' }
  ]

  it('suggests people from mail, counting how often they wrote', () => {
    const out = suggestContacts({ mail })
    const sarah = out.find((s) => s.email === 'sarah@x.com')
    expect(sarah?.reason).toBe('emailed you 3 times')
    expect(out.find((s) => s.email === 'david@x.com')?.reason).toBe('emailed you once')
  })

  it('never suggests a no-reply sender', () => {
    expect(suggestContacts({ mail }).some((s) => s.email?.includes('noreply'))).toBe(false)
  })

  it('orders by evidence, not alphabetically', () => {
    // The person who wrote three times should be asked about before the one
    // who wrote once.
    const out = suggestContacts({ mail })
    expect(out[0].email).toBe('sarah@x.com')
  })

  it('suggests task assignees, with no invented address', () => {
    const out = suggestContacts({ assignees: ['Michael', 'Michael', 'Priya'] })
    const m = out.find((s) => s.name === 'Michael')
    expect(m?.reason).toBe('assigned 2 tasks here')
    // Inventing an address for a name somebody typed would be a fabrication.
    expect(m?.email).toBeNull()
    expect(out.find((s) => s.name === 'Priya')?.reason).toBe('assigned 1 task here')
  })

  it('suggests meeting organisers and org members, each saying why', () => {
    const out = suggestContacts({
      organisers: ['emma@x.com'],
      orgMembers: [{ accountId: 'a1', name: 'Tom Adams', email: 'tom@x.com' }]
    })
    expect(out.find((s) => s.email === 'emma@x.com')?.reason).toBe('organised a meeting')
    expect(out.find((s) => s.accountId === 'a1')?.reason).toBe('in your organisation')
  })

  it('adds weight when somebody appears in two places', () => {
    const both = suggestContacts({
      mail: [{ fromName: 'Sarah', fromAddress: 'sarah@x.com' }],
      organisers: ['sarah@x.com']
    })
    const only = suggestContacts({ mail: [{ fromName: 'Sarah', fromAddress: 'sarah@x.com' }] })
    expect(both[0].weight).toBeGreaterThan(only[0].weight)
    // ...and still one row, not two.
    expect(both).toHaveLength(1)
  })

  it('never suggests somebody who is already a contact', () => {
    const existing = [contact({ id: 'c1', name: 'Sarah Whitfield', email: 'sarah@x.com' })]
    expect(suggestContacts({ mail, existing }).some((s) => s.email === 'sarah@x.com')).toBe(false)
  })

  it('matches an existing contact by name for assignees, which have no address', () => {
    const existing = [contact({ id: 'c1', name: 'Michael' })]
    expect(suggestContacts({ assignees: ['Michael'], existing })).toEqual([])
  })

  it('never suggests the user to themselves', () => {
    const out = suggestContacts({ mail, self: ['sarah@x.com'] })
    expect(out.some((s) => s.email === 'sarah@x.com')).toBe(false)
  })

  it('returns nothing when there is nothing to go on', () => {
    // An honest empty list: no sources means no people, not invented ones.
    expect(suggestContacts({})).toEqual([])
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      fromName: `P${i}`,
      fromAddress: `p${i}@x.com`
    }))
    expect(suggestContacts({ mail: many }, 5)).toHaveLength(5)
  })
})
