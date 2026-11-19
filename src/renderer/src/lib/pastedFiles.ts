// Files copied in Finder (or Explorer) and pasted: delivered where the paste
// was aimed (owner, 2026-11-19: paste must work everywhere).
//
// A page is only given a Finder copy's NAMES and ICON, so main reads the files
// and sends their bytes (main/pasteFiles.ts). Here they become File objects and
// a PASTE_FILES_EVENT is dispatched at the element with focus, bubbling, so the
// nearest place that takes files takes them:
//   - the assistant's composer: its attachment tray (pictures as pictures,
//     documents as their text);
//   - Files (the view or the panel): imported into the folder shown;
//   - a Gallery work widget: pictures join it;
//   - the desk, when focus is on the desk and not in a field: one file work
//     widget per file, as a Finder drop makes.
// With nothing focused (focus on the page itself), the event goes to where the
// person last clicked instead: a Gallery or the Files panel's blank area holds
// no focus, yet a paste after clicking there is aimed there. If nothing there
// takes the files, the event bubbles on to the desk.
// A taker calls preventDefault(). If none does, a text field gets the files'
// names (what the platform pastes there, typed in), and
// anywhere else a notice says where files can be pasted. Files main could not
// read (too large, a folder) are named in a notice, never dropped in silence.
import type { PastedFilesPayload } from '@shared/types'
import { useNoticeStore } from '../stores/notice'

export const PASTE_FILES_EVENT = 'plexii:pastefiles'

export interface PasteFilesDetail {
  files: File[]
}

/** The pasted files as File objects. */
export function toFiles(payload: PastedFilesPayload): File[] {
  return payload.files.map((f) => new File([f.bytes as BlobPart], f.name, { type: f.mimeType === 'application/octet-stream' ? '' : f.mimeType }))
}

/** The files a PASTE_FILES_EVENT carries. */
export function pastedFilesOf(e: Event): File[] {
  return ((e as CustomEvent<PasteFilesDetail>).detail?.files ?? []).slice()
}

/** Whether an element is a field a person types in. */
export function isTextField(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(el.type)
  return (el as HTMLElement).isContentEditable === true
}

/** The words for files that were copied but not pasted. */
export function skippedNote(skipped: PastedFilesPayload['skipped']): string | null {
  if (!skipped.length) return null
  const named = skipped.slice(0, 3).map((s) => `“${s.name}” (${s.reason})`)
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''
  return `Not pasted: ${named.join(', ')}${more}.`
}

export const NOWHERE_NOTE = 'Files can be pasted on a desk, into Files, or into the assistant.'

/** Where a paste goes when focus is on the page itself (the router: the last click). */
export type PasteFallback = () => Element | null

/**
 * Deliver pasted files to the element with focus (or, with nothing focused, to
 * `fallback`). Returns where they went: 'taken' (something took them), 'text'
 * (the ordinary paste ran in a field), 'nowhere' (said in a notice), or 'none'
 * (nothing was read).
 */
export function deliverPastedFiles(
  payload: PastedFilesPayload,
  doc: Document = document,
  fallback?: PasteFallback
): 'taken' | 'text' | 'nowhere' | 'none' {
  const note = skippedNote(payload.skipped)
  const files = toFiles(payload)
  if (!files.length) {
    if (note) useNoticeStore.getState().show({ text: note, icon: 'info' }, 8000)
    return 'none'
  }
  const focused = doc.activeElement as HTMLElement | null
  const target = (focused && focused !== doc.body ? focused : null) ?? (fallback?.() as HTMLElement | null) ?? doc.body
  const ev = new CustomEvent<PasteFilesDetail>(PASTE_FILES_EVENT, { detail: { files }, bubbles: true, cancelable: true, composed: true })
  target.dispatchEvent(ev)
  if (note) useNoticeStore.getState().show({ text: note, icon: 'info' }, 8000)
  if (ev.defaultPrevented) return 'taken'
  if (isTextField(target)) {
    // What the platform pastes in a field: the files' names. Typed in, not
    // pasted: a page's own execCommand('paste') may be refused.
    const names = [...payload.files.map((f) => f.name), ...payload.skipped.map((s) => s.name)]
    doc.execCommand('insertText', false, names.join('\n'))
    return 'text'
  }
  useNoticeStore.getState().show({ text: NOWHERE_NOTE, icon: 'info' })
  return 'nowhere'
}

/** Listen for pasted files from main. Called once from App. */
export function installPastedFilesRouter(doc: Document = document): () => void {
  const api = (window as unknown as { api?: { pastedFiles?: { onPaste?: (cb: (p: PastedFilesPayload) => void) => () => void } } }).api
  const onPaste = api?.pastedFiles?.onPaste
  if (!onPaste) return () => undefined
  // Where the person last clicked: capture phase, so nothing that stops a
  // pointerdown hides it.
  let lastClicked: Element | null = null
  const onDown = (e: Event): void => {
    lastClicked = e.target instanceof Element ? e.target : null
  }
  doc.addEventListener('pointerdown', onDown, true)
  const stop = onPaste((p) => void deliverPastedFiles(p, doc, () => (lastClicked?.isConnected ? lastClicked : null)))
  return () => {
    doc.removeEventListener('pointerdown', onDown, true)
    stop()
  }
}
