import { describe, it, expect } from 'vitest'
import {
  linkModesFor,
  ORG_SNIPPET_REACH_NOTE,
  ORG_SNIPPETS_SYNC,
  snippetBodyIsEmpty,
  snippetBodyMatchesKind,
  snippetMatches,
  snippetSummary,
  targetAccepts,
  canRenderNatively,
  instanceModeFor,
  primaryKindFor,
  type Snippet,
  type SnippetBody,
  type SnippetTarget
} from '../../src/shared/snippets'

// The snippet substrate's rules, which both the main process and the renderer
// run. They are pure on purpose: the library's own filtering and the SQL-backed
// query must agree on what "matches" means, and a surface must not be offered a
// link mode it cannot honour.

function snippet(over: Partial<Snippet> = {}): Snippet {
  const body: SnippetBody = over.body ?? { kind: 'doc', content: [{ type: 'paragraph' }], text: 'hello' }
  return {
    id: 's1',
    kind: body.kind,
    name: 'Payment terms',
    description: 'Net 30 wording',
    body,
    tags: ['legal'],
    scope: 'personal',
    orgId: 'personal',
    authorId: null,
    revision: 1,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function target(over: Partial<SnippetTarget> = {}): SnippetTarget {
  return {
    id: 'doc:1',
    label: 'This document',
    accepts: ['doc'],
    supports: ['duplicate', 'live'],
    insert: () => true,
    ...over
  }
}

describe('what a target will accept', () => {
  it('offers both link modes for a kind it takes and can resolve', () => {
    expect(linkModesFor(target(), 'doc')).toEqual(['duplicate', 'live'])
  })

  it('offers nothing for a kind it does not take', () => {
    // A sheet snippet in a document is not a degraded insertion, it is no
    // insertion — so the picker must not show it as a destination at all.
    expect(linkModesFor(target(), 'sheet')).toEqual([])
    expect(targetAccepts(target(), snippet({ kind: 'sheet' }))).toBe(false)
  })

  it('offers duplicate alone when the surface cannot resolve a reference', () => {
    // The point of the `supports` list: a surface that cannot resolve at render
    // time must not advertise Live, because a Live that silently became a copy
    // would be a lie about what the user asked for.
    const copyOnly = target({ supports: ['duplicate'] })
    expect(linkModesFor(copyOnly, 'doc')).toEqual(['duplicate'])
    expect(targetAccepts(copyOnly, snippet())).toBe(true)
  })
})

describe('searching the library', () => {
  it('matches on name, description and tags', () => {
    const s = snippet()
    expect(snippetMatches(s, { search: 'payment' })).toBe(true)
    expect(snippetMatches(s, { search: 'net 30' })).toBe(true)
    expect(snippetMatches(s, { search: 'legal' })).toBe(true)
  })

  it('matches on the body text, so "the one with X in it" is findable', () => {
    // Searching inside the content is what makes a library usable without the
    // user having tagged everything up front.
    expect(snippetMatches(snippet(), { search: 'hello' })).toBe(true)
  })

  it('filters by kind and scope', () => {
    const s = snippet()
    expect(snippetMatches(s, { kinds: ['widget'] })).toBe(false)
    expect(snippetMatches(s, { kinds: ['doc'] })).toBe(true)
    expect(snippetMatches(s, { scope: 'org' })).toBe(false)
    expect(snippetMatches(s, { scope: 'personal' })).toBe(true)
  })

  it('an empty search is not a filter', () => {
    expect(snippetMatches(snippet(), { search: '   ' })).toBe(true)
  })
})

describe('emptiness, per kind', () => {
  it('refuses a doc body with no nodes', () => {
    expect(snippetBodyIsEmpty({ kind: 'doc', content: [], text: '' })).toBe(true)
  })

  it('refuses a sheet block of only blank cells', () => {
    // Saving a selection of empty cells would put an entry in the library that
    // cannot be told apart from any other empty one.
    expect(snippetBodyIsEmpty({ kind: 'sheet', rows: [['', '  '], ['', '']] })).toBe(true)
    expect(snippetBodyIsEmpty({ kind: 'sheet', rows: [['', 'x']] })).toBe(false)
  })

  it('accepts a diagram with only edges, and refuses one with neither', () => {
    expect(snippetBodyIsEmpty({ kind: 'diagram', nodes: [], edges: [{}] })).toBe(false)
    expect(snippetBodyIsEmpty({ kind: 'diagram', nodes: [], edges: [] })).toBe(true)
  })
})

describe('the kind and the body must agree', () => {
  it('rejects a body whose discriminator is the wrong kind', () => {
    // This guard is why a slide surface can never be handed an object a
    // document wrote: the store refuses the write, and a corrupt row reads
    // back as an empty body of the declared kind.
    expect(snippetBodyMatchesKind('slide', { kind: 'doc', content: [], text: '' })).toBe(false)
    expect(snippetBodyMatchesKind('doc', { kind: 'doc', content: [], text: '' })).toBe(true)
  })
})

describe('the summary describes what is really there', () => {
  it('uses the body text when there is some', () => {
    expect(snippetSummary(snippet())).toBe('hello')
  })

  it('says a doc block is empty rather than inventing a description', () => {
    expect(snippetSummary(snippet({ body: { kind: 'doc', content: [], text: '' } }))).toBe('Empty')
  })

  it('counts blocks when there is content but no text', () => {
    const body: SnippetBody = { kind: 'doc', content: [{ type: 'image' }], text: '' }
    expect(snippetSummary(snippet({ body }))).toBe('1 block(s), no text')
  })

  it('reports sheet dimensions from the widest row', () => {
    const body: SnippetBody = { kind: 'sheet', rows: [['a'], ['b', 'c', 'd']] }
    expect(snippetSummary(snippet({ kind: 'sheet', body }))).toBe('2 × 3 cells')
  })

  it('truncates a long block rather than running off the row', () => {
    const text = 'x'.repeat(200)
    const out = snippetSummary(snippet({ body: { kind: 'doc', content: [{ type: 'paragraph' }], text } }))
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(120)
  })
})

describe('an org snippet must not claim a reach it does not have', () => {
  // Workspace sync carries a closed set of item types, enforced SERVER-side by
  // WORKSPACE_ITEM_TYPES, which rejects anything else with "Invalid itemType".
  // `snippet` is not in it, so an org snippet stays on this computer. The
  // wording the UI shows is derived from one flag rather than written out in
  // each place, so these two cannot drift apart — which is the only way the
  // claim and the capability stay in step.
  it('derives its wording from whether sync actually carries snippets', () => {
    if (ORG_SNIPPETS_SYNC) {
      expect(ORG_SNIPPET_REACH_NOTE).toMatch(/everyone in this organisation/i)
    } else {
      expect(ORG_SNIPPET_REACH_NOTE).toMatch(/this computer/i)
      expect(ORG_SNIPPET_REACH_NOTE).toMatch(/sync/i)
    }
  })

  it('does not promise colleagues can see it while sync cannot carry it', () => {
    // The specific failure being guarded: a label that says teammates have it
    // when nothing left the machine. Precedent is in the server's own comment
    // about a sync that "faithfully carried everything it was willing to
    // accept" and reported success while dropping the rest.
    if (!ORG_SNIPPETS_SYNC) {
      expect(ORG_SNIPPET_REACH_NOTE.toLowerCase()).not.toContain('everyone')
      expect(ORG_SNIPPET_REACH_NOTE.toLowerCase()).not.toContain('shared with')
    }
  })
})

describe('a host is never offered a link mode it cannot honour', () => {
  const t = (over: Partial<SnippetTarget> = {}): SnippetTarget => ({
    id: 'doc:1',
    label: 'This document',
    accepts: ['doc', 'widget', 'diagram'],
    supports: ['duplicate', 'live'],
    insert: () => true,
    ...over
  })

  it('knows what each host renders as itself', () => {
    expect(canRenderNatively('doc', 'doc')).toBe(true)
    // NOT widget-in-doc, though a document CAN contain a work widget:
    // WidgetEmbedNode embeds an existing widget by id, while a widget snippet
    // body is a template with no widget. Rendering it natively would have to
    // CREATE one, and resolving a live instance must stay read-only.
    expect(canRenderNatively('widget', 'doc')).toBe(false)
    expect(canRenderNatively('diagram', 'doc')).toBe(false)
    expect(canRenderNatively('widget', 'desk')).toBe(true)
    expect(canRenderNatively('sheet', 'sheet')).toBe(true)
    expect(canRenderNatively('sheet', 'slide')).toBe(false)
  })

  it('offers both modes wherever the target supports them, converted or not', () => {
    // An earlier version of this withheld 'live' for a converted pair. The owner
    // ruled otherwise: such an instance is live and READ-ONLY, so the user still
    // gets a placed copy that follows its source. The native/converted split
    // decides EDITABILITY instead — see instanceModeFor below.
    expect(linkModesFor(t({ host: 'doc' }), 'doc')).toEqual(['duplicate', 'live'])
    expect(linkModesFor(t({ host: 'doc' }), 'diagram')).toEqual(['duplicate', 'live'])
    expect(linkModesFor(t({ host: 'doc' }), 'widget')).toEqual(['duplicate', 'live'])
  })

  it('still refuses a kind the target does not accept at all', () => {
    expect(linkModesFor(t({ host: 'doc', accepts: ['doc'] }), 'diagram')).toEqual([])
  })

  it('never invents a mode the target did not support', () => {
    expect(linkModesFor(t({ host: 'doc', supports: ['duplicate'] }), 'doc')).toEqual(['duplicate'])
  })
})

describe('how a placed instance behaves', () => {
  it('a live instance of a native kind is editable, and edits the master', () => {
    expect(instanceModeFor('doc', 'doc', 'live')).toBe('editable')
    expect(instanceModeFor('widget', 'desk', 'live')).toBe('editable')
  })

  it('a live instance of a converted kind is read-only, not editable', () => {
    // It follows the master by re-converting on resolve, but must never be
    // written back through: that would overwrite the master with its own lossy
    // form — edit the image of a diagram and the diagram becomes an image.
    expect(instanceModeFor('diagram', 'doc', 'live')).toBe('readonly')
    expect(instanceModeFor('widget', 'doc', 'live')).toBe('readonly')
    expect(instanceModeFor('sheet', 'slide', 'live')).toBe('readonly')
  })

  it('a duplicate is detached whatever the kinds, native or not', () => {
    expect(instanceModeFor('doc', 'doc', 'duplicate')).toBe('detached')
    expect(instanceModeFor('diagram', 'doc', 'duplicate')).toBe('detached')
  })

  it('names the kind a converted insert must become, for the re-convert hook', () => {
    expect(primaryKindFor('doc')).toBe('doc')
    expect(primaryKindFor('desk')).toBe('widget')
    expect(primaryKindFor('diagram')).toBe('diagram')
  })
})
