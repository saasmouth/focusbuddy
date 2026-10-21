import { useEffect, useRef, useState } from 'react'
import type { MapBody } from '@shared/types'
import { hiddenCount, type Graph, type Sel } from '@shared/diagram/ops'
import type { PageInfo } from '@shared/diagram/pages'
import { SHAPES, SHAPE_CATEGORIES } from '@shared/diagram/shapes'
import DrawMenuBar from '../editor/DrawMenuBar'
import type { MenuItem } from '../editor/menuBarKit'
import Icon from '../../Icon'
import type { Commands } from './commands'
import type { Tool } from './DiagramEditor'
import { Toolbar } from './Toolbar'
import { ShapeLibrary } from './ShapeLibrary'
import { Inspector } from './Inspector'
import { LayersPanel } from './LayersPanel'
import { AiDialog, DataDialog, FindPanel, MermaidDialog, ShortcutsDialog, TemplatesDialog } from './dialogs'

// The editor frame: menu bar, toolbar, library | canvas | inspector, and the
// pages + status bar. Owns which panels and dialogs are open.

type Dialog = 'ai' | 'data' | 'data-widgets' | 'find' | 'templates' | 'mermaid' | 'shortcuts' | null

export function DiagramChrome({
  cmd,
  body,
  page,
  pageIdx,
  pages,
  sel,
  tool,
  setTool,
  zoom,
  canUndo,
  canRedo,
  readOnly,
  children
}: {
  cmd: Commands
  body: MapBody
  page: Graph
  pageIdx: number
  pages: PageInfo[]
  sel: Sel
  tool: Tool
  setTool: (t: Tool) => void
  zoom: number
  canUndo: boolean
  canRedo: boolean
  readOnly: boolean
  children: React.ReactNode
}): JSX.Element {
  const [library, setLibrary] = useState(true)
  const [inspector, setInspector] = useState(true)
  const [layers, setLayers] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [status, setStatusText] = useState<string | null>(null)
  const statusTimer = useRef<number>()
  const fileRef = useRef<HTMLInputElement>(null)
  const fileKind = useRef<'drawio' | 'json'>('drawio')
  const settings = body.settings ?? {}

  const setStatus = (msg: string): void => {
    setStatusText(msg || null)
    window.clearTimeout(statusTimer.current)
    if (msg) statusTimer.current = window.setTimeout(() => setStatusText(null), 6000)
  }

  // ⌘F opens find; ? opens shortcuts.
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setDialog('find')
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) setDialog('shortcuts')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const exportFmt = async (f: 'svg' | 'png' | 'jpg' | 'pdf', scope: 'page' | 'selection' = 'page'): Promise<void> => {
    setStatus(`Exporting ${f.toUpperCase()}…`)
    try {
      setStatus(await cmd.exportAs(f, scope))
    } catch (e) {
      setStatus(`Could not export: ${(e as Error).message}`)
    }
  }

  const hasSel = sel.nodes.size > 0
  const hasAny = sel.nodes.size > 0 || sel.edges.size > 0
  const hiddenOnPage = hiddenCount(page)

  const menus = {
    file: (): MenuItem[] => [
      {
        kind: 'submenu',
        label: 'Import',
        icon: 'upload_file',
        items: [
          { kind: 'item', label: 'Mermaid…', icon: 'code', run: () => setDialog('mermaid') },
          { kind: 'item', label: 'draw.io / diagrams.net file…', icon: 'draw', run: () => ((fileKind.current = 'drawio'), fileRef.current?.click()) },
          { kind: 'item', label: 'Visio (.vsdx)…', icon: 'schema', run: () => void cmd.importVsdx().then((e) => e && setStatus(e)) },
          { kind: 'item', label: 'PlexiiDiagrams JSON…', icon: 'data_object', run: () => ((fileKind.current = 'json'), fileRef.current?.click()) }
        ]
      },
      {
        kind: 'submenu',
        label: 'Export',
        icon: 'download',
        items: [
          { kind: 'item', label: 'PNG image', run: () => void exportFmt('png') },
          { kind: 'item', label: 'SVG (vector)', run: () => void exportFmt('svg') },
          { kind: 'item', label: 'JPG image', run: () => void exportFmt('jpg') },
          { kind: 'item', label: 'PDF', run: () => void exportFmt('pdf') },
          { kind: 'sep' },
          { kind: 'item', label: 'Selection as PNG', run: () => void exportFmt('png', 'selection'), disabled: !hasSel },
          { kind: 'item', label: 'Selection as SVG', run: () => void exportFmt('svg', 'selection'), disabled: !hasSel },
          { kind: 'sep' },
          { kind: 'item', label: 'Mermaid (.mmd)', run: () => cmd.exportText('mermaid') },
          { kind: 'item', label: 'Copy as Mermaid', run: () => (cmd.copyMermaid(), setStatus('Mermaid copied to the clipboard.')) },
          { kind: 'item', label: 'draw.io (.drawio), all pages', run: () => cmd.exportText('drawio') },
          { kind: 'item', label: 'PlexiiDiagrams JSON', run: () => cmd.exportText('json') }
        ]
      }
    ],
    edit: (): MenuItem[] => [
      { kind: 'item', label: 'Undo', icon: 'undo', shortcut: '⌘Z', run: cmd.undo, disabled: !canUndo },
      { kind: 'item', label: 'Redo', icon: 'redo', shortcut: '⇧⌘Z', run: cmd.redo, disabled: !canRedo },
      { kind: 'sep' },
      { kind: 'item', label: 'Cut', icon: 'content_cut', shortcut: '⌘X', run: () => document.execCommand('cut'), disabled: !hasSel },
      { kind: 'item', label: 'Copy', icon: 'content_copy', shortcut: '⌘C', run: () => document.execCommand('copy'), disabled: !hasSel },
      { kind: 'item', label: 'Paste', icon: 'content_paste', shortcut: '⌘V', run: () => void cmd.paste(null) },
      { kind: 'item', label: 'Duplicate', icon: 'control_point_duplicate', shortcut: '⌘D', run: cmd.duplicate, disabled: !hasSel },
      { kind: 'item', label: 'Delete', icon: 'delete', shortcut: '⌫', run: cmd.deleteSelection, disabled: !hasAny },
      { kind: 'sep' },
      { kind: 'item', label: 'Select all', icon: 'select_all', shortcut: '⌘A', run: cmd.selectAll },
      { kind: 'item', label: 'Find and replace', icon: 'search', shortcut: '⌘F', run: () => setDialog('find') },
      { kind: 'sep' },
      { kind: 'item', label: 'Copy style', icon: 'format_paint', shortcut: '⌥⌘C', run: cmd.copyStyle, disabled: !hasSel },
      { kind: 'item', label: 'Paste style', icon: 'format_color_fill', shortcut: '⌥⌘V', run: cmd.pasteStyle, disabled: !hasSel }
    ],
    view: (): MenuItem[] => [
      { kind: 'item', label: 'Fit to view', icon: 'fit_screen', shortcut: '⇧1', run: cmd.fit },
      { kind: 'item', label: 'Zoom to selection', icon: 'zoom_in_map', shortcut: '⇧2', run: cmd.zoomToSelection, disabled: !hasSel },
      { kind: 'item', label: 'Zoom in', icon: 'zoom_in', shortcut: '⌘+', run: cmd.zoomIn },
      { kind: 'item', label: 'Zoom out', icon: 'zoom_out', shortcut: '⌘−', run: cmd.zoomOut },
      { kind: 'item', label: 'Actual size', icon: 'crop_free', shortcut: '⌘0', run: () => cmd.zoomTo(1) },
      { kind: 'sep' },
      { kind: 'item', label: 'Shape library', icon: 'category', run: () => setLibrary((v) => !v), active: library },
      { kind: 'item', label: 'Inspector', icon: 'tune', run: () => setInspector((v) => !v), active: inspector },
      { kind: 'item', label: 'Layers', icon: 'layers', run: () => setLayers((v) => !v), active: layers },
      { kind: 'sep' },
      { kind: 'item', label: 'Grid', icon: 'grid_on', run: () => cmd.setSettings({ grid: settings.grid === false ? undefined : false }), active: settings.grid !== false },
      { kind: 'item', label: 'Snap to grid', icon: 'grid_goldenratio', run: () => cmd.setSettings({ snap: settings.snap === false ? undefined : false }), active: settings.snap !== false },
      { kind: 'item', label: 'Smart guides', icon: 'straighten', run: () => cmd.setSettings({ guides: settings.guides === false ? undefined : false }), active: settings.guides !== false },
      { kind: 'item', label: 'Line jumps', icon: 'u_turn_right', run: () => cmd.setSettings({ lineJumps: settings.lineJumps ? undefined : true }), active: !!settings.lineJumps },
      { kind: 'item', label: 'Minimap', icon: 'map', run: () => cmd.setSettings({ minimap: settings.minimap === false ? undefined : false }), active: settings.minimap !== false }
    ],
    insert: (): MenuItem[] => [
      // The everyday shapes first; the whole library is one submenu per category.
      ...(['process', 'decision', 'terminator', 'data', 'database', 'circle'] as const).map((id) => {
        const s = SHAPES.find((x) => x.id === id)!
        return { kind: 'item' as const, label: s.label, run: () => void cmd.addShape(id) }
      }),
      { kind: 'sep' },
      ...SHAPE_CATEGORIES.filter((c) => SHAPES.some((s) => s.category === c)).map((c) => ({
        kind: 'submenu' as const,
        label: `${c} shapes`,
        icon: 'category',
        items: SHAPES.filter((s) => s.category === c).map((s) => ({ kind: 'item' as const, label: s.label, run: () => void cmd.addShape(s.id) }))
      })),
      { kind: 'sep' },
      { kind: 'item', label: 'Text', icon: 'title', shortcut: 'T', run: () => setTool('text') },
      { kind: 'item', label: 'Table', icon: 'table', run: () => void cmd.addShape(SHAPES.find((s) => s.special === 'table')?.id ?? 'process') },
      { kind: 'item', label: 'Sticky note', icon: 'sticky_note_2', run: () => void cmd.addShape(SHAPES.find((s) => s.special === 'sticky')?.id ?? 'note') },
      { kind: 'item', label: 'Swimlane', icon: 'view_column', run: () => void cmd.addShape('lane') },
      { kind: 'item', label: 'Image…', icon: 'image', run: () => setLibrary(true) },
      { kind: 'sep' },
      { kind: 'item', label: 'From a Plexii table…', icon: 'table_chart', run: () => setDialog('data') },
      { kind: 'item', label: 'Work widget from a desk…', icon: 'widgets', run: () => setDialog('data-widgets') },
      { kind: 'item', label: 'Template…', icon: 'dashboard', run: () => setDialog('templates') },
      { kind: 'item', label: 'Mermaid…', icon: 'code', run: () => setDialog('mermaid') },
      { kind: 'item', label: 'AI diagram…', icon: 'auto_awesome', run: () => setDialog('ai') },
      { kind: 'sep' },
      { kind: 'item', label: 'New page', icon: 'note_add', run: cmd.addPage }
    ],
    arrange: (): MenuItem[] => [
      { kind: 'item', label: 'Bring to front', icon: 'flip_to_front', shortcut: '⇧⌘]', run: () => cmd.order('front'), disabled: !hasSel },
      { kind: 'item', label: 'Bring forward', icon: 'arrow_upward', shortcut: '⌘]', run: () => cmd.order('forward'), disabled: !hasSel },
      { kind: 'item', label: 'Send backward', icon: 'arrow_downward', shortcut: '⌘[', run: () => cmd.order('backward'), disabled: !hasSel },
      { kind: 'item', label: 'Send to back', icon: 'flip_to_back', shortcut: '⇧⌘[', run: () => cmd.order('back'), disabled: !hasSel },
      { kind: 'sep' },
      { kind: 'item', label: 'Group', icon: 'link', shortcut: '⌘G', run: cmd.group, disabled: sel.nodes.size < 2 },
      { kind: 'item', label: 'Ungroup', icon: 'link_off', shortcut: '⇧⌘G', run: cmd.ungroup, disabled: !hasSel },
      { kind: 'item', label: 'Lock / unlock', icon: 'lock', shortcut: '⇧⌘L', run: cmd.toggleLock, disabled: !hasAny },
      { kind: 'item', label: 'Hide', icon: 'visibility_off', run: cmd.hideSelection, disabled: !sel.nodes.size },
      { kind: 'item', label: `Show all hidden${hiddenOnPage ? ` (${hiddenOnPage})` : ''}`, icon: 'visibility', run: cmd.showAllHidden, disabled: !hiddenOnPage },
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
        ).map(([e, l]) => ({ kind: 'item' as const, label: l, run: () => cmd.align(e), disabled: sel.nodes.size < 2 }))
      },
      {
        kind: 'submenu',
        label: 'Distribute',
        icon: 'horizontal_distribute',
        items: [
          { kind: 'item', label: 'Horizontally', run: () => cmd.distribute('h'), disabled: sel.nodes.size < 3 },
          { kind: 'item', label: 'Vertically', run: () => cmd.distribute('v'), disabled: sel.nodes.size < 3 }
        ]
      },
      {
        kind: 'submenu',
        label: 'Rotate & flip',
        icon: 'rotate_right',
        items: [
          { kind: 'item', label: 'Rotate 90° right', run: () => cmd.rotate(90), disabled: !hasSel },
          { kind: 'item', label: 'Rotate 90° left', run: () => cmd.rotate(-90), disabled: !hasSel },
          { kind: 'item', label: 'Flip horizontally', run: () => cmd.flip('x'), disabled: !hasSel },
          { kind: 'item', label: 'Flip vertically', run: () => cmd.flip('y'), disabled: !hasSel }
        ]
      },
      { kind: 'sep' },
      { kind: 'item', label: 'Tidy connections', icon: 'cleaning_services', run: () => setStatus(cmd.tidyConnections()) },
      {
        kind: 'submenu',
        label: 'Auto layout',
        icon: 'account_tree',
        items: [
          { kind: 'item', label: 'Hierarchy, top to bottom', run: () => cmd.layout('layered', 'TB') },
          { kind: 'item', label: 'Hierarchy, left to right', run: () => cmd.layout('layered', 'LR') },
          { kind: 'item', label: 'Tree', run: () => cmd.layout('tree', 'TB') },
          { kind: 'item', label: 'Mind map', run: () => cmd.layout('mindmap', 'LR') },
          { kind: 'item', label: 'Radial', run: () => cmd.layout('radial', 'TB') },
          { kind: 'item', label: 'Organic', run: () => cmd.layout('organic', 'TB') },
          { kind: 'item', label: 'Grid', run: () => cmd.layout('grid', 'TB') }
        ]
      }
    ],
    help: (): MenuItem[] => [
      { kind: 'item', label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: '?', run: () => setDialog('shortcuts') },
      { kind: 'item', label: 'How to diagram', icon: 'help', run: () => setDialog('shortcuts') }
    ]
  }

  return (
    <div className="h-full w-full flex flex-col bg-[var(--surface-raised)] relative" data-testid="diagram-editor">
      <input
        ref={fileRef}
        type="file"
        accept=".drawio,.xml,.json,.plexidiagram.json"
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          const notes: string[] = []
          for (const f of files) {
            const text = await f.text()
            if (fileKind.current === 'json') {
              // A JSON file is a whole diagram; importing it replaces the current one.
              const err = cmd.importJson(text)
              notes.push(err ?? `Imported ${f.name}`)
              if (files.length > 1) notes.push('only the last JSON file is kept — each replaces the diagram')
            } else {
              const w = cmd.importDrawio(text)
              notes.push(w.length ? `${f.name}: ${w.slice(0, 2).join(' · ')}` : `Imported ${f.name}`)
            }
          }
          if (notes.length) setStatus([...new Set(notes)].join(' · '))
        }}
      />
      <div className="shrink-0 px-2 pt-1.5 pb-1 border-b border-[var(--edge-soft)] flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <DrawMenuBar actions={menus} />
        </div>
        <button type="button" className="icon-btn" title={library ? 'Hide shape library' : 'Show shape library'} onClick={() => setLibrary((v) => !v)} data-testid="diagram-toggle-library">
          <Icon name="left_panel_open" size={16} />
        </button>
        <button type="button" className="icon-btn" title={inspector ? 'Hide inspector' : 'Show inspector'} onClick={() => setInspector((v) => !v)} data-testid="diagram-toggle-inspector">
          <Icon name="right_panel_open" size={16} />
        </button>
      </div>
      <Toolbar
        cmd={cmd}
        page={page}
        sel={sel}
        tool={tool}
        setTool={setTool}
        zoom={zoom}
        canUndo={canUndo}
        canRedo={canRedo}
        themeId={settings.theme}
        readOnly={readOnly}
        onOpen={(d) => setDialog(d)}
        status={setStatus}
      />
      <div className="flex-1 min-h-0 flex">
        {library && <ShapeLibrary cmd={cmd} themeId={settings.theme ?? 'plexii'} readOnly={readOnly} />}
        <div className="flex-1 min-w-0 relative">
          {children}
          {dialog === 'find' && <FindPanel cmd={cmd} onClose={() => setDialog(null)} />}
          {layers && <LayersPanel cmd={cmd} page={page} sel={sel} onClose={() => setLayers(false)} />}
        </div>
        {inspector && <Inspector cmd={cmd} page={page} sel={sel} settings={settings} readOnly={readOnly} />}
      </div>
      <PagesBar cmd={cmd} pages={pages} pageIdx={pageIdx} sel={sel} page={page} status={status} onLayers={() => setLayers((v) => !v)} readOnly={readOnly} />
      {dialog === 'ai' && <AiDialog cmd={cmd} onClose={() => setDialog(null)} />}
      {(dialog === 'data' || dialog === 'data-widgets') && <DataDialog cmd={cmd} onClose={() => setDialog(null)} initialTab={dialog === 'data-widgets' ? 'widgets' : 'tables'} />}
      {dialog === 'templates' && <TemplatesDialog cmd={cmd} onClose={() => setDialog(null)} onMermaid={() => setDialog('mermaid')} />}
      {dialog === 'mermaid' && <MermaidDialog cmd={cmd} onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </div>
  )
}

function PagesBar({
  cmd,
  pages,
  pageIdx,
  sel,
  page,
  status,
  onLayers,
  readOnly
}: {
  cmd: Commands
  pages: PageInfo[]
  pageIdx: number
  sel: Sel
  page: Graph
  status: string | null
  onLayers: () => void
  readOnly: boolean
}): JSX.Element {
  const [renaming, setRenaming] = useState<number | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  const summary =
    sel.nodes.size || sel.edges.size
      ? [sel.nodes.size ? `${sel.nodes.size} shape${sel.nodes.size === 1 ? '' : 's'}` : '', sel.edges.size ? `${sel.edges.size} line${sel.edges.size === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') + ' selected'
      : `${page.nodes.length} shape${page.nodes.length === 1 ? '' : 's'} · ${page.edges.length} line${page.edges.length === 1 ? '' : 's'}`
  return (
    <div className="shrink-0 h-8 flex items-center gap-1 px-2 border-t border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_55%,transparent)] text-[11px]" data-testid="diagram-pages-bar">
      <div className="flex items-center gap-0.5 overflow-x-auto min-w-0">
        {pages.map((p, i) => (
          <div key={p.id} className="relative">
            {renaming === i ? (
              <input
                autoFocus
                defaultValue={p.name}
                onBlur={(e) => {
                  cmd.renamePage(i, e.target.value)
                  setRenaming(null)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
                className="fb-field h-6 px-1 text-[11px] w-[110px]"
              />
            ) : (
              <button
                type="button"
                onClick={() => (i === pageIdx ? setMenu(menu === i ? null : i) : cmd.gotoPage(i))}
                onDoubleClick={() => !readOnly && setRenaming(i)}
                data-testid={`diagram-page-${i}`}
                className={`h-6 px-2.5 rounded inline-flex items-center gap-1 whitespace-nowrap ${i === pageIdx ? 'bg-[var(--surface-raised)] shadow-sm font-semibold text-[var(--ink-90)]' : 'text-[var(--ink-60)] hover:text-[var(--ink-90)]'}`}
              >
                {p.name}
                {i === pageIdx && !readOnly && <Icon name="expand_more" size={12} />}
              </button>
            )}
            {menu === i && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
                <div className="fb-glass-panel fb-pop-in absolute bottom-7 left-0 z-50 w-40 py-1 rounded-[var(--radius-row)]">
                  {[
                    { l: 'Rename', run: () => setRenaming(i) },
                    { l: 'Duplicate', run: () => cmd.duplicatePage(i) },
                    { l: 'Move left', run: () => cmd.movePage(i, i - 1), off: i === 0 },
                    { l: 'Move right', run: () => cmd.movePage(i, i + 1), off: i === pages.length - 1 },
                    { l: 'Delete page', run: () => window.confirm(`Delete "${p.name}"? Undo can bring it back.`) && cmd.deletePage(i), off: pages.length < 2 }
                  ].map((it) => (
                    <button
                      key={it.l}
                      type="button"
                      disabled={it.off}
                      onClick={() => {
                        setMenu(null)
                        it.run()
                      }}
                      className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
                    >
                      {it.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
        {!readOnly && (
          <button type="button" onClick={cmd.addPage} className="h-6 w-6 rounded inline-flex items-center justify-center text-[var(--ink-60)] hover:bg-[var(--surface-raised)]" title="Add page" data-testid="diagram-page-add">
            <Icon name="add" size={14} />
          </button>
        )}
      </div>
      <div className="flex-1" />
      {status ? (
        <span className="text-[var(--ink-70)] truncate max-w-[420px]" data-testid="map-export-status" title={status}>
          {status}
        </span>
      ) : (
        <span className="text-[var(--ink-50)]" data-testid="diagram-selection-summary">
          {summary}
        </span>
      )}
      <button type="button" onClick={onLayers} className="h-6 px-1.5 rounded inline-flex items-center gap-1 text-[var(--ink-60)] hover:bg-[var(--surface-raised)]" title="Layers" data-testid="diagram-layers-toggle">
        <Icon name="layers" size={14} />
        {page.layers?.length ? page.layers.length : ''}
      </button>
    </div>
  )
}
