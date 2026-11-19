// A multi-line paste into a ONE-line box that asks the AI (the home bar, ⌘K's
// Ask, PlexiiCells' "Ask a question", a mind-map agent reply, Design's purpose).
//
// A one-line <input> cannot hold a line break, and Chromium flattened such a
// paste into one run of words: an email, a log or a range from a spreadsheet
// reached the assistant as a single line. The box still shows the paste on one
// line (it is a one-line box), but the lines are kept, and the question that is
// sent carries them as they were. A multi-line question also never reads as a
// web search or a command: the lines are back before that is decided.
import { useCallback, useRef } from 'react'
import type React from 'react'

export interface KeptLines {
  /** How the paste reads in the box. */
  flat: string
  /** The paste as it was. */
  full: string
}

/** The pasted text, if it is several lines; null for a one-line paste (left to the box). */
export function multilinePaste(text: string): KeptLines | null {
  const full = text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')
  if (!full.includes('\n')) return null
  const flat = full
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
  return flat ? { flat, full } : null
}

/** The question with every kept paste back in its lines. */
export function withKeptLines(text: string, kept: readonly KeptLines[]): string {
  let out = text
  for (const k of kept) if (out.includes(k.flat)) out = out.replace(k.flat, k.full)
  return out
}

/** For a one-line ask box: its onPaste, and `restore` for what it sends. */
export function useKeptLines(): {
  onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void
  restore: (text: string) => string
  reset: () => void
} {
  const kept = useRef<KeptLines[]>([])
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>): void => {
    const k = multilinePaste(e.clipboardData.getData('text/plain'))
    if (!k) return
    e.preventDefault()
    // At the caret, as typing would (and as an undoable edit of the box).
    document.execCommand('insertText', false, k.flat)
    kept.current.push(k)
  }, [])
  const restore = useCallback((text: string): string => withKeptLines(text, kept.current), [])
  const reset = useCallback((): void => {
    kept.current = []
  }, [])
  return { onPaste, restore, reset }
}
