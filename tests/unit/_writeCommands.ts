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
