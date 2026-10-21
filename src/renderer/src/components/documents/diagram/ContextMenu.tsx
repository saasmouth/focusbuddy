import type { Graph, Sel } from '@shared/diagram/ops'
import Icon from '../../Icon'
import type { Commands } from './commands'

// Right-click menu for shapes, lines and the empty canvas.

export type ContextTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'pane'; flow: { x: number; y: number } }

type Item = { label: string; icon: string; run: () => void; hint?: string; disabled?: boolean } | 'sep'

export function ContextMenu({ x, y, target, cmd, sel, page, onClose }: { x: number; y: number; target: ContextTarget; cmd: Commands; sel: Sel; page: Graph; onClose: () => void }): JSX.Element {
  const nodes = page.nodes.filter((n) => sel.nodes.has(n.id))
  const locked = nodes.some((n) => n.locked) || page.edges.some((e) => sel.edges.has(e.id) && e.locked)
  const grouped = nodes.some((n) => n.groupId)
  const items: Item[] =
    target.kind === 'pane'
      ? [
          { label: 'Paste', icon: 'content_paste', hint: '⌘V', run: () => void navigator.clipboard?.readText().then((t) => cmd.paste(dataFromText(t))).catch(() => cmd.paste(null)) },
          { label: 'Add text here', icon: 'title', run: () => cmd.addShape('note', { center: target.flow, edit: true }) },
          { label: 'Add a box here', icon: 'crop_square', run: () => cmd.addShape('process', { center: target.flow, edit: true }) },
          'sep',
          { label: 'Select all', icon: 'select_all', hint: '⌘A', run: cmd.selectAll },
          { label: 'Tidy connections', icon: 'cleaning_services', run: () => void cmd.tidyConnections() },
          { label: 'Fit page', icon: 'fit_screen', hint: '⇧1', run: cmd.fit }
        ]
      : target.kind === 'edge'
        ? [
            { label: 'Edit label', icon: 'edit', hint: 'Enter', run: cmd.editSelected },
            { label: 'Right-angle', icon: 'turn_right', run: () => cmd.setEdges({ routing: 'orthogonal', waypoints: undefined }) },
            { label: 'Curved', icon: 'gesture', run: () => cmd.setEdges({ routing: 'curved', waypoints: undefined }) },
            { label: 'Straight', icon: 'horizontal_rule', run: () => cmd.setEdges({ routing: 'straight', waypoints: undefined }) },
            { label: 'Reset route', icon: 'restart_alt', run: () => cmd.setEdges({ waypoints: undefined, sourceHandle: undefined, targetHandle: undefined }) },
            'sep',
            { label: locked ? 'Unlock' : 'Lock', icon: locked ? 'lock_open' : 'lock', hint: '⇧⌘L', run: cmd.toggleLock },
            { label: 'Delete', icon: 'delete', hint: '⌫', run: cmd.deleteSelection }
          ]
        : [
            { label: 'Edit text', icon: 'edit', hint: 'Enter', run: cmd.editSelected, disabled: nodes.length !== 1 },
            'sep',
            { label: 'Cut', icon: 'content_cut', hint: '⌘X', run: () => document.execCommand('cut') },
            { label: 'Copy', icon: 'content_copy', hint: '⌘C', run: () => document.execCommand('copy') },
            { label: 'Duplicate', icon: 'control_point_duplicate', hint: '⌘D', run: cmd.duplicate },
            { label: 'Delete', icon: 'delete', hint: '⌫', run: cmd.deleteSelection },
            'sep',
            { label: 'Copy style', icon: 'format_paint', hint: '⌥⌘C', run: cmd.copyStyle },
            { label: 'Paste style', icon: 'format_color_fill', hint: '⌥⌘V', run: cmd.pasteStyle, disabled: !cmd.hasStyleClipboard() },
            'sep',
            { label: 'Bring to front', icon: 'flip_to_front', hint: '⇧⌘]', run: () => cmd.order('front') },
            { label: 'Send to back', icon: 'flip_to_back', hint: '⇧⌘[', run: () => cmd.order('back') },
            nodes.length > 1 ? { label: 'Group', icon: 'link', hint: '⌘G', run: cmd.group } : { label: 'Zoom to shape', icon: 'zoom_in', hint: '⇧2', run: cmd.zoomToSelection },
            ...(grouped ? [{ label: 'Ungroup', icon: 'link_off', hint: '⇧⌘G', run: cmd.ungroup } as Item] : []),
            { label: locked ? 'Unlock' : 'Lock', icon: locked ? 'lock_open' : 'lock', hint: '⇧⌘L', run: cmd.toggleLock },
            { label: nodes.length > 1 ? 'Hide shapes' : 'Hide shape', icon: 'visibility_off', run: cmd.hideSelection },
            'sep',
            { label: 'Tidy these connections', icon: 'cleaning_services', run: () => void cmd.tidyConnections(), disabled: nodes.length < 2 }
          ]
  return (
    <>
      <div className="absolute inset-0 z-30" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div className="fb-glass-panel fb-pop-in absolute z-40 py-1 min-w-[200px] rounded-[var(--radius-row)] shadow-xl" style={{ left: x, top: y }} data-testid="diagram-context-menu">
        {items.map((it, i) =>
          it === 'sep' ? (
            <div key={i} className="my-1 h-px bg-[var(--edge-soft)]" />
          ) : (
            <button
              key={i}
              type="button"
              disabled={it.disabled}
              onClick={() => {
                it.run()
                onClose()
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--surface-sunken)] disabled:opacity-40"
            >
              <Icon name={it.icon} size={14} className="text-[var(--ink-60)]" />
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="text-[10px] text-[var(--ink-40)]">{it.hint}</span>}
            </button>
          )
        )}
      </div>
    </>
  )
}

function dataFromText(text: string): DataTransfer {
  const dt = new DataTransfer()
  dt.setData('text/plain', text)
  return dt
}
