import type { Editor } from '@tiptap/react'
import {
  buildWriteCommands,
  type WriteCommandDeps,
  type WriteCommands
} from '../../src/renderer/src/components/documents/editor/writeCommands'

// Write's REAL command registry over a stub editor, for the tests that render a
// Write surface. They build the genuine commands rather than a hand-written
// lookalike, so a label, a key or an enabled state asserted here is the one the
// person gets — which is the whole point of there being one registry.
//
// Every callback defaults to a no-op; a test overrides only the ones it watches.

/**
 * An editor that answers the few things the registry asks, and nothing more.
 * Shared, so the Write registry test and the cross-app guard cannot drift on
 * what "a Write editor" means. `can()` reports undo and redo available; pass a
 * different one where a test needs them off.
 */
export function stubEditor(active: string[] = []): Editor {
  const chain: unknown = new Proxy(function () {}, {
    get: () => () => chain,
    apply: () => chain
  })
  return {
    isActive: (n: unknown) => typeof n === 'string' && active.includes(n),
    getAttributes: () => ({}),
    can: () => ({ undo: () => true, redo: () => true }),
    chain: () => chain,
    getHTML: () => '<p></p>',
    getText: () => '',
    getJSON: () => ({ type: 'doc', content: [] }),
    state: { selection: { empty: false } },
    storage: {}
  } as unknown as Editor
}

export function writeCommandsFor(editor: unknown, over: Partial<WriteCommandDeps> = {}): WriteCommands {
  const noop = (): void => {}
  const deps: WriteCommandDeps = {
    editor: editor as Editor,
    readOnly: false,
    title: 'A document',
    insertImage: noop,
    insertWidget: noop,
    insertDoc: noop,
    insertSnippet: noop,
    saveSnippet: noop,
    importDocx: noop,
    exportDocx: noop,
    exportPdf: noop,
    find: noop,
    findReplace: noop,
    focusMode: noop,
    outline: noop,
    comments: noop,
    pageView: true,
    setPageView: noop,
    setPortrait: noop,
    setLandscape: noop,
    dialog: noop,
    shortcuts: noop,
    draftAi: noop,
    rewriteAi: noop,
    ...over
  }
  return buildWriteCommands(deps)
}
