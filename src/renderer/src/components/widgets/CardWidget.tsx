import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parseMentionText } from '@shared/mentionText'
import { MentionChip } from '../MentionText'
import MentionTextarea from '../MentionTextarea'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import { parseInline } from '../../lib/inlineMarkdown'

// Render the card body's markdown-lite as JSX: **bold**, *italic*, links (both
// [text](url) and bare URLs) that open in the user's browser, and "- " bullets.
function renderBody(body: string): ReactNode {
  const openLink = (href: string): void => {
    void window.api.files.openExternal(href)
  }
  const inline = (s: string, keyBase: string): ReactNode[] =>
    parseInline(s).map((t, i) => {
      const k = `${keyBase}-${i}`
      if (t.type === 'bold') return <strong key={k}>{t.value}</strong>
      if (t.type === 'italic') return <em key={k}>{t.value}</em>
      if (t.type === 'link')
        return (
          <a
            key={k}
            href={t.href}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openLink(t.href)
            }}
            className="text-accent underline hover:text-accent/80 cursor-pointer"
          >
            {t.text}
          </a>
        )
      // Plain runs may still hold @-mentions, which are drawn as chips rather
      // than left as the markup somebody would otherwise be reading.
      return (
        <span key={k}>
          {parseMentionText(t.value).map((seg, j) =>
            seg.type === 'mention' ? (
              <MentionChip key={`${k}-m${j}`} mention={seg.mention} />
            ) : (
              <span key={`${k}-t${j}`}>{seg.text}</span>
            )
          )}
        </span>
      )
    })
  return body.split('\n').map((line, idx) => {
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim())
    if (bullet) {
      return (
        <div key={idx} className="flex items-start gap-1.5">
          <span className="mt-[-1px] shrink-0">•</span>
          <span>{inline(bullet[1], `b${idx}`)}</span>
        </div>
      )
    }
    if (line.trim() === '') return <div key={idx}>&nbsp;</div>
    return <div key={idx}>{inline(line, `l${idx}`)}</div>
  })
}

// A clean titled card — an accent bar, a bold editable title and a multi-line
// body. A step up from a sticky for structured callouts. Persists as JSON.

interface CardData {
  title: string
  body: string
  accent: string
  // When true the whole card fills with a soft tint of the accent instead of
  // showing only the accent bar — a calmer, more callout-like look.
  bgFill?: boolean
  // Optional emoji on the title row.
  icon?: string
}

const ACCENTS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b']
const ICONS = ['💡', '⭐', '🔥', '✅', '⚠️', '📌', '🎯', '❤️', '🚀', '📝', '🔑', '💬']
const DEFAULT: CardData = { title: '', body: '', accent: ACCENTS[0] }

function parse(content: string): CardData {
  if (!content) return { ...DEFAULT }
  try {
    const p = JSON.parse(content) as Partial<CardData>
    return {
      title: p.title ?? '',
      body: p.body ?? '',
      accent: p.accent ?? DEFAULT.accent,
      bgFill: p.bgFill ?? false,
      icon: p.icon ?? ''
    }
  } catch {
    // Legacy / plain-text content becomes the body.
    return { ...DEFAULT, body: content }
  }
}

// A hex accent at low alpha, for the full-fill background tint. Works on both
// light and dark themes because the alpha is low enough to read either way.
function tint(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return 'transparent'
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function CardWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [data, setData] = useState<CardData>(() => parse(widget.content))
  const [pickAccent, setPickAccent] = useState(false)
  const [pickIcon, setPickIcon] = useState(false)
  // The body shows rendered rich text (bold, italic, clickable links, bullets)
  // and flips to a raw textarea while editing. Empty bodies start editable.
  const [bodyEditing, setBodyEditing] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const lastSaved = useRef(widget.content)

  useEffect(() => {
    const next = JSON.stringify(data)
    if (next === lastSaved.current) return
    const h = window.setTimeout(() => {
      lastSaved.current = next
      void update(widget.id, { content: next })
    }, 300)
    return () => window.clearTimeout(h)
  }, [data, widget.id, update])

  // Adopt content pushed in from a synced sibling (live sync). Without this the
  // linked copy only reflects edits after a remount / hard refresh. We compare
  // against lastSaved so our OWN debounced save round-trip doesn't re-trigger.
  useEffect(() => {
    if (widget.content !== lastSaved.current) {
      lastSaved.current = widget.content
      setData(parse(widget.content))
    }
  }, [widget.content])

  const set = (patch: Partial<CardData>): void => setData((d) => ({ ...d, ...patch }))

  const content = (
    <div
      className={`group relative min-h-full w-full flex flex-col ${data.bgFill ? '' : 'bg-[var(--surface-raised)]'}`}
      style={data.bgFill ? { backgroundColor: tint(data.accent, 0.14) } : undefined}
    >
      <div className="h-1.5 w-full shrink-0" style={{ backgroundColor: data.accent }} />
      <div className="flex-1 flex flex-col gap-1.5 p-3">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPickIcon((v) => !v)}
            onMouseDown={(e) => e.stopPropagation()}
            className={`shrink-0 h-6 w-6 inline-flex items-center justify-center rounded text-[15px] leading-none ${
              data.icon ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]'
            } transition-opacity`}
            title="Card icon"
            aria-label="Card icon"
            data-testid="card-icon-button"
          >
            {data.icon || '☺'}
          </button>
          <input
            value={data.title}
            onChange={(e) => set({ title: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="Title"
            className="flex-1 bg-transparent text-[15px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
          />
        </div>
        {pickIcon && (
          <div
            className="fb-card flex flex-wrap gap-1 p-1.5 max-w-[220px]"
            onMouseDown={(e) => e.stopPropagation()}
            data-testid="card-icon-picker"
          >
            {ICONS.map((ic) => (
              <button
                key={ic}
                onClick={() => {
                  set({ icon: data.icon === ic ? '' : ic })
                  setPickIcon(false)
                }}
                className="h-6 w-6 inline-flex items-center justify-center rounded text-[15px] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]"
              >
                {ic}
              </button>
            ))}
          </div>
        )}
        {bodyEditing || data.body.trim() === '' ? (
          <MentionTextarea
            ref={bodyRef}
            value={data.body}
            autoFocus={bodyEditing}
            onChange={(e) => set({ body: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
            // Focusing the field IS editing it. Without this the editor was
            // only open because the body happened to be empty, so the first
            // character typed made it non-empty and unmounted the field
            // mid-keystroke.
            onFocus={() => setBodyEditing(true)}
            onBlur={() => setBodyEditing(false)}
            placeholder="Write something… **bold**, *italic*, paste a link"
            wrapperClassName="flex-1 min-h-0 flex flex-col"
            className="h-full w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--ink-70)] placeholder:text-[var(--ink-40)]"
          />
        ) : (
          <div
            data-testid="card-body-rendered"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              // A link handles its own click; clicking elsewhere edits.
              if ((e.target as HTMLElement).closest('a')) return
              setBodyEditing(true)
              requestAnimationFrame(() => bodyRef.current?.focus())
            }}
            className="flex-1 min-h-0 w-full overflow-auto text-[13px] leading-relaxed text-[var(--ink-70)] cursor-text whitespace-pre-wrap"
          >
            {renderBody(data.body)}
          </div>
        )}
      </div>

      {/* Accent picker (hover) */}
      <div className="absolute top-2.5 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <button
          onClick={() => setPickAccent((v) => !v)}
          onMouseDown={(e) => e.stopPropagation()}
          className="h-5 w-5 rounded-full ring-2 ring-[var(--surface-raised)] shadow"
          style={{ backgroundColor: data.accent }}
          title="Card colour"
          aria-label="Card colour"
        />
        {pickAccent && (
          <div
            className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 mt-1 flex flex-col gap-1.5 p-1.5 z-10"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex gap-1">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  onClick={() => set({ accent: c })}
                  className={`h-5 w-5 rounded-full ring-1 ring-black/10 ${data.accent === c ? 'ring-2 ring-offset-1 ring-[var(--edge-firm)]' : ''}`}
                  style={{ backgroundColor: c }}
                  aria-label={`Accent ${c}`}
                />
              ))}
            </div>
            <button
              onClick={() => set({ bgFill: !data.bgFill })}
              data-testid="card-fill-toggle"
              className="text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-100)] text-left px-1 py-0.5 rounded hover:bg-[var(--surface-sunken)]"
            >
              {data.bgFill ? '✓ Fill background' : 'Fill background'}
            </button>
          </div>
        )}
      </div>
    </div>
  )

  if (inline) return content

  return (
    <WidgetFrame widget={widget} headerLabel="card" headerAccent="bg-stone-200/70 dark:bg-white/[0.07]">
      {content}
    </WidgetFrame>
  )
}
