import type { DocumentOps } from './documentOps'
import { MenuBarShell, type MenuDef, type MenuItem } from './menuBarKit'

// The PlexiDiagrams menu bar. Document-level File actions come from the
// DocumentOps the host bound to the diagram on screen (never the documents
// store's `active`, which in a desk widget is some other document); the editor
// supplies everything else (import/export, Edit, View, Insert, Arrange, Help) as
// menu items wired to its real commands, so nothing here invents an action.
//
// The file name predates the PlexiDiagrams rename; PlexiDraw is now the separate
// vector + painting studio and has its own DrawStudioMenuBar.

export interface DrawMenuActions {
  // Extra File items (import / export), shown after the document actions.
  file: () => MenuItem[]
  edit: () => MenuItem[]
  view: () => MenuItem[]
  insert: () => MenuItem[]
  arrange: () => MenuItem[]
  help: () => MenuItem[]
  /**
   * The diagram on screen, bound by the host (createDocumentOps). Absent when it
   * is not a document (a diagram snippet session): then New, Make a copy,
   * Rename, Version history, Start a meeting and Move to trash are not shown at
   * all; the editor's own import/export items stay.
   */
  documentOps?: DocumentOps
}

export default function DrawMenuBar({ actions }: { actions: DrawMenuActions }): JSX.Element {
  const a = actions
  const ops = a.documentOps

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: (): MenuItem[] =>
        ops
          ? [
              { kind: 'item', label: 'New diagram', icon: 'note_add', run: () => void ops.newDocument() },
              { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void ops.makeCopy() },
              { kind: 'sep' },
              { kind: 'item', label: 'Rename', icon: 'edit', run: () => void ops.rename() },
              { kind: 'item', label: 'Version history', icon: 'history', run: ops.openHistory },
              { kind: 'sep' },
              ...a.file(),
              { kind: 'sep' },
              { kind: 'item', label: 'Start a meeting', icon: 'videocam', run: ops.startMeeting },
              { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void ops.moveToTrash() }
            ]
          : a.file()
    },
    { id: 'edit', label: 'Edit', build: a.edit },
    { id: 'view', label: 'View', build: a.view },
    { id: 'insert', label: 'Insert', build: a.insert },
    { id: 'arrange', label: 'Arrange', build: a.arrange },
    { id: 'help', label: 'Help', build: a.help }
  ]

  return <MenuBarShell menus={menus} testid="draw-menubar" />
}
