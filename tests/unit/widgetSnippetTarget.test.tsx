import { describe, expect, it } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Snippet, SnippetBody } from '../../src/shared/snippets'
import { linkModesFor } from '../../src/shared/snippets'
import { useTextWidgetSnippets } from '../../src/renderer/src/components/widgets/useWidgetSnippets'
import { useSnippetsStore } from '../../src/renderer/src/stores/snippets'
import type { Widget } from '../../src/shared/types'
import * as F from './snippetConvertFixtures'

// A work widget as a snippet target (docs/saved-snippets.md): registers while
// mounted, withdraws on unmount, Duplicate only, no host, and its insert goes
// through the store so a refusal reaches the person verbatim and a converted
// insert shows its lossy line.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// A use is counted through IPC on a real insert; there is no main process here.
;(window as unknown as { api: unknown }).api = { snippets: { recordUse: async () => true } }

const widget = (id: string, kind: string): Widget => ({ id, kind, title: '', content: '' }) as unknown as Widget
const snip = (body: SnippetBody): Snippet => ({ id: 's', kind: body.kind, name: 'S', description: '', body, tags: [], scope: 'personal', orgId: 'personal', authorId: null, revision: 1, usageCount: 0, createdAt: 0, updatedAt: 0 })

let textNow = ''
function Sticky({ id }: { id: string }): null {
  const [text, setText] = useState('Hello')
  textNow = text
  useTextWidgetSnippets(widget(id, 'sticky'), 'sticky', () => text, (t) => setText(t), () => null)
  return null
}

const targets = () => useSnippetsStore.getState().targets
const stickyTargets = (id: string): string[] => Object.keys(targets()).filter((k) => k.startsWith(`widget:${id}:`))

describe('a sticky as a snippet target', () => {
  it('registers on mount, withdraws on unmount; two mounts are two places', () => {
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement('div', null, createElement(Sticky, { id: 'a' }), createElement(Sticky, { id: 'a' }))))
    expect(stickyTargets('a')).toHaveLength(2)
    const t = targets()[stickyTargets('a')[0]]
    expect(t.supports).toEqual(['duplicate'])
    expect(t.host).toBeUndefined()
    expect(linkModesFor(t, 'sheet')).toEqual(['duplicate'])
    act(() => root.unmount())
    expect(stickyTargets('a')).toHaveLength(0)
  })

  it('a Cells block lands as a pipe table after what was there, and the lossy line is the notice', async () => {
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Sticky, { id: 'b' })))
    const id = stickyTargets('b')[0]
    let ok = false
    await act(async () => {
      ok = await useSnippetsStore.getState().insert(snip(F.sheet()), 'duplicate', id)
    })
    expect(ok).toBe(true)
    expect(textNow.split('\n')[0]).toBe('Hello')
    expect(textNow.split('\n')[1]).toBe('| Item | Qty | Price | Total |')
    expect(useSnippetsStore.getState().notice).toContain('Formulas become their values.')
    act(() => root.unmount())
  })

  it('a drawing is refused, and the reason reaches the store verbatim', async () => {
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Sticky, { id: 'c' })))
    let ok = true
    await act(async () => {
      ok = await useSnippetsStore.getState().insert(snip(F.draw()), 'duplicate', stickyTargets('c')[0])
    })
    expect(ok).toBe(false)
    expect(useSnippetsStore.getState().error).toBe('Stickies hold text. Insert it on the desk to add it as an image.')
    expect(textNow).toBe('Hello')
    act(() => root.unmount())
  })
})
