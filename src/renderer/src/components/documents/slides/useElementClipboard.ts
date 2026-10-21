import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ELEMENT_CLIP_MIME,
  buildElementClipboard,
  elementsPlainText,
  parseElementClipboard,
  pasteElements,
  serializeElementClipboard,
  type ElementClipboard
} from '@shared/elementClipboard'
import type { SlideElement } from '@shared/types'

// Cut, Copy and Paste for canvas elements, shared by PlexiiDesign and
// PlexiiDeck. The payload and all its awkward arithmetic live in
// src/shared/elementClipboard.ts; this is the part that has to touch the DOM.
//
// WHY CLIPBOARD EVENTS and not a keydown handler, which is what both editors
// already had for ⌘D: the native Edit menu (Edit › Cut / Copy / Paste) is made
// of Electron roles, and clicking one makes Chromium fire a DOM cut/copy/paste
// event at whatever has focus. Handling the event means the menu item and the
// key run the same code. PlexiiDraw settled this first; see
// draw/editor/menuClipboard.ts.
//
// No double firing: handling the event calls preventDefault, after which
// Chromium neither repeats it nor passes the key to the menu's accelerator. An
// event we decline (⌘C inside an input, or with nothing selected) is left to
// the browser, which is what makes copying from an inspector field still work.
//
// THE IN-APP MENU is a second path. PlexiiDesign and PlexiiDeck draw their own
// menu bar in React, and clicking a React button fires no clipboard event — so
// those items call copy/cut/paste here directly. A direct paste cannot read the
// system clipboard synchronously, so it uses the last copy made in this app.
// That is why `lastClip` exists: not as a cache, but because an in-app menu
// item has nothing else to read. A copy made in another app arrives through the
// real paste event instead, where the data is on the event.

/** The last copy made in this renderer, for menu-driven paste. */
let lastClip: ElementClipboard | null = null

/** Test seam: forget the last copy. */
export function resetElementClipboard(): void {
  lastClip = null
}

export interface ElementClipboardWiring {
  /** The canvas being copied from and pasted onto. */
  canvas: () => { w: number; h: number }
  /** The elements currently selected, in any order. */
  selected: () => SlideElement[]
  /** Highest z on the page, so a paste lands on top. */
  topZ: () => number
  /** A fresh element id, minted the way this editor mints them. */
  newId: () => string
  /** Add the pasted elements and select them. */
  onPaste: (elements: SlideElement[]) => void
  /** Remove these ids, for a cut. */
  onCut: (ids: string[]) => void
  /**
   * False when the editor must not take the keystroke: a modal is open, or the
   * caret is in text on the canvas, where ⌘C means "copy these words".
   */
  enabled?: () => boolean
}

export interface ElementClipboardApi {
  copy: () => void
  cut: () => void
  paste: () => void
  /** Whether a menu-driven paste has anything to paste. */
  hasClip: boolean
}

export function useElementClipboard(wiring: ElementClipboardWiring): ElementClipboardApi {
  // The wiring closes over editor state that changes every render; a ref keeps
  // the document listeners from being torn down and rebuilt on every keystroke.
  const ref = useRef(wiring)
  ref.current = wiring
  const [hasClip, setHasClip] = useState(lastClip !== null)

  const writeClip = useCallback((data: DataTransfer | null): boolean => {
    const w = ref.current
    const els = w.selected()
    if (els.length === 0) return false
    const clip = buildElementClipboard(els, w.canvas())
    lastClip = clip
    setHasClip(true)
    if (data) {
      data.setData(ELEMENT_CLIP_MIME, serializeElementClipboard(clip))
      // The words as well, so a paste into a message or a document gets the
      // copy rather than a wall of JSON. Elements with no text leave this
      // empty, which is honest: there were no words to take.
      data.setData('text/plain', elementsPlainText(els))
    }
    return true
  }, [])

  const readClip = useCallback((data: DataTransfer | null): ElementClipboard | null => {
    const fromEvent = data ? parseElementClipboard(data.getData(ELEMENT_CLIP_MIME)) : null
    return fromEvent ?? lastClip
  }, [])

  const applyPaste = useCallback((clip: ElementClipboard | null): boolean => {
    if (!clip) return false
    const w = ref.current
    const els = pasteElements(clip, { canvas: w.canvas(), topZ: w.topZ(), newId: w.newId })
    if (els.length === 0) return false
    w.onPaste(els)
    return true
  }, [])

  // The in-app menu's three items.
  const copy = useCallback(() => {
    writeClip(null)
  }, [writeClip])
  const cut = useCallback(() => {
    const ids = ref.current.selected().map((e) => e.id)
    if (writeClip(null) && ids.length) ref.current.onCut(ids)
  }, [writeClip])
  const paste = useCallback(() => {
    applyPaste(lastClip)
  }, [applyPaste])

  useEffect(() => {
    /** Is this event ours, or does it belong to a field or a text selection? */
    function mine(e: ClipboardEvent): boolean {
      if (ref.current.enabled && !ref.current.enabled()) return false
      const node = e.target instanceof Node ? (e.target.nodeType === 1 ? (e.target as HTMLElement) : e.target.parentElement) : null
      if (node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable)) return false
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().length > 0) return false
      return true
    }

    function onCopy(e: ClipboardEvent): void {
      if (!mine(e)) return
      if (writeClip(e.clipboardData)) e.preventDefault()
    }
    function onCut(e: ClipboardEvent): void {
      if (!mine(e)) return
      const ids = ref.current.selected().map((el) => el.id)
      if (writeClip(e.clipboardData)) {
        e.preventDefault()
        if (ids.length) ref.current.onCut(ids)
      }
    }
    function onPaste(e: ClipboardEvent): void {
      if (!mine(e)) return
      if (applyPaste(readClip(e.clipboardData))) e.preventDefault()
    }

    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', onPaste)
    }
  }, [writeClip, readClip, applyPaste])

  return { copy, cut, paste, hasClip }
}
