import { useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'

// Living Doc — a read-only document that writes itself. You give it a brief
// (stored in widget.livingQuery), and the AI keeps a running summary of the
// OTHER widgets on the same desk, regenerated on demand and auto-refreshed when
// source widgets change (livingPageScheduler). The body is serialized Tiptap
// JSON, system-owned, rendered read-only with the page's prose styling. Unlike
// the old "make living" toggle on a Page, the brief is captured with an inline
// input, never window.prompt (which Electron does not support).

interface Props {
  widget: Widget
  inline?: boolean
}

// Parse stored content (serialized Tiptap JSON) into an editor doc; fall back to
// a single paragraph for legacy/plain/malformed content so it never crashes.
function tryParseContent(raw: string): object {
  if (raw && raw.trim()) {
    try {
      const p = JSON.parse(raw) as { type?: string }
      if (p && typeof p === 'object' && p.type === 'doc') return p
    } catch {
      // not JSON — treat as plain text below
    }
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] }
  }
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

export default function LivingDocWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const isLiving = widget.livingQuery !== null && widget.livingQuery !== undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brief, setBrief] = useState(widget.livingQuery ?? '')
  const [editingBrief, setEditingBrief] = useState(false)

  // Read-only editor. Re-mounts when the generation timestamp changes so a fresh
  // body shows after each regenerate (same trick the Page widget uses).
  const editor = useEditor(
    {
      editable: false,
      extensions: [
        StarterKit,
        TaskList,
        TaskItem.configure({ nested: true }),
        Link.configure({ openOnClick: false }),
        Placeholder.configure({
          placeholder: 'This doc fills itself from the other work widgets on this desk.'
        })
      ],
      content: tryParseContent(widget.content)
    },
    [widget.id, widget.livingGeneratedAt]
  )

  async function regenerate(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const resp = await window.api.livingPage.regenerate(widget.id)
      if (!resp.ok) {
        setError(resp.error ?? 'Could not generate.')
        return
      }
      if (resp.skip) {
        setError(resp.reason ?? 'Add notes, files, or other work widgets to this desk first, then regenerate.')
        return
      }
      if (resp.content && resp.generatedAt) {
        await update(widget.id, { content: resp.content, livingGeneratedAt: resp.generatedAt })
      }
    } finally {
      setBusy(false)
    }
  }

  async function startLiving(): Promise<void> {
    const q = brief.trim()
    if (!q) return
    await update(widget.id, { livingQuery: q, livingPaused: false })
    setTimeout(() => void regenerate(), 50)
  }

  async function commitBrief(): Promise<void> {
    const next = brief.trim()
    if (!next) {
      setBrief(widget.livingQuery ?? '')
      setEditingBrief(false)
      return
    }
    if (next !== widget.livingQuery) {
      await update(widget.id, { livingQuery: next })
      setTimeout(() => void regenerate(), 50)
    }
    setEditingBrief(false)
  }

  async function togglePause(): Promise<void> {
    await update(widget.id, { livingPaused: !widget.livingPaused })
  }

  // First-run setup — no brief yet. An inline input (NOT window.prompt).
  const setup = (
    <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-5 text-center bg-[var(--surface-raised)]">
      <Icon name="auto_awesome" size={22} />
      <div className="text-[13px] font-semibold text-[var(--ink-90)]">A doc that writes itself</div>
      <div className="text-[11px] text-[var(--ink-50)] max-w-[300px] leading-relaxed">
        Tell it what to track. It reads the other work widgets on this desk and keeps a living summary, refreshing as things change.
      </div>
      <input
        data-testid="livingdoc-brief-input"
        value={brief}
        autoFocus
        onChange={(e) => setBrief(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void startLiving()
        }}
        placeholder="e.g. a running summary of everything on this task"
        className="fb-field w-full max-w-[330px] px-3 py-2 text-[12px] text-[var(--ink-90)]"
      />
      <button
        data-testid="livingdoc-start"
        onClick={() => void startLiving()}
        disabled={!brief.trim()}
        className="btn-primary !text-[12px] disabled:opacity-50"
      >
        Start living doc
      </button>
    </div>
  )

  const header = (
    <div className="px-2.5 py-1.5 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] flex items-center gap-1.5">
      <Icon name="auto_awesome" size={12} className="text-accent shrink-0" />
      {editingBrief ? (
        <input
          autoFocus
          data-testid="livingdoc-brief-edit"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={() => void commitBrief()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitBrief()
            if (e.key === 'Escape') {
              setBrief(widget.livingQuery ?? '')
              setEditingBrief(false)
            }
          }}
          className="flex-1 bg-transparent text-[11px] text-[var(--ink-70)] border-b border-accent"
        />
      ) : (
        <button
          onClick={() => {
            setBrief(widget.livingQuery ?? '')
            setEditingBrief(true)
          }}
          className="flex-1 min-w-0 text-left text-[11px] text-[var(--ink-70)] truncate hover:text-accent"
          title="Edit what this doc tracks"
          data-testid="livingdoc-brief"
        >
          {widget.livingQuery}
        </button>
      )}
      {widget.livingPaused && (
        <span className="text-[9px] uppercase tracking-wide text-amber-500 shrink-0">paused</span>
      )}
      <button
        onClick={() => void togglePause()}
        title={widget.livingPaused ? 'Resume auto-updates' : 'Pause auto-updates'}
        data-testid="livingdoc-pause"
        className="shrink-0 h-5 w-5 inline-flex items-center justify-center rounded text-[var(--ink-40)] hover:text-accent"
      >
        <Icon name={widget.livingPaused ? 'play_arrow' : 'pause'} size={13} />
      </button>
      <button
        onClick={() => void regenerate()}
        disabled={busy}
        title="Regenerate now"
        data-testid="livingdoc-regenerate"
        className="shrink-0 h-5 w-5 inline-flex items-center justify-center rounded text-[var(--ink-40)] hover:text-accent disabled:opacity-50"
      >
        <Icon name={busy ? 'hourglass_empty' : 'refresh'} size={13} className={busy ? 'animate-spin' : ''} />
      </button>
    </div>
  )

  const body = (
    <div className="h-full w-full flex flex-col bg-[var(--surface-raised)]">
      {!isLiving ? (
        setup
      ) : (
        <>
          {header}
          {error && (
            <div
              data-testid="livingdoc-error"
              className="px-3 py-1 text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/20 border-b border-amber-100 dark:border-amber-900"
            >
              {error}
            </div>
          )}
          <div
            className="flex-1 overflow-auto md-rendered tiptap-editor px-4 py-3 text-[var(--ink-100)] select-text"
            data-testid="livingdoc-body"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <EditorContent editor={editor} />
          </div>
        </>
      )}
    </div>
  )

  if (inline) return body

  return (
    <WidgetFrame widget={widget} headerLabel="living doc" headerAccent="bg-accent/10">
      {body}
    </WidgetFrame>
  )
}
