import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import { useDocumentsStore } from '../../../stores/documents'
import { useViewStore } from '../../../stores/view'
import { launchMeeting } from '../../../lib/startMeeting'
import { MenuBarShell, type MenuDef, type MenuItem } from './menuBarKit'

// The PlexiDiagrams menu bar. Document-level File actions live here; the editor
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
}

export default function DrawMenuBar({ actions }: { actions: DrawMenuActions }): JSX.Element {
  const a = actions
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const active = useDocumentsStore((s) => s.active)
  const rename = useDocumentsStore((s) => s.rename)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const goDocuments = useViewStore((s) => s.goDocuments)
  const title = active?.title ?? 'Untitled diagram'

  async function newDiagram(): Promise<void> {
    const doc = await createBlank('map')
    goDocument(doc.id)
  }
  async function makeCopy(): Promise<void> {
    const copy = await window.api.documents.create({
      docType: 'map',
      title: `Copy of ${title}`,
      body: active?.body
    })
    goDocument(copy.id)
  }
  async function doRename(): Promise<void> {
    const next = await promptText({ title: 'Rename diagram', initial: title, confirmLabel: 'Rename' })
    if (next != null && next.trim()) void rename(next.trim())
  }
  async function moveToTrash(): Promise<void> {
    if (!active) return
    const ok = await confirmDialog({
      title: `Move "${title}" to trash?`,
      body: 'You can restore it from the Documents trash.',
      confirmLabel: 'Move to trash'
    })
    if (!ok) return
    await remove(active.id)
    goDocuments()
  }

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => [
        { kind: 'item', label: 'New diagram', icon: 'note_add', run: () => void newDiagram() },
        { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void makeCopy() },
        { kind: 'sep' },
        { kind: 'item', label: 'Rename', icon: 'edit', run: doRename },
        { kind: 'item', label: 'Version history', icon: 'history', run: () => { if (active) openDocHistory(active.id) } },
        { kind: 'sep' },
        ...a.file(),
        { kind: 'sep' },
        { kind: 'item', label: 'Start a meeting', icon: 'videocam', run: () => void launchMeeting({ kind: 'draw', id: active?.id ?? '', title: title || 'Diagram meeting' }) },
        { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void moveToTrash() }
      ]
    },
    { id: 'edit', label: 'Edit', build: a.edit },
    { id: 'view', label: 'View', build: a.view },
    { id: 'insert', label: 'Insert', build: a.insert },
    { id: 'arrange', label: 'Arrange', build: a.arrange },
    { id: 'help', label: 'Help', build: a.help }
  ]

  return <MenuBarShell menus={menus} testid="draw-menubar" />
}
