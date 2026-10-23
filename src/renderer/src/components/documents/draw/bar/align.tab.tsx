// Align: Illustrator's Align panel in one row -- Align Objects (six),
// Distribute Objects (six), Distribute Spacing (two, Auto or an exact value)
// and Align To: the selection, a key object, or the artboard. With "key
// object", click one of the selected objects with the Selection tool to make
// it the key: it is outlined in bold, it never moves, and an exact spacing is
// measured from it. It was the Align panel and the inspector's align row.

import { BarCustom, BarGroup, BarSelect, BarSep } from '../../../office/shell'
import { DISTRIBUTE_EDGES, type DistributeEdge } from '@shared/draw/ops'
import { activeKey, alignState, type AlignToMode } from '../commands/align.commands'
import type { DrawBarTab, EditorCtx } from '../editor/types'
import { NumField } from '../transform/fields'
import { CmdButton, useBarReadOnly, useEditor } from './controls'

const ALIGN: Array<{ edge: string; icon: string; label: string }> = [
  { edge: 'left', icon: 'align_horizontal_left', label: 'Horizontal align left' },
  { edge: 'center', icon: 'align_horizontal_center', label: 'Horizontal align centre' },
  { edge: 'right', icon: 'align_horizontal_right', label: 'Horizontal align right' },
  { edge: 'top', icon: 'align_vertical_top', label: 'Vertical align top' },
  { edge: 'middle', icon: 'align_vertical_center', label: 'Vertical align centre' },
  { edge: 'bottom', icon: 'align_vertical_bottom', label: 'Vertical align bottom' }
]

const DIST_ICON: Record<DistributeEdge, string> = {
  top: 'vertical_align_top',
  vcenter: 'vertical_align_center',
  bottom: 'vertical_align_bottom',
  left: 'format_align_left',
  hcenter: 'format_align_center',
  right: 'format_align_right'
}

export function AlignControls({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const s = useEditor(ctx)
  const readOnly = useBarReadOnly() || s.readOnly
  const a = alignState(s)
  const key = activeKey(s)
  return (
    <>
      <BarGroup label="Align objects" testid="draw-align-panel">
        {ALIGN.map((b) => (
          <CmdButton key={b.edge} ctx={ctx} id={`object.align.${b.edge}`} icon={b.icon} label={b.label} testid={`draw-alignpanel-${b.edge}`} />
        ))}
        <BarSelect<AlignToMode>
          label="Align to"
          value={a.to}
          width={142}
          options={[
            { value: 'selection', label: 'Align to selection' },
            { value: 'key', label: 'Align to key object' },
            { value: 'artboard', label: 'Align to artboard' }
          ]}
          onChange={(v) => ctx.run(`object.alignTo.${v}`)}
          testid="draw-align-to"
        />
      </BarGroup>
      <BarSep />
      <BarGroup label="Distribute objects">
        {DISTRIBUTE_EDGES.map((e) => (
          <CmdButton key={e} ctx={ctx} id={`object.distribute.${e}`} icon={DIST_ICON[e]} testid={`draw-distribute-${e}`} />
        ))}
      </BarGroup>
      <BarSep />
      <BarGroup label="Distribute spacing">
        <CmdButton ctx={ctx} id="object.distributeSpacing.v" icon="vertical_distribute" testid="draw-distribute-space-v" />
        <CmdButton ctx={ctx} id="object.distributeSpacing.h" icon="horizontal_distribute" testid="draw-distribute-space-h" />
        <BarCustom label="Spacing">
          <NumField
            label="Distribute spacing"
            kind="length"
            settings={s.doc.settings}
            value={a.spacing}
            onCommit={(v) => ctx.run('object.alignSpacing', v)}
            disabled={readOnly}
            title="Distribute spacing: an exact gap, measured from the key object. Leave empty for Auto (even gaps)."
            testId="draw-align-spacing"
            className="w-[64px]"
          />
          <button
            type="button"
            className="text-[11px] px-1 h-6 rounded text-[var(--ink-50)] hover:text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
            disabled={readOnly || a.spacing === null}
            onClick={() => ctx.run('object.alignSpacing', null)}
            title="Back to Auto: even gaps between the outermost objects"
            data-testid="draw-align-spacing-auto"
          >
            Auto
          </button>
        </BarCustom>
      </BarGroup>
      {(a.to === 'key' || (a.spacing !== null && !key)) && (
        <span className="shrink-0 pl-2 text-[11px] text-[var(--ink-50)] max-w-[300px] truncate" data-testid={a.to === 'key' ? 'draw-align-key-hint' : 'draw-align-spacing-hint'} title={keyHint(a.to, !!key)}>
          {keyHint(a.to, !!key)}
        </span>
      )}
    </>
  )
}

function keyHint(to: AlignToMode, hasKey: boolean): string {
  if (to === 'key') return hasKey ? 'Key object outlined in bold — it stays put. Click another selected object to change it.' : 'Click one of the selected objects to make it the key object.'
  return 'An exact spacing is measured from a key object: choose Align to key object to use it.'
}

const align: DrawBarTab = { id: 'align', label: 'Align', order: 30, component: AlignControls }

export default align
