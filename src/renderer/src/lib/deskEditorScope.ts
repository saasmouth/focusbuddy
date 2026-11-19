// An office editor (Deck, Design, Draw, Diagrams) sitting in a work widget on a
// desk shares the window with the desk and every other widget. Its window-level
// key and clipboard listeners were written for the full-screen editor, where the
// whole window is the editor, so on a desk they acted whenever no text field had
// focus: ⌘Z on the desk undid a Deck edit, and ⌘V on an empty desk pasted into
// every Deck, Design and Diagram on it as well as onto the desk (owner,
// 2026-11-19: "check for similar issues with all other widgets and fix").
//
// On a desk an editor's keys are its own only while focus is inside it. Its root
// takes focus when it is pressed anywhere that does not take focus itself (a
// slide, a shape, the canvas), so working in it feels the same as before;
// pressing the desk or another widget moves focus there, and the keys with it.
// Full screen, nothing changes: the editor owns the window.
import { useCallback, useRef } from 'react'
import type React from 'react'

const TAKES_FOCUS = 'input, textarea, select, button, a[href], [contenteditable="true"], [contenteditable=""], [tabindex]:not([tabindex="-1"])'

export interface DeskEditorScope {
  /** The editor's root element. */
  rootRef: React.MutableRefObject<HTMLDivElement | null>
  /** Are keys and clipboard events the editor's right now? Always, full screen. */
  owns: () => boolean
  /** Spread onto the root: focusable, and focused when pressed. Empty full screen. */
  rootProps: { tabIndex?: number; onPointerDownCapture?: (e: React.PointerEvent) => void }
}

export function ownsFocus(root: Element | null, active: Element | null = document.activeElement): boolean {
  return !!root && !!active && root.contains(active)
}

export function useDeskEditorScope(onDesk: boolean, rootRef?: React.MutableRefObject<HTMLDivElement | null>): DeskEditorScope {
  const own = useRef<HTMLDivElement | null>(null)
  const ref = rootRef ?? own
  const owns = useCallback((): boolean => !onDesk || ownsFocus(ref.current), [onDesk, ref])
  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent): void => {
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest(TAKES_FOCUS)) return
      ref.current?.focus({ preventScroll: true })
    },
    [ref]
  )
  return { rootRef: ref, owns, rootProps: onDesk ? { tabIndex: -1, onPointerDownCapture } : {} }
}
