// PlexiiDesign's ToolRail items, as data (SPEC §3.9), the same shape as
// deckRailItems and diagramRailItems so the rail contract can check all six
// apps. Navigate (Select) · Create (Text, the Shapes flyout: armed modes,
// D4) · Insert (Image first) · bottom: the overlay panels, then AI last.
//
// Armed tools carry `design-tool-*` ids: the old `design-add-*` ids meant
// "adds one now", and keeping them on something that only arms a mode is how
// a test passes while placing nothing (§4.1).

import { armedTool, railGroup, type RailItem } from '../../office/shell'

export type DesignRailTool = 'select' | 'text' | 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'line'
export type DesignRailPanel = 'layout' | 'styles' | 'swatches' | 'preflight'

export interface DesignRailCmds {
  armTool: (t: DesignRailTool, lock?: boolean) => void
  addImage: () => void
  placeLogo: () => void
  insertWidget: () => void
  togglePanel: (p: DesignRailPanel) => void
  /** The AI design generator, a pane in the shared right side pane (like Deck's Generate deck). */
  toggleGenerate: () => void
}

const shape = (id: Exclude<DesignRailTool, 'select' | 'text'>, label: string, icon: string, order: number, shortcut?: string): RailItem<DesignRailCmds> =>
  armedTool<DesignRailCmds>({ id: `tool-${id}`, label, icon, role: 'shape', order, shortcut, flyout: 'shapes', arm: (c, lock) => c.armTool(id, lock), testid: `design-tool-${id}` })

const panel = (id: DesignRailPanel, label: string, icon: string, order: number): RailItem<DesignRailCmds> => ({
  id: `panel-${id}`,
  label,
  icon,
  kind: 'panel',
  role: 'panel',
  controls: id,
  group: railGroup('panel'),
  order,
  pinned: 'bottom',
  onSelect: (c) => c.togglePanel(id),
  testid: `design-rail-${id}`
})

export function designRailItems(): RailItem<DesignRailCmds>[] {
  return [
    // Select has no double-click options: a "double-click for options" hint on
    // it promised something that did not exist.
    { id: 'select', label: 'Select', icon: 'arrow_selector_tool', kind: 'tool', role: 'select', group: railGroup('select'), order: 0, shortcut: 'V', readOnlySafe: true, onSelect: (c) => c.armTool('select'), testid: 'design-tool-select' },
    armedTool<DesignRailCmds>({ id: 'tool-text', label: 'Text', icon: 'title', role: 'text', order: 0, shortcut: 'T', arm: (c, lock) => c.armTool('text', lock), testid: 'design-tool-text' }),
    shape('rect', 'Rectangle', 'crop_square', 1, 'M'),
    shape('roundRect', 'Rounded rectangle', 'rounded_corner', 2),
    shape('ellipse', 'Ellipse', 'circle', 3, 'L'),
    shape('triangle', 'Triangle', 'change_history', 4),
    shape('line', 'Line', 'horizontal_rule', 5, '\\'),
    { id: 'image', label: 'Image', icon: 'image', kind: 'action', role: 'image', group: railGroup('image'), order: 0, onSelect: (c) => c.addImage(), testid: 'design-add-image' },
    { id: 'logo', label: 'Logo', icon: 'badge', kind: 'action', role: 'insert', group: railGroup('insert'), order: 1, onSelect: (c) => c.placeLogo(), testid: 'design-add-logo' },
    { id: 'widget', label: 'Work widget from a desk', icon: 'widgets', kind: 'action', role: 'insert', group: railGroup('insert'), order: 2, onSelect: (c) => c.insertWidget(), testid: 'design-add-widget' },
    // The overlay panels (two doors to each: the rail and its ribbon button),
    // then AI design last. AI design generates a whole layout from a prompt;
    // it opens in the right side pane beside PlexiiAssist, as Deck's Generate
    // deck and Diagrams' AI diagram do.
    panel('layout', 'Page layout', 'dashboard', 0),
    panel('styles', 'Paragraph styles', 'format_paint', 1),
    panel('swatches', 'Swatches & spot inks', 'invert_colors', 2),
    panel('preflight', 'Preflight for print', 'rule', 3),
    { id: 'ai-generate', label: 'AI design', icon: 'auto_awesome', kind: 'panel', role: 'ai', sidePane: true, group: railGroup('ai'), order: 4, pinned: 'bottom', onSelect: (c) => c.toggleGenerate(), testid: 'design-ai-btn' }
  ]
}

/** The rail id the active tool stands for. */
export const designRailIdForTool = (t: DesignRailTool): string => (t === 'select' ? 'select' : `tool-${t}`)
