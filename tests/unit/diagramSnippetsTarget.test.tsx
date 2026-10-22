import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useDiagramSnippetTarget, diagramSnippetTargetId } from '../../src/renderer/src/components/documents/diagram/diagramSnippets'
import { useSnippetsStore } from '../../src/renderer/src/stores/snippets'

// The diagram target's lifecycle (docs/saved-snippets.md rule 1): it registers
// while the editor is mounted and editable, and withdraws on unmount, so the
// picker never offers a diagram that is no longer on screen.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Surface({ id, readOnly }: { id: string; readOnly: boolean }): null {
  useDiagramSnippetTarget(id, 'Flow', readOnly, () => true)
  return null
}

const targets = (): string[] => Object.keys(useSnippetsStore.getState().targets)

describe('useDiagramSnippetTarget', () => {
  it('registers on mount and withdraws on unmount; two mounts are two targets', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement('div', null, createElement(Surface, { id: 's1', readOnly: false }), createElement(Surface, { id: 's2', readOnly: false }))))
    expect(targets()).toEqual(expect.arrayContaining([diagramSnippetTargetId('s1'), diagramSnippetTargetId('s2')]))
    act(() => root.render(createElement(Surface, { id: 's1', readOnly: false })))
    expect(targets()).toContain(diagramSnippetTargetId('s1'))
    expect(targets()).not.toContain(diagramSnippetTargetId('s2'))
    act(() => root.unmount())
    expect(targets()).not.toContain(diagramSnippetTargetId('s1'))
  })

  it('a read-only diagram registers nothing, and withdraws when it becomes read-only', () => {
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Surface, { id: 'ro', readOnly: true })))
    expect(targets()).not.toContain(diagramSnippetTargetId('ro'))
    act(() => root.render(createElement(Surface, { id: 'ro', readOnly: false })))
    expect(targets()).toContain(diagramSnippetTargetId('ro'))
    act(() => root.render(createElement(Surface, { id: 'ro', readOnly: true })))
    expect(targets()).not.toContain(diagramSnippetTargetId('ro'))
    act(() => root.unmount())
  })
})
