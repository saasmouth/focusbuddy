// Artboard (contextual, while the Artboard tool (⇧O) is active): the active
// artboard's name, width and height, preset and orientation, Move/copy
// artwork with artboard, New / Duplicate / Delete, Artboard Options… and the
// Artboards panel. Every change goes through a registered artboard command,
// so the v2 gate (several, moved or named artboards) refuses it the same way
// everywhere and says why.

import { useEffect, useState } from 'react'
import { BarCustom, BarDialogButton, BarGroup, BarNumber, BarSelect, BarSep, BarToggle, READ_ONLY_REASON, barTip } from '../../../office/shell'
import Tooltip from '../../../Tooltip'
import { DRAW_SIZES } from '@shared/draw'
import { ARTBOARD_MAX, ARTBOARD_MIN, primaryArtboard } from '@shared/draw/ops'
import { artboardsBlockedReason, artboardsEditable, moveArtWithArtboard } from '../editor/artboards'
import type { DrawBarTab, EditorCtx } from '../editor/types'
import { keyOf } from './controls'
import { CmdButton, useBarReadOnly, useEditor } from './controls'

/** The name field: commits on Enter or leaving it (one undo step), Escape puts the old name back. */
function NameField({ value, onCommit, disabled, reason }: { value: string; onCommit: (v: string) => void; disabled: boolean; reason?: string }): JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const tip = barTip('Artboard name', undefined, disabled ? reason : undefined)
  return (
    <Tooltip content={tip} placement="bottom">
      <input
        aria-label={tip}
        value={text}
        maxLength={120}
        disabled={disabled}
        data-testid="draw-artboard-name"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() && text.trim() !== value) onCommit(text)
          else setText(value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(value)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="fb-field h-6 w-[130px] px-1.5 text-[12px] disabled:opacity-35"
      />
    </Tooltip>
  )
}

function ArtboardTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const s = useEditor(ctx)
  const readOnly = useBarReadOnly() || s.readOnly
  const a = primaryArtboard(s.doc)
  const editable = artboardsEditable(s)
  const blocked = readOnly ? READ_ONLY_REASON : (artboardsBlockedReason(s) ?? undefined)
  const patch = (p: Record<string, unknown>, label: string): void => ctx.run('artboard.patch', { id: a.id, patch: p, label })
  const index = s.doc.artboards.findIndex((x) => x.id === a.id)
  const portrait = a.h > a.w
  return (
    <>
      <BarCustom label="Artboard">
        <span className="shrink-0 px-1 text-[11px] text-[var(--ink-50)] fb-tabular" data-testid="draw-artboard-index">
          {index + 1} of {s.doc.artboards.length}
        </span>
        <NameField value={a.name} disabled={!editable} reason={blocked} onCommit={(name) => ctx.run('artboard.rename', { id: a.id, name })} />
      </BarCustom>
      <BarSep />
      <BarGroup label="Size">
        <BarNumber label="Artboard width" value={a.w} min={ARTBOARD_MIN} max={ARTBOARD_MAX} suffix="W" width={54} disabled={!editable} disabledReason={blocked} onChange={(w) => patch({ w: Math.round(w) }, 'Artboard size')} testid="draw-artboard-w" />
        <BarNumber label="Artboard height" value={a.h} min={ARTBOARD_MIN} max={ARTBOARD_MAX} suffix="H" width={54} disabled={!editable} disabledReason={blocked} onChange={(h) => patch({ h: Math.round(h) }, 'Artboard size')} testid="draw-artboard-h" />
        <BarSelect
          label="Preset"
          value={a.presetId ?? ''}
          width={150}
          disabled={!editable}
          disabledReason={blocked}
          options={[{ value: '', label: `Custom — ${a.w}×${a.h}` }, ...DRAW_SIZES.map((z) => ({ value: z.id, label: `${z.label} — ${z.w}×${z.h}` }))]}
          onChange={(id) => {
            const z = DRAW_SIZES.find((x) => x.id === id)
            if (z) patch({ w: z.w, h: z.h, presetId: z.id }, 'Artboard preset')
          }}
          testid="draw-artboard-preset"
        />
        <BarToggle icon="crop_portrait" label="Portrait" pressed={portrait} disabled={!editable || portrait} disabledReason={editable ? 'already portrait' : blocked} onChange={() => patch({ w: a.h, h: a.w }, 'Artboard orientation')} testid="draw-artboard-portrait" />
        <BarToggle icon="crop_landscape" label="Landscape" pressed={!portrait && a.w !== a.h} disabled={!editable || a.w >= a.h} disabledReason={editable ? 'already landscape' : blocked} onChange={() => patch({ w: a.h, h: a.w }, 'Artboard orientation')} testid="draw-artboard-landscape" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Artboards">
        <BarToggle icon="open_with" label="Move/copy artwork with artboard" pressed={moveArtWithArtboard(s)} onChange={() => ctx.run('artboard.toggleMoveArt')} testid="draw-artboard-with-art" />
        <CmdButton ctx={ctx} id="artboard.new" reason={blocked} testid="draw-artboard-new" />
        <CmdButton ctx={ctx} id="artboard.duplicate" reason={blocked} testid="draw-artboard-duplicate" />
        <CmdButton ctx={ctx} id="artboard.delete" reason={blocked ?? 'a drawing keeps at least one artboard'} testid="draw-artboard-delete" />
        <BarDialogButton icon="tune" label="Options" disabled={!editable} disabledReason={blocked} onOpen={() => ctx.run('artboard.options')} testid="draw-artboard-options" />
        <BarDialogButton icon="dashboard" label="Artboards" shortcut={keyOf('window.artboards')} readOnlySafe onOpen={() => ctx.run('window.artboards', true)} testid="draw-artboard-panel-open" />
      </BarGroup>
    </>
  )
}

const artboard: DrawBarTab = { id: 'artboard', label: 'Artboard', order: 170, when: (s) => s.tool === 'artboard', component: ArtboardTab }

export default artboard
