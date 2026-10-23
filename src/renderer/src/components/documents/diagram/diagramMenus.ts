import { SHAPES, SHAPE_CATEGORIES } from '@shared/diagram/shapes'
import type { MenuItem } from '../editor/menuBarKit'
import { menuAction } from '../../../lib/menus/menuAction'
import { menuItemOf } from '../../../lib/menus/officeCommand'
import type { Commands } from './commands'
import type { DiagramCommands } from './diagramCommands'
import type { DiagramPanel } from './ribbon'

// PlexiiDiagrams' menu bar rows (File's own, Edit, View, Insert, Arrange,
// Help), built from the command registry (diagramCommands) so a viewer's rows
// are off with the shell's sentence where the bar's are (SPEC §9.5). Out of
// DiagramChrome so the rows can be built and read without React Flow: the
// read-only guard (officeReadOnlyReason.test) walks every one of them.
//
// What is still written by hand here only READS the diagram or the screen:
// Download ▸, the panels, the ribbon's own collapse, Help. Every row that
// changes the diagram renders from a command, with that command's gate.

export interface DiagramMenuDeps {
  c: DiagramCommands
  cmd: Commands
  singlePage: boolean
  /** Something is selected (Download ▸ Selection as …). */
  hasSel: boolean
  /** Shapes hidden on this page, for Show all hidden's label. */
  hiddenOnPage: number
  exportFmt: (f: 'svg' | 'png' | 'jpg' | 'pdf', scope?: 'page' | 'selection') => void
  setStatus: (msg: string) => void
  openShortcuts: () => void
  togglePanel: (p: DiagramPanel) => void
  isOpen: (p: DiagramPanel) => boolean
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  onSaveSnippet?: () => void
  onInsertSnippet?: () => void
}

export interface DiagramMenus {
  file: () => MenuItem[]
  edit: () => MenuItem[]
  view: () => MenuItem[]
  insert: () => MenuItem[]
  arrange: () => MenuItem[]
  help: () => MenuItem[]
}

export function diagramMenus(m: DiagramMenuDeps): DiagramMenus {
  const { c, cmd, singlePage } = m
  // A shape row: the one Insert-shape definition (its gate), this shape's label and run.
  const shapeRow = (id: string, label: string): MenuItem => menuItemOf(c.insertShape, { label, icon: undefined, run: () => void cmd.addShape(id) })
  return {
    file: (): MenuItem[] => [
      {
        kind: 'submenu',
        label: 'Import',
        icon: 'upload_file',
        items: [
          menuItemOf(c.mermaid),
          // draw.io and PlexiiDiagrams JSON can carry several pages (JSON replaces
          // the whole diagram); a single-page editor would keep page one and drop
          // the rest, so neither is offered there.
          ...(singlePage ? [] : [menuItemOf(c.importDrawio)]),
          menuItemOf(c.importVsdx),
          ...(singlePage ? [] : [menuItemOf(c.importJson)])
        ]
      },
      {
        kind: 'submenu',
        label: menuAction('download').label,
        icon: 'download',
        items: [
          { kind: 'item', label: 'PNG image', run: () => m.exportFmt('png') },
          { kind: 'item', label: 'SVG (vector)', run: () => m.exportFmt('svg') },
          { kind: 'item', label: 'JPG image', run: () => m.exportFmt('jpg') },
          { kind: 'item', label: 'PDF', run: () => m.exportFmt('pdf') },
          { kind: 'sep' },
          { kind: 'item', label: 'Selection as PNG', run: () => m.exportFmt('png', 'selection'), disabled: !m.hasSel },
          { kind: 'item', label: 'Selection as SVG', run: () => m.exportFmt('svg', 'selection'), disabled: !m.hasSel },
          { kind: 'sep' },
          { kind: 'item', label: 'Mermaid (.mmd)', run: () => cmd.exportText('mermaid') },
          { kind: 'item', label: 'Copy as Mermaid', run: () => (cmd.copyMermaid(), m.setStatus('Mermaid copied to the clipboard.')) },
          { kind: 'item', label: 'draw.io (.drawio), all pages', run: () => cmd.exportText('drawio') },
          { kind: 'item', label: 'PlexiiDiagrams JSON', run: () => cmd.exportText('json') }
        ]
      }
    ],
    edit: (): MenuItem[] => [
      menuItemOf(c.undo),
      menuItemOf(c.redo),
      { kind: 'sep' },
      menuItemOf(c.cut),
      menuItemOf(c.copy),
      menuItemOf(c.paste),
      menuItemOf(c.duplicate),
      menuItemOf(c.remove),
      { kind: 'sep' },
      menuItemOf(c.selectAll),
      menuItemOf(c.find),
      menuItemOf(c.findAndReplace),
      ...(m.onSaveSnippet ? [{ kind: 'sep' as const }, { kind: 'item' as const, ...menuAction('saveAsSnippet'), icon: 'bookmark_add', run: m.onSaveSnippet }] : []),
      { kind: 'sep' },
      menuItemOf(c.copyStyle),
      menuItemOf(c.pasteStyle)
    ],
    view: (): MenuItem[] => [
      menuItemOf(c.fit),
      menuItemOf(c.zoomToSelection),
      menuItemOf(c.zoomIn),
      menuItemOf(c.zoomOut),
      menuItemOf(c.actualSize),
      { kind: 'sep' },
      { kind: 'item', label: 'Shape library', icon: 'category', run: () => m.togglePanel('library'), active: m.isOpen('library') },
      { kind: 'item', label: 'Layers', icon: 'layers', run: () => m.togglePanel('layers'), active: m.isOpen('layers') },
      { kind: 'item', label: 'Ribbon', icon: 'view_day', run: () => m.setCollapsed(!m.collapsed), active: !m.collapsed },
      { kind: 'sep' },
      menuItemOf(c.grid),
      menuItemOf(c.snap),
      menuItemOf(c.guides),
      menuItemOf(c.lineJumps),
      menuItemOf(c.minimap)
    ],
    insert: (): MenuItem[] => [
      ...(['process', 'decision', 'terminator', 'data', 'database', 'circle'] as const).map((id) => shapeRow(id, SHAPES.find((x) => x.id === id)!.label)),
      { kind: 'sep' },
      ...SHAPE_CATEGORIES.filter((cat) => SHAPES.some((s) => s.category === cat)).map((cat) => ({
        kind: 'submenu' as const,
        label: `${cat} shapes`,
        icon: 'category',
        items: SHAPES.filter((s) => s.category === cat).map((s) => shapeRow(s.id, s.label))
      })),
      { kind: 'sep' },
      menuItemOf(c.insertText),
      menuItemOf(c.insertTable),
      menuItemOf(c.insertSticky),
      menuItemOf(c.insertSwimlane),
      menuItemOf(c.insertImage),
      { kind: 'sep' },
      menuItemOf(c.fromTable),
      menuItemOf(c.template),
      menuItemOf(c.mermaid),
      menuItemOf(c.aiDiagram),
      ...(singlePage ? [] : [{ kind: 'sep' as const }, menuItemOf(c.newPage)]),
      // The shared tail (SPEC §9.2): Insert snippet… · Work widget from a desk…, then Meeting (DrawMenuBar).
      { kind: 'sep' },
      ...(m.onInsertSnippet ? [menuItemOf(c.insertSnippet)] : []),
      menuItemOf(c.insertWidget)
    ],
    arrange: (): MenuItem[] => [
      menuItemOf(c.bringToFront),
      menuItemOf(c.bringForward),
      menuItemOf(c.sendBackward),
      menuItemOf(c.sendToBack),
      { kind: 'sep' },
      menuItemOf(c.group),
      menuItemOf(c.ungroup),
      menuItemOf(c.lock),
      menuItemOf(c.hide),
      menuItemOf(c.showAllHidden, { label: `Show all hidden${m.hiddenOnPage ? ` (${m.hiddenOnPage})` : ''}` }),
      { kind: 'sep' },
      {
        kind: 'submenu',
        label: 'Align',
        icon: 'align_horizontal_left',
        items: (
          [
            ['left', 'Left'],
            ['hcenter', 'Centre'],
            ['right', 'Right'],
            ['top', 'Top'],
            ['vcenter', 'Middle'],
            ['bottom', 'Bottom']
          ] as const
        ).map(([e, l]) => menuItemOf(c.align, { label: l, icon: undefined, run: () => cmd.align(e) }))
      },
      {
        kind: 'submenu',
        label: 'Distribute',
        icon: 'horizontal_distribute',
        items: [
          menuItemOf(c.distribute, { label: 'Horizontally', icon: undefined, run: () => cmd.distribute('h') }),
          menuItemOf(c.distribute, { label: 'Vertically', icon: undefined, run: () => cmd.distribute('v') })
        ]
      },
      {
        kind: 'submenu',
        label: 'Rotate & flip',
        icon: 'rotate_right',
        items: [menuItemOf(c.rotateRight), menuItemOf(c.rotateLeft), menuItemOf(c.flipH), menuItemOf(c.flipV)]
      },
      { kind: 'sep' },
      menuItemOf(c.tidy),
      {
        kind: 'submenu',
        label: 'Auto layout',
        icon: 'account_tree',
        items: (
          [
            ['Hierarchy, top to bottom', 'layered', 'TB'],
            ['Hierarchy, left to right', 'layered', 'LR'],
            ['Tree', 'tree', 'TB'],
            ['Mind map', 'mindmap', 'LR'],
            ['Radial', 'radial', 'TB'],
            ['Organic', 'organic', 'TB'],
            ['Grid', 'grid', 'TB']
          ] as const
        ).map(([l, a, dir]) => menuItemOf(c.autoLayout, { label: l, icon: undefined, run: () => cmd.layout(a, dir) }))
      }
    ],
    help: (): MenuItem[] => [
      { kind: 'item', ...menuAction('keyboardShortcuts'), icon: 'keyboard', run: m.openShortcuts },
      { kind: 'item', label: 'How to diagram', icon: 'help', run: m.openShortcuts }
    ]
  }
}
