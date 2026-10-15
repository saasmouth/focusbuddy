// What this suggestion will actually become, shown before you commit to it.
//
// The cards used to show a title, a reason, and `content` as one truncated
// monospace line. For a sticky that is the whole widget, so it was fine; for a
// table `content` is a table id, so the line was either empty or a uuid, and
// the configuration the AI had just spent its effort on — the columns, the
// page's headings, the field's type and options — was invisible until the thing
// was already on your desk. You had to accept it to find out what it was.
//
// Everything here is read from the suggestion itself. Nothing is inferred,
// padded or sampled: if the AI did not configure something, the preview says
// so, because "this table has no columns yet" is information the user wants
// BEFORE it lands, not after.

import type { AiBuildSuggestion } from '@shared/types'
import Icon from '../Icon'

/** A Tiptap node, loosely typed — we only read what a preview needs. */
interface TipNode {
  type?: string
  attrs?: { level?: number; checked?: boolean }
  content?: TipNode[]
  text?: string
}

function plainText(nodes: TipNode[] | undefined): string {
  if (!nodes) return ''
  return nodes
    .map((n) => (n.text ? n.text : plainText(n.content)))
    .join('')
    .trim()
}

/** The first few blocks of a page, as they will read. */
function pageOutline(doc: unknown): { kind: string; text: string }[] {
  const content = (doc as { content?: TipNode[] } | null)?.content
  if (!Array.isArray(content)) return []
  const out: { kind: string; text: string }[] = []
  for (const node of content.slice(0, 8)) {
    const text = plainText(node.content)
    if (node.type === 'heading') {
      out.push({ kind: `h${node.attrs?.level ?? 1}`, text })
    } else if (node.type === 'taskList' || node.type === 'bulletList' || node.type === 'orderedList') {
      for (const item of (node.content ?? []).slice(0, 4)) {
        out.push({ kind: node.type === 'taskList' ? 'task' : 'item', text: plainText(item.content) })
      }
    } else if (text) {
      out.push({ kind: 'p', text })
    }
  }
  return out.filter((l) => l.text).slice(0, 7)
}

const Frame = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <div
    className="mt-2 rounded-md border border-[var(--edge-soft)] bg-[var(--surface-base)] p-2 overflow-hidden"
    data-testid="suggestion-preview"
  >
    {children}
  </div>
)

const Empty = ({ what }: { what: string }): JSX.Element => (
  <Frame>
    <p className="text-[10px] text-[var(--ink-40)] leading-snug">{what}</p>
  </Frame>
)

export default function SuggestionPreview({ s }: { s: AiBuildSuggestion }): JSX.Element | null {
  // ── A table: its real columns, as a header row ──────────────────────────
  if (s.kind === 'table') {
    const cols = s.tableSchema?.columns ?? []
    if (cols.length === 0) {
      return <Empty what="No columns configured — this would arrive as an empty grid." />
    }
    return (
      <Frame>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" data-testid="preview-table">
            <thead>
              <tr>
                {cols.slice(0, 6).map((c) => (
                  <th
                    key={c.id}
                    className="text-left px-1.5 py-1 border-b border-[var(--edge-soft)] whitespace-nowrap"
                  >
                    <span className="block text-[10px] font-medium text-[var(--ink-80)]">
                      {c.label}
                    </span>
                    <span className="block text-[9px] text-[var(--ink-40)] font-mono">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Two empty rows, so it reads as a grid ready for data. They are
                  blank on purpose: inventing plausible rows here would be
                  showing the user data that is not going to exist. */}
              {[0, 1].map((r) => (
                <tr key={r}>
                  {cols.slice(0, 6).map((c) => (
                    <td
                      key={c.id}
                      className="px-1.5 py-1 border-b border-[var(--edge-hairline)] h-4"
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cols.length > 6 && (
          <p className="text-[9px] text-[var(--ink-40)] mt-1">+{cols.length - 6} more columns</p>
        )}
        {/* Select options are configuration a user would otherwise only find by
            opening the column editor. */}
        {cols
          .filter((c) => Array.isArray((c.config as { options?: unknown[] })?.options))
          .slice(0, 2)
          .map((c) => {
            const options = ((c.config as { options?: { label?: string; color?: string }[] })
              .options ?? []).slice(0, 6)
            return (
              <div key={c.id} className="flex items-center gap-1 flex-wrap mt-1.5">
                <span className="text-[9px] text-[var(--ink-40)]">{c.label}:</span>
                {options.map((o, i) => (
                  <span
                    key={i}
                    className="text-[9px] px-1 py-px rounded-full border border-[var(--edge-soft)]"
                    style={o.color ? { backgroundColor: `${o.color}22`, color: o.color } : undefined}
                  >
                    {o.label}
                  </span>
                ))}
              </div>
            )
          })}
      </Frame>
    )
  }

  // ── A page: its headings and first lines ───────────────────────────────
  if (s.kind === 'page') {
    const lines = pageOutline(s.pageContent)
    if (lines.length === 0) {
      return <Empty what="No content configured — this would arrive as a blank page." />
    }
    return (
      <Frame>
        <div className="space-y-0.5" data-testid="preview-page">
          {lines.map((l, i) => (
            <div key={i} className="flex items-start gap-1">
              {l.kind === 'task' && (
                <span className="mt-[3px] h-2 w-2 shrink-0 rounded-sm border border-[var(--ink-40)]" />
              )}
              {l.kind === 'item' && (
                <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-[var(--ink-40)]" />
              )}
              <span
                className={
                  l.kind.startsWith('h')
                    ? 'text-[11px] font-semibold text-[var(--ink-90)] leading-snug'
                    : 'text-[10px] text-[var(--ink-60)] leading-snug line-clamp-2'
                }
              >
                {l.text}
              </span>
            </div>
          ))}
        </div>
      </Frame>
    )
  }

  // ── A field: label, type, and its options ──────────────────────────────
  if (s.kind === 'field') {
    if (!s.fieldDef) {
      return <Empty what="No field type configured — this would arrive unset." />
    }
    const options = ((s.fieldDef.config as { options?: { label?: string }[] } | null)?.options ??
      []).slice(0, 6)
    return (
      <Frame>
        <div className="flex items-baseline gap-2" data-testid="preview-field">
          <span className="text-[11px] font-medium text-[var(--ink-90)]">{s.fieldDef.label}</span>
          <span className="text-[9px] font-mono text-[var(--ink-40)]">{s.fieldDef.type}</span>
        </div>
        {options.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap mt-1">
            {options.map((o, i) => (
              <span
                key={i}
                className="text-[9px] px-1 py-px rounded-full border border-[var(--edge-soft)] text-[var(--ink-60)]"
              >
                {o.label}
              </span>
            ))}
          </div>
        )}
      </Frame>
    )
  }

  // ── A link-shaped widget: the real destination ─────────────────────────
  if (['webview', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email'].includes(s.kind)) {
    if (!s.content) {
      return <Empty what="No URL configured — you would have to paste one." />
    }
    let host = s.content
    let path = ''
    try {
      const u = new URL(s.content)
      host = u.host.replace(/^www\./, '')
      path = u.pathname === '/' ? '' : u.pathname + (u.search ? u.search : '')
    } catch {
      // Not a parseable URL — show it verbatim rather than guessing at it.
    }
    return (
      <Frame>
        <div className="flex items-center gap-1.5 min-w-0" data-testid="preview-link">
          <Icon name="link" size={11} className="shrink-0 text-[var(--ink-40)]" />
          <span className="text-[10px] text-[var(--ink-80)] font-medium shrink-0">{host}</span>
          {path && (
            <span className="text-[10px] text-[var(--ink-40)] font-mono truncate">{path}</span>
          )}
        </div>
      </Frame>
    )
  }

  // ── A timer: the duration it will be set to ────────────────────────────
  if (s.kind === 'timer') {
    let secs: number | null = null
    try {
      secs = (JSON.parse(s.content ?? '{}') as { targetSec?: number }).targetSec ?? null
    } catch {
      secs = null
    }
    if (secs === null) return <Empty what="No duration configured." />
    const m = Math.round(secs / 60)
    return (
      <Frame>
        <span className="text-[11px] font-mono text-[var(--ink-80)]" data-testid="preview-timer">
          {m} min
        </span>
      </Frame>
    )
  }

  // ── A colour: the actual swatch ────────────────────────────────────────
  if (s.kind === 'color' && s.content) {
    return (
      <Frame>
        <div className="flex items-center gap-1.5" data-testid="preview-color">
          <span
            className="h-4 w-4 rounded border border-[var(--edge-soft)]"
            style={{ backgroundColor: s.content }}
          />
          <span className="text-[10px] font-mono text-[var(--ink-60)]">{s.content}</span>
        </div>
      </Frame>
    )
  }

  // ── Anything whose content IS its text ─────────────────────────────────
  if (s.content && s.content.trim()) {
    return (
      <Frame>
        <p
          className="text-[10px] text-[var(--ink-70)] leading-snug whitespace-pre-wrap line-clamp-5"
          data-testid="preview-text"
        >
          {s.content}
        </p>
      </Frame>
    )
  }

  // Nothing to show rather than an empty box pretending to be a preview.
  return null
}
