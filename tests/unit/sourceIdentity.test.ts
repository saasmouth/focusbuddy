import { describe, it, expect } from 'vitest'
import { sourceIdentity } from '../../src/renderer/src/lib/sourceIdentity'

// F2: every retrievable kind wears an identity; unknown kinds wear none
// (a neutral row beats a wrong colour claiming a kind it isn't).

describe('sourceIdentity', () => {
  it('covers every kind the retrieval pools emit', () => {
    for (const kind of ['knowledge', 'doc', 'sheet', 'slides', 'task', 'table', 'note']) {
      const id = sourceIdentity(kind)
      expect(id, kind).not.toBeNull()
      expect(id!.icon.length).toBeGreaterThan(0)
      expect(id!.tone).toMatch(/^text-/)
      expect(id!.location.length).toBeGreaterThan(0)
    }
  })
  it('is honest about kinds it does not know', () => {
    expect(sourceIdentity('mystery')).toBeNull()
    expect(sourceIdentity(undefined)).toBeNull()
  })
  it('keys documents and knowledge to their areas', () => {
    expect(sourceIdentity('doc')!.location).toBe('Documents')
    expect(sourceIdentity('knowledge')!.location).toBe('PlexiiBrain')
  })
})

describe('A2 reach identities (#16/#17)', () => {
  it('every retrievable type wears an identity in the trace', () => {
    for (const type of ['living-doc', 'card', 'custom-block', 'field', 'agent', 'mindmap', 'diagram', 'chart', 'file', 'chat']) {
      const id = sourceIdentity(type)
      expect(id, type).not.toBeNull()
      expect(id?.icon).toBeTruthy()
      expect(id?.tone).toBeTruthy()
      expect(id?.location).toBeTruthy()
    }
  })

  it('widget kinds wear the desks tone — colour answers WHERE', () => {
    expect(sourceIdentity('living-doc')?.tone).toBe(sourceIdentity('note')?.tone)
    expect(sourceIdentity('chart')?.tone).toBe(sourceIdentity('task')?.tone)
  })
})
