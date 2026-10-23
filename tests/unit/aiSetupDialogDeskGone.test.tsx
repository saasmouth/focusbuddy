// "Let me set up your desk" opens straight after a desk is created. The next
// Cmd-Z undoes that create — the global undo takes it, because focus is on the
// dialog's Close button, not a text field — and the desk is gone. The dialog
// used to stay open regardless, still reading "for: <the desk that is gone>"
// and still offering to build work widgets for it. It closes now, and Accept
// can never build for a desk that no longer exists.
//
// The e2e half is UNDO-KEY (tests/e2e/undoKeyboard.spec.ts), which drives the
// real create dialog and the real Cmd-Z.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiBuildSuggestion, FbNode } from '../../src/shared/types'

// The real node store pulls in sync, CRDT and capability machinery; this is the
// one slice of it the dialog reads, as a real zustand store. Built in
// vi.hoisted so it exists whether or not the component imports the store.
const nodes = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return { store: create<{ nodes: FbNode[] }>(() => ({ nodes: [] })) }
})
vi.mock('../../src/renderer/src/stores/nodes', () => ({ useNodeStore: nodes.store }))
vi.mock('../../src/renderer/src/components/Icon', () => ({ default: () => <span /> }))
vi.mock('../../src/renderer/src/components/ai/SuggestionPreview', () => ({ default: () => <div /> }))

import AISetupDialog from '../../src/renderer/src/components/AISetupDialog'

const desk = { id: 'desk-1', title: 'Quarterly plan', kind: 'task', parentId: null } as unknown as FbNode
const suggestion = { kind: 'sticky', title: 'Goals', reason: 'start here' } as unknown as AiBuildSuggestion

let host: HTMLDivElement
let root: Root
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    setup: { suggest: vi.fn(async () => ({ ok: true, suggestions: [suggestion] })) }
  }
  nodes.store.setState({ nodes: [desk] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('AISetupDialog when its desk stops existing', () => {
  it('stays open while the desk exists', async () => {
    const onClose = vi.fn()
    act(() => root.render(<AISetupDialog task={desk} onClose={onClose} onAccept={vi.fn(async () => {})} />))
    await flush()
    expect(document.body.textContent).toContain('for: Quarterly plan')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes itself when the desk is removed from the store (an undone create, a trash)', async () => {
    const onClose = vi.fn()
    act(() => root.render(<AISetupDialog task={desk} onClose={onClose} onAccept={vi.fn(async () => {})} />))
    await flush()
    expect(onClose).not.toHaveBeenCalled()

    act(() => nodes.store.setState({ nodes: [] }))
    await flush()
    expect(onClose).toHaveBeenCalled()
  })

  it('never builds for a desk that is gone, even if Accept is reached before the close lands', async () => {
    const onAccept = vi.fn(async () => {})
    // A parent that ignores onClose, so the dialog is still on screen and its
    // Accept still clickable after the desk goes.
    act(() => root.render(<AISetupDialog task={desk} onClose={() => {}} onAccept={onAccept} />))
    await flush()
    act(() => nodes.store.setState({ nodes: [] }))
    await flush()
    const accept = Array.from(document.querySelectorAll('button')).find((b) =>
      /add|set up|create/i.test(b.textContent ?? '')
    )
    expect(accept, 'the dialog offers an accept button once suggestions are ready').toBeTruthy()
    await act(async () => {
      accept!.click()
      await Promise.resolve()
    })
    expect(onAccept).not.toHaveBeenCalled()
  })
})
