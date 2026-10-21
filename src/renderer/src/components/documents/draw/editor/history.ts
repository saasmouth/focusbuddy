// Undo and redo for the PlexiiDraw editor.
//
// Snapshot history: every entry is a whole document, which is cheap because
// documents are immutable and share every unchanged node by reference (and,
// in v2, paint-layer bytes live in the asset store, so an entry holds ids).
// 80 entries, one per gesture or command.
//
// In a live co-editing session the local stacks are not used: steps go to the
// own-change Y.UndoManager (yjsKeyedJson.createLiveUndo), whose undo reverses
// only this person's operations, and the result comes back through the fold.

import type { DrawDoc } from '@shared/draw/model'
import type { EditorState, History, HostService, Txn } from './types'

const DEPTH = 80

interface StoreLike {
  getState(): EditorState
  setState(patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)): void
}

export interface HistoryHooks {
  /** Hand a document to the host (already decides v1/v2 and opaque restoration). */
  emit(doc: DrawDoc): void
  host: HostService
  /** Called after undo/redo restores a document, so paint layers repaint from it. */
  onRestore(): void
}

const NOOP_TXN: Txn = { preview: () => {}, commit: () => {}, cancel: () => {} }

export function createHistory(store: StoreLike, hooks: HistoryHooks): History {
  const live = (): ReturnType<HostService['liveUndo']> => hooks.host.liveUndo()

  function setDoc(next: DrawDoc): void {
    store.setState({ doc: next })
    hooks.emit(next)
  }

  const history: History = {
    commit(next, label = 'Edit') {
      const s = store.getState()
      if (s.readOnly) return
      const prev = s.doc
      if (next === prev) return
      const lu = live()
      if (lu) lu.checkpoint()
      else store.setState((st) => ({ past: [...st.past.slice(-(DEPTH - 1)), { doc: prev, label }], future: [] }))
      setDoc(next)
    },

    replace(next) {
      if (store.getState().readOnly) return
      setDoc(next)
    },

    begin(label = 'Edit') {
      const s = store.getState()
      if (s.readOnly) return NOOP_TXN
      const lu = live()
      if (lu) {
        // Live: everything streamed until the next checkpoint is one step.
        lu.checkpoint()
        return { preview: (d) => history.replace(d), commit: () => {}, cancel: () => {} }
      }
      // The "before" is recorded eagerly, exactly as a gesture always has: a
      // gesture that then changes nothing is cancelled off the stack again.
      const before = s.doc
      store.setState((st) => ({ past: [...st.past.slice(-(DEPTH - 1)), { doc: before, label }], future: [] }))
      return {
        preview: (d) => history.replace(d),
        commit: () => {},
        cancel: () => store.setState((st) => ({ past: st.past.slice(0, -1) }))
      }
    },

    undo() {
      const lu = live()
      if (lu) {
        lu.undo()
        return
      }
      const s = store.getState()
      if (!s.past.length) return
      const prev = s.past[s.past.length - 1]
      store.setState({ past: s.past.slice(0, -1), future: [{ doc: s.doc, label: prev.label }, ...s.future.slice(0, DEPTH - 1)] })
      setDoc(prev.doc)
      hooks.onRestore()
    },

    redo() {
      const lu = live()
      if (lu) {
        lu.redo()
        return
      }
      const s = store.getState()
      if (!s.future.length) return
      const next = s.future[0]
      store.setState({ future: s.future.slice(1), past: [...s.past.slice(-(DEPTH - 1)), { doc: s.doc, label: next.label }] })
      setDoc(next.doc)
      hooks.onRestore()
    },

    canUndo() {
      const lu = live()
      return lu ? lu.canUndo() : store.getState().past.length > 0
    },

    canRedo() {
      const lu = live()
      return lu ? lu.canRedo() : store.getState().future.length > 0
    }
  }
  return history
}
