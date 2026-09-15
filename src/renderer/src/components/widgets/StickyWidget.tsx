import { useEffect, useRef, useState } from 'react'
import { renderInlineText as renderInline } from '../../lib/renderInlineText'
import { useMentionAutocomplete } from '../../lib/useMentionAutocomplete'
import { useGrowToFit, GROW_MAX_HEIGHT } from '../../lib/useGrowToFit'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import ConnectedToolMenu from '../contextMenu/UnifiedConnectedMenu'
import Icon from '../Icon'
import {
  STICKY_CHECK_RE,
  STICKY_BULLET_RE,
  hasChecklist as hasChecklistText,
  toggleCheckLine,
  toggleChecklist,
  splitStickyBlocks
} from '../../lib/stickyText'

const COLORS = ['#fef08a', '#fbcfe8', '#bae6fd', '#bbf7d0', '#fed7aa']

interface Props {
  widget: Widget
  inline?: boolean
}

// Render one line's inline markdown-lite: **bold** becomes bold. Everything
// else is plain text. Kept deliberately tiny so a sticky stays a sticky and
// never turns into a full editor.

const CHECK_RE = STICKY_CHECK_RE
const BULLET_RE = STICKY_BULLET_RE

export default function StickyWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [text, setText] = useState(widget.content)
  // `@` anywhere in the note. setText is the commit target, and the caret is
  // restored after React writes the value or the next keystroke lands wrong.
  const mentions = useMentionAutocomplete(text, (next, caret) => {
    setText(next)
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(caret, caret))
  })
  const lastSavedRef = useRef(widget.content)
  // Mirror the latest text each render so the unmount-flush closure reads the
  // CURRENT value; hold the debounce timer in a ref so the flush can cancel it.
  const textRef = useRef(widget.content)
  textRef.current = text
  const saveTimerRef = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; selectionText?: string } | null>(null)
  // A sticky shows a rendered view (bold, bullets, tickable checkboxes) and
  // flips to a raw textarea while the user is editing. New / empty stickies
  // start in edit mode so they are immediately typeable.
  const [editing, setEditing] = useState(widget.content.trim() === '')

  // Auto-grow: grow the note by whatever its content overflows, in whichever
  // view is showing, so a longer note stays readable without manual resizing.
  // The rule (grow-only, capped, skipped inline) now lives in useGrowToFit so
  // every content widget behaves the same way — this was the original.
  useGrowToFit(widget, scrollRef, { maxHeight: GROW_MAX_HEIGHT.sticky, disabled: inline }, [text, editing])

  // Adopt the store's content on a NEW widget, or on a genuine EXTERNAL change
  // (sync, AI, sync-group mirror). Never re-adopt the echo of our own debounced
  // save: doing so resets the textarea to the just-saved value and drops any
  // characters typed in the gap between the save firing and the store update
  // landing, which reads as the cursor freezing mid-word. This is the same
  // self-echo guard MarkdownWidget already uses.
  const prevIdRef = useRef(widget.id)
  useEffect(() => {
    const idChanged = widget.id !== prevIdRef.current
    prevIdRef.current = widget.id
    if (idChanged || widget.content !== lastSavedRef.current) {
      setText(widget.content)
      lastSavedRef.current = widget.content
    }
  }, [widget.id, widget.content])

  useEffect(() => {
    if (text === lastSavedRef.current) return
    saveTimerRef.current = window.setTimeout(() => {
      lastSavedRef.current = text
      saveTimerRef.current = null
      void update(widget.id, { content: text })
    }, 600)
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    }
  }, [text, widget.id, update])

  // Flush any pending save on unmount. The canvas remounts every widget when
  // layoutVersion bumps; without this the un-debounced tail of what you just
  // typed is silently lost.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        if (textRef.current !== lastSavedRef.current) {
          void update(widget.id, { content: textRef.current })
        }
      }
    }
  }, [update, widget.id])

  const bgColor = widget.color ?? '#fef08a'
  const hasChecklist = hasChecklistText(text)

  // Toggle a single checklist line between done and not, by its line index.
  function toggleCheck(lineIndex: number): void {
    setText(toggleCheckLine(text, lineIndex))
  }

  // Toolbar action: turn the body into a checklist, or strip the checkboxes if
  // it already is one.
  function toggleChecklistMode(): void {
    setText(toggleChecklist(text))
  }

  // Wrap the textarea selection in ** ** (or insert a bold placeholder). Edit
  // mode only, since it acts on the textarea selection.
  function applyBold(): void {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const sel = text.slice(start, end) || 'bold'
    const next = `${text.slice(0, start)}**${sel}**${text.slice(end)}`
    setText(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start + 2, start + 2 + sel.length)
    })
  }

  // Prefix the current line with "- " to make it a bullet.
  function applyBullet(): void {
    const ta = textareaRef.current
    if (!ta) return
    const pos = ta.selectionStart
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1
    const next = `${text.slice(0, lineStart)}- ${text.slice(lineStart)}`
    setText(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(pos + 2, pos + 2)
    })
  }

  // PLX-A11Y-001: 20px (h-5 w-5) failed the WCAG 2.5.8 target-size minimum
  // (24x24) once the swatch buttons beside it stopped absorbing the row's
  // failures — raised to 24px, the same fix already applied to WidgetFrame's
  // icon buttons.
  const toolbarBtn =
    'h-6 w-6 shrink-0 inline-flex items-center justify-center rounded text-stone-700/70 hover:text-stone-900 hover:bg-black/10 transition-colors'

  const rendered = (
    <div
      className={`fb-sticky-rendered w-full flex-1 font-hand text-stone-900 cursor-text whitespace-pre-wrap ${
        'fb-body'
      }`}
      onMouseDown={(e) => {
        // Let a checkbox click through; otherwise a click drops into edit mode.
        if ((e.target as HTMLElement).closest('[data-sticky-check]')) return
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-sticky-check]')) return
        setEditing(true)
        requestAnimationFrame(() => textareaRef.current?.focus())
      }}
    >
      {text.trim() === '' ? (
        <span className="text-stone-700/40">Write a note…</span>
      ) : (
        splitStickyBlocks(text).map((block, bi) => {
          if (block.type === 'table') {
            return (
              <div key={`t${bi}`} className="my-1 overflow-auto" data-testid={`sticky-table-${bi}`}>
                <table className="border-collapse text-[0.85em] font-sans">
                  <thead>
                    <tr>
                      {block.headers.map((h, hi) => (
                        // Sticky paper table: rules are drawn relative to the sticky's own paper colour.
                        <th key={hi} className="border border-black/20 px-1.5 py-0.5 bg-black/[0.04] text-left font-semibold align-top">
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri}>
                        {block.headers.map((_, ci) => (
                          <td key={ci} className="border border-black/20 px-1.5 py-0.5 align-top">
                            {renderInline(row[ci] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
          const idx = block.index
          const line = block.text
          const trimmed = line.trim()
          const check = CHECK_RE.exec(trimmed)
          if (check) {
            const done = check[1].toLowerCase() === 'x'
            return (
              <div key={idx} className="flex items-start gap-1.5 leading-snug">
                <button
                  data-sticky-check
                  data-testid={`sticky-check-${idx}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleCheck(idx)
                  }}
                  className="mt-0.5 shrink-0 text-stone-700 hover:text-stone-900"
                  aria-label={done ? 'Mark not done' : 'Mark done'}
                >
                  <Icon name={done ? 'check_box' : 'check_box_outline_blank'} size={16} />
                </button>
                <span className={done ? 'line-through opacity-55' : ''}>{renderInline(check[2])}</span>
              </div>
            )
          }
          const bullet = BULLET_RE.exec(trimmed)
          if (bullet) {
            return (
              <div key={idx} className="flex items-start gap-1.5 leading-snug">
                <span className="mt-[-1px] shrink-0">•</span>
                <span>{renderInline(bullet[1])}</span>
              </div>
            )
          }
          if (trimmed === '') return <div key={idx}>&nbsp;</div>
          return <div key={idx}>{renderInline(line)}</div>
        })
      )}
    </div>
  )

  const editor = (
    <div className="relative">
    <textarea
      ref={textareaRef}
      value={text}
      autoFocus={editing}
      onChange={(e) => {
        setText(e.target.value)
        mentions.onInput(e.target.value, e.target.selectionStart ?? e.target.value.length)
      }}
      onKeyUp={(e) =>
        mentions.onInput(
          e.currentTarget.value,
          e.currentTarget.selectionStart ?? e.currentTarget.value.length
        )
      }
      onKeyDown={(e) => {
        // The picker consumes Enter and the arrows while it is open; without
        // this, Enter both picks a mention and breaks the line.
        mentions.onKeyDown(e)
      }}
      onBlur={() => {
        mentions.close()
        setEditing(false)
      }}
      placeholder="Write a note… **bold**, - bullet, [ ] task"
      onContextMenu={(e) => {
        if (e.shiftKey) return
        e.preventDefault()
        const sel = window.getSelection()?.toString() ?? ''
        setCtxMenu({ x: e.clientX, y: e.clientY, selectionText: sel })
      }}
      // field-sizing: content (fb-sticky-textarea, globals.css) grows the
      // textarea with its text so the sticky auto-grows instead of scrolling.
      className={`fb-sticky-textarea w-full min-h-[2.5rem] resize-none bg-transparent text-stone-900 font-hand placeholder:text-stone-700/40 ${
        'fb-body'
      }`}
    />
    {mentions.open && (
      <div
        className="absolute left-0 top-full z-[60] mt-1 max-h-[190px] w-[240px] overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface-raised)] py-1 shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
        data-testid="mention-picker"
      >
        {mentions.candidates.map((c, i) => (
          <button
            key={`${c.kind}:${c.id}`}
            type="button"
            onClick={() => mentions.choose(c)}
            className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] ${
              i === mentions.activeIndex
                ? 'bg-accent/10 text-[var(--ink-90)]'
                : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <Icon name={c.icon} size={12} className="shrink-0 text-[var(--ink-40)]" />
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            {c.detail && <span className="shrink-0 text-[9px] text-[var(--ink-35)]">{c.detail}</span>}
          </button>
        ))}
      </div>
    )}
    </div>
  )

  const content = (
    <div
      data-fb-sticky-body
      className="fb-sticky-body min-h-full w-full p-3 flex flex-col gap-2"
      style={{ backgroundColor: bgColor, '--fb-sticky-tint': bgColor } as React.CSSProperties}
    >
      {/* PLX-A11Y-001: flex-wrap matches MarkdownWidget's own toolbar row —
          growing the swatches + Bold/Bullet/Checklist buttons to a real 24px
          target size means the row no longer always fits one line on a
          narrow sticky; wrapping (not shrinking below 24px, not spilling
          past the note edge) is the same accessible-toolbar pattern already
          used there. */}
      <div className="flex items-center gap-0.5 flex-wrap">
        {COLORS.map((c) => (
          // PLX-A11Y-001: the visible swatch stays 12px (the sticky's compact
          // toolbar look is unchanged), but the button itself gets a 24x24
          // invisible hit-slop so it clears the WCAG 2.5.8 target-size
          // minimum — same technique as WidgetFrame's icon buttons, just with
          // the visual dot nested inside a bigger tappable box instead of the
          // icon itself growing.
          <button
            key={c}
            onClick={() => void update(widget.id, { color: c })}
            className="h-6 w-6 shrink-0 rounded-full inline-flex items-center justify-center"
            aria-label={`Color ${c}`}
          >
            {/* Swatch containment on the sticky's own paper. */}
            <span
              className="h-3 w-3 rounded-full border border-black/10 hover:scale-125 transition-transform"
              style={{ backgroundColor: c }}
            />
          </button>
        ))}
        <span className="mx-0.5 h-3.5 w-px bg-black/10 shrink-0" aria-hidden />
        <button onClick={applyBold} className={toolbarBtn} title="Bold (**text**)" aria-label="Bold" data-testid="sticky-bold">
          <Icon name="format_bold" size={13} />
        </button>
        <button onClick={applyBullet} className={toolbarBtn} title="Bullet line" aria-label="Bullet" data-testid="sticky-bullet">
          <Icon name="format_list_bulleted" size={13} />
        </button>
        <button
          onClick={toggleChecklistMode}
          className={`${toolbarBtn} ${hasChecklist ? 'text-accent' : ''}`}
          title={hasChecklist ? 'Remove checkboxes' : 'Make a checklist'}
          aria-label="Checklist"
          data-testid="sticky-checklist"
        >
          <Icon name="checklist" size={13} />
        </button>
      </div>
      <div ref={scrollRef} className="flex flex-col">
        {editing ? editor : rendered}
      </div>
      {ctxMenu && (
        <ConnectedToolMenu
          sourceWidgetId={widget.id}
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectionContext={{ selectionText: ctxMenu.selectionText }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )

  if (inline) return content

  return (
    <WidgetFrame widget={widget} headerLabel="sticky" headerAccent="bg-black/5 dark:bg-white/[0.06]">
      {content}
    </WidgetFrame>
  )
}
