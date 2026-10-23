import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapBody } from '@shared/types'
import { hiddenCount, type Graph, type Sel } from '@shared/diagram/ops'
import type { PageInfo } from '@shared/diagram/pages'
import DrawMenuBar from '../editor/DrawMenuBar'
import type { DocumentOps } from '../editor/documentOps'
import Icon from '../../Icon'
import { BarButton, BarMenu, BarToggle, ContextBar, OfficeShellLayout, ShellPanel, ShellSidePane, SIDE_PANE_DOM_ID, ToolRail, useShellChrome } from '../../office/shell'
import type { Commands } from './commands'
import type { Tool } from './DiagramEditor'
import { ShapeLibrary } from './ShapeLibrary'
import { LayersPanel } from './LayersPanel'
import { AiPane, DataDialog, FindPanel, MermaidDialog, ShortcutsDialog, TemplatesDialog } from './dialogs'
import { Binding, CustomData, IconInput } from './parts'
import { DIAGRAM_TABS, diagramCtx, diagramRailItems, type DiagramDialog, type DiagramPanel, type DiagramSidePane } from './ribbon'
import { diagramMenus } from './diagramMenus'
import { barMenuItem, barProps } from '../../../lib/menus/officeCommand'

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
        },
        canUndo,
        canRedo,
        importFile: (kind) => {
          fileKind.current = kind
          fileRef.current?.click()
        },
        openAi: () => setSidePane('ai'),
        insertSnippet: onInsertSnippet
      }),
    [cmd, page, sel, settings, readOnly, singlePage, zoom, tool, setTool, togglePanel, openPanel, isOpen, sidePane, toggleSidePane, setStatus, canUndo, canRedo, setSidePane, onInsertSnippet]
  )
  // Every shared action, defined once (diagramCommands): menus, ribbon and zoom controls render from it.
  const c = ctx.cmds
  const railItems = useMemo(() => diagramRailItems(), [])

  // Every menu row, from the registry where it changes the diagram (diagramMenus).
  const menus = diagramMenus({
    c,
    cmd,
    singlePage,
    hasSel,
    hiddenOnPage,
    exportFmt: (f, scope) => void exportFmt(f, scope),
    setStatus,
    openShortcuts: () => setDialog('shortcuts'),
    togglePanel,
    isOpen,
    collapsed,
    setCollapsed: chrome.setCollapsed,
    onSaveSnippet,
    onInsertSnippet
  })

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
                {/* Edit's Undo / Redo commands: off with "Nothing to undo." or, for a viewer, the read-only sentence. */}
                <BarButton {...barProps(c.undo)} onClick={c.undo.run} testid="diagram-undo" />
                <BarButton {...barProps(c.redo)} onClick={c.redo.run} testid="diagram-redo" />
              </>
            }
            rightSlot={
              <>
                <BarButton {...barProps(c.find)} onClick={c.find.run} testid="diagram-find" />
                <BarButton {...barProps(c.zoomOut)} icon="remove" onClick={c.zoomOut.run} />
                <BarMenu
                  label="Zoom"
                  testid="diagram-zoom"
                  readOnlySafe
                  valueLabel={<span className="fb-tabular w-[38px] text-center">{Math.round(zoom * 100)}%</span>}
                  items={[...zoomItems, 'sep', barMenuItem(c.fit), barMenuItem(c.zoomToSelection)]}
                />
                <BarButton {...barProps(c.zoomIn)} icon="add" onClick={c.zoomIn.run} />
                <BarButton {...barProps(c.fit)} onClick={c.fit.run} testid="diagram-fit" />
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
