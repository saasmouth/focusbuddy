// The Artboards panel (WP-ARTBOARD): every artboard in order, as in
// Illustrator's -- click one to go to it, double-click its name to rename it,
// move it up or down the list (the order PDF pages and Next Artboard follow),
// add, duplicate or delete one, and set the active artboard's size, position
// and preset. It shows once a drawing has several artboards, or while the
// Artboard tool is active. Every change goes through a registered command.

import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { DRAW_SIZES } from '@shared/draw'
import { ARTBOARD_MAX, ARTBOARD_MIN, primaryArtboard } from '@shared/draw/ops'
import Icon from '../../../Icon'
import { artboardsEditable, moveArtWithArtboard } from '../editor/artboards'
import type { DrawPanel, EditorCtx } from '../editor/types'

/** A number field that commits on Enter or blur (not on every keystroke, so one change is one undo step). */
function NumField({ label, value, onCommit, testid, min, max }: { label: string; value: number; onCommit: (v: number) => void; testid: string; min?: number; max?: number }): JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (): void => {
    const v = Number(text)
    if (!Number.isFinite(v) || text.trim() === '') return setText(String(value))
    const c = Math.round(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v)))
    if (c !== value) onCommit(c)
    setText(String(c))
  }
  return (
    <label className="flex items-center gap-1">
      <span className="w-3 text-[11px] text-[var(--ink-40)]">{label}</span>
      <input
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        data-testid={testid}
        className="fb-field w-full min-w-0 px-1.5 py-0.5 text-[12px]"
      />
    </label>
  )
}

function ArtboardsPanel({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const doc = useStore(ctx.store, (s) => s.doc)
  const editable = useStore(ctx.store, (s) => artboardsEditable(s))
  const withArt = useStore(ctx.store, (s) => moveArtWithArtboard(s))
  const [renaming, setRenaming] = useState<string | null>(null)
  const active = primaryArtboard(doc)
  const n = doc.artboards.length
  const patch = (p: Record<string, unknown>, label?: string): void => ctx.run('artboard.patch', { id: active.id, patch: p, label })
  return (
    <div className="h-full flex flex-col text-[12px]" data-testid="draw-artboards-panel">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--edge-soft)]">
        <span className="flex-1 text-[11px] uppercase tracking-wide text-[var(--ink-40)]">Artboards</span>
        <button title="New artboard" aria-label="New artboard" disabled={!editable} onClick={() => ctx.run('artboard.new')} data-testid="draw-artboards-new" className="p-0.5 rounded hover:bg-[var(--surface-sunken)] disabled:opacity-40">
          <Icon name="add_box" size={15} />
        </button>
        <button title="Duplicate artboard" aria-label="Duplicate artboard" disabled={!editable} onClick={() => ctx.run('artboard.duplicate')} data-testid="draw-artboards-duplicate" className="p-0.5 rounded hover:bg-[var(--surface-sunken)] disabled:opacity-40">
          <Icon name="library_add" size={15} />
        </button>
        <button title="Rearrange all artboards" aria-label="Rearrange all artboards" disabled={!editable || n < 2} onClick={() => ctx.run('artboard.rearrange')} data-testid="draw-artboards-rearrange" className="p-0.5 rounded hover:bg-[var(--surface-sunken)] disabled:opacity-40">
          <Icon name="grid_view" size={15} />
        </button>
        <button title="Delete artboard" aria-label="Delete artboard" disabled={!editable || n < 2} onClick={() => ctx.run('artboard.delete')} data-testid="draw-artboards-delete" className="p-0.5 rounded hover:bg-[var(--surface-sunken)] disabled:opacity-40">
          <Icon name="delete" size={15} />
        </button>
      </div>
      <ol className="flex-1 min-h-0 overflow-auto py-0.5" data-testid="draw-artboards-list">
        {doc.artboards.map((a, i) => (
          <li
            key={a.id}
            data-testid={`draw-artboards-row-${i}`}
            data-active={a.id === active.id ? '1' : undefined}
            onClick={() => ctx.run('artboard.activate', a.id)}
            onDoubleClick={() => editable && setRenaming(a.id)}
            className={`group flex items-center gap-1.5 px-2 py-0.5 cursor-default ${a.id === active.id ? 'bg-[var(--surface-sunken)] font-medium' : 'hover:bg-[var(--surface-sunken)]'}`}
          >
            <span className="w-5 text-right text-[var(--ink-40)] fb-tabular">{i + 1}</span>
            {renaming === a.id ? (
              <input
                autoFocus
                defaultValue={a.name}
                maxLength={120}
                data-testid="draw-artboards-rename"
                className="fb-field flex-1 min-w-0 px-1 py-0 text-[12px]"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setRenaming(null)
                  if (e.target.value.trim() && e.target.value.trim() !== a.name) ctx.run('artboard.rename', { id: a.id, name: e.target.value })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') {
                    ;(e.target as HTMLInputElement).value = a.name
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
              />
            ) : (
              <span className="flex-1 min-w-0 truncate" title={`${a.name} — ${a.w} × ${a.h}`}>
                {a.name}
              </span>
            )}
            <button
              title="Move up"
              aria-label={`Move ${a.name} up`}
              disabled={!editable || i === 0}
              data-testid={`draw-artboards-up-${i}`}
              onClick={(e) => {
                e.stopPropagation()
                ctx.run('artboard.reorder', { id: a.id, index: i - 1 })
              }}
              className="opacity-0 group-hover:opacity-100 disabled:!opacity-0"
            >
              <Icon name="arrow_upward" size={13} />
            </button>
            <button
              title="Move down"
              aria-label={`Move ${a.name} down`}
              disabled={!editable || i === n - 1}
              data-testid={`draw-artboards-down-${i}`}
              onClick={(e) => {
                e.stopPropagation()
                ctx.run('artboard.reorder', { id: a.id, index: i + 1 })
              }}
              className="opacity-0 group-hover:opacity-100 disabled:!opacity-0"
            >
              <Icon name="arrow_downward" size={13} />
            </button>
          </li>
        ))}
      </ol>
      <div className="border-t border-[var(--edge-soft)] px-2 py-1.5 space-y-1" data-testid="draw-artboards-props">
        <div className="grid grid-cols-2 gap-1.5">
          <NumField label="W" value={active.w} min={ARTBOARD_MIN} max={ARTBOARD_MAX} testid="draw-artboards-w" onCommit={(w) => patch({ w }, 'Artboard size')} />
          <NumField label="H" value={active.h} min={ARTBOARD_MIN} max={ARTBOARD_MAX} testid="draw-artboards-h" onCommit={(h) => patch({ h }, 'Artboard size')} />
          <NumField label="X" value={active.x} testid="draw-artboards-x" onCommit={(x) => patch({ x }, 'Move Artboard')} />
          <NumField label="Y" value={active.y} testid="draw-artboards-y" onCommit={(y) => patch({ y }, 'Move Artboard')} />
        </div>
        <select
          value={active.presetId ?? ''}
          aria-label="Preset"
          data-testid="draw-artboards-preset"
          className="fb-field w-full px-1.5 py-0.5 text-[12px]"
          onChange={(e) => {
            const s = DRAW_SIZES.find((z) => z.id === e.target.value)
            if (s) patch({ w: s.w, h: s.h, presetId: s.id }, 'Artboard preset')
          }}
        >
          <option value="">Custom — {active.w}×{active.h}</option>
          {DRAW_SIZES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} — {s.w}×{s.h}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--ink-50)]">
          <input type="checkbox" checked={withArt} onChange={() => ctx.run('artboard.toggleMoveArt')} data-testid="draw-artboards-with-art" />
          Move/copy artwork with artboard
        </label>
      </div>
    </div>
  )
}

const artboards: DrawPanel = {
  id: 'artboards',
  title: 'Artboards',
  dock: 'right',
  order: 18,
  height: 250,
  when: (s) => s.doc.artboards.length > 1 || s.tool === 'artboard',
  component: ArtboardsPanel
}

export default artboards
