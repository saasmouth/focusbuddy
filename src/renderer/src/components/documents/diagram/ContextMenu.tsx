import type { Graph, Sel } from '@shared/diagram/ops'
import CanvasContextMenu, { type CtxMenuItem } from '../../CanvasContextMenu'
import { canvasMenu, objectMenu } from '../../../lib/menus/officeContextMenu'
import { hint } from '../../../lib/menus/menuAction'
import type { Commands } from './commands'

// Right-click menu for shapes, lines and the empty canvas: the kit's menu in
// the two shapes every office app shares (SPEC §9.3), so a shape here reads
// like a slide element in Deck or a frame in Design. Every row the old bespoke
// menu had is still here; the ones past the first four groups sit in More
// actions ▸.

export type ContextTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'pane'; flow: { x: number; y: number } }

export function ContextMenu({
  x,
  y,
  target,
  cmd,
  sel,
  page,
  readOnly = false,
  onSaveSnippet,
  onInsertSnippet,
  onClose
}: {
  /** Viewport coordinates of the right-click. */
  x: number
  y: number
  target: ContextTarget
  cmd: Commands
  sel: Sel
  page: Graph
  readOnly?: boolean
  onSaveSnippet?: () => void
  onInsertSnippet?: () => void
  onClose: () => void
}): JSX.Element {
  const nodes = page.nodes.filter((n) => sel.nodes.has(n.id))
  const locked = nodes.some((n) => n.locked) || page.edges.some((e) => sel.edges.has(e.id) && e.locked)
  const grouped = nodes.some((n) => n.groupId)
  const paste = (): void => void navigator.clipboard?.readText().then((t) => cmd.paste(dataFromText(t))).catch(() => cmd.paste(null))
  const lock: CtxMenuItem = { label: locked ? 'Unlock' : 'Lock', icon: locked ? 'lock_open' : 'lock', shortcut: hint(['shift', 'mod', 'l']), onClick: cmd.toggleLock }

  const items: CtxMenuItem[] =
    target.kind === 'pane'
      ? canvasMenu({
          paste,
          insertSnippet: onInsertSnippet && !readOnly ? onInsertSnippet : undefined,
          create: [
            { label: 'Add text here', icon: 'title', onClick: () => cmd.addShape('note', { center: target.flow, edit: true }) },
            { label: 'Add a box here', icon: 'crop_square', onClick: () => cmd.addShape('process', { center: target.flow, edit: true }) }
          ],
          selectAll: cmd.selectAll,
          view: [
            { label: 'Tidy connections', icon: 'cleaning_services', onClick: () => void cmd.tidyConnections() },
            { label: 'Fit page', icon: 'fit_screen', shortcut: hint(['shift', '1']), onClick: cmd.fit }
          ]
        })
      : target.kind === 'edge'
        ? objectMenu({
            object: [
              { label: 'Edit label', icon: 'edit', shortcut: hint(['enter']), onClick: cmd.editSelected },
              {
                label: 'Route',
                icon: 'turn_right',
                children: [
                  { label: 'Right-angle', icon: 'turn_right', onClick: () => cmd.setEdges({ routing: 'orthogonal', waypoints: undefined }) },
                  { label: 'Curved', icon: 'gesture', onClick: () => cmd.setEdges({ routing: 'curved', waypoints: undefined }) },
                  { label: 'Straight', icon: 'horizontal_rule', onClick: () => cmd.setEdges({ routing: 'straight', waypoints: undefined }) },
                  { separator: true },
                  { label: 'Reset route', icon: 'restart_alt', onClick: () => cmd.setEdges({ waypoints: undefined, sourceHandle: undefined, targetHandle: undefined }) }
                ]
              }
            ],
            more: [lock],
            del: cmd.deleteSelection
          })
        : objectMenu({
            object: [
              {
                label: 'Edit text',
                icon: 'edit',
                shortcut: hint(['enter']),
                onClick: cmd.editSelected,
                disabled: nodes.length !== 1,
                hint: nodes.length !== 1 ? 'Select one shape' : undefined
              }
            ],
            cut: () => document.execCommand('cut'),
            copy: () => document.execCommand('copy'),
            paste,
            duplicate: cmd.duplicate,
            bringToFront: () => cmd.order('front'),
            sendToBack: () => cmd.order('back'),
            group: nodes.length > 1 ? cmd.group : undefined,
            ungroup: grouped ? cmd.ungroup : undefined,
            saveAsSnippet: onSaveSnippet,
            more: [
              { label: 'Copy style', icon: 'format_paint', shortcut: hint(['alt', 'mod', 'c']), onClick: cmd.copyStyle },
              {
                label: 'Paste style',
                icon: 'format_color_fill',
                shortcut: hint(['alt', 'mod', 'v']),
                onClick: cmd.pasteStyle,
                disabled: !cmd.hasStyleClipboard(),
                hint: cmd.hasStyleClipboard() ? undefined : 'Copy a style first'
              },
              { separator: true },
              lock,
              { label: nodes.length > 1 ? 'Hide shapes' : 'Hide shape', icon: 'visibility_off', onClick: cmd.hideSelection, testid: 'diagram-ctx-hide' },
              { label: 'Zoom to shape', icon: 'zoom_in', shortcut: hint(['shift', '2']), onClick: cmd.zoomToSelection },
              {
                label: 'Tidy these connections',
                icon: 'cleaning_services',
                onClick: () => void cmd.tidyConnections(),
                disabled: nodes.length < 2,
                hint: nodes.length < 2 ? 'Select two or more shapes' : undefined
              }
            ],
            del: cmd.deleteSelection
          })

  return <CanvasContextMenu testid="diagram-context-menu" x={x} y={y} items={items} onClose={onClose} />
}

function dataFromText(text: string): DataTransfer {
  const dt = new DataTransfer()
  dt.setData('text/plain', text)
  return dt
}
