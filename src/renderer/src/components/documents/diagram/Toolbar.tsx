import { useState } from 'react'
import type { MapNode, MapEdge } from '@shared/types'
import { getTheme, resolveNodeStyle } from '@shared/diagram/style'
import type { Graph, Sel } from '@shared/diagram/ops'
import type { Commands } from './commands'
import type { Tool } from './DiagramEditor'
import { ColorField, IconBtn, MenuButton, Sep } from './ui'

// The quick-access toolbar under the menu bar. Shape formatting controls apply
// to the selection; everything else is always available.

export function Toolbar({
  cmd,
  page,
  sel,
  tool,
  setTool,
  zoom,
  canUndo,
  canRedo,
  themeId,
  readOnly,
  onOpen,
  status
}: {
  cmd: Commands
  page: Graph
  sel: Sel
  tool: Tool
  setTool: (t: Tool) => void
  zoom: number
  canUndo: boolean
  canRedo: boolean
  themeId?: string
  readOnly: boolean
  onOpen: (dialog: 'ai' | 'data' | 'find' | 'templates' | 'mermaid') => void
  status: (msg: string) => void
}): JSX.Element {
  const nodes: MapNode[] = page.nodes.filter((n) => sel.nodes.has(n.id))
  const edges: MapEdge[] = page.edges.filter((e) => sel.edges.has(e.id))
  const first = nodes[0]
  const fs = first ? resolveNodeStyle(first, themeId) : null
  const palette = getTheme(themeId).palette
  const [zoomOpen, setZoomOpen] = useState(false)
  const hasSel = nodes.length > 0

  return (
    <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_55%,transparent)] overflow-x-auto" data-testid="diagram-toolbar">
      <IconBtn icon="undo" title="Undo (⌘Z)" onClick={cmd.undo} disabled={!canUndo || readOnly} testid="diagram-undo" />
      <IconBtn icon="redo" title="Redo (⇧⌘Z)" onClick={cmd.redo} disabled={!canRedo || readOnly} testid="diagram-redo" />
      <Sep />
      <IconBtn icon="arrow_selector_tool" title="Select (V)" active={tool === 'select'} onClick={() => setTool('select')} testid="diagram-tool-select" />
      <IconBtn icon="pan_tool" title="Pan (H) — or hold Space / drag with the middle button" active={tool === 'pan'} onClick={() => setTool('pan')} testid="diagram-tool-pan" />
      <IconBtn icon="title" title="Text (T) — click the canvas to type" active={tool === 'text'} onClick={() => setTool('text')} disabled={readOnly} testid="diagram-tool-text" />
      <Sep />
      <IconBtn icon="format_bold" title="Bold (⌘B)" disabled={!hasSel} active={!!fs?.bold} onClick={() => cmd.setStyle({ bold: fs?.bold ? undefined : true })} />
      <IconBtn icon="format_italic" title="Italic (⌘I)" disabled={!hasSel} active={!!fs?.italic} onClick={() => cmd.setStyle({ italic: fs?.italic ? undefined : true })} />
      <IconBtn icon="format_size" title="Larger text" disabled={!hasSel} onClick={() => cmd.setStyle({ fontSize: Math.min(200, (fs?.fontSize ?? 12) + 2) })} />
      <span className={hasSel ? '' : 'opacity-35 pointer-events-none'}>
        <ColorField value={first?.style?.fill} onChange={(v) => cmd.setStyle({ fill: v })} palette={palette} allowNone title="Fill" testid="diagram-toolbar-fill" />
      </span>
      <span className={hasSel ? '' : 'opacity-35 pointer-events-none'}>
        <ColorField value={first?.color} onChange={(v) => v && cmd.setNodes({ color: v })} palette={palette} title="Shape colour" testid="diagram-toolbar-color" />
      </span>
      {edges.length > 0 && (
        <>
          <Sep />
          <IconBtn icon="turn_right" title="Right-angle lines" onClick={() => cmd.setEdges({ routing: 'orthogonal', waypoints: undefined })} />
          <IconBtn icon="gesture" title="Curved lines" onClick={() => cmd.setEdges({ routing: 'curved', waypoints: undefined })} />
          <IconBtn icon="horizontal_rule" title="Straight lines" onClick={() => cmd.setEdges({ routing: 'straight', waypoints: undefined })} />
        </>
      )}
      <Sep />
      <IconBtn icon="flip_to_front" title="Bring to front (⇧⌘])" disabled={!hasSel} onClick={() => cmd.order('front')} />
      <IconBtn icon="flip_to_back" title="Send to back (⇧⌘[)" disabled={!hasSel} onClick={() => cmd.order('back')} />
      <IconBtn icon="link" title="Group (⌘G)" disabled={nodes.length < 2} onClick={cmd.group} />
      <MenuButton
        icon="align_horizontal_left"
        title="Align and distribute"
        testid="diagram-align-menu"
        items={[
          { label: 'Align left', icon: 'align_horizontal_left', run: () => cmd.align('left') },
          { label: 'Align centre', icon: 'align_horizontal_center', run: () => cmd.align('hcenter') },
          { label: 'Align right', icon: 'align_horizontal_right', run: () => cmd.align('right') },
          { label: 'Align top', icon: 'align_vertical_top', run: () => cmd.align('top') },
          { label: 'Align middle', icon: 'align_vertical_center', run: () => cmd.align('vcenter') },
          { label: 'Align bottom', icon: 'align_vertical_bottom', run: () => cmd.align('bottom') },
          'sep',
          { label: 'Distribute horizontally', icon: 'horizontal_distribute', run: () => cmd.distribute('h') },
          { label: 'Distribute vertically', icon: 'vertical_distribute', run: () => cmd.distribute('v') }
        ]}
      />
      <Sep />
      <IconBtn
        icon="cleaning_services"
        label="Tidy"
        title="Tidy connections: reroute lines around shapes, spread shared connection points, straighten near-aligned links, fix overlaps (selection, or the whole page)"
        disabled={readOnly || !page.edges.length}
        onClick={() => status(cmd.tidyConnections())}
        testid="diagram-tidy"
      />
      <MenuButton
        icon="account_tree"
        label="Layout"
        title="Automatic layout (selection, or the whole page)"
        testid="map-arrange"
        items={[
          { label: 'Hierarchy, top to bottom', icon: 'south', run: () => cmd.layout('layered', 'TB'), testid: 'diagram-layout-layered-tb' },
          { label: 'Hierarchy, left to right', icon: 'east', run: () => cmd.layout('layered', 'LR'), testid: 'diagram-layout-layered-lr' },
          { label: 'Hierarchy, bottom to top', icon: 'north', run: () => cmd.layout('layered', 'BT') },
          { label: 'Hierarchy, right to left', icon: 'west', run: () => cmd.layout('layered', 'RL') },
          'sep',
          { label: 'Tree (org chart)', icon: 'account_tree', run: () => cmd.layout('tree', 'TB'), testid: 'diagram-layout-tree' },
          { label: 'Mind map', icon: 'hub', run: () => cmd.layout('mindmap', 'LR'), testid: 'diagram-layout-mindmap' },
          { label: 'Radial', icon: 'radar', run: () => cmd.layout('radial', 'TB') },
          { label: 'Organic', icon: 'bubble_chart', run: () => cmd.layout('organic', 'TB') },
          { label: 'Grid', icon: 'grid_view', run: () => cmd.layout('grid', 'TB') }
        ]}
      />
      <Sep />
      <IconBtn icon="dashboard" label="Templates" title="Start from a template" onClick={() => onOpen('templates')} disabled={readOnly} testid="diagram-templates" />
      <IconBtn icon="database" label="Data" title="Build from Plexii tables, work widgets, apps and tools" onClick={() => onOpen('data')} disabled={readOnly} testid="diagram-data" />
      <IconBtn icon="auto_awesome" label="AI" title="Generate a diagram from a description" onClick={() => onOpen('ai')} disabled={readOnly} testid="map-ai" />
      <div className="flex-1" />
      <IconBtn icon="search" title="Find and replace (⌘F)" onClick={() => onOpen('find')} testid="diagram-find" />
      <IconBtn icon="remove" title="Zoom out (⌘−)" onClick={cmd.zoomOut} />
      <div className="relative">
        <button type="button" onClick={() => setZoomOpen((v) => !v)} className="h-7 px-1.5 text-[11px] tabular-nums text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] rounded w-[52px]" data-testid="diagram-zoom" title="Zoom">
          {Math.round(zoom * 100)}%
        </button>
        {zoomOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setZoomOpen(false)} />
            <div className="fb-glass-panel fb-pop-in absolute right-0 z-50 mt-1 w-40 py-1 rounded-[var(--radius-row)]">
              {[0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((z) => (
                <button key={z} type="button" onClick={() => (cmd.zoomTo(z), setZoomOpen(false))} className="w-full text-left px-3 py-1 text-[12px] hover:bg-[var(--surface-sunken)]">
                  {z * 100}%
                </button>
              ))}
              <div className="my-1 h-px bg-[var(--edge-soft)]" />
              <button type="button" onClick={() => (cmd.fit(), setZoomOpen(false))} className="w-full text-left px-3 py-1 text-[12px] hover:bg-[var(--surface-sunken)]">
                Fit page <span className="text-[10px] text-[var(--ink-40)]">⇧1</span>
              </button>
              <button type="button" onClick={() => (cmd.zoomToSelection(), setZoomOpen(false))} className="w-full text-left px-3 py-1 text-[12px] hover:bg-[var(--surface-sunken)]">
                Zoom to selection <span className="text-[10px] text-[var(--ink-40)]">⇧2</span>
              </button>
            </div>
          </>
        )}
      </div>
      <IconBtn icon="add" title="Zoom in (⌘+)" onClick={cmd.zoomIn} />
      <IconBtn icon="fit_screen" title="Fit page (⇧1)" onClick={cmd.fit} testid="diagram-fit" />
    </div>
  )
}
