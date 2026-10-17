import { describe, it, expect, vi } from 'vitest'

// M2 — stop lying, tested on the REAL resolution path (A1 engine half).
//
// Same doctrine as plexiiRetrievalCeilings.test.ts: the e2e specs stub
// chat:sendStream and hand-write the resolution report, so nothing there can
// catch a chip claiming content the model never saw. This suite seeds fake DB
// rows and runs the REAL mentionResolver → chatMentions pipeline, asserting on
// the prompt block and the resolution report the renderer would receive.
//
// Defect numbers refer to AI-RETRIEVAL-DEFECTS-2026-08-21.md.

const widgets = new Map<string, { id: string; kind: string; title: string; content: string; taskId: string }>()
const widgetsByTask = new Map<string, Array<{ id: string; kind: string; title: string; content: string; taskId: string }>>()
const nodes = new Map<string, { id: string; kind: string; title: string; description?: string }>()
const documents = new Map<string, { id: string; docType: string; body: unknown }>()

vi.mock('../../src/main/db/widgets', () => ({
  getWidget: (id: string) => widgets.get(id) ?? null,
  listWidgetsByTask: (taskId: string) => widgetsByTask.get(taskId) ?? []
}))
vi.mock('../../src/main/db/nodes', () => ({
  getNode: (id: string) => nodes.get(id) ?? null,
  listNodes: () => [...nodes.values()]
}))
vi.mock('../../src/main/db/documents', () => ({
  getDocument: (id: string) => documents.get(id) ?? null
}))
vi.mock('../../src/main/db/files', () => ({ getFile: () => null }))
vi.mock('../../src/main/db/knowledge', () => ({ getKnowledge: () => null }))
vi.mock('../../src/main/db/tables', () => ({ getTable: () => null, listRows: () => [] }))
vi.mock('../../src/main/peopleDirectory', () => ({
  getDirectoryPerson: () => null,
  personDisplayName: () => ''
}))

import { resolveMentions, reportResolutions, type ResolvedMention } from '../../src/main/ai/mentionResolver'
import { renderMentions } from '../../src/main/ai/chatMentions'
import { renderAttachments } from '../../src/main/ai/chatAttachments'
import { DOC_TEXT_CAP } from '../../src/main/workspaceRank'
import {
  getTraceView,
  rotatedLabel,
  type AssistantTrace
} from '../../src/renderer/src/lib/traceView'
import type { ChatMentionRef } from '../../src/shared/types'
// 4.3.32 lexicon standard: user-facing text says “work widget”. The string pins in
// this file that read “widget” were rewritten to the new wording (owner ruling).

function ref(kind: ChatMentionRef['kind'], id: string, title: string): ChatMentionRef {
  return { kind, id, title } as ChatMentionRef
}

describe('#6 — a mentioned browser/PDF widget states the not-read boundary', () => {
  it('carries the address plus an explicit "was not read" notice, never a bare URL posing as content', () => {
    widgets.set('w-web', {
      id: 'w-web',
      kind: 'webview',
      title: 'Venue site',
      content: 'https://example.com/venue',
      taskId: 't1'
    })
    const [m] = resolveMentions([ref('widget', 'w-web', 'Venue site')])
    expect(m.text).toContain('https://example.com/venue')
    expect(m.text).toContain('was not read')
    const { block, admitted } = renderMentions([m])
    // The block admits the reference (the address IS real information)…
    expect(admitted.has('widget:w-web')).toBe(true)
    // …and the prompt itself carries the boundary, so the model can say it.
    expect(block).toContain('was not read')
  })
})

describe('#9 — a desk mention reports the widgets it did NOT read', () => {
  it('says "read 12 of 15", lists the shortfall in the text, and flags truncation', () => {
    nodes.set('desk-1', { id: 'desk-1', kind: 'task', title: 'Big desk' })
    widgetsByTask.set(
      'desk-1',
      Array.from({ length: 15 }, (_, i) => ({
        id: `w${i}`,
        kind: 'note',
        title: `Note ${i}`,
        content: `Contents of note number ${i}.`,
        taskId: 'desk-1'
      }))
    )
    const [m] = resolveMentions([ref('desk', 'desk-1', 'Big desk')])
    expect(m.source).toBe('read 12 of 15 work widgets')
    expect(m.text).toContain('3 more widgets on this desk were not read')
    expect(m.truncated).toBe(true)
    // The upstream cut has no honest total, so the notice must not invent one.
    expect(m.fullLength).toBeNull()
  })
})

describe('#11 — no false truncation denominator for office-doc widgets', () => {
  it('a body landing on DOC_TEXT_CAP yields "the rest was not read", never "of <cap>"', () => {
    documents.set('doc-1', {
      id: 'doc-1',
      docType: 'doc',
      body: {
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(DOC_TEXT_CAP + 5000) }] }
          ]
        }
      }
    })
    widgets.set('w-doc', { id: 'w-doc', kind: 'doc', title: 'Contract', content: 'doc-1', taskId: 't1' })
    const [m] = resolveMentions([ref('widget', 'w-doc', 'Contract')])
    expect(m.truncated).toBe(true)
    expect(m.fullLength).toBeNull()
    const { block } = renderMentions([m])
    expect(block).toContain('the rest was not read')
    expect(block).not.toContain(`of ${DOC_TEXT_CAP}`)
  })
})

describe('#10 — design widgets resolve instead of dead-ending', () => {
  it('reads a design document’s element text through the doc path', () => {
    documents.set('doc-d', {
      id: 'doc-d',
      docType: 'design',
      body: { elements: [{ type: 'text', text: 'Poster headline words' }] }
    })
    widgets.set('w-design', { id: 'w-design', kind: 'design', title: 'Poster', content: 'doc-d', taskId: 't1' })
    const [m] = resolveMentions([ref('widget', 'w-design', 'Poster')])
    expect(m.reason).toBeNull()
    expect(m.text).toContain('Poster headline words')
  })
})

describe('#7 — evicted for budget is not "produced no readable content"', () => {
  it('a resolved reference squeezed out by the shared budget says so', () => {
    const big = (id: string): ResolvedMention => ({
      ref: ref('document', id, id),
      kindLabel: 'document',
      text: 'y'.repeat(8000),
      source: null,
      reason: null,
      truncated: false,
      fullLength: 8000
    })
    const resolved = [big('a'), big('b'), big('c'), big('d')]
    const { admitted } = renderMentions(resolved)
    // 8000 + 8000 + 4000 fills the 20000 budget; "d" resolved but never rode.
    expect(admitted.has('document:d')).toBe(false)
    const report = reportResolutions(resolved, admitted)
    const d = report.find((r) => r.id === 'd')
    expect(d?.resolved).toBe(false)
    expect(d?.reason).toContain('size budget')
    expect(d?.reason).not.toContain('no readable content')
  })
})

describe('#19 — canvas attachments state their cut', () => {
  it('a page past the per-attachment cap carries the truncation notice', () => {
    const block = renderAttachments([
      { widgetId: 'w1', kind: 'webview', title: 'Booking page', source: 'https://x.y', text: 'z'.repeat(9000) }
    ])
    expect(block).toContain('[Truncated — the first 8000 characters are shown')
  })
  it('an attachment within budget carries no notice', () => {
    const block = renderAttachments([
      { widgetId: 'w1', kind: 'webview', title: 'Small page', source: 'https://x.y', text: 'hello world' }
    ])
    expect(block).not.toContain('Truncated')
  })
})

describe('#15 — the trace says when search was keyword-only', () => {
  const base: AssistantTrace = {
    status: 'done',
    startedAt: 0,
    retrievedAt: 1,
    retrievalMs: 12,
    repliedAt: 2,
    completedAt: 3,
    mentions: [],
    sources: [{ n: 1, docId: 'd1', title: 'Doc', docType: 'document', snippet: '' }],
    tools: [],
    activity: null,
    error: null
  }
  it('semantic:false appends "keyword match" to the search line', () => {
    const view = getTraceView({ ...base, semantic: false }, 1)
    expect(view.completed.find((l) => l.key === 'retrieve')?.label).toContain('keyword match')
  })
  it('unknown (older main / restored trace) discloses nothing', () => {
    const view = getTraceView(base, 1)
    expect(view.completed.find((l) => l.key === 'retrieve')?.label).not.toContain('keyword')
  })
})

describe('rotating thinking verbs (AI-29, Caleb: watch the words rotate)', () => {
  it('cycles the phase set, staying inside honest phases', () => {
    expect(rotatedLabel('answer', 'Writing the answer…', 0)).toBe('Thinking…')
    expect(rotatedLabel('answer', 'Writing the answer…', 1)).toBe('Pondering…')
    expect(rotatedLabel('answer', 'x', 4)).toBe('Thinking…')
    expect(rotatedLabel('retrieve', 'Searching your workspace…', 1)).toBe('Searching the web…')
  })

  it('phases without a rotation keep their real label — Reading stays Reading', () => {
    expect(rotatedLabel('read-3', 'Reading Henderson contract…', 2)).toBe(
      'Reading Henderson contract…'
    )
    expect(rotatedLabel('answer', 'canonical', -1)).toBe('canonical')
  })
})
