// Double-click a .plexii-* file and Plexii opens it (F3, 2026-11-20): the
// window's end. Main read each file the OS handed over (main/plexiiFileOpen.ts);
// here each one is brought in as a COPY by the same import as Files › Import,
// then put on the desk on screen -- a document as its Office widget, a work
// widget as a linked instance of its new file -- or, with no desk on screen,
// opened. One notice says what happened, naming any file that could not be
// opened and why. The live wiring is components/PlexiiFileOpenEffects.tsx.
import type { OpenedPlexiiFile } from '@shared/plexiiFileTypes'

type Imported =
  | { ok: true; kind: 'document'; document: { id: string; docType: string; title: string } }
  | { ok: true; kind: 'widget'; file: { id: string; kind: string; title: string } }
  | { ok: false; error?: string; canceled?: boolean }

export interface OpenFilesDeps {
  /** Files › Import's own import (widgetFiles:import): a new copy in Files. */
  importText: (text: string) => Promise<Imported>
  /** The desk on screen, if any. */
  deskOnScreen: () => string | null
  /** Put a work widget file on a desk as a linked instance; null when it could not be. */
  placeWidgetFile: (fileId: string, deskId: string) => Promise<unknown | null>
  /** Put a document on a desk as its Office widget. */
  placeDocument: (doc: { id: string; docType: string; title: string }, deskId: string) => Promise<unknown | null>
  /** Open a document or work widget file full-pane. */
  open: (id: string) => void
  notify: (n: { text: string; icon: 'check_circle' | 'warning' | 'error' }) => void
}

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)

export async function bringInOpenedFiles(items: readonly OpenedPlexiiFile[], deps: OpenFilesDeps): Promise<void> {
  if (!items.length) return
  const failed: string[] = []
  const brought: Array<{ id: string; title: string; place: (deskId: string) => Promise<unknown | null> }> = []
  for (const item of items) {
    if ('error' in item) {
      failed.push(`“${item.name}” could not be opened: ${sentence(item.error)}`)
      continue
    }
    try {
      const r = await deps.importText(item.text)
      if (!r.ok) {
        failed.push(`“${item.name}” could not be opened: ${sentence(r.error ?? 'It is not a Plexii file.')}`)
      } else if (r.kind === 'document') {
        const doc = r.document
        brought.push({ id: doc.id, title: doc.title || item.name, place: (deskId) => deps.placeDocument(doc, deskId) })
      } else {
        const file = r.file
        brought.push({ id: file.id, title: file.title || item.name, place: (deskId) => deps.placeWidgetFile(file.id, deskId) })
      }
    } catch (e) {
      failed.push(`“${item.name}” could not be opened: ${sentence((e as Error)?.message || 'It could not be brought in.')}`)
    }
  }

  let said = ''
  let offDesk = 0
  if (brought.length) {
    const desk = deps.deskOnScreen()
    if (desk) {
      for (const b of brought) {
        const placed = await b.place(desk).catch(() => null)
        if (!placed) offDesk++
      }
    } else {
      deps.open(brought[brought.length - 1]!.id)
    }
    const one = brought.length === 1
    const opened = one ? `Opened “${brought[0]!.title}”.` : `Opened ${brought.length} Plexii files.`
    const where = !desk
      ? `${one ? 'A copy is' : 'Copies are'} in Files.`
      : offDesk === 0
        ? `${one ? 'A copy is' : 'Copies are'} in Files and on this desk.`
        : one
          ? 'A copy is in Files; it could not be put on this desk.'
          : `Copies are in Files; ${offDesk} could not be put on this desk.`
    said = `${opened} ${where}`
  }
  const text = [said, ...failed].filter(Boolean).join(' ')
  const icon = !brought.length ? 'error' : failed.length || offDesk ? 'warning' : 'check_circle'
  deps.notify({ text, icon })
}
