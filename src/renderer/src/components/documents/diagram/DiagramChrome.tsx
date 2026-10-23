import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapBody } from '@shared/types'
import { hiddenCount, type Graph, type Sel } from '@shared/diagram/ops'
import type { PageInfo } from '@shared/diagram/pages'
import { SHAPES, SHAPE_CATEGORIES } from '@shared/diagram/shapes'
import DrawMenuBar from '../editor/DrawMenuBar'
import type { DocumentOps } from '../editor/documentOps'
import type { MenuItem } from '../editor/menuBarKit'
import Icon from '../../Icon'
import { BarButton, BarMenu, BarToggle, ContextBar, OfficeShellLayout, ShellPanel, ShellSidePane, SIDE_PANE_DOM_ID, ToolRail, useShellChrome } from '../../office/shell'
import type { Commands } from './commands'
import type { Tool } from './DiagramEditor'
import { ShapeLibrary } from './ShapeLibrary'
import { LayersPanel } from './LayersPanel'
import { AiPane, DataDialog, FindPanel, MermaidDialog, ShortcutsDialog, TemplatesDialog } from './dialogs'
import { Binding, CustomData, IconInput } from './parts'
import { DIAGRAM_TABS, diagramCtx, diagramRailItems, type DiagramDialog, type DiagramPanel, type DiagramSidePane } from './ribbon'
import { hint, menuAction } from '../../../lib/menus/menuAction'

// The PlexiiDiagrams frame on the shared office shell (SPEC §6.1): the menu bar
// and ribbon tabs on one row, the active tab's controls under them, the tool
// rail on the left, the canvas, the pages bar, and overlay panels beside the
// rail, and the shared right side pane for content (the AI). No property
// inspector (owner ruling D1, as amended). Owns which panels, panes and dialogs
// are open; the tool and selection live in the editor.

const PINS_KEY = 'plexii.diagram.pinnedPanels'
const SIDE_KEY = 'plexii.diagram.sidePane'

const readPref = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const writePref = (k: string, v: unknown): void => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* preferences are a convenience */
  }
}

export function DiagramChrome({
  cmd,
  body,
  page,
  pageIdx,
  pages,
  sel,
  tool,
  toolLocked,
  setTool,
  onPanelInset,
  zoom,
  canUndo,
  canRedo,
  readOnly,
  singlePage = false,
  documentOps,
  onSaveSnippet,
  onInsertSnippet,
  children
}: {
  cmd: Commands
  body: MapBody
  page: Graph
  pageIdx: number
  pages: PageInfo[]
  sel: Sel
  tool: Tool
  toolLocked: boolean
  setTool: (t: Tool, lock?: boolean) => void
  onPanelInset: (px: number) => void
  zoom: number
  canUndo: boolean
  canRedo: boolean
  readOnly: boolean
  /** One graph, no pages (a diagram snippet): no page tabs, no new page. */
  singlePage?: boolean
  /** The document this diagram IS (host-bound); absent → no document File items. */
  documentOps?: DocumentOps
  // Saved snippets: the editor owns the dialogs; the menus only open them.
  onSaveSnippet?: () => void
  onInsertSnippet?: () => void
  children: React.ReactNode
}): JSX.Element {
  // Panels start closed so the canvas is unobstructed (an overlay over a fresh
  // diagram would cover the shapes people place). Pinned panels reopen with the
  // editor: pin the Library once and it stays.
  const [pinned, setPinned] = useState<DiagramPanel[]>(() => readPref<DiagramPanel[]>(PINS_KEY, []))
  const [open, setOpen] = useState<DiagramPanel[]>(() => readPref<DiagramPanel[]>(PINS_KEY, []))
  const [dialog, setDialog] = useState<DiagramDialog | null>(null)
  // Tab (opens on Home), collapse (remembered) and the shapes flyout's last
  // pick: the same host state as every office app (SPEC §3.9).
  const chrome = useShellChrome('diagram', { shapes: 'shape:process' })
  const { tab, collapsed } = chrome
  // A shape armed by its key (M, L) is the flyout's last pick too, as in Deck.
  const pickShape = chrome.onFlyoutPick
  useEffect(() => {
    if (tool.startsWith('shape:')) pickShape('shapes', tool)
  }, [tool, pickShape])
  const [status, setStatusText] = useState<string | null>(null)
  const statusTimer = useRef<number>()
  const fileRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const imageReplace = useRef<string | undefined>(undefined)
  const fileKind = useRef<'drawio' | 'json'>('drawio')
  const settings = body.settings ?? {}

  const setStatus = useCallback((msg: string): void => {
    setStatusText(msg || null)
    window.clearTimeout(statusTimer.current)
    if (msg) statusTimer.current = window.setTimeout(() => setStatusText(null), 6000)
  }, [])

  // ? opens the shortcuts. ⌘F (Find and replace) and ⌘/ are bound by the menu
  // bar, as in every office app (menuBarKit, SPEC §9.2).
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) setDialog('shortcuts')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  // The right side pane: which content pane shows (null = the slim edge tab), remembered per app.
  const [sidePane, setSidePaneState] = useState<DiagramSidePane | null>(() => {
    const v = readPref<string | null>(SIDE_KEY, null)
    return v === 'ai' ? v : null
  })
  const setSidePane = useCallback((p: DiagramSidePane | null) => {
    setSidePaneState(p)
    writePref(SIDE_KEY, p)
  }, [])
  const toggleSidePane = useCallback((p: DiagramSidePane) => setSidePane(sidePane === p ? null : p), [sidePane, setSidePane])

  const isOpen = useCallback((p: DiagramPanel) => open.includes(p), [open])
  const openPanel = useCallback((p: DiagramPanel) => setOpen((o) => (o.includes(p) ? o : [...o, p])), [])
  const closePanel = useCallback((p: DiagramPanel) => setOpen((o) => o.filter((x) => x !== p)), [])
  const togglePanel = useCallback((p: DiagramPanel) => setOpen((o) => (o.includes(p) ? o.filter((x) => x !== p) : [...o, p])), [])
  const setPin = (p: DiagramPanel, v: boolean): void =>
    setPinned((cur) => {
      const next = v ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)
      writePref(PINS_KEY, next)
      return next
    })
  // Data panels belong to one shape; close them when the selection moves on.
  const selKey = [...sel.nodes].join(',')
  useEffect(() => {
    setOpen((o) => o.filter((p) => !(['icon', 'label', 'link', 'data-fields', 'binding'] as DiagramPanel[]).includes(p) || sel.nodes.size === 1 || (p === 'icon' && sel.nodes.size > 0)))
  }, [selKey, sel.nodes.size])

  // Pinned panels inset Fit and zoom-to-selection (SPEC §2.4).
  const panelRects = useRef<Record<string, DOMRect | null>>({})
  const canvasLeft = useRef<HTMLDivElement>(null)
  const reportInset = useCallback(
    (id: string, rect: DOMRect | null) => {
      panelRects.current[id] = rect
      const left = canvasLeft.current?.getBoundingClientRect().left ?? 0
      const right = Math.max(0, ...Object.values(panelRects.current).map((r) => (r ? r.right - left : 0)))
      onPanelInset(right)
    },
    [onPanelInset]
  )

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

  const ctx = useMemo(
    () =>
      diagramCtx({
        cmd,
        page,
        sel,
        settings,
        themeId: settings.theme,
        readOnly,
        singlePage,
        zoom,
        tool,
        setTool,
        openDialog: (d) => setDialog(d),
        togglePanel,
        openPanel,
        isPanelOpen: isOpen,
        sidePane,
        toggleSidePane,
        setStatus,
        pickImage: (replaceNodeId) => {
          imageReplace.current = replaceNodeId
          imageRef.current?.click()
        }
      }),
    [cmd, page, sel, settings, readOnly, singlePage, zoom, tool, setTool, togglePanel, openPanel, isOpen, sidePane, toggleSidePane, setStatus]
  )
  const railItems = useMemo(() => diagramRailItems(), [])

  const menus = {
    file: (): MenuItem[] => [
      {
        kind: 'submenu',
        label: 'Import',
        icon: 'upload_file',
        items: [
          { kind: 'item', label: 'Mermaid…', icon: 'code', run: () => setDialog('mermaid') },
          // draw.io and PlexiiDiagrams JSON can carry several pages (JSON replaces
          // the whole diagram); a single-page editor would keep page one and drop
          // the rest, so neither is offered there.
          ...(singlePage ? [] : [{ kind: 'item' as const, label: 'draw.io / diagrams.net file…', icon: 'draw', run: () => ((fileKind.current = 'drawio'), fileRef.current?.click()) }]),
          { kind: 'item', label: 'Visio (.vsdx)…', icon: 'schema', run: () => void cmd.importVsdx().then((e) => e && setStatus(e)) },
          ...(singlePage ? [] : [{ kind: 'item' as const, label: 'PlexiiDiagrams JSON…', icon: 'data_object', run: () => ((fileKind.current = 'json'), fileRef.current?.click()) }])
        ]
      },
      {
        kind: 'submenu',
        label: menuAction('download').label,
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
      { kind: 'item', ...menuAction('undo'), icon: 'undo', run: cmd.undo, disabled: !canUndo },
      { kind: 'item', ...menuAction('redo'), icon: 'redo', run: cmd.redo, disabled: !canRedo },
      { kind: 'sep' },
      { kind: 'item', ...menuAction('cut'), icon: 'content_cut', run: () => document.execCommand('cut'), disabled: !hasSel, hint: hasSel ? undefined : 'Select something first' },
      { kind: 'item', ...menuAction('copy'), icon: 'content_copy', run: () => document.execCommand('copy'), disabled: !hasSel, hint: hasSel ? undefined : 'Select something first' },
      { kind: 'item', ...menuAction('paste'), icon: 'content_paste', run: () => void cmd.paste(null) },
      { kind: 'item', ...menuAction('duplicate'), icon: 'control_point_duplicate', run: cmd.duplicate, disabled: !hasSel, hint: hasSel ? undefined : 'Select something first' },
      { kind: 'item', ...menuAction('delete'), icon: 'delete', run: cmd.deleteSelection, disabled: !hasAny, hint: hasAny ? undefined : 'Select something first' },
      { kind: 'sep' },
      { kind: 'item', ...menuAction('selectAll'), icon: 'select_all', run: cmd.selectAll },
      // One panel holds both (its Replace row always shows); the two rows are the E-14 keys.
      { kind: 'item', ...menuAction('find'), icon: 'search', run: () => setDialog('find') },
      { kind: 'item', ...menuAction('findAndReplace'), icon: 'find_replace', run: () => setDialog('find') },
      ...(onSaveSnippet ? [{ kind: 'sep' as const }, { kind: 'item' as const, ...menuAction('saveAsSnippet'), icon: 'bookmark_add', run: onSaveSnippet }] : []),
      { kind: 'sep' },
      { kind: 'item', label: 'Copy style', icon: 'format_paint', shortcut: hint(['alt', 'mod', 'c']), run: cmd.copyStyle, disabled: !hasSel },
      { kind: 'item', label: 'Paste style', icon: 'format_color_fill', shortcut: hint(['alt', 'mod', 'v']), run: cmd.pasteStyle, disabled: !hasSel }
    ],
    view: (): MenuItem[] => [
      { kind: 'item', label: 'Fit to view', icon: 'fit_screen', shortcut: '⇧1', run: cmd.fit },
      { kind: 'item', label: 'Zoom to selection', icon: 'zoom_in_map', shortcut: '⇧2', run: cmd.zoomToSelection, disabled: !hasSel },
      { kind: 'item', label: 'Zoom in', icon: 'zoom_in', shortcut: '⌘+', run: cmd.zoomIn },
      { kind: 'item', label: 'Zoom out', icon: 'zoom_out', shortcut: '⌘−', run: cmd.zoomOut },
      { kind: 'item', label: 'Actual size', icon: 'crop_free', shortcut: '⌘0', run: () => cmd.zoomTo(1) },
      { kind: 'sep' },
      { kind: 'item', label: 'Shape library', icon: 'category', run: () => togglePanel('library'), active: isOpen('library') },
      { kind: 'item', label: 'Layers', icon: 'layers', run: () => togglePanel('layers'), active: isOpen('layers') },
      { kind: 'item', label: 'Ribbon', icon: 'view_day', run: () => changeCollapsed(!collapsed), active: !collapsed },
      { kind: 'sep' },
      { kind: 'item', label: 'Grid', icon: 'grid_on', run: () => cmd.setSettings({ grid: settings.grid === false ? undefined : false }), active: settings.grid !== false },
      { kind: 'item', label: 'Snap to grid', icon: 'grid_goldenratio', run: () => cmd.setSettings({ snap: settings.snap === false ? undefined : false }), active: settings.snap !== false },
      { kind: 'item', label: 'Smart guides', icon: 'straighten', run: () => cmd.setSettings({ guides: settings.guides === false ? undefined : false }), active: settings.guides !== false },
      { kind: 'item', label: 'Line jumps', icon: 'u_turn_right', run: () => cmd.setSettings({ lineJumps: settings.lineJumps ? undefined : true }), active: !!settings.lineJumps },
      { kind: 'item', label: 'Minimap', icon: 'map', run: () => cmd.setSettings({ minimap: settings.minimap === false ? undefined : false }), active: settings.minimap !== false }
    ],
    insert: (): MenuItem[] => [
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
      { kind: 'item', label: 'Image…', icon: 'image', run: () => ctx.pickImage() },
      { kind: 'sep' },
      { kind: 'item', label: 'From a Plexii table…', icon: 'table_chart', run: () => setDialog('data') },
      { kind: 'item', label: 'Template…', icon: 'dashboard', run: () => setDialog('templates') },
      { kind: 'item', label: 'Mermaid…', icon: 'code', run: () => setDialog('mermaid') },
      { kind: 'item', label: 'AI diagram…', icon: 'auto_awesome', run: () => setSidePane('ai') },
      ...(singlePage ? [] : [{ kind: 'sep' as const }, { kind: 'item' as const, label: 'New page', icon: 'note_add', run: cmd.addPage }]),
      // The shared tail (SPEC §9.2): Insert snippet… · Work widget from a desk…, then Meeting (DrawMenuBar).
      { kind: 'sep' },
      ...(onInsertSnippet ? [{ kind: 'item' as const, ...menuAction('insertSnippet'), icon: 'bookmarks', run: onInsertSnippet, disabled: readOnly }] : []),
      { kind: 'item', ...menuAction('workWidgetFromDesk'), icon: 'widgets', run: () => setDialog('data-widgets') }
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
      { kind: 'item', ...menuAction('keyboardShortcuts'), icon: 'keyboard', run: () => setDialog('shortcuts') },
      { kind: 'item', label: 'How to diagram', icon: 'help', run: () => setDialog('shortcuts') }
    ]
  }

  const changeTab = chrome.setTab
  const changeCollapsed = chrome.setCollapsed

  const one = sel.nodes.size === 1 ? page.nodes.find((n) => sel.nodes.has(n.id)) : undefined
  const panelProps = (id: DiagramPanel) => ({
    id,
    open: isOpen(id),
    onClose: () => closePanel(id),
    pinnable: true,
    pinned: pinned.includes(id),
    onPinnedChange: (v: boolean) => setPin(id, v),
    onRectChange: (r: DOMRect | null) => reportInset(id, r),
    returnFocus: () => document.querySelector<HTMLElement>('[data-testid="diagram-canvas"]')?.focus({ preventScroll: true }),
    testid: `diagram-panel-${id}`
  })

  const zoomItems = [0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((z) => ({ label: `${z * 100}%`, active: Math.abs(zoom - z) < 0.01, run: () => cmd.zoomTo(z) }))

  return (
    <div className="h-full w-full flex flex-col bg-[var(--surface-raised)] relative" data-testid="diagram-editor" data-tool-locked={toolLocked ? 'true' : undefined}>
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
      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        data-testid="diagram-image-picker"
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          const replace = imageReplace.current
          imageReplace.current = undefined
          if (!files.length) return
          if (replace) {
            const f = files[0]!
            if (f.size > 2_500_000) return setStatus('Images up to 2.5 MB can be stored in a diagram.')
            const url = await new Promise<string>((res) => {
              const r = new FileReader()
              r.onload = () => res(String(r.result))
              r.readAsDataURL(f)
            })
            cmd.setNode(replace, { image: url })
          } else await cmd.addImageFiles(files)
        }}
      />
      <OfficeShellLayout
        testid="diagram-shell"
        rightPane={
          <ShellSidePane
            testid="diagram-sidepane"
            panes={[{ id: 'ai', title: 'AI diagram', icon: 'auto_awesome', testid: 'diagram-ai-pane', render: () => <AiPane cmd={cmd} /> }]}
            activeId={sidePane}
            onChange={(id) => setSidePane(id === 'ai' ? 'ai' : null)}
          />
        }
        bar={
          <ContextBar
            testid="diagram-toolbar"
            tabs={DIAGRAM_TABS}
            ctx={ctx}
            activeTab={tab}
            onTabChange={changeTab}
            collapsed={collapsed}
            onCollapsedChange={changeCollapsed}
            readOnly={readOnly}
            menuBar={<DrawMenuBar actions={{ ...menus, documentOps }} />}
            pinnedStart={
              <>
                <BarButton icon="undo" label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={cmd.undo} testid="diagram-undo" />
                <BarButton icon="redo" label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={cmd.redo} testid="diagram-redo" />
              </>
            }
            rightSlot={
              <>
                <BarButton icon="search" label="Find and replace" shortcut="⌘F" onClick={() => setDialog('find')} testid="diagram-find" readOnlySafe />
                <BarButton icon="remove" label="Zoom out" shortcut="⌘−" onClick={cmd.zoomOut} readOnlySafe />
                <BarMenu
                  label="Zoom"
                  testid="diagram-zoom"
                  readOnlySafe
                  valueLabel={<span className="fb-tabular w-[38px] text-center">{Math.round(zoom * 100)}%</span>}
                  items={[...zoomItems, 'sep', { label: 'Fit page', shortcut: '⇧1', run: cmd.fit }, { label: 'Zoom to selection', shortcut: '⇧2', run: cmd.zoomToSelection, disabled: !hasSel }]}
                />
                <BarButton icon="add" label="Zoom in" shortcut="⌘+" onClick={cmd.zoomIn} readOnlySafe />
                <BarButton icon="fit_screen" label="Fit page" shortcut="⇧1" onClick={cmd.fit} testid="diagram-fit" readOnlySafe />
                <BarToggle icon="right_panel_open" label="Side pane" pressed={sidePane !== null} onChange={(v) => setSidePane(v ? 'ai' : null)} controls={SIDE_PANE_DOM_ID} testid="diagram-sidepane-toggle" readOnlySafe />
              </>
            }
          />
        }
        rail={
          <ToolRail
            testid="diagram-rail"
            items={railItems}
            ctx={ctx}
            activeId={tool}
            openPanels={sidePane ? [...open, sidePane] : open}
            lastUsed={chrome.lastUsed}
            onFlyoutPick={chrome.onFlyoutPick}
            readOnly={readOnly}
            ariaLabel="Diagram tools"
          />
        }
        bottom={<PagesBar cmd={cmd} pages={pages} pageIdx={pageIdx} sel={sel} page={page} status={status} layersOpen={isOpen('layers')} onLayers={() => togglePanel('layers')} readOnly={readOnly} singlePage={singlePage} />}
        panels={
          open.length ? (
            <>
              <ShellPanel {...panelProps('library')} title="Shape library" icon="category" fill>
                <ShapeLibrary cmd={cmd} themeId={settings.theme ?? 'plexii'} readOnly={readOnly} />
              </ShellPanel>
              <ShellPanel {...panelProps('layers')} title="Layers" icon="layers">
                <LayersPanel cmd={cmd} page={page} sel={sel} />
              </ShellPanel>
              <ShellPanel {...panelProps('icon')} title="Icon" icon="emoji_symbols">
                <div className="p-2.5">
                  <IconInput value={page.nodes.find((n) => sel.nodes.has(n.id))?.icon} onChange={(v) => cmd.setNodes({ icon: v || undefined })} />
                </div>
              </ShellPanel>
              {one && (
                <>
                  <ShellPanel {...panelProps('label')} title="Label" icon="edit_note">
                    <div className="p-2.5">
                      <textarea
                        value={one.label}
                        onChange={(e) => cmd.setNode(one.id, { label: e.target.value }, `label:${one.id}`)}
                        onKeyDown={(e) => e.stopPropagation()}
                        rows={4}
                        className="fb-field w-full px-1.5 py-1 text-[12px] resize-y"
                        data-testid="diagram-label-field"
                      />
                    </div>
                  </ShellPanel>
                  <ShellPanel {...panelProps('link')} title="Link and notes" icon="link">
                    <div className="p-2.5 space-y-2">
                      <div className="flex items-center gap-1">
                        <input
                          value={one.link ?? ''}
                          onChange={(e) => cmd.setNode(one.id, { link: e.target.value || undefined }, `link:${one.id}`)}
                          onKeyDown={(e) => e.stopPropagation()}
                          placeholder="https://… or plexii://…"
                          className="fb-field h-7 px-1.5 text-[12px] flex-1 min-w-0"
                          data-testid="diagram-link"
                        />
                        {one.link && /^https?:\/\//i.test(one.link) && (
                          <button type="button" title="Open link" onClick={() => window.open(one.link, '_blank', 'noopener,noreferrer')} className="icon-btn">
                            <Icon name="open_in_new" size={14} />
                          </button>
                        )}
                      </div>
                      <textarea
                        value={one.description ?? ''}
                        onChange={(e) => cmd.setNode(one.id, { description: e.target.value || undefined }, `desc:${one.id}`)}
                        onKeyDown={(e) => e.stopPropagation()}
                        rows={4}
                        placeholder="Notes about this shape (searchable)"
                        className="fb-field w-full px-1.5 py-1 text-[12px] resize-y"
                        data-testid="diagram-notes"
                      />
                    </div>
                  </ShellPanel>
                  <ShellPanel {...panelProps('data-fields')} title="Custom data" icon="data_object">
                    <div className="p-2.5">
                      <CustomData cmd={cmd} node={one} />
                    </div>
                  </ShellPanel>
                  <ShellPanel {...panelProps('binding')} title="Data source" icon="table_chart">
                    <div className="p-2.5">
                      <Binding cmd={cmd} node={one} />
                    </div>
                  </ShellPanel>
                </>
              )}
            </>
          ) : undefined
        }
      >
        <div ref={canvasLeft} className="absolute inset-0">
          {children}
          {dialog === 'find' && <FindPanel cmd={cmd} onClose={() => setDialog(null)} />}
        </div>
      </OfficeShellLayout>
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
  layersOpen,
  onLayers,
  readOnly,
  singlePage
}: {
  cmd: Commands
  pages: PageInfo[]
  pageIdx: number
  sel: Sel
  page: Graph
  status: string | null
  layersOpen: boolean
  onLayers: () => void
  readOnly: boolean
  singlePage: boolean
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
        {!singlePage && pages.map((p, i) => (
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
                // The active page's menu edits pages (rename, duplicate, move, delete); a
                // read-only diagram has no such menu.
                onClick={() => (i === pageIdx ? !readOnly && setMenu(menu === i ? null : i) : cmd.gotoPage(i))}
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
        {!readOnly && !singlePage && (
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
      {/* The same Layers panel the rail toggles: one state (SPEC §3.7). */}
      <button
        type="button"
        onClick={onLayers}
        aria-pressed={layersOpen}
        aria-controls="shell-panel-layers"
        className={`h-6 px-1.5 rounded inline-flex items-center gap-1 hover:bg-[var(--surface-raised)] ${layersOpen ? 'text-accent' : 'text-[var(--ink-60)]'}`}
        title="Layers"
        data-testid="diagram-layers-toggle"
      >
        <Icon name="layers" size={14} />
        {page.layers?.length ? page.layers.length : ''}
      </button>
    </div>
  )
}
