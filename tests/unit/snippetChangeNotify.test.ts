// The registry that makes a live instance follow an edit.
//
// A live instance resolves its master on mount, which covers a host opened after
// an edit and NOT the one the user is looking at. The owner's feature edits the
// master from inside a placed instance, so the instance beside it has to change
// too — otherwise "changes appear everywhere it's used" is a claim the UI does
// not honour.
import { describe, it, expect, vi } from 'vitest'
import { onSnippetChanged, notifySnippetChanged } from '../../src/renderer/src/stores/snippets'

describe('live-instance invalidation', () => {
  it('tells every instance of that snippet, and only that snippet', () => {
    const a1 = vi.fn()
    const a2 = vi.fn()
    const other = vi.fn()
    onSnippetChanged('a', a1)
    onSnippetChanged('a', a2)
    onSnippetChanged('b', other)

    notifySnippetChanged('a')
    expect(a1).toHaveBeenCalledTimes(1)
    expect(a2).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
  })

  it('stops after unsubscribe, so an unmounted host is never called', () => {
    const cb = vi.fn()
    const stop = onSnippetChanged('c', cb)
    stop()
    notifySnippetChanged('c')
    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribing one instance leaves its siblings subscribed', () => {
    const stays = vi.fn()
    const goes = vi.fn()
    onSnippetChanged('d', stays)
    const stop = onSnippetChanged('d', goes)
    stop()
    notifySnippetChanged('d')
    expect(stays).toHaveBeenCalledTimes(1)
    expect(goes).not.toHaveBeenCalled()
  })

  it('notifying a snippet nothing is watching is harmless', () => {
    expect(() => notifySnippetChanged('nobody-here')).not.toThrow()
  })
})
