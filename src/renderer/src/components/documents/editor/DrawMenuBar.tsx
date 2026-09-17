import { useState } from 'react'
import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import type { MapShape } from '@shared/types'
import { useDocumentsStore } from '../../../stores/documents'
import { useViewStore } from '../../../stores/view'
import { launchMeeting } from '../../../lib/startMeeting'
import { MenuBarShell, MenuModal, type MenuDef } from './menuBarKit'

// A menu bar for PlexiDiagrams (the flowchart / mind-map canvas). It is a
// lightweight React-Flow surface: you add shape nodes, connect them, and fit the
// view. It has no undo history or file export of its own, so this menu bar
// deliberately does NOT show Edit/Download/Format — only the actions the canvas
// can really do, plus the document-level File actions.
//
// The file name predates the PlexiDiagrams rename; PlexiDraw is now the separate
// vector + painting studio and has its own DrawStudioMenuBar.

export interface DrawMenuActions {
  shapes: { shape: MapShape; label: string }[]
  addNode: (shape: MapShape) => void
  insertWidget: () => void
  fitView: () => void
}

export default function DrawMenuBar({ actions }: { actions: DrawMenuActions }): JSX.Element {
  const a = actions
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const active = useDocumentsStore((s) => s.active)
  const rename = useDocumentsStore((s) => s.rename)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const goDocuments = useViewStore((s) => s.goDocuments)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
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
        { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void moveToTrash() }
      ]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        ...a.shapes.map((s) => ({ kind: 'item' as const, label: s.label, run: () => a.addNode(s.shape) })),
        { kind: 'sep' as const },
        { kind: 'item' as const, label: 'Widget from a desk', icon: 'widgets', run: a.insertWidget },
        { kind: 'sep' as const },
        { kind: 'item' as const, label: 'Meeting', icon: 'videocam', run: () => void launchMeeting({ kind: 'draw', id: active?.id ?? '', title: title || 'Diagram meeting' }) }
      ]
    },
    {
      id: 'view',
      label: 'View',
      build: () => [{ kind: 'item', label: 'Fit to view', icon: 'fit_screen', run: a.fitView }]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [{ kind: 'item', label: 'How to diagram', icon: 'help', run: () => setShortcutsOpen(true) }]
    }
  ]

  return (
    <>
      <MenuBarShell menus={menus} testid="draw-menubar" />
      {shortcutsOpen && (
        <MenuModal title="How to diagram" onClose={() => setShortcutsOpen(false)}>
          <ul className="space-y-1.5 text-[13px] text-[var(--ink-70)] list-disc pl-4">
            <li>Add a shape from the Insert menu or the stencil palette.</li>
            <li>Double-click a node to rename it.</li>
            <li>Drag from a node&apos;s dot to connect it to another.</li>
            <li>Double-click a connector to label it.</li>
            <li>Press Delete or Backspace to remove the selection.</li>
          </ul>
        </MenuModal>
      )}
    </>
  )
}
