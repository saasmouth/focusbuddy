import type { DocType } from '@shared/types'
import { useDocumentsStore } from '../../../stores/documents'
import { launchMeeting, type MeetingOrigin } from '../../../lib/startMeeting'
import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import { printSourceOf } from './printSource'
import { useNoticeStore } from '../../../stores/notice'

// The document an office editor's File menu acts on, handed to it by the HOST.
//
// The menu bars used to read the documents store's `active` and act on that:
// Move to trash ran remove(active.id), Make a copy took active.body, Version
// history and Start a meeting used active.id. But a desk widget (OfficeDocWidget)
// holds its document in local state, never in the store, so its File menu acted
// on whatever Documents last had open: trashing, copying or meeting on a
// DIFFERENT document, silently (public 4.3.33 included). A snippet session has
// no document at all.
//
// So the editors have no document id, by design, and the host that DOES know
// which document is on screen binds these ops to it. No menu bar reads the store
// (tests/unit/documentOpsGuard.test.ts). An editor given no ops shows no
// document items: absent, not disabled.
//
// Every member acts BY ID. Two store methods are deliberately not used:
// `rename(title)` renames `active` (renameById is used instead), and nothing
// here reads `active`. `remove(id)` is id-based and brings the Undo toast.

export interface DocumentOps {
  /** The document these ops are bound to. Never the store's `active`. */
  id: string
  /**
   * THIS document's live title, as the host knows it (raw: '' when untitled).
   * For labels that name the document, so they name the bound one.
   */
  title(): string
  /**
   * New document of the same type (creates a row, navigates to it). With
   * `init`, the new document starts with that title and body instead of blank
   * (PlexiiDraw's New from preset and Open SVG).
   */
  newDocument(init?: { title: string; body: unknown }): Promise<void>
  /**
   * Copy THIS document into a new document, and open it. The stored body by
   * default; an editor that holds a newer one in memory (edits still inside
   * its host's save debounce) passes it, so the copy is what is on screen.
   */
  makeCopy(body?: unknown): Promise<void>
  /** Prompt for a name and rename THIS document. */
  rename(): Promise<void>
  openHistory(): void
  /** A meeting about THIS document (it reaches other people: never another id). */
  startMeeting(): void
  /** Confirm, then move THIS document to the Trash (restorable, with Undo). */
  moveToTrash(): Promise<void>
  /**
   * Print… THIS document through the system print dialog, from the same render
   * its Download ▸ PDF makes (main: printDocument.ts). The editor supplies what
   * is on screen (editor/printSource.ts). Present only for the five printable
   * apps on the desktop; absent in the browser runtime, which has no printer,
   * and for Draw, which keeps ⌘P for itself (SPEC §9.5: absent, not disabled).
   */
  print?: () => Promise<void>
  /**
   * Download ▸ PDF for an app whose editor has no export of its own (Cells),
   * from the same render as print(). Present on the desktop for those apps only.
   */
  exportPdf?: () => Promise<void>
}

/** The apps with Print… (Draw is out: it reserves ⌘P). */
export const PRINTABLE_DOC_TYPES: ReadonlySet<DocType> = new Set<DocType>(['doc', 'sheet', 'slides', 'design', 'map'])

/** True where printing exists: the desktop app (its preload serves print:document), never the browser runtime. */
export function canPrintHere(): boolean {
  if ((globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ === true) return false
  const api = (globalThis as { window?: { api?: { print?: { document?: unknown } } } }).window?.api
  return typeof api?.print?.document === 'function'
}

export interface DocumentOpsInput {
  id: string
  docType: DocType
  /** The live title, for prompts, copy names and the meeting. */
  title: () => string
  /** Where New and Make a copy go (Documents: goDocument). */
  onOpen: (id: string) => void
  /** Called only after a confirmed, successful trash (never after a cancel). */
  onTrashed: () => void
  /** Keep a host's local copy in sync (OfficeDocWidget holds its doc in state). */
  onRenamed?: (title: string) => void
}

const NOUN: Partial<Record<DocType, string>> = {
  doc: 'document',
  sheet: 'spreadsheet',
  slides: 'presentation',
  map: 'diagram',
  design: 'design',
  draw: 'artwork'
}

// The meeting kind for each office type (startMeeting's MeetingOrigin).
function meetingOrigin(docType: DocType, id: string, title: string): MeetingOrigin {
  switch (docType) {
    case 'sheet':
      return { kind: 'sheet', id, title }
    case 'slides':
      return { kind: 'slides', id, title }
    case 'map':
    case 'draw':
      return { kind: 'draw', id, title }
    case 'design':
      return { kind: 'design', id, title }
    default:
      return { kind: 'doc', id, title }
  }
}

export function createDocumentOps(input: DocumentOpsInput): DocumentOps {
  const { id, docType } = input
  const noun = NOUN[docType] ?? 'document'
  const name = (): string => input.title().trim() || `Untitled ${noun}`
  const ops: DocumentOps = {
    id,
    title: () => input.title(),
    async newDocument(init) {
      if (init) {
        const doc = await window.api.documents.create({ docType, title: init.title, body: init.body } as never)
        await useDocumentsStore.getState().refresh()
        input.onOpen(doc.id)
        return
      }
      // createBlank opens the new document in the store; that is right here,
      // because New always navigates to it.
      const doc = await useDocumentsStore.getState().createBlank(docType)
      input.onOpen(doc.id)
    },
    async makeCopy(body) {
      let copyBody = body
      if (copyBody === undefined) {
        const src = await window.api.documents.get(id)
        if (!src) return
        copyBody = src.body
      }
      const copy = await window.api.documents.create({ docType, title: `Copy of ${name()}`, body: copyBody } as never)
      await useDocumentsStore.getState().refresh()
      input.onOpen(copy.id)
    },
    async rename() {
      const next = await promptText({ title: `Rename ${noun}`, initial: input.title(), confirmLabel: 'Rename' })
      if (next == null || !next.trim()) return
      await useDocumentsStore.getState().renameById(id, next.trim())
      input.onRenamed?.(next.trim())
    },
    openHistory() {
      openDocHistory(id)
    },
    startMeeting() {
      void launchMeeting(meetingOrigin(docType, id, name()))
    },
    async moveToTrash() {
      const ok = await confirmDialog({
        title: `Move "${name()}" to trash?`,
        body: 'You can restore it from the Documents trash.',
        confirmLabel: 'Move to trash'
      })
      if (!ok) return
      await useDocumentsStore.getState().remove(id)
      input.onTrashed()
    }
  }
  const notify = (text: string): void => useNoticeStore.getState().show({ text, icon: 'print' })
  if (PRINTABLE_DOC_TYPES.has(docType) && canPrintHere()) {
    ops.print = async () => {
      const request = await printSourceOf(ops)?.()
      if (!request) {
        notify(`This ${noun} is still opening. Try Print again in a moment.`)
        return
      }
      const res = await window.api.print.document(request)
      if (!res.ok && !res.cancelled && res.error) notify(res.error)
    }
    if (docType === 'sheet') {
      ops.exportPdf = async () => {
        const request = await printSourceOf(ops)?.()
        if (!request || request.app !== 'cells') return
        const res = await window.api.print.sheetPdf({ title: request.title, sheet: request.sheet, paper: request.paper })
        if (res.ok && res.path) notify(`Saved ${res.path}`)
        else if (res.error) notify(res.error)
      }
    }
  }
  return ops
}
