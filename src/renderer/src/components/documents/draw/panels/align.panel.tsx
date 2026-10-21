// The Align panel (Illustrator's Window › Align): Align Objects (six),
// Distribute Objects (six), Distribute Spacing (two, Auto or an exact value)
// and Align To: the selection, a key object, or the artboard. With "key
// object", click one of the selected objects with the Selection tool to make
// it the key -- it is outlined in bold, it never moves, and an exact spacing is
// measured from it.

import { useStore } from 'zustand'
import Icon from '../../../Icon'
import { DISTRIBUTE_EDGES, type DistributeEdge } from '@shared/draw/ops'
import type { DrawPanel, EditorCtx } from '../editor/types'
import { activeKey, alignState, canAlign, canDistribute, type AlignToMode } from '../commands/align.commands'
import { NumField } from '../transform/fields'

const ALIGN: Array<{ edge: string; icon: string; label: string }> = [
  { edge: 'left', icon: 'align_horizontal_left', label: 'Horizontal align left' },
  { edge: 'center', icon: 'align_horizontal_center', label: 'Horizontal align center' },
  { edge: 'right', icon: 'align_horizontal_right', label: 'Horizontal align right' },
  { edge: 'top', icon: 'align_vertical_top', label: 'Vertical align top' },
  { edge: 'middle', icon: 'align_vertical_center', label: 'Vertical align center' },
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

const DIST_LABEL: Record<DistributeEdge, string> = {
  top: 'Vertical distribute top',
  vcenter: 'Vertical distribute center',
  bottom: 'Vertical distribute bottom',
  left: 'Horizontal distribute left',
  hcenter: 'Horizontal distribute center',
  right: 'Horizontal distribute right'
}

function Btn({ icon, label, disabled, onClick, testId }: { icon: string; label: string; disabled: boolean; onClick(): void; testId: string }): JSX.Element {
  return (
    <button type="button" className="icon-btn !h-6 !w-6 disabled:opacity-30" title={label} aria-label={label} disabled={disabled} onClick={onClick} data-testid={testId}>
      <Icon name={icon} size={15} />
    </button>
  )
}

function AlignPanel({ ctx }: { ctx: EditorCtx }): JSX.Element {
  // Subscribe to everything the enabled states read.
  useStore(ctx.store, (s) => s.doc)
  useStore(ctx.store, (s) => s.selection)
  useStore(ctx.store, (s) => s.readOnly)
  const toolState = useStore(ctx.store, (s) => s.toolState)
  const s = ctx.get()
  const a = alignState({ toolState })
  const key = activeKey(s)
  const settings = s.doc.settings
  const alignOk = canAlign(ctx)
  const distOk = canDistribute(ctx)
  const exactNeedsKey = a.spacing !== null && !key

  return (
    <div className="h-full overflow-y-auto px-2 py-1.5 space-y-1" data-testid="draw-align-panel">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--ink-60)]">Align</span>
        <select
          className="fb-field text-[11px] px-1 py-0"
          aria-label="Align to"
          title="Align to"
          value={a.to}
          onChange={(e) => ctx.run(`object.alignTo.${e.target.value as AlignToMode}`)}
          data-testid="draw-align-to"
        >
          <option value="selection">Align to selection</option>
          <option value="key">Align to key object</option>
          <option value="artboard">Align to artboard</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-0.5" role="group" aria-label="Align objects">
        {ALIGN.map((b) => (
          <Btn key={b.edge} icon={b.icon} label={b.label} disabled={!alignOk} onClick={() => ctx.run(`object.align.${b.edge}`)} testId={`draw-alignpanel-${b.edge}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-0.5" role="group" aria-label="Distribute objects">
        {DISTRIBUTE_EDGES.map((e) => (
          <Btn key={e} icon={DIST_ICON[e]} label={DIST_LABEL[e]} disabled={!distOk} onClick={() => ctx.run(`object.distribute.${e}`)} testId={`draw-distribute-${e}`} />
        ))}
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Distribute spacing">
        <Btn icon="vertical_distribute" label="Vertical distribute space" disabled={!distOk} onClick={() => ctx.run('object.distributeSpacing.v')} testId="draw-distribute-space-v" />
        <Btn icon="horizontal_distribute" label="Horizontal distribute space" disabled={!distOk} onClick={() => ctx.run('object.distributeSpacing.h')} testId="draw-distribute-space-h" />
        <NumField
          label="Distribute spacing"
          kind="length"
          settings={settings}
          value={a.spacing}
          onCommit={(v) => ctx.run('object.alignSpacing', v)}
          title="Distribute spacing: an exact gap, measured from the key object. Leave empty for Auto (even gaps)."
          testId="draw-align-spacing"
          className="flex-1"
        />
        <button
          type="button"
          className="text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-80)] disabled:opacity-40"
          disabled={a.spacing === null}
          onClick={() => ctx.run('object.alignSpacing', null)}
          title="Back to Auto: even gaps between the outermost objects"
          data-testid="draw-align-spacing-auto"
        >
          Auto
        </button>
      </div>
      {a.to === 'key' && (
        <p className="text-[10px] text-[var(--ink-50)]" data-testid="draw-align-key-hint">
          {key ? 'Key object outlined in bold — it stays put. Click another selected object to change it.' : 'Click one of the selected objects to make it the key object.'}
        </p>
      )}
      {a.to !== 'key' && exactNeedsKey && (
        <p className="text-[10px] text-[var(--ink-50)]">An exact spacing is measured from a key object: choose Align to key object to use it.</p>
      )}
    </div>
  )
}

const align: DrawPanel = {
  id: 'align',
  title: 'Align',
  dock: 'right',
  order: 16,
  height: 150,
  when: (s) => s.selection.length > 0,
  component: AlignPanel
}

export default align
