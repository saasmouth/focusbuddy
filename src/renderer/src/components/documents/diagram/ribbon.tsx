import { barProps } from '../../../lib/menus/officeCommand'
import { buildDiagramCommands, type DiagramCommands } from './diagramCommands'
import type { MapArrowHead, MapEdge, MapNode, MapRouting, MapSettings } from '@shared/types'
import type { Graph, Sel } from '@shared/diagram/ops'
import { hiddenCount } from '@shared/diagram/ops'
import { SHAPES, SHAPE_CATEGORIES, getShape } from '@shared/diagram/shapes'
import { nodeSize } from '@shared/diagram/geom'
import { THEMES, getTheme, resolveEdgeStyle, resolveNodeStyle } from '@shared/diagram/style'
import { ARROW_HEADS } from '@shared/diagram/arrowheads'
import {
  armedTool,
  BarButton,
  BarColor,
  BarFontSize,
  BarCustom,
  BarDialogButton,
  BarGroup,
  BarMenu,
  BarNumber,
  BarSelect,
  BarSep,
  BarToggle,
  shellPanelDomId,
  SIDE_PANE_DOM_ID,
  railGroup,
  type BarTab,
  type RailItem
} from '../../office/shell'
import type { Commands } from './commands'
import type { Tool } from './DiagramEditor'
import { ARROW_LABEL, ArrowPreview, DASHES, FONTS, common } from './parts'
import FontPicker from '../editor/FontPicker'

// PlexiiDiagrams on the office shell (SPEC §6.1): the ToolRail items and every
// ContextBar tab. Owner ruling D1 removed the right Inspector, so every control
// it had lives in a tab here, keeping its testid. Panels (Library, Layers, the
// data forms, icon search, label editing) are opened by id; the chrome renders
// them as ShellPanels.

export type DiagramDialog = 'data' | 'data-widgets' | 'find' | 'templates' | 'mermaid' | 'shortcuts'
export type DiagramPanel = 'library' | 'layers' | 'icon' | 'label' | 'link' | 'data-fields' | 'binding'
/** Content panes in the shared right ShellSidePane (SPEC §2.5a). */
export type DiagramSidePane = 'ai'

export interface DCtx {
  cmd: Commands
  /** Every shared action as an OfficeCommand (diagramCommands): buttons render from these. */
  cmds: DiagramCommands
  page: Graph
  sel: Sel
  nodes: MapNode[]
  edges: MapEdge[]
  settings: MapSettings
  themeId?: string
  palette: string[]
  readOnly: boolean
  /** One graph, no pages: editing a diagram snippet (a snippet is a single graph). */
  singlePage?: boolean
  zoom: number
  tool: Tool
  setTool: (t: Tool, lock?: boolean) => void
  openDialog: (d: DiagramDialog) => void
  togglePanel: (p: DiagramPanel) => void
  openPanel: (p: DiagramPanel) => void
  isPanelOpen: (p: DiagramPanel) => boolean
  sidePane: DiagramSidePane | null
  toggleSidePane: (p: DiagramSidePane) => void
  setStatus: (msg: string) => void
  pickImage: (replaceNodeId?: string) => void
}

/** Build the per-render context from the editor's state. Pure. */
export function diagramCtx(base: Omit<DCtx, 'nodes' | 'edges' | 'palette' | 'cmds'>): DCtx {
  const nodes = base.page.nodes.filter((n) => base.sel.nodes.has(n.id))
  const edges = base.page.edges.filter((e) => base.sel.edges.has(e.id))
  return {
    ...base,
    nodes,
    edges,
    palette: getTheme(base.themeId).palette,
    cmds: buildDiagramCommands({
      cmd: base.cmd,
      nodes: nodes.length,
      edges: edges.length,
      locked: nodes.some((n) => n.locked) || edges.some((e) => e.locked),
      grouped: nodes.some((n) => n.groupId),
      openFind: () => base.openDialog('find')
    })
  }
}

const ROUTINGS: [MapRouting, string, string][] = [
  ['orthogonal', 'turn_right', 'Right-angle lines'],
  ['curved', 'gesture', 'Curved lines'],
  ['straight', 'horizontal_rule', 'Straight lines']
]
const ALIGNS = [
  ['left', 'align_horizontal_left', 'Align left'],
  ['hcenter', 'align_horizontal_center', 'Align centre'],
  ['right', 'align_horizontal_right', 'Align right'],
  ['top', 'align_vertical_top', 'Align top'],
  ['vcenter', 'align_vertical_center', 'Align middle'],
  ['bottom', 'align_vertical_bottom', 'Align bottom']
] as const
export const QUICK_SHAPES = ['process', 'decision', 'terminator', 'data', 'database', 'circle'] as const
const tableShapeId = (): string => SHAPES.find((s) => s.special === 'table')?.id ?? 'process'
const stickyShapeId = (): string => SHAPES.find((s) => s.special === 'sticky')?.id ?? 'note'

// ── shared clusters ─────────────────────────────────────────────────────────

function LayoutMenu({ c, testid }: { c: DCtx; testid?: string }): JSX.Element {
  const { cmd } = c
  return (
    <BarMenu
      icon="account_tree"
      label="Layout"
      testid={testid}
      items={[
        { label: 'Hierarchy, top to bottom', icon: 'south', run: () => cmd.layout('layered', 'TB'), testid: testid && 'diagram-layout-layered-tb' },
        { label: 'Hierarchy, left to right', icon: 'east', run: () => cmd.layout('layered', 'LR'), testid: testid && 'diagram-layout-layered-lr' },
        { label: 'Hierarchy, bottom to top', icon: 'north', run: () => cmd.layout('layered', 'BT') },
        { label: 'Hierarchy, right to left', icon: 'west', run: () => cmd.layout('layered', 'RL') },
        'sep',
        { label: 'Tree (org chart)', icon: 'account_tree', run: () => cmd.layout('tree', 'TB'), testid: testid && 'diagram-layout-tree' },
        { label: 'Mind map', icon: 'hub', run: () => cmd.layout('mindmap', 'LR'), testid: testid && 'diagram-layout-mindmap' },
        { label: 'Radial', icon: 'radar', run: () => cmd.layout('radial', 'TB') },
        { label: 'Organic', icon: 'bubble_chart', run: () => cmd.layout('organic', 'TB') },
        { label: 'Grid', icon: 'grid_view', run: () => cmd.layout('grid', 'TB') }
      ]}
    />
  )
}

function TidyButton({ c }: { c: DCtx }): JSX.Element {
  return (
    <BarButton
      icon="cleaning_services"
      label="Tidy"
      showLabel
      testid="diagram-tidy"
      disabled={!c.page.edges.length}
      disabledReason="add some lines first"
      onClick={() => c.setStatus(c.cmd.tidyConnections())}
    />
  )
}

function ArrowMenu({ label, value, onChange, testid }: { label: string; value: MapArrowHead | undefined; onChange: (v: MapArrowHead) => void; testid?: string }): JSX.Element {
  return (
    <BarMenu
      label={label}
      testid={testid}
      valueLabel={
        <span className="inline-flex items-center gap-1">
          <span className="text-[10px] text-[var(--ink-50)]">{label}</span>
          {value ? <ArrowPreview kind={value} /> : <span className="text-[11px]">Mixed</span>}
        </span>
      }
      items={ARROW_HEADS.map((k) => ({ label: ARROW_LABEL[k], preview: <ArrowPreview kind={k} />, active: k === value, run: () => onChange(k) }))}
    />
  )
}

function TextFormat({ c, ids }: { c: DCtx; ids: boolean }): JSX.Element {
  const { cmd, nodes } = c
  const res = nodes.map((n) => resolveNodeStyle(n, c.themeId))
  const r = <K extends keyof ReturnType<typeof resolveNodeStyle>>(k: K): ReturnType<typeof resolveNodeStyle>[K] | undefined => common(res, (x) => x[k])
  // The same toggle as ⌘B / ⌘I / ⌘U (commands.toggleTextStyle).
  const toggle = (k: 'bold' | 'italic' | 'underline' | 'strike'): void => cmd.toggleTextStyle(k)
  return (
    <BarGroup label="Text">
      <BarCustom label="Font" semantic="font-family">
        <FontPicker value={r('fontFamily') ?? ''} mixed={r('fontFamily') === undefined} extra={FONTS} allowDefault={false} compact onChange={(v) => v && cmd.setStyle({ fontFamily: v })} testid={ids ? 'diagram-font' : undefined} />
      </BarCustom>
      <BarFontSize value={r('fontSize')} min={6} max={200} suffix="pt" onChange={(v) => cmd.setStyle({ fontSize: v })} testid={ids ? 'diagram-font-size' : undefined} width={44} />
      <BarToggle {...barProps(c.cmds.bold)} semantic="bold" pressed={cmd.textStyleOn('bold')} onChange={c.cmds.bold.run} testid={ids ? 'diagram-bold' : undefined} />
      <BarToggle {...barProps(c.cmds.italic)} semantic="italic" pressed={cmd.textStyleOn('italic')} onChange={c.cmds.italic.run} />
      <BarToggle {...barProps(c.cmds.underline)} semantic="underline" pressed={cmd.textStyleOn('underline')} onChange={c.cmds.underline.run} />
      {ids && <BarToggle icon="strikethrough_s" label="Strikethrough" pressed={cmd.textStyleOn('strike')} onChange={() => toggle('strike')} />}
      <BarColor icon="format_color_text" semantic="text-color" label="Text colour" value={common(nodes, (n) => n.style?.textColor)} palette={c.palette} onChange={(v) => cmd.setStyle({ textColor: v })} testid={ids ? 'diagram-text-color' : undefined} />
      <BarSep />
      <BarToggle icon="format_align_left" semantic="align-left" label="Align left" pressed={r('textAlign') === 'left'} onChange={() => cmd.setStyle({ textAlign: 'left' })} />
      <BarToggle icon="format_align_center" semantic="align-center" label="Align centre" pressed={r('textAlign') === 'center'} onChange={() => cmd.setStyle({ textAlign: 'center' })} />
      <BarToggle icon="format_align_right" semantic="align-right" label="Align right" pressed={r('textAlign') === 'right'} onChange={() => cmd.setStyle({ textAlign: 'right' })} />
      {ids && (
        <>
          <BarToggle icon="vertical_align_top" label="Text at the top" pressed={r('vAlign') === 'top'} onChange={() => cmd.setStyle({ vAlign: 'top' })} />
          <BarToggle icon="vertical_align_center" label="Text in the middle" pressed={r('vAlign') === 'middle'} onChange={() => cmd.setStyle({ vAlign: 'middle' })} />
          <BarToggle icon="vertical_align_bottom" label="Text at the bottom" pressed={r('vAlign') === 'bottom'} onChange={() => cmd.setStyle({ vAlign: 'bottom' })} />
        </>
      )}
    </BarGroup>
  )
}

function Routing({ c, ids }: { c: DCtx; ids: boolean }): JSX.Element {
  const routing = common(c.edges, (e) => e.routing ?? c.settings.defaultRouting ?? 'orthogonal')
  return (
    <BarGroup label="Line routing">
      {ROUTINGS.map(([r, icon, label]) => (
        <BarToggle key={r} icon={icon} label={label} pressed={routing === r} onChange={() => c.cmd.setEdges({ routing: r, waypoints: undefined })} testid={ids ? `diagram-routing-${r}` : undefined} />
      ))}
    </BarGroup>
  )
}

function AlignTools({ c, ids }: { c: DCtx; ids: boolean }): JSX.Element {
  const n = c.nodes.length
  return (
    <BarGroup label="Align and distribute" testid={ids ? 'map-align-tools' : undefined}>
      {ALIGNS.map(([edge, icon, label]) => (
        <BarButton key={edge} icon={icon} label={label} disabled={n < 2} disabledReason="select two or more shapes" onClick={() => c.cmd.align(edge)} testid={ids ? `map-align-${edge}` : undefined} />
      ))}
      <BarButton icon="horizontal_distribute" label="Distribute horizontally" disabled={n < 3} disabledReason="select three or more shapes" onClick={() => c.cmd.distribute('h')} testid={ids ? 'map-distribute-h' : undefined} />
      <BarButton icon="vertical_distribute" label="Distribute vertically" disabled={n < 3} disabledReason="select three or more shapes" onClick={() => c.cmd.distribute('v')} testid={ids ? 'map-distribute-v' : undefined} />
    </BarGroup>
  )
}

// ── tabs ────────────────────────────────────────────────────────────────────

const homeTab: BarTab<DCtx> = {
  id: 'home',
  label: 'Home',
  role: 'home',
  render: (c) => {
    const { cmd, nodes, edges } = c
    const first = nodes[0]
    const fs = first ? resolveNodeStyle(first, c.themeId) : null
    return (
      <>
        {nodes.length > 0 && (
          <>
            <TextFormat c={c} ids={false} />
            <BarButton icon="format_size" label="Larger text" onClick={() => cmd.setStyle({ fontSize: Math.min(200, (fs?.fontSize ?? 12) + 2) })} />
            <BarSep />
            <BarColor icon="format_color_fill" label="Fill" value={common(nodes, (n) => n.style?.fill)} allowNone palette={c.palette} onChange={(v) => cmd.setStyle({ fill: v })} testid="diagram-toolbar-fill" />
            <BarColor icon="palette" label="Shape colour" value={common(nodes, (n) => n.color)} palette={c.palette} onChange={(v) => v && cmd.setNodes({ color: v })} testid="diagram-toolbar-color" />
            <BarSep />
          </>
        )}
        {edges.length > 0 && (
          <>
            <Routing c={c} ids={false} />
            <BarColor icon="border_color" label="Line colour" value={common(edges, (e) => e.stroke)} palette={c.palette} onChange={(v) => cmd.setEdges({ stroke: v })} />
            <BarSep />
          </>
        )}
        {!nodes.length && !edges.length && <span className="shrink-0 px-1.5 text-[11px] text-[var(--ink-50)]">Select a shape or line to format it</span>}
        <BarButton {...barProps(c.cmds.bringToFront)} onClick={c.cmds.bringToFront.run} />
        <BarButton {...barProps(c.cmds.sendToBack)} onClick={c.cmds.sendToBack.run} />
        <BarButton {...barProps(c.cmds.group)} onClick={c.cmds.group.run} />
        <BarMenu
          icon="align_horizontal_left"
          label="Align and distribute"
          showLabel={false}
          testid="diagram-align-menu"
          items={[...ALIGNS.map(([e, icon, label]) => ({ label, icon, run: () => cmd.align(e) })), 'sep', { label: 'Distribute horizontally', icon: 'horizontal_distribute', run: () => cmd.distribute('h') }, { label: 'Distribute vertically', icon: 'vertical_distribute', run: () => cmd.distribute('v') }]}
        />
        <BarSep />
        <TidyButton c={c} />
        <LayoutMenu c={c} testid="map-arrange" />
      </>
    )
  }
}

const insertTab: BarTab<DCtx> = {
  id: 'insert',
  label: 'Insert',
  role: 'insert',
  render: (c) => {
    const { cmd } = c
    return (
      <>
        <BarMenu
          icon="category"
          label="Shapes"
          testid="diagram-insert-shapes"
          items={[
            ...QUICK_SHAPES.map((id) => ({ label: getShape(id).label, run: () => void cmd.addShape(id) })),
            'sep',
            { label: 'All shapes, icons and images…', icon: 'category', run: () => c.openPanel('library') }
          ]}
        />
        <BarButton icon="title" label="Text" showLabel shortcut="T" onClick={() => c.setTool('text')} testid="diagram-insert-text" />
        <BarButton icon="grid_on" label="Table" showLabel onClick={() => void cmd.addShape(tableShapeId())} testid="diagram-insert-table" />
        <BarButton icon="sticky_note_2" label="Sticky note" showLabel onClick={() => void cmd.addShape(stickyShapeId())} testid="diagram-insert-sticky" />
        <BarButton icon="view_column" label="Swimlane" showLabel onClick={() => void cmd.addShape('lane')} testid="diagram-insert-lane" />
        <BarButton icon="image" label="Image" showLabel onClick={() => c.pickImage()} testid="diagram-insert-image" />
        <BarSep />
        <BarDialogButton icon="dashboard" label="Template" onOpen={() => c.openDialog('templates')} testid="diagram-templates" />
        <BarDialogButton icon="database" label="From a Plexii table" onOpen={() => c.openDialog('data')} testid="diagram-data" />
        <BarDialogButton icon="widgets" label="Work widget" onOpen={() => c.openDialog('data-widgets')} testid="diagram-insert-widget" />
        <BarDialogButton icon="code" label="Mermaid" onOpen={() => c.openDialog('mermaid')} testid="diagram-insert-mermaid" />
        <BarButton icon="auto_awesome" label="AI diagram" onClick={() => c.sidePane !== 'ai' && c.toggleSidePane('ai')} controls={SIDE_PANE_DOM_ID} testid="diagram-insert-ai" />
        {!c.singlePage && (
          <>
            <BarSep />
            <BarButton icon="note_add" label="New page" showLabel onClick={cmd.addPage} testid="diagram-insert-page" />
          </>
        )}
      </>
    )
  }
}

const arrangeTab: BarTab<DCtx> = {
  id: 'arrange',
  label: 'Arrange',
  role: 'arrange',
  render: (c) => {
    const { cmd, nodes } = c
    const one = nodes.length === 1 ? nodes[0]! : null
    const size = one ? nodeSize(one) : null
    const locked = common(nodes, (n) => !!n.locked)
    const hidden = hiddenCount(c.page)
    return (
      <>
        {one && size && (
          <>
            <BarGroup label="Position and size">
              <BarNumber label="X" value={one.x} onChange={(v) => cmd.setGeometry(one.id, { x: Math.round(v) })} testid="diagram-x" width={50} />
              <BarNumber label="Y" value={one.y} onChange={(v) => cmd.setGeometry(one.id, { y: Math.round(v) })} testid="diagram-y" width={50} />
              <BarNumber label="Width" value={size.w} min={8} onChange={(v) => cmd.setGeometry(one.id, { width: Math.max(8, Math.round(v)) })} testid="diagram-w" width={50} />
              <BarNumber label="Height" value={size.h} min={8} onChange={(v) => cmd.setGeometry(one.id, { height: Math.max(8, Math.round(v)) })} testid="diagram-h" width={50} />
              <BarNumber label="Rotation" value={one.rotation ?? 0} suffix="°" onChange={(v) => cmd.setGeometry(one.id, { rotation: ((Math.round(v) % 360) + 360) % 360 || undefined })} testid="diagram-rotation" width={44} />
            </BarGroup>
            <BarSep />
          </>
        )}
        <BarButton icon="rotate_left" label="Rotate 90° left" disabled={!nodes.length} onClick={() => cmd.rotate(-90)} />
        <BarButton icon="rotate_right" label="Rotate 90° right" disabled={!nodes.length} onClick={() => cmd.rotate(90)} />
        <BarButton icon="flip" label="Flip horizontally" disabled={!nodes.length} onClick={() => cmd.flip('x')} />
        <BarButton icon="swap_vert" label="Flip vertically" disabled={!nodes.length} onClick={() => cmd.flip('y')} />
        <BarSep />
        <BarButton {...barProps(c.cmds.bringToFront)} onClick={c.cmds.bringToFront.run} testid="diagram-front" />
        <BarButton {...barProps(c.cmds.bringForward)} onClick={c.cmds.bringForward.run} />
        <BarButton {...barProps(c.cmds.sendBackward)} onClick={c.cmds.sendBackward.run} />
        <BarButton {...barProps(c.cmds.sendToBack)} onClick={c.cmds.sendToBack.run} testid="diagram-back" />
        <BarSep />
        <BarButton {...barProps(c.cmds.group)} onClick={c.cmds.group.run} testid="diagram-group" />
        <BarButton {...barProps(c.cmds.ungroup)} onClick={c.cmds.ungroup.run} />
        <BarToggle {...barProps(c.cmds.lock)} pressed={!!locked} onChange={c.cmds.lock.run} testid="diagram-lock" />
        <BarButton {...barProps(c.cmds.hide)} onClick={c.cmds.hide.run} testid="diagram-hide" />
        <BarButton icon="visibility" label={hidden ? `Show all hidden (${hidden})` : 'Show all hidden'} showLabel={hidden > 0} disabled={!hidden} disabledReason="nothing is hidden" onClick={cmd.showAllHidden} testid="diagram-show-all-hidden" />
        <BarSep />
        <AlignTools c={c} ids />
        <BarMenu
          icon="width"
          label="Match size"
          showLabel={false}
          disabled={nodes.length < 2}
          disabledReason="select two or more shapes"
          items={[
            { label: 'Same width', run: () => cmd.matchSize('width') },
            { label: 'Same height', run: () => cmd.matchSize('height') },
            { label: 'Same size', run: () => cmd.matchSize('both') }
          ]}
        />
        <BarSep />
        <TidyButton c={c} />
        <LayoutMenu c={c} />
      </>
    )
  }
}

const designTab: BarTab<DCtx> = {
  id: 'design',
  label: 'Design',
  role: 'app',
  render: (c) => {
    const { cmd, settings } = c
    const theme = getTheme(settings.theme)
    return (
      <>
        <BarMenu
          icon="palette"
          label="Theme"
          testid="diagram-theme-section"
          valueLabel={<span className="text-[12px]">Theme: {theme.name}</span>}
          items={THEMES.map((t) => ({ label: t.name, active: theme.id === t.id, testid: `diagram-theme-${t.id}`, run: () => cmd.setSettings({ theme: t.id === 'plexii' ? undefined : t.id }) }))}
        />
        <BarButton icon="format_paint" label="Apply theme to every shape" showLabel onClick={() => cmd.applyThemeToAll(theme.id)} />
        <BarSep />
        <BarColor icon="wallpaper" label="Background" value={settings.background} allowNone palette={theme.palette} onChange={(v) => cmd.setSettings({ background: v })} testid="diagram-bg" />
        <BarToggle icon="grid_on" label="Show grid" pressed={settings.grid !== false} onChange={(v) => cmd.setSettings({ grid: v ? undefined : false })} testid="diagram-grid" readOnlySafe />
        <BarNumber label="Grid size" value={settings.gridSize ?? 16} min={4} max={100} suffix="px" onChange={(v) => cmd.setSettings({ gridSize: v === 16 ? undefined : v })} width={40} />
        <BarToggle icon="grid_goldenratio" label="Snap to grid" pressed={settings.snap !== false} onChange={(v) => cmd.setSettings({ snap: v ? undefined : false })} testid="diagram-snap" />
        <BarToggle icon="straighten" label="Smart alignment guides" pressed={settings.guides !== false} onChange={(v) => cmd.setSettings({ guides: v ? undefined : false })} testid="diagram-guides" />
        <BarToggle icon="map" label="Minimap" pressed={settings.minimap !== false} onChange={(v) => cmd.setSettings({ minimap: v ? undefined : false })} testid="diagram-minimap" readOnlySafe />
        <BarSep />
        <BarSelect<MapRouting>
          label="New lines"
          value={settings.defaultRouting ?? 'orthogonal'}
          options={[
            { value: 'orthogonal', label: 'Right-angle' },
            { value: 'curved', label: 'Curved' },
            { value: 'straight', label: 'Straight' }
          ]}
          onChange={(v) => cmd.setSettings({ defaultRouting: v === 'orthogonal' ? undefined : v })}
          testid="diagram-default-routing"
          width={100}
        />
        <ArrowMenu label="Arrow" value={settings.defaultEndArrow ?? 'arrow'} onChange={(v) => cmd.setSettings({ defaultEndArrow: v === 'arrow' ? undefined : v })} testid="diagram-default-arrow" />
        <BarToggle icon="u_turn_right" label="Line jumps where lines cross" pressed={!!settings.lineJumps} onChange={(v) => cmd.setSettings({ lineJumps: v || undefined })} testid="diagram-line-jumps" />
        <BarSep />
        <span className="shrink-0 px-1 text-[11px] text-[var(--ink-50)]" data-testid="diagram-page-stats">
          {c.page.nodes.length} shape{c.page.nodes.length === 1 ? '' : 's'} · {c.page.edges.length} line{c.page.edges.length === 1 ? '' : 's'}
          {c.page.nodes.some((n) => n.binding) ? ` · ${c.page.nodes.filter((n) => n.binding).length} linked to data` : ''}
        </span>
      </>
    )
  }
}

const viewTab: BarTab<DCtx> = {
  id: 'view',
  label: 'View',
  role: 'view',
  render: (c) => {
    return (
      <>
        <BarButton {...barProps(c.cmds.fit)} showLabel onClick={c.cmds.fit.run} readOnlySafe />
        <BarButton {...barProps(c.cmds.zoomToSelection)} onClick={c.cmds.zoomToSelection.run} readOnlySafe />
        <BarButton {...barProps(c.cmds.actualSize)} onClick={c.cmds.actualSize.run} readOnlySafe />
        <BarSep />
        <BarToggle icon="category" label="Shape library" pressed={c.isPanelOpen('library')} onChange={() => c.togglePanel('library')} readOnlySafe testid="diagram-view-library" controls={shellPanelDomId('library')} />
        <BarToggle icon="layers" label="Layers" pressed={c.isPanelOpen('layers')} onChange={() => c.togglePanel('layers')} readOnlySafe testid="diagram-view-layers" controls={shellPanelDomId('layers')} />
        <BarButton icon="keyboard" label="Keyboard shortcuts" shortcut="?" onClick={() => c.openDialog('shortcuts')} readOnlySafe />
      </>
    )
  }
}

// Contextual tabs (SPEC §2.3): appear with the selection, never steal focus.

const shapeTab: BarTab<DCtx> = {
  id: 'shape',
  label: 'Shape',
  contextual: true,
  when: (c) => c.nodes.length > 0,
  render: (c) => {
    const { cmd, nodes } = c
    const res = nodes.map((n) => resolveNodeStyle(n, c.themeId))
    const st = <K extends 'fill' | 'stroke' | 'radius'>(k: K) => common(nodes, (n) => n.style?.[k])
    const one = nodes.length === 1 ? nodes[0]! : null
    const def = one ? getShape(one.shape) : null
    const shapeId = common(nodes, (n) => n.shape)
    return (
      <>
        <BarCustom label="Shape type">
          <select
            aria-label="Shape type"
            value={shapeId ?? ''}
            onChange={(e) => cmd.setNodes({ shape: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={c.readOnly}
            className="fb-field h-6 px-1 text-[12px] w-[130px]"
            data-testid="diagram-change-shape"
          >
            {shapeId === undefined && <option value="">Mixed</option>}
            {SHAPE_CATEGORIES.map((cat) => (
              <optgroup key={cat} label={cat}>
                {SHAPES.filter((s) => s.category === cat).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </BarCustom>
        <BarColor icon="palette" label="Shape colour (tints fill and line)" value={common(nodes, (n) => n.color)} palette={c.palette} onChange={(v) => v && cmd.setNodes({ color: v })} testid="diagram-color" />
        <BarSep />
        <BarColor icon="format_color_fill" label="Fill" value={st('fill')} allowNone palette={c.palette} onChange={(v) => cmd.setStyle({ fill: v })} testid="diagram-fill" />
        <BarNumber label="Fill opacity" value={Math.round((common(res, (r) => r.fillOpacity) ?? 1) * 100)} min={0} max={100} step={5} suffix="%" onChange={(v) => cmd.setStyle({ fillOpacity: v / 100 }, 'fillOpacity')} width={40} />
        <BarColor icon="border_color" label="Line" value={st('stroke')} allowNone palette={c.palette} onChange={(v) => cmd.setStyle({ stroke: v })} testid="diagram-stroke" />
        <BarNumber label="Line width" value={common(res, (r) => r.strokeWidth)} min={0} max={20} step={0.5} suffix="px" onChange={(v) => cmd.setStyle({ strokeWidth: v })} testid="diagram-stroke-width" width={40} />
        <BarSelect label="Line style" value={common(res, (r) => r.strokeDash) ?? 'solid'} options={DASHES} onChange={(v) => cmd.setStyle({ strokeDash: v })} testid="diagram-stroke-dash" width={84} />
        <BarSep />
        <BarNumber label="Corners" value={st('radius')} min={0} max={200} suffix="px" onChange={(v) => cmd.setStyle({ radius: v })} width={40} />
        <BarNumber label="Opacity" value={Math.round((common(res, (r) => r.opacity) ?? 1) * 100)} min={10} max={100} step={5} suffix="%" onChange={(v) => cmd.setStyle({ opacity: v / 100 }, 'opacity')} width={40} />
        <BarToggle icon="shadow" label="Drop shadow" pressed={!!common(res, (r) => r.shadow)} onChange={(v) => cmd.setStyle({ shadow: v || undefined })} testid="diagram-shadow" />
        <BarSep />
        <BarButton {...barProps(c.cmds.copyStyle)} onClick={c.cmds.copyStyle.run} />
        <BarButton {...barProps(c.cmds.pasteStyle)} onClick={c.cmds.pasteStyle.run} />
        <BarButton icon="format_clear" label="Reset style" onClick={() => cmd.setNodes({ style: undefined })} />
        <BarSep />
        <BarDialogButton icon="emoji_symbols" label="Icon" onOpen={() => c.openPanel('icon')} testid="diagram-shape-icon" />
        {def?.special === 'image' && one && <BarButton icon="image" label="Replace image" showLabel onClick={() => c.pickImage(one.id)} testid="diagram-replace-image" />}
        {def?.special === 'table' && one && <TableSize c={c} node={one} />}
      </>
    )
  }
}

function TableSize({ c, node }: { c: DCtx; node: MapNode }): JSX.Element {
  const m = /(\d+)x(\d+)/.exec(node.shape)
  const rows = node.cells?.length ?? (m ? Number(m[2]) : 3)
  const cols = node.cells ? Math.max(...node.cells.map((r) => r.length)) : m ? Number(m[1]) : 3
  const resize = (r: number, k: number): void => {
    const cells = Array.from({ length: r }, (_, i) => Array.from({ length: k }, (_, j) => node.cells?.[i]?.[j] ?? ''))
    c.cmd.setNode(node.id, { cells })
  }
  return (
    <BarGroup label="Table size">
      <BarNumber label="Rows" value={rows} min={1} max={60} onChange={(v) => resize(Math.round(v), cols)} testid="diagram-table-rows" width={36} />
      <BarNumber label="Columns" value={cols} min={1} max={20} onChange={(v) => resize(rows, Math.round(v))} testid="diagram-table-cols" width={36} />
    </BarGroup>
  )
}

const textTab: BarTab<DCtx> = {
  id: 'text',
  label: 'Text',
  contextual: true,
  when: (c) => c.nodes.length > 0,
  render: (c) => (
    <>
      <TextFormat c={c} ids />
      {c.nodes.length === 1 && (
        <>
          <BarSep />
          <BarDialogButton icon="edit_note" label="Edit label" onOpen={() => c.openPanel('label')} testid="diagram-edit-label" />
        </>
      )}
    </>
  )
}

const lineTab: BarTab<DCtx> = {
  id: 'line',
  label: 'Line',
  contextual: true,
  when: (c) => c.edges.length > 0,
  render: (c) => {
    const { cmd, edges } = c
    const res = edges.map((e) => resolveEdgeStyle(e, c.themeId))
    const one = edges.length === 1 ? edges[0]! : null
    return (
      <>
        <Routing c={c} ids />
        <BarSep />
        <BarColor icon="border_color" label="Line colour" value={common(edges, (e) => e.stroke)} palette={c.palette} onChange={(v) => cmd.setEdges({ stroke: v })} testid="diagram-line-color" />
        <BarNumber label="Line width" value={common(res, (r) => r.strokeWidth)} min={0.5} max={20} step={0.5} suffix="px" onChange={(v) => cmd.setEdges({ strokeWidth: v })} testid="diagram-line-width" width={40} />
        <BarSelect label="Pattern" value={common(res, (r) => r.dash) ?? 'solid'} options={DASHES.filter((d) => d.value !== 'none')} onChange={(v) => cmd.setEdges({ dash: v, style: undefined })} testid="diagram-line-dash" width={84} />
        <ArrowMenu label="Start" value={common(res, (r) => r.startArrow)} onChange={(v) => cmd.setEdges({ startArrow: v })} testid="diagram-start-arrow" />
        <ArrowMenu label="End" value={common(res, (r) => r.endArrow)} onChange={(v) => cmd.setEdges({ endArrow: v })} testid="diagram-end-arrow" />
        <BarButton icon="swap_horiz" label="Swap arrows" disabled={!one} disabledReason="select one line" onClick={() => one && cmd.setEdges({ startArrow: one.endArrow ?? 'arrow', endArrow: one.startArrow ?? 'none' })} />
        <BarSep />
        {one && (
          <BarCustom label="Line label">
            <input
              aria-label="Line label"
              value={one.label ?? ''}
              onChange={(e) => cmd.setEdges({ label: e.target.value || undefined }, `elabel:${one.id}`)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Line label"
              disabled={c.readOnly}
              className="fb-field h-6 px-1.5 text-[12px] w-[140px]"
              data-testid="diagram-edge-label-field"
            />
          </BarCustom>
        )}
        <BarNumber label="Label size" value={common(res, (r) => r.fontSize)} min={6} max={72} suffix="pt" onChange={(v) => cmd.setEdges({ fontSize: v })} width={40} />
        <BarColor icon="format_color_text" label="Label colour" value={common(edges, (e) => e.textColor)} palette={c.palette} onChange={(v) => cmd.setEdges({ textColor: v })} />
        <BarToggle icon="animation" label="Animated flow" pressed={!!common(edges, (e) => !!e.animated)} onChange={(v) => cmd.setEdges({ animated: v || undefined })} testid="diagram-line-animated" />
        <BarSep />
        <BarButton icon="restart_alt" label="Reset route" showLabel onClick={() => cmd.setEdges({ waypoints: undefined, sourceHandle: undefined, targetHandle: undefined })} testid="diagram-reset-line" />
        <BarToggle icon={common(edges, (e) => !!e.locked) ? 'lock' : 'lock_open'} label="Lock line" pressed={!!common(edges, (e) => !!e.locked)} onChange={cmd.toggleLock} />
      </>
    )
  }
}

const dataTab: BarTab<DCtx> = {
  id: 'data',
  label: 'Data',
  contextual: true,
  when: (c) => c.nodes.length === 1,
  render: (c) => {
    const one = c.nodes[0]!
    const linked = !!one.binding
    return (
      <>
        <BarDialogButton icon="link" label="Link and notes" onOpen={() => c.openPanel('link')} testid="diagram-open-link" />
        <BarDialogButton icon="data_object" label={`Custom data${one.data ? ` (${Object.keys(one.data).length})` : ''}`} onOpen={() => c.openPanel('data-fields')} testid="diagram-open-data" />
        <BarDialogButton icon="table_chart" label={linked ? 'Data source (linked)' : 'Data source'} onOpen={() => c.openPanel('binding')} testid="diagram-open-binding" />
      </>
    )
  }
}

/** Every ContextBar tab, in the SPEC §3.5 order (common tabs, then contextual). */
export const DIAGRAM_TABS: BarTab<DCtx>[] = [homeTab, insertTab, arrangeTab, designTab, viewTab, shapeTab, textTab, lineTab, dataTab]

// ── rail ────────────────────────────────────────────────────────────────────

const SHAPE_TOOLS: { id: string; key?: string }[] = [
  { id: 'process', key: 'M' },
  { id: 'decision' },
  { id: 'terminator' },
  { id: 'data' },
  { id: 'database' },
  { id: 'circle', key: 'L' }
]

/** The ToolRail items (SPEC §3.1 order). Armed shapes use new `-tool-` ids (§4.1). */
export function diagramRailItems(): RailItem<DCtx>[] {
  return [
    { id: 'select', label: 'Select', icon: 'arrow_selector_tool', kind: 'tool', role: 'select', group: railGroup('select'), order: 0, shortcut: 'V', readOnlySafe: true, testid: 'diagram-tool-select', onSelect: (c) => c.setTool('select') },
    { id: 'pan', label: 'Hand (or hold Space, or drag with the middle button)', icon: 'pan_tool', kind: 'tool', role: 'hand', group: railGroup('hand'), order: 1, shortcut: 'H', readOnlySafe: true, testid: 'diagram-tool-pan', onSelect: (c) => c.setTool('pan') },
    armedTool<DCtx>({ id: 'text', label: 'Text: click the canvas to type', icon: 'title', role: 'text', order: 0, shortcut: 'T', testid: 'diagram-tool-text', arm: (c, lock) => c.setTool('text', lock) }),
    ...SHAPE_TOOLS.map(({ id, key }, i): RailItem<DCtx> =>
      armedTool<DCtx>({
        id: `shape:${id}`,
        label: `${getShape(id).label}: click to place, drag to size`,
        icon: SHAPE_ICON[id] ?? 'crop_square',
        role: 'shape',
        order: 1 + i,
        flyout: 'shapes',
        shortcut: key,
        testid: `diagram-tool-${id}`,
        arm: (c, lock) => c.setTool(`shape:${id}`, lock)
      })
    ),
    // Inserts, Image first (SPEC §3.1).
    { id: 'image', label: 'Image', icon: 'image', kind: 'action', role: 'image', group: railGroup('image'), order: 0, testid: 'diagram-rail-image', onSelect: (c) => c.pickImage() },
    { id: 'table', label: 'Table', icon: 'grid_on', kind: 'action', role: 'insert', group: railGroup('insert'), order: 1, testid: 'diagram-rail-table', onSelect: (c) => void c.cmd.addShape(tableShapeId()) },
    { id: 'sticky', label: 'Sticky note', icon: 'sticky_note_2', kind: 'action', role: 'insert', group: railGroup('insert'), order: 2, testid: 'diagram-rail-sticky', onSelect: (c) => void c.cmd.addShape(stickyShapeId()) },
    { id: 'library', label: 'Shape library (shapes, icons, images)', icon: 'category', kind: 'panel', role: 'panel', group: railGroup('panel'), order: 0, pinned: 'bottom', readOnlySafe: true, testid: 'diagram-toggle-library', onSelect: (c) => c.togglePanel('library') },
    { id: 'layers', label: 'Layers', icon: 'layers', kind: 'panel', role: 'panel', group: railGroup('panel'), order: 1, pinned: 'bottom', readOnlySafe: true, testid: 'diagram-rail-layers', onSelect: (c) => c.togglePanel('layers') },
    { id: 'ai', label: 'Generate a diagram with AI', icon: 'auto_awesome', kind: 'panel', role: 'ai', sidePane: true, group: railGroup('ai'), order: 2, pinned: 'bottom', testid: 'map-ai', onSelect: (c) => c.toggleSidePane('ai') }
  ]
}

const SHAPE_ICON: Record<string, string> = {
  process: 'crop_square',
  decision: 'diamond',
  terminator: 'rounded_corner',
  data: 'input',
  database: 'database',
  circle: 'circle'
}
