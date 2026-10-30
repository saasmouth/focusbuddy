import { describe, it, expect, vi } from 'vitest'
import {
  scoreMetadata,
  METADATA_SIGNALS,
  type MetadataCandidate
} from '../../src/main/metadataRecall'

// Finding related things by their METADATA, not by waiting on a full-text or
// vector pass over everything (asked for 2026-10-30: "use a table of meta data
// to find appropriate related things, not time based … only use logical things
// that are likely to surface related info").
//
// fb_document_metadata already holds what a local pass distilled from each
// document — its keywords, the entities it names, its category, a summary.
// Until now that was used only to DECORATE a result that something else had
// already found. So a question about "Acme" missed a document whose body says
// "the client" throughout and whose entities list says Acme.
//
// This is recall, never a filter: it can only ADD a candidate, so nothing that
// used to be findable stops being findable.

function meta(over: Partial<MetadataCandidate> & { docId: string }): MetadataCandidate {
  return { title: '', summary: '', category: '', entities: [], keywords: [], ...over }
}

describe('scoreMetadata — the signals that actually mean "related"', () => {
  it('finds a document by an entity its body never spells out', () => {
    const s = scoreMetadata('what did we agree with Acme', meta({ docId: 'd1', entities: ['Acme Corp'] }))
    expect(s).toBeGreaterThan(0)
  })

  it('finds a document by its distilled keywords', () => {
    expect(
      scoreMetadata('honeymoon flights', meta({ docId: 'd1', keywords: ['honeymoon', 'flights', 'bali'] }))
    ).toBeGreaterThan(0)
  })

  it('finds a document by its category when the question names one', () => {
    expect(scoreMetadata('show me the invoices', meta({ docId: 'd1', category: 'invoice' }))).toBeGreaterThan(0)
  })

  it('weights a named entity above a passing word in a summary', () => {
    const entity = scoreMetadata('the Acme renewal', meta({ docId: 'a', entities: ['Acme'] }))
    const summary = scoreMetadata('the Acme renewal', meta({ docId: 'b', summary: 'Acme is mentioned once here.' }))
    expect(entity).toBeGreaterThan(summary)
  })

  it('scores an unrelated document zero', () => {
    expect(
      scoreMetadata('honeymoon destinations', meta({ docId: 'd1', keywords: ['payroll', 'tax'], category: 'finance' }))
    ).toBe(0)
  })

  it('ignores filler, so a question does not match everything', () => {
    expect(scoreMetadata('can you add the top thing', meta({ docId: 'd1', keywords: ['top'] }))).toBe(0)
  })

  it('matches words, not substrings — the same rule as everywhere else', () => {
    expect(scoreMetadata('top destinations', meta({ docId: 'd1', keywords: ['laptop'] }))).toBe(0)
  })

  it('says which signals it uses, and uses nothing time-based', () => {
    // The owner's constraint: logical relations only. A document is not
    // related to a question because it was edited recently.
    expect(METADATA_SIGNALS).toEqual(['entities', 'keywords', 'title', 'category', 'summary'])
    expect(METADATA_SIGNALS).not.toContain('enrichedAt')
    expect(METADATA_SIGNALS).not.toContain('updatedAt')
  })
})

// ── Wired into retrieval, not just scored in isolation ─────────────────────
describe('retrieveSources surfaces a document only its metadata relates', () => {
  const EMPTY = { sources: [], rounds: 0, exhausted: false, fetched: 0 }

  async function search(query: string): Promise<Array<{ docId: string; title: string }>> {
    vi.resetModules()
    // Every other pool returns nothing, so anything that comes back came
    // from the metadata table.
    vi.doMock('../../src/main/semanticRetrieval', () => ({ semanticSearchKnowledge: async () => [] }))
    vi.doMock('../../src/main/documentRetrieval', () => ({ semanticSearchDocuments: async () => [] }))
    vi.doMock('../../src/main/passageRetrieval', () => ({ passageSearchDocuments: async () => [] }))
    vi.doMock('../../src/main/chunkIndex', () => ({
      chunkIndexActive: () => true,
      chunkSearchWidgets: () => [],
      chunkSearchFiles: () => [],
      chunkSearchChats: () => []
    }))
    vi.doMock('../../src/main/workspaceExtras', () => ({ collectExtraSources: () => [] }))
    vi.doMock('../../src/main/segmentRecall', () => ({ meetingRecallSources: () => [] }))
    vi.doMock('../../src/main/mailGrounding', () => ({ mailGroundingForQuestion: async () => EMPTY }))
    vi.doMock('../../src/main/db/database', () => ({ getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }) }) }))
    vi.doMock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal' }))
    vi.doMock('../../src/main/db/documents', () => ({
      listDocuments: () => [{ id: 'd1', title: 'Kickoff call notes', docType: 'doc' }],
      // The body never names the entity — "the client" throughout. This is
      // the document the old retrieval could not reach.
      getDocument: () => ({
        docType: 'doc',
        body: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'The client wants the renewal signed before the quarter closes.' }]
            }
          ]
        }
      })
    }))
    vi.doMock('../../src/main/db/docMetadata', () => ({
      listDocMetadata: () =>
        new Map([
          [
            'd1',
            {
              docId: 'd1',
              summary: 'Kickoff with the client.',
              category: 'meeting-notes',
              entities: ['Acme Corp'],
              dates: [],
              keywords: ['renewal', 'kickoff'],
              language: 'en',
              wordCount: 12,
              model: 'local',
              enrichedAt: 0
            }
          ]
        ]),
      getDocMetadata: () => null
    }))
    const { retrieveSources } = await import('../../src/main/workspaceSearch')
    const out = await retrieveSources(query)
    return out.map((s) => ({ docId: s.docId, title: s.title }))
  }

  it('finds it by an entity the body never spells out', async () => {
    const hits = await search('what did we agree with Acme')
    expect(hits.map((h) => h.docId)).toContain('d1')
  })

  it('finds it by a distilled keyword', async () => {
    expect((await search('where are we on the renewal')).map((h) => h.docId)).toContain('d1')
  })

  it('does not drag it into an unrelated question', async () => {
    // Recall, not a free pass: no signal matches, so nothing comes back.
    expect(await search('honeymoon destinations in fiji')).toEqual([])
  })
})
