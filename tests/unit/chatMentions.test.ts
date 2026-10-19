import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatMentionRef, FbNode, Widget } from '../../src/shared/types'
// 4.3.32 lexicon standard: user-facing text says “work widget”. The string pins in
// this file that read “widget” were rewritten to the new wording (owner ruling).

// Phase 4.2 — the resolver, the prompt block and the honesty gate between them.
//
// The rule under test everywhere below: a reference that produced no readable
// text may not appear in the prompt, may not be named in its lead sentence, and
// must come back to the renderer marked unresolved with a reason. The pin
// already had this rule for ONE widget; a reference set can name six things
// across the workspace, so every failure mode has to hold.
//
// The DB is mocked (the vi.mock convention this suite already uses elsewhere)
// so every branch — including "deleted out from under the reference" — is
// reachable deterministically without a live SQLite file.

const docs = new Map<string, { id: string; docType: string; title: string; body: unknown }>()
const nodes = new Map<string, FbNode>()
const widgets = new Map<string, Widget>()
const widgetsByTask = new Map<string, Widget[]>()
const files = new Map<
  string,
  { id: string; originalName: string; mimeType: string; sizeBytes: number; ext: string; storedPath: string }
>()
const knowledge = new Map<string, { id: string; title: string; body: string; tags: string[]; pinned: boolean }>()
const fileBytes = new Map<string, string>()

vi.mock('../../src/main/db/documents', () => ({
  getDocument: (id: string) => docs.get(id) ?? null
}))
vi.mock('../../src/main/db/nodes', () => ({
  getNode: (id: string) => nodes.get(id) ?? null,
  listNodes: () => [...nodes.values()]
}))
vi.mock('../../src/main/db/widgets', () => ({
  getWidget: (id: string) => widgets.get(id) ?? null,
  listWidgetsByTask: (taskId: string) => widgetsByTask.get(taskId) ?? []
}))
vi.mock('../../src/main/db/files', () => ({
  getFile: (id: string) => files.get(id) ?? null
}))
vi.mock('../../src/main/db/knowledge', () => ({
  getKnowledge: (id: string) => knowledge.get(id) ?? null
}))
vi.mock('../../src/main/db/tables', () => ({
  getTable: () => null,
  listRows: () => []
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = (p: string): string => {
    if (!fileBytes.has(p as string)) throw new Error('ENOENT')
    return fileBytes.get(p as string)!
  }
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

const { renderMentions } = await import('../../src/main/ai/chatMentions')
const { setPeopleDirectory } = await import('../../src/main/peopleDirectory')
const { personMentionCandidates } = await import(
  '../../src/renderer/src/lib/peopleDirectory'
)
const { resolveMentions, mentionedDeskIds, reportResolutions } = await import(
  '../../src/main/ai/mentionResolver'
)
const { DOC_TEXT_CAP } = await import('../../src/main/workspaceRank')

function widget(p: Partial<Widget>): Widget {
  return {
    id: 'w1',
    taskId: 't1',
    kind: 'note',
    title: 'A note',
    content: 'note body',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    zIndex: 1,
    color: null,
    pinned: false,
    pinnedScreenX: null,
    pinnedScreenY: null,
    pinnedZone: null,
    parentSectionId: null,
    layout: null,
    ...p
  } as Widget
}

function node(p: Partial<FbNode>): FbNode {
  return {
    id: 'n1',
    parentId: null,
    kind: 'task',
    title: 'Marketing',
    description: '',
    status: 'open',
    priority: 'medium',
    interest: 'medium',
    importance: 'medium',
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    estimateMinutes: null,
    extensionsMinutes: 0,
    resumeMarkdown: null,
    resumeUpdatedAt: null,
    dueDate: null,
    archived: false,
    isPlan: false,
    sharedFromHandle: null,
    ...p
  } as FbNode
}

const ref = (p: Partial<ChatMentionRef> = {}): ChatMentionRef => ({
  kind: 'document',
  id: 'd1',
  title: 'Q3 brief',
  ...p
})

beforeEach(() => {
  docs.clear()
  nodes.clear()
  widgets.clear()
  widgetsByTask.clear()
  files.clear()
  knowledge.clear()
  fileBytes.clear()
  setPeopleDirectory([])
  docs.set('d1', {
    id: 'd1',
    docType: 'doc',
    title: 'Q3 brief',
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ship in September' }] }] }
  })
})

// ── The resolver reads real rows, and refuses when there are none ───────────

describe('resolveMentions — real content or an honest reason, never invention', () => {
  it('reads a document across the workspace', () => {
    const [r] = resolveMentions([ref()])
    expect(r.text).toContain('ship in September')
    expect(r.reason).toBeNull()
  })

  it('reads a widget on a desk the user is NOT looking at — the thing the pin could never do', () => {
    widgets.set('w-far', widget({ id: 'w-far', taskId: 't-other', title: 'Pipeline', content: 'Q3 pipeline rows' }))
    const [r] = resolveMentions([ref({ kind: 'widget', id: 'w-far', taskId: 't-other' })])
    expect(r.text).toContain('Q3 pipeline rows')
    expect(r.reason).toBeNull()
  })

  it('summarises a desk from its own widgets', () => {
    nodes.set('t1', node({ id: 't1', title: 'Marketing', description: 'the launch desk' }))
    widgetsByTask.set('t1', [widget({ id: 'w1', title: 'Plan', content: 'week one tasks' })])
    const [r] = resolveMentions([ref({ kind: 'desk', id: 't1' })])
    expect(r.text).toContain('Marketing')
    expect(r.text).toContain('the launch desk')
    expect(r.text).toContain('week one tasks')
  })

  it('reads a PlexiBrain entry', () => {
    knowledge.set('k1', { id: 'k1', title: 'Pricing', body: 'seats are $12', tags: ['sales'], pinned: true })
    const [r] = resolveMentions([ref({ kind: 'knowledge', id: 'k1' })])
    expect(r.text).toContain('seats are $12')
  })

  it('reads a text file, and is explicit that it did NOT read a binary one', () => {
    files.set('f1', {
      id: 'f1',
      originalName: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 2048,
      ext: 'md',
      storedPath: '/x/notes.md'
    })
    fileBytes.set('/x/notes.md', 'the real file body')
    const [text] = resolveMentions([ref({ kind: 'file', id: 'f1' })])
    expect(text.text).toContain('the real file body')

    files.set('f2', {
      id: 'f2',
      originalName: 'scan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 90000,
      ext: 'pdf',
      storedPath: '/x/scan.pdf'
    })
    const [binary] = resolveMentions([ref({ kind: 'file', id: 'f2' })])
    expect(binary.text).toContain('scan.pdf')
    expect(binary.text).toContain('contents were not read')
  })

  it.each([
    ['document', 'd-gone', 'this document no longer exists'],
    ['desk', 't-gone', 'this desk no longer exists'],
    ['room', 'r-gone', 'this room no longer exists'],
    ['widget', 'w-gone', 'this work widget no longer exists'],
    ['file', 'f-gone', 'this file no longer exists'],
    ['knowledge', 'k-gone', 'this PlexiiBrain entry no longer exists']
  ])('a deleted %s resolves to NO text and a stated reason', (kind, id, reason) => {
    const [r] = resolveMentions([ref({ kind: kind as ChatMentionRef['kind'], id })])
    expect(r.text).toBeNull()
    expect(r.reason).toBe(reason)
  })

  it('an empty widget produces no text rather than a placeholder posing as content', () => {
    widgets.set('w-empty', widget({ id: 'w-empty', content: '' }))
    const [r] = resolveMentions([ref({ kind: 'widget', id: 'w-empty' })])
    expect(r.text).toBeNull()
  })

  it('a PARENTHESISED placeholder is not content either — "(empty table)" must never ride', () => {
    // The sharper half of the same rule, and the one the empty-string case above
    // cannot reach: the shared extractor answers some unreadable widgets with a
    // truthy placeholder like "(empty table)" or "(empty document)". Those are
    // labels describing an absence, not content — a chip backed by one would
    // claim the assistant read something it did not.
    widgets.set('w-tbl', widget({ id: 'w-tbl', kind: 'table', content: '' }))
    const [table] = resolveMentions([ref({ kind: 'widget', id: 'w-tbl' })])
    expect(table.text).toBeNull()
    expect(table.reason).toBe('this work widget has no readable content')

    widgets.set('w-mind', widget({ id: 'w-mind', kind: 'mindmap', content: '' }))
    const [mind] = resolveMentions([ref({ kind: 'widget', id: 'w-mind' })])
    expect(mind.text).toBeNull()
  })

  it('a desk skips its placeholder-only widgets instead of listing them as content', () => {
    nodes.set('t9', node({ id: 't9', title: 'Sparse', description: 'has one real widget' }))
    widgetsByTask.set('t9', [
      widget({ id: 'w-real', kind: 'note', title: 'Real', content: 'genuine body' }),
      widget({ id: 'w-ghost', kind: 'table', title: 'Ghost', content: '' })
    ])
    const [r] = resolveMentions([ref({ kind: 'desk', id: 't9' })])
    expect(r.text).toContain('genuine body')
    expect(r.text).not.toContain('(empty table)')
    expect(r.source).toBe('1 work widget read')
  })

  it('a person reference refuses while the directory is empty — see the people section below', () => {
    // Phase 4.2 stubbed this branch as a throwing port because the capability
    // was not built; Phase 4.7 built it. The refusal survives, but now for the
    // honest reason rather than the placeholder one: with nothing fetched there
    // is no person to describe.
    const [r] = resolveMentions([ref({ kind: 'person', id: 'p1', title: 'Ryan' })])
    expect(r.text).toBeNull()
    expect(r.reason).toContain('not in the workspace directory')
  })

  it('a resolver that throws loses only its own reference, never the chat', () => {
    // A row whose body cannot be walked at all.
    docs.set('d-bad', {
      id: 'd-bad',
      docType: 'doc',
      get body(): unknown {
        throw new Error('corrupt row')
      },
      title: 'Broken'
    } as never)
    const out = resolveMentions([ref({ id: 'd-bad' }), ref({ id: 'd1' })])
    expect(out[0].text).toBeNull()
    expect(out[1].text).toContain('ship in September')
  })

  it('preserves order — the first @ is the first thing the model reads', () => {
    knowledge.set('k1', { id: 'k1', title: 'Pricing', body: 'seats', tags: [], pinned: false })
    const out = resolveMentions([ref({ kind: 'knowledge', id: 'k1' }), ref({ id: 'd1' })])
    expect(out.map((r) => r.ref.id)).toEqual(['k1', 'd1'])
  })

  it('returns nothing at all for a request that carried no references', () => {
    expect(resolveMentions(undefined)).toEqual([])
    expect(resolveMentions([])).toEqual([])
  })
})

// ── The prompt block: the honesty gate ─────────────────────────────────────

describe('renderMentions — the block claims only what genuinely rendered', () => {
  it('renders a resolved reference with its title and its text', () => {
    const { block, admitted } = renderMentions(resolveMentions([ref()]))
    expect(block).toContain('Q3 brief')
    expect(block).toContain('ship in September')
    expect(admitted.get('document:d1')?.chars).toBeGreaterThan(0)
  })

  it('says NOTHING when every reference failed — no empty referenced-items section', () => {
    const { block, admitted } = renderMentions(resolveMentions([ref({ id: 'gone' })]))
    expect(block).toBe('')
    expect(admitted.size).toBe(0)
  })

  it('never names an unresolved reference — not in the lead sentence, not anywhere', () => {
    const { block } = renderMentions(
      resolveMentions([ref({ id: 'd1' }), ref({ id: 'ghost', title: 'Deleted Doc' })])
    )
    expect(block).toContain('Q3 brief')
    // The critical half: the failed reference's title must appear NOWHERE, or
    // the prompt asserts context the model was never given.
    expect(block).not.toContain('Deleted Doc')
    expect(block).not.toContain('ghost')
  })

  it('never cuts silently — a shortened reference always says so, in the block and in the report', () => {
    const huge = 'x'.repeat(30000)
    docs.set('big', { id: 'big', docType: 'doc', title: 'Big', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: huge }] }] } })
    const { block, admitted } = renderMentions(resolveMentions([ref({ id: 'big', title: 'Big' })]))
    expect(block).toContain('Truncated')
    expect(admitted.get('document:big')?.truncated).toBe(true)
  })

  it('never quotes a total it cannot know when an upstream extractor already cut the body', () => {
    // Two caps sit above this block: the resolver's own PER_MENTION, and
    // extractDocText's DOC_TEXT_CAP, which trims every document body before the
    // resolver ever sees it. For a document larger than DOC_TEXT_CAP the true
    // length is not knowable here — so the notice must state the cut WITHOUT a
    // denominator rather than presenting the cap as the whole document. (The
    // seed tracks the constant so raising the ceiling re-tests, not retires,
    // this rule — M1 moved it from 12000 to 48000.)
    const huge = 'y'.repeat(DOC_TEXT_CAP + 5000)
    docs.set('big', { id: 'big', docType: 'doc', title: 'Big', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: huge }] }] } })
    const resolved = resolveMentions([ref({ id: 'big', title: 'Big' })])
    expect(resolved[0].truncated).toBe(true)
    expect(resolved[0].fullLength).toBeNull()
    const { block } = renderMentions(resolved)
    expect(block).toContain('the rest was not read')
    // The exact failure this guards: quoting a cap as if it were the total.
    expect(block).not.toMatch(new RegExp(`of (8000|${DOC_TEXT_CAP}|${DOC_TEXT_CAP + 4}) characters shown`))
  })

  it('DOES quote the real total when it genuinely knows it', () => {
    // A widget's text is not capped upstream, so here the denominator is real.
    widgets.set('w-big', widget({ id: 'w-big', content: 'z'.repeat(9000) }))
    const resolved = resolveMentions([ref({ kind: 'widget', id: 'w-big', title: 'Big note' })])
    expect(resolved[0].fullLength).toBe(9000)
    expect(renderMentions(resolved).block).toMatch(/Truncated to fit — 8000 of 9000 characters shown/)
  })

  it('does not cry truncation for a reference that fitted whole', () => {
    const { block } = renderMentions(resolveMentions([ref()]))
    expect(block).not.toContain('Truncated to fit')
  })

  it('renders nothing for an empty set', () => {
    expect(renderMentions([]).block).toBe('')
  })

  it('names one reference in the singular and several with a count', () => {
    knowledge.set('k1', { id: 'k1', title: 'Pricing', body: 'seats', tags: [], pinned: false })
    const one = renderMentions(resolveMentions([ref()])).block
    expect(one).toContain('The user referenced "Q3 brief"')
    const two = renderMentions(resolveMentions([ref(), ref({ kind: 'knowledge', id: 'k1', title: 'Pricing' })])).block
    expect(two).toContain('referenced 2 items')
  })
})

// ── The report back to the renderer ────────────────────────────────────────

describe('reportResolutions — derived from the same pass that built the prompt', () => {
  it('marks admitted references resolved, with the characters that actually rode', () => {
    const resolved = resolveMentions([ref()])
    const { admitted } = renderMentions(resolved)
    const [report] = reportResolutions(resolved, admitted)
    expect(report.resolved).toBe(true)
    expect(report.chars).toBeGreaterThan(0)
    expect(report.reason).toBeNull()
  })

  it('marks a failed reference unresolved and ALWAYS gives a reason', () => {
    const resolved = resolveMentions([ref({ id: 'gone', title: 'Gone' })])
    const { admitted } = renderMentions(resolved)
    const [report] = reportResolutions(resolved, admitted)
    expect(report.resolved).toBe(false)
    expect(report.chars).toBe(0)
    expect(report.reason).toBeTruthy()
  })

  it('reports every reference the request carried, resolved or not', () => {
    const resolved = resolveMentions([ref(), ref({ id: 'gone' })])
    const report = reportResolutions(resolved, renderMentions(resolved).admitted)
    expect(report).toHaveLength(2)
    expect(report.map((r) => r.resolved)).toEqual([true, false])
  })
})

// ── Retrieval scoping: only what the data model can honestly support ───────

describe('mentionedDeskIds — narrows the pool that CAN be narrowed', () => {
  it('takes a desk by its own id and a widget by its owning desk', () => {
    expect(
      mentionedDeskIds([
        ref({ kind: 'desk', id: 't1' }),
        ref({ kind: 'widget', id: 'w1', taskId: 't2' })
      ])
    ).toEqual(['t1', 't2'])
  })

  it('yields nothing for kinds with no desk affiliation in the data model', () => {
    // Documents and PlexiBrain entries genuinely have no owning desk, which is
    // why the prompt never claims retrieval was scoped for them.
    expect(
      mentionedDeskIds([ref({ kind: 'document', id: 'd1' }), ref({ kind: 'knowledge', id: 'k1' })])
    ).toEqual([])
  })

  it('dedupes two widgets from the same desk', () => {
    expect(
      mentionedDeskIds([
        ref({ kind: 'widget', id: 'a', taskId: 't1' }),
        ref({ kind: 'widget', id: 'b', taskId: 't1' })
      ])
    ).toEqual(['t1'])
  })

  it('ignores a widget with no owning desk rather than inventing one', () => {
    expect(mentionedDeskIds([ref({ kind: 'widget', id: 'a', taskId: null })])).toEqual([])
  })

  it('is empty for a request with no references', () => {
    expect(mentionedDeskIds(undefined)).toEqual([])
  })
})

// ── People (Phase 4.7) ─────────────────────────────────────────────────────
// People are the one mentionable kind main cannot look up: they live on the
// signal server behind a session token, so the renderer publishes what it has
// genuinely fetched (the pattern db/search.ts uses for mail). The rule under
// test: an empty directory refuses, it never improvises a name.

describe('person references — context only, and only from what was really fetched', () => {
  it('refuses when the directory is empty (signed out, or never loaded)', () => {
    setPeopleDirectory([])
    const [r] = resolveMentions([ref({ kind: 'person', id: 'acc-1', title: 'Ryan' })])
    expect(r.text).toBeNull()
    expect(r.reason).toContain('not in the workspace directory')
  })

  it('describes a person the app really loaded', () => {
    setPeopleDirectory([
      { accountId: 'acc-1', handle: 'ryan', firstName: 'Ryan', lastName: 'Chen', role: 'admin' }
    ])
    const [r] = resolveMentions([ref({ kind: 'person', id: 'acc-1', title: 'Ryan Chen' })])
    expect(r.text).toContain('Ryan Chen')
    expect(r.text).toContain('@ryan')
    expect(r.text).toContain('admin')
    expect(r.reason).toBeNull()
  })

  it('tells the model plainly that it cannot contact them — context, never a notification', () => {
    setPeopleDirectory([
      { accountId: 'acc-1', handle: 'ryan', firstName: 'Ryan', lastName: null, role: 'member' }
    ])
    const [r] = resolveMentions([ref({ kind: 'person', id: 'acc-1', title: 'Ryan' })])
    expect(r.text).toContain('do not claim you have contacted them')
  })

  it('still refuses a person who is not in the loaded directory, even when others are', () => {
    setPeopleDirectory([
      { accountId: 'acc-1', handle: 'ryan', firstName: 'Ryan', lastName: null, role: 'member' }
    ])
    const [r] = resolveMentions([ref({ kind: 'person', id: 'acc-999', title: 'Someone Else' })])
    expect(r.text).toBeNull()
    // And critically: the title the RENDERER supplied is not echoed back as if
    // it were a fact the directory confirmed.
    expect(r.reason).not.toContain('Someone Else')
  })

  it('falls back to the handle when the directory has no name', () => {
    setPeopleDirectory([
      { accountId: 'acc-2', handle: 'quietone', firstName: null, lastName: null, role: 'guest' }
    ])
    const [r] = resolveMentions([ref({ kind: 'person', id: 'acc-2', title: 'quietone' })])
    expect(r.text).toContain('quietone')
  })

  it('a refused person contributes nothing to the prompt at all', () => {
    setPeopleDirectory([])
    const { block } = renderMentions(
      resolveMentions([ref({ kind: 'person', id: 'acc-1', title: 'Ghost Person' })])
    )
    expect(block).toBe('')
  })

  it('the picker offers nobody from an empty directory', () => {
    expect(personMentionCandidates([], 'ry', 'c1')).toEqual([])
  })

  it('the picker matches on name OR handle, because people are known both ways', () => {
    const dir = [
      { accountId: 'a', handle: 'rchen', firstName: 'Ryan', lastName: 'Chen', role: 'admin' }
    ]
    expect(personMentionCandidates(dir, 'ryan', 'c1')).toHaveLength(1)
    expect(personMentionCandidates(dir, 'rchen', 'c1')).toHaveLength(1)
    expect(personMentionCandidates(dir, 'zzz', 'c1')).toHaveLength(0)
    expect(personMentionCandidates(dir, 'ryan', 'c1')[0].kind).toBe('person')
  })
})
