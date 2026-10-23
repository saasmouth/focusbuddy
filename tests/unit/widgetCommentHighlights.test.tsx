// A document on a desk shows its comment highlights too.
//
// A comment anchored the new way has NO mark in the body — it is drawn from its
// stored range as a decoration — so a surface that never resolves anchors shows
// no highlight at all. OfficeDocWidget did not resolve them, which meant a
// passage visibly commented in the Documents view looked uncommented on a desk.
// A highlight that exists in one view and not another is the kind of thing
// people report as lost work.
//
// This file is about the WIRING: which threads are handed to the resolver, that
// the result reaches the editor, and that nothing is asked of a kind that has
// no comments. The resolution itself is f0's (commentAnchor, commentPositions)
// and the decoration is covered in commentDecorations; mocking the resolver here
// keeps those failures where they belong instead of re-testing them badly.

import { act, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
  /** Threads the widget handed to the resolver. */
  seen: [] as { id: string; anchor: unknown; state?: string }[],
  /** Ranges the resolver will answer with. */
  ranges: [] as { id: string; from: number; to: number }[],
  /** What the editor was told to draw. */
  pushed: [] as unknown[],
  /** anchorToPersist's answer, per call. */
  persist: null as { json: string; reason: string } | null
}))

vi.mock('../../src/renderer/src/components/documents/editor/commentPositions', () => ({
  resolveForEditor: (_editor: unknown, threads: typeof H.seen) => {
    H.seen = [...threads]
    return { ranges: H.ranges, orphans: [] }
  },
  positionText: () => 'Hello brave new world',
  localAnchorFor: () => ({ kind: 'local', from: 0, to: 1 })
}))
vi.mock('../../src/renderer/src/components/documents/editor/commentWriteBack', () => ({
  anchorToPersist: () => H.persist
}))

vi.mock('@office', () => ({
  DocEditor: ({ onEditorReady }: { onEditorReady?: (e: unknown) => void }) => {
    // HANDED OVER ONCE, which is DocEditor's actual contract: it calls this
    // when the editor is created and with null on teardown, never per render.
    //
    // A first version called it in the render body with a FRESH object each
    // time. The widget holds the editor in state and its resolve effect
    // depends on that identity, so every render produced a new editor, which
    // set state, which rendered again — an infinite loop that OOM-killed the
    // vitest worker at load 8.77. It read exactly like the machine being
    // overloaded, which is what I blamed first.
    const editor = useRef({
      commands: {
        setCommentRanges: (r: unknown) => {
          H.pushed.push(r)
          return true
        }
      },
      state: { doc: {} }
    }).current
    useEffect(() => {
      onEditorReady?.(editor)
      return () => onEditorReady?.(null)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div data-testid="doc-editor" />
  },
  SheetEditor: () => <div data-testid="sheet-editor" />,
  SlidesEditor: () => <div />,
  MapEditor: () => <div />,
  DesignEditor: () => <div />,
  DrawStudio: () => <div />
}))
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({
  default: ({ children }: { children: unknown }) => <div>{children as never}</div>
}))
vi.mock('../../src/renderer/src/components/plexi/PromptDialog', () => ({
  confirmDialog: vi.fn(),
  promptText: vi.fn()
}))
vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: () => <i />
}))

import OfficeDocWidget from '../../src/renderer/src/components/widgets/OfficeDocWidget'

const DOC = { id: 'd1', title: 'On the desk', docType: 'doc', body: { type: 'doc' }, bodyRev: 1 }
let listComments: ReturnType<typeof vi.fn>
let setCommentAnchor: ReturnType<typeof vi.fn>
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

const row = (id: string, anchor: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  parentId: null,
  anchor,
  resolved: false,
  author: 'You',
  body: 'a note',
  createdAt: 0,
  anchorId: null,
  ...extra
})

beforeEach(() => {
  H.seen = []
  H.pushed = []
  H.ranges = [{ id: 't1', from: 7, to: 12 }]
  H.persist = null
  listComments = vi.fn().mockResolvedValue([row('t1', '{"kind":"local","from":6,"to":11}')])
  setCommentAnchor = vi.fn().mockResolvedValue(true)
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: {
      documents: {
        get: vi.fn(async () => DOC),
        create: vi.fn(),
        update: vi.fn(),
        updateBody: vi.fn(async () => ({ ok: true, doc: DOC })),
        listComments,
        setCommentAnchor,
        onChanged: () => () => {}
      },
      widgets: { update: vi.fn() }
    }
  }) as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const widget = (kind: string): unknown => ({ id: 'w1', kind, content: 'd1', title: '', x: 0, y: 0, w: 4, h: 4 })

const mount = async (kind = 'doc'): Promise<void> => {
  await act(async () => {
    root.render(<OfficeDocWidget widget={widget(kind) as never} inline />)
  })
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() })
}

describe('a document widget draws its comment highlights', () => {
  it('asks for the threads and pushes the resolved ranges into the editor', async () => {
    await mount()
    expect(listComments).toHaveBeenCalledWith('d1')
    expect(H.pushed.at(-1)).toEqual([{ id: 't1', from: 7, to: 12 }])
  })

  it('hands the resolver only threads that HAVE an anchor', async () => {
    // A comment anchored the old way, by a mark, is not broken and keeps its
    // mark highlight. Passing it would have it reported as an orphan — "comment
    // on removed text" about a comment that is perfectly fine.
    listComments.mockResolvedValue([
      row('t1', '{"kind":"local","from":6,"to":11}'),
      row('old', null),
      row('reply', '{"kind":"local","from":1,"to":2}', { parentId: 't1' })
    ])
    await mount()
    expect(H.seen.map((t) => t.id)).toEqual(['t1'])
  })

  it('draws nothing, rather than stale ranges, when there are no anchored threads', async () => {
    listComments.mockResolvedValue([row('old', null)])
    await mount()
    expect(H.pushed.at(-1)).toEqual([])
  })

  it('carries the resolved state through, so a resolved thread is not drawn', async () => {
    listComments.mockResolvedValue([row('t1', '{"kind":"local","from":6,"to":11}', { resolved: true })])
    await mount()
    expect(H.seen[0]!.state).toBe('resolved')
  })
})

describe('what it does not do', () => {
  it('asks for no comments on a spreadsheet, which has none', async () => {
    // Only documents have comments. Asking anyway would be a wasted IPC call per
    // sheet widget on every desk.
    await mount('sheet')
    expect(listComments).not.toHaveBeenCalled()
  })

  it('still renders the document when the comments cannot be read', async () => {
    // The honest fallback is no highlights. Letting it throw would mean a widget
    // that fails to show a DOCUMENT because its COMMENTS failed.
    listComments.mockRejectedValue(new Error('db gone'))
    await mount()
    expect(host.querySelector('[data-testid="doc-editor"]')).not.toBeNull()
  })
})

describe('an anchor it had to re-find is persisted, by the shared rule', () => {
  it('writes back what anchorToPersist returns', async () => {
    // Through the shared rule, not a third copy of it: that rule is what stops
    // a live document's anchor being written back as a local one, which would
    // destroy its relative positions permanently.
    H.persist = { json: '{"kind":"local","from":7,"to":12}', reason: 'moved' }
    await mount()
    expect(setCommentAnchor).toHaveBeenCalledWith('t1', '{"kind":"local","from":7,"to":12}')
  })

  it('writes nothing when the rule says nothing changed', async () => {
    H.persist = null
    await mount()
    expect(setCommentAnchor).not.toHaveBeenCalled()
  })
})
