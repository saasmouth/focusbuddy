// Two editors, one document — the data loss, and the guard, through the real
// OfficeDocWidget.
//
// Reachable through a shipped feature rather than a contrivance: widgets
// sharing a syncGroupId mirror their `content` to each other, so a LINKED
// DUPLICATE legitimately points two widgets at one fb_documents id, both
// mounted on the same desk. Each holds the whole body in its own state, seeded
// at mount, so each save used to write its copy over the other's. Measured
// before the fix: writes ["start +A", "start +B"], final "start +B".
//
// The fake IPC below implements the CAS the way src/main/db/documents.ts does,
// and copies everything across the boundary the way real IPC structured-clones
// it. That second part is not pedantry: a first version of this reproduction
// returned the row object itself, so a write by A appeared in B's state and the
// loss was invisible — the test reported no bug, twice.

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FbDocument } from '../../src/shared/types'

/**
 * The stubbed editor hangs its "type this" function on its own DOM node, and
 * the test reaches it by POSITION — first node is the first widget's editor.
 *
 * Two earlier versions of this harness each hid real behaviour. Computing the
 * identity in the render body let one widget's re-render steal the other's
 * emitter, so "B types" typed into A. Freezing it per mount with a counter was
 * no better once catch-up started REMOUNTING editors: a remount is a third
 * mount, so it took the other widget's slot and the stale closure stayed
 * addressable. DOM position is stable across both, and a ref callback always
 * carries the live closure of the mount that is actually on screen.
 *
 * `seeded` stays per-mount on purpose: that is exactly what every real office
 * editor does, and it is why catch-up has to remount at all.
 */
type Typable = HTMLDivElement & { __type?: (edit: string) => void }

vi.mock('@office', () => ({
  DocEditor: ({ content, onChange }: { content: unknown; onChange: (b: unknown) => void }) => {
    const [seeded] = useState(() => (content as { text?: string }).text ?? '')
    return (
      <div
        data-testid="editor"
        ref={(el) => {
          if (el) (el as Typable).__type = (edit: string) => onChange({ text: `${seeded}${edit}` })
        }}
      >
        {/* What this editor was SEEDED with, so a test can tell a re-seed from
            a re-render — the difference between catching up and having your
            unsaved text replaced underneath you. */}
        {seeded}
      </div>
    )
  },
  SheetEditor: () => <div />,
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
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import OfficeDocWidget from '../../src/renderer/src/components/widgets/OfficeDocWidget'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// The one row, plus every document created during a test.
let rows: Record<string, FbDocument>
/** Subscribers to documents:changed, as the real broadcast reaches every window. */
let listeners: ((id: string, bodyRev: number) => void)[]
const announce = (id: string): void => {
  const rev = rows[id]!.bodyRev
  for (const l of [...listeners]) l(id, rev)
}
let widgetPatches: { id: string; patch: Record<string, unknown> }[]
let created: FbDocument[]
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

const DOC_ID = 'doc-shared'

const bodyText = (id: string): string => (rows[id]?.body as { text?: string })?.text ?? ''

beforeEach(() => {
  widgetPatches = []
  created = []
  listeners = []
  rows = {
    [DOC_ID]: {
      id: DOC_ID,
      docType: 'doc',
      title: 'Shared',
      body: { text: 'start' } as never,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      orgId: 'personal',
      bodyRev: 3
    }
  }
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: {
      documents: {
        get: vi.fn(async (id: string) => (rows[id] ? clone(rows[id]!) : null)),
        create: vi.fn(async (draft: { docType: string; title: string; body?: unknown }) => {
          const doc: FbDocument = {
            id: `doc-new-${created.length + 1}`,
            docType: draft.docType as FbDocument['docType'],
            title: draft.title,
            body: (draft.body ?? {}) as never,
            archived: false,
            createdAt: 2,
            updatedAt: 2,
            orgId: 'personal',
            bodyRev: 0
          }
          rows[doc.id] = doc
          created.push(clone(doc))
          return clone(doc)
        }),
        // The unconditional path, as an import / snapshot restore / AI edit uses
        // it: it writes and bumps, which is what makes an open editor's next
        // conditional save fail instead of overwriting it.
        update: vi.fn(async (id: string, patch: { body?: unknown }) => {
          const row = rows[id]
          if (!row) return null
          if (patch.body !== undefined) {
            row.body = clone(patch.body) as never
            row.bodyRev += 1
            announce(id)
          }
          return clone(row)
        }),
        // The conditional path, mirroring the SQL: the comparison decides
        // whether anything is written at all.
        onChanged: (cb: (id: string, bodyRev: number) => void): (() => void) => {
          listeners.push(cb)
          return () => {
            listeners = listeners.filter((l) => l !== cb)
          }
        },
        updateBody: vi.fn(async (id: string, body: unknown, expectedBodyRev: number) => {
          const row = rows[id]
          if (!row) return { ok: false as const, reason: 'missing' as const }
          if (row.bodyRev !== expectedBodyRev) {
            return { ok: false as const, reason: 'stale' as const, current: clone(row) }
          }
          row.body = clone(body) as never
          row.bodyRev += 1
          announce(id)
          return { ok: true as const, doc: clone(row) }
        })
      },
      widgets: {
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          widgetPatches.push({ id, patch })
          return null
        })
      }
    }
  }) as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const widget = (id: string): unknown => ({
  id,
  kind: 'doc',
  content: DOC_ID,
  title: '',
  x: 0,
  y: 0,
  w: 4,
  h: 4
})

const mountBoth = async (): Promise<void> => {
  await act(async () => {
    root.render(
      <>
        <OfficeDocWidget widget={widget('w1') as never} inline />
        <OfficeDocWidget widget={widget('w2') as never} inline />
      </>
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
}

/** The editor of the Nth widget on screen, in DOM order. */
const editorAt = (i: number): Typable => {
  const nodes = host.querySelectorAll('[data-testid="editor"]')
  const el = nodes[i] as Typable | undefined
  if (!el?.__type) throw new Error(`no editor at position ${i}`)
  return el
}
const typeAt = async (i: number, edit: string): Promise<void> => {
  await act(async () => editorAt(i).__type!(edit))
}

/**
 * Drain the promise chains a refresh rides on.
 *
 * A single microtask tick is not enough: the catch-up path is announce ->
 * documents.get -> setState, so a test that asserted straight after the save
 * could not see whether a refresh happened at all. That is what let an earlier
 * version of this file pass with the "don't refresh over unsaved text" guard
 * deleted.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const type = async (who: 'a' | 'b', edit: string): Promise<void> => {
  await typeAt(who === 'a' ? 0 : 1, edit)
  await act(async () => {
    vi.advanceTimersByTime(600)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const el = (testid: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null

/**
 * Put widget B in genuine conflict: B types and, before its debounce fires,
 * someone ELSE replaces the body. B cannot be refreshed — that would destroy
 * B's unsaved text — so B's own save is refused when it lands.
 *
 * The other writer here is a direct API write rather than widget A, and that is
 * deliberate: two widgets typing at once arm two 500ms timers that fire in the
 * same flush, so which one is refused depends on which was scheduled first. A
 * test whose expected outcome turns on that is not a test. This also models the
 * cases a broadcast cannot smooth over anyway — another window, a snapshot
 * restore, a body arriving from sync — which all look the same from here.
 */
const collide = async (): Promise<void> => {
  await typeAt(1, ' +B') // B types; its save is now pending
  await act(async () => {
    await window.api.documents.update(DOC_ID, { body: { text: 'start +A' } as never })
  })
  await act(async () => {
    vi.advanceTimersByTime(600)
  })
  await settle()
}

describe('two linked-duplicate widgets on one document', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('a widget does not remount on the echo of its OWN save', async () => {
    // The desk-widget half of the undo-history bug. The Documents view lost its
    // entire undo stack about a second after any edit, because the broadcast is
    // emitted inside the write and arrives before the write's promise resolves
    // — so the store saw a revision it did not recognise, refetched, and
    // remounted the editor.
    //
    // The widget survives it for a DIFFERENT reason: it clears `pending` only
    // after the await, so its unsaved-text guard is still set when the echo
    // lands. That is correct but incidental, and worth pinning: reordering
    // those two lines would reintroduce the bug here with nothing to catch it.
    //
    // Asserted on what the editor was SEEDED with. A remount re-seeds from the
    // new body, so 'start +A' here would mean the editor was rebuilt and the
    // user's undo stack went with it.
    await mountBoth()
    await type('a', ' +A')
    expect(bodyText(DOC_ID)).toBe('start +A')
    expect(editorAt(0).textContent).toBe('start')
  })

  it('taking turns keeps BOTH edits, with no conflict to resolve', async () => {
    // What used to happen here: the stored body ended as "start +B" and " +A"
    // was gone, no merge, no conflict, no warning.
    //
    // What happens now, and it is better than merely refusing the second write:
    // the idle widget hears about A's save and catches up, so B types onto A's
    // text and its own save lands cleanly. The guard is the backstop; the
    // broadcast is what means nobody has to see it most of the time.
    await mountBoth()
    await type('a', ' +A')
    expect(bodyText(DOC_ID)).toBe('start +A')
    await type('b', ' +B')
    expect(bodyText(DOC_ID)).toBe('start +A +B')
    expect(el('document-conflict')).toBeNull()
  })

  it('a real collision — unsaved text against a body that moved — is refused and explained', async () => {
    // The case a broadcast cannot fix: the widget was already mid-edit, so
    // catching up would have destroyed its unsaved text. Nothing is written,
    // and all three ways out are offered rather than one being chosen.
    await mountBoth()
    await collide()
    expect(bodyText(DOC_ID)).toBe('start +A')
    expect(el('document-conflict')).not.toBeNull()
    expect(el('document-conflict-theirs')).not.toBeNull()
    expect(el('document-conflict-mine')).not.toBeNull()
    expect(el('document-conflict-copy')).not.toBeNull()
  })

  it('does not refresh a widget that has unsaved text', async () => {
    // The other half of the catch-up rule, and the reason it is conditional:
    // refreshing here would replace what the user is typing with someone
    // else's body — the very loss the guard exists to prevent, arriving
    // through the back door.
    //
    // Asserted on what the EDITOR IS SEEDED WITH, not on the stored body. The
    // stored body is identical either way, which is why an earlier version of
    // this test passed with the guard deleted: both paths end with the same row
    // and the same conflict bar, and only the text on the user's screen differs.
    await mountBoth()
    await collide()
    expect(editorAt(1).textContent).toBe('start')
    // And it is still offering to keep the user's own text, which means it
    // still has it.
    await act(async () => el('document-conflict-mine')!.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(bodyText(DOC_ID)).toBe('start +B')
  })

  it('"Keep mine" overwrites deliberately, against the version it was shown', async () => {
    await mountBoth()
    await collide()
    await act(async () => el('document-conflict-mine')!.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(bodyText(DOC_ID)).toBe('start +B')
    expect(el('document-conflict')).toBeNull()
  })

  it('"Save mine as a copy" loses nothing at all', async () => {
    // The branch that matters most: the stored document keeps A's work, B's
    // text becomes its own document, and the widget follows it so B's work is
    // still where B was working.
    await mountBoth()
    await collide()
    await act(async () => el('document-conflict-copy')!.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(bodyText(DOC_ID)).toBe('start +A')
    expect(created).toHaveLength(1)
    expect((created[0]!.body as { text: string }).text).toBe('start +B')
    expect(widgetPatches.at(-1)).toEqual({ id: 'w2', patch: { content: created[0]!.id } })
  })

  it('"Reload theirs" discards only because it was asked to', async () => {
    await mountBoth()
    await collide()
    await act(async () => el('document-conflict-theirs')!.click())
    expect(bodyText(DOC_ID)).toBe('start +A')
    expect(el('document-conflict')).toBeNull()
    expect(created).toHaveLength(0)
  })
})

describe('an AI edit while a widget is open', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('an idle widget picks the AI edit up, and the next keystroke builds ON it', async () => {
    // The AI path writes unconditionally, and that is right: it reads and
    // writes in one step, so it is never holding a stale body. What matters
    // here is the two things that follow. It BUMPS the version, so a widget
    // sitting open cannot later revert it; and it ANNOUNCES, so a widget with
    // nothing unsaved re-seeds and the user's next keystroke extends the AI's
    // text instead of fighting it.
    await mountBoth()
    await act(async () => {
      await window.api.documents.update(DOC_ID, { body: { text: 'AI text' } as never })
    })
    await act(async () => {
      await Promise.resolve()
    })
    await type('a', ' +A')
    expect(bodyText(DOC_ID)).toBe('AI text +A')
    expect(el('document-conflict')).toBeNull()
  })

  it('but a widget with unsaved text is refused rather than reverting the AI edit', async () => {
    await mountBoth()
    await typeAt(0, ' +mine')
    await act(async () => {
      await window.api.documents.update(DOC_ID, { body: { text: 'AI text' } as never })
    })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    await act(async () => {
      await Promise.resolve()
    })
    // The AI's work stands, and the user's text is still on offer.
    expect(bodyText(DOC_ID)).toBe('AI text')
    expect(el('document-conflict')).not.toBeNull()
  })
})
