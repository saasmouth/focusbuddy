import { useEffect, useMemo, useRef } from 'react'
import type { DesignBody } from '@shared/design'
import type { FlowMeasurer, FlowParagraph } from '@shared/designFlow'
import { parsePaste, type ContentDoc } from '@shared/designContent'
import {
  caretDocEnd,
  caretEnd,
  caretHome,
  caretLeft,
  caretRight,
  deleteBackward,
  deleteForward,
  insertBlocks,
  insertText,
  isCollapsed,
  orderedSelection,
  selectAll,
  selectedText,
  setBlockKind,
  splitAt,
  type DocCaret,
  type DocSelection
} from '@shared/designTextEdit'
import { caretToPoint, caretVertical, pointToCaret, selectionRects } from './caretMap'

// Typing on the page.
//
// The page draws the type; a hidden input takes the keystrokes. That split is
// how every real layout program works and it is the only way to get the things
// people expect for free: the OS caret, dead keys and IME composition, system
// text shortcuts, and a paste event carrying the clipboard's HTML flavour so a
// pasted Word document keeps its headings and lists.
//
// The input is kept ONE PIXEL wide at the caret's own position rather than
// hidden off-screen, so the browser scrolls it into view and the OS puts its IME
// candidate window where the words are actually appearing.

interface Props {
  design: DesignBody
  storyId: string
  doc: ContentDoc
  paragraphs: FlowParagraph[]
  selection: DocSelection
  measure: FlowMeasurer
  /** The page currently on the canvas, so only its caret and rects are drawn. */
  pageIndex: number
  /** On-screen px per logical px. */
  scale: number
  onSelection: (sel: DocSelection) => void
  onChange: (doc: ContentDoc, caret: DocCaret) => void
  onExit: () => void
  /** Fires when the caret leaves the page on screen, so the editor can follow. */
  onGoToPage: (pageIndex: number) => void
}

export default function FrameTextEditor(p: Props): JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const { design, storyId, paragraphs, selection, measure, doc } = p

  const caretPoint = useMemo(
    () => caretToPoint(design, storyId, paragraphs, selection.focus, measure),
    [design, storyId, paragraphs, selection.focus, measure]
  )
  const rects = useMemo(
    () => selectionRects(design, storyId, paragraphs, doc, selection, measure),
    [design, storyId, paragraphs, doc, selection, measure]
  )

  // Focus once, when the caret enters this story. Re-focusing on every render
  // (or on every blur) sets up a fight with any other focusable panel that does
  // the same, and two elements trading focus re-render the page forever — which
  // is exactly what happened when the story editor panel was open at the time.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [storyId])

  // Follow the caret when an edit pushes it onto another page.
  useEffect(() => {
    if (caretPoint && caretPoint.pageIndex !== p.pageIndex) p.onGoToPage(caretPoint.pageIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caretPoint?.pageIndex])

  function apply(next: { doc: ContentDoc; caret: DocCaret }): void {
    p.onChange(next.doc, next.caret)
  }

  function moveTo(caret: DocCaret, extend: boolean): void {
    p.onSelection({ anchor: extend ? selection.anchor : caret, focus: caret })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    const mod = e.metaKey || e.ctrlKey
    // The canvas's own shortcuts (delete the selected object, duplicate…) must
    // not fire while the caret is in text.
    e.stopPropagation()

    if (e.key === 'Escape') {
      e.preventDefault()
      p.onExit()
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      p.onSelection(selectAll(doc))
      return
    }
    if (mod && ['z', 'y'].includes(e.key.toLowerCase())) {
      // Undo belongs to the document's own history, which the editor owns.
      return
    }
    // Paragraph styles, the shortcuts every writing tool uses.
    if (mod && e.altKey && ['0', '1', '2', '3'].includes(e.key)) {
      e.preventDefault()
      const kind = e.key === '0' ? 'paragraph' : e.key === '1' ? 'heading1' : e.key === '2' ? 'heading2' : 'heading3'
      apply(setBlockKind(doc, selection.focus, kind))
      return
    }

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        moveTo(mod ? caretHome(selection.focus) : caretLeft(doc, selection.focus), e.shiftKey)
        return
      case 'ArrowRight':
        e.preventDefault()
        moveTo(mod ? caretEnd(doc, selection.focus) : caretRight(doc, selection.focus), e.shiftKey)
        return
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault()
        const next = caretVertical(design, storyId, paragraphs, selection.focus, e.key === 'ArrowUp' ? -1 : 1, measure)
        if (next) moveTo(next, e.shiftKey)
        return
      }
      case 'Home':
        e.preventDefault()
        moveTo(caretHome(selection.focus), e.shiftKey)
        return
      case 'End':
        e.preventDefault()
        moveTo(caretEnd(doc, selection.focus), e.shiftKey)
        return
      case 'Enter':
        e.preventDefault()
        apply(splitAt(doc, selection))
        return
      case 'Backspace':
        e.preventDefault()
        apply(deleteBackward(doc, selection))
        return
      case 'Delete':
        e.preventDefault()
        apply(deleteForward(doc, selection))
        return
      case 'Tab':
        // Tab belongs to the page, not the paragraph — let it move focus on.
        return
      default:
        break
    }

    if (mod && e.key.toLowerCase() === 'x' && !isCollapsed(doc, selection)) {
      e.preventDefault()
      void navigator.clipboard.writeText(selectedText(doc, selection)).catch(() => {})
      apply(insertText(doc, selection, ''))
      return
    }
    if (mod && e.key.toLowerCase() === 'c' && !isCollapsed(doc, selection)) {
      e.preventDefault()
      void navigator.clipboard.writeText(selectedText(doc, selection)).catch(() => {})
    }
  }

  /**
   * Real typed characters. Reading them from the input's own value (rather than
   * from key codes) is what makes dead keys, IME composition and autocorrect
   * work — the browser has already resolved them by the time this fires.
   */
  function onInput(e: React.FormEvent<HTMLTextAreaElement>): void {
    const el = e.currentTarget
    const typed = el.value
    el.value = ''
    if (!typed) return
    apply(insertText(doc, selection, typed))
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const html = e.clipboardData.getData('text/html')
    const text = e.clipboardData.getData('text/plain')
    if (!html && !text) return
    // A paste with structure keeps it; a plain paste is just characters.
    const parsed = parsePaste({ html, text })
    if (parsed.blocks.length > 1 || (parsed.blocks[0] && parsed.blocks[0].kind !== 'paragraph')) {
      apply(insertBlocks(doc, selection, parsed.blocks))
    } else {
      apply(insertText(doc, selection, text || parsed.blocks[0]?.text || ''))
    }
  }

  const k = 1 / Math.max(p.scale, 0.001)
  const showCaret = caretPoint && caretPoint.pageIndex === p.pageIndex

  return (
    <>
      {/* Selection highlight, under the caret and over the type. */}
      {rects
        .filter((r) => r.pageIndex === p.pageIndex)
        .map((r, i) => (
          <div
            key={i}
            data-testid="design-text-selection"
            style={{
              position: 'absolute',
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              background: 'rgba(109,93,252,0.26)',
              pointerEvents: 'none',
              zIndex: 9996
            }}
          />
        ))}

      {showCaret && (
        <div
          data-testid="design-text-caret"
          className="fb-caret-blink"
          style={{
            position: 'absolute',
            left: caretPoint.x,
            top: caretPoint.y,
            width: Math.max(1, 1.4 * k),
            height: caretPoint.h,
            background: 'var(--accent)',
            pointerEvents: 'none',
            zIndex: 9999
          }}
        />
      )}

      {/* The real input. One logical pixel wide, parked at the caret, so the OS
          puts IME candidates where the words are and never scrolls elsewhere. */}
      <textarea
        ref={inputRef}
        data-testid="design-text-input"
        aria-label="Story text"
        value=""
        onChange={() => {}}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck
        style={{
          position: 'absolute',
          left: showCaret ? caretPoint.x : 0,
          top: showCaret ? caretPoint.y : 0,
          width: 1,
          height: showCaret ? caretPoint.h : 1,
          opacity: 0,
          border: 0,
          padding: 0,
          margin: 0,
          resize: 'none',
          outline: 'none',
          zIndex: 9998
        }}
      />
    </>
  )
}

/** Turn a click on the page into a caret. Exported so the canvas can call it. */
export function caretFromClick(
  design: DesignBody,
  storyId: string,
  paragraphs: FlowParagraph[],
  point: { pageIndex: number; x: number; y: number },
  measure: FlowMeasurer
): DocCaret | null {
  return pointToCaret(design, storyId, paragraphs, point, measure)
}

export { caretDocEnd, orderedSelection }
