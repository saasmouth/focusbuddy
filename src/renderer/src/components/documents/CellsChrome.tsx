import { useCallback, useMemo, useState, type ReactNode } from 'react'
import Icon from '../Icon'
import type { SheetCellFormat } from '@shared/types'
import {
  BarButton,
  ContextBar,
  OfficeShellLayout,
  resolveActiveTab,
  ShellPanel,
  ShellSidePane,
  SIDE_PANE_DOM_ID,
  ToolRail,
  type SidePane
} from '../office/shell'
import type { SheetMenuActions } from './editor/SheetMenuBar'
import { CELLS_TABS, cellsRailItems, cmdButton, type CCtx, type CellsPanel, type CellsSidePane } from './sheet/cellsRibbon'
import type { CellsCommands } from './sheet/cellsCommands'

// The PlexiiCells frame on the shared office shell (SPEC §6.3): the menu bar
// and ribbon tabs on one row, the active tab's controls under them, the tool
// rail on the left, the grid, the sheet tab strip along the bottom, overlay
// panels beside the rail, and the assistant in the shared right side pane.
// No property inspector — owner ruling D1, as amended by §2.5a.
//
// It owns which tab, panels and pane are open. The grid, the workbook and
// every operation stay with SheetEditor and arrive here as `actions`: this
// component places chrome, it does not own the sheet.

const TAB_KEY = 'plexii.sheet.ribbonTab'
const COLLAPSE_KEY = 'plexii.sheet.ribbonCollapsed'
const PINS_KEY = 'plexii.sheet.pinnedPanels'

function readPref<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

function writePref(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* preferences are a convenience */
  }
}

export interface CellsChromeProps {
  actions: SheetMenuActions
  readOnly: boolean
  /** PlexiiCells' command registry, built by SheetEditor. The bar renders its shared controls from it. */
  commands: CellsCommands
  /** <SheetMenuBar> — it shares row 1 with the tabs (owner ruling D2). */
  menuBar: ReactNode
  /** Format of the active cell: what the mark toggles and alignment read. */
  activeFormat: SheetCellFormat | undefined
  activeFont?: string
  isMerged: boolean
  onMergeCells: () => void
  onInsertLookup: () => void
  onMacros: () => void
  onQuery: () => void
  // ── the one right content pane
  aiOpen: boolean
  onAiOpen: (v: boolean) => void
  renderAssistant: () => ReactNode
  /**
   * Bodies for panels SheetEditor owns. Empty today: Cells' only ShellPanel is
   * `office`, whose body CellsChrome draws itself. This stays because it is how
   * a converted tool supplies its body — see CellsPanel for the five that are
   * still modals.
   */
  panelBodies?: Partial<Record<CellsPanel, ReactNode>>
  /** The sheet tab strip along the bottom. */
  bottom?: ReactNode
  /** The grid. */
  children: ReactNode
}

const PANEL_META: Record<CellsPanel, { title: string; icon: string; width?: number; pinnable?: boolean }> = {
  office: { title: 'Import / export', icon: 'folder_open', width: 240 }
}

export default function CellsChrome(props: CellsChromeProps): JSX.Element {
  const { actions, readOnly, commands, menuBar, aiOpen, onAiOpen, panelBodies, bottom, children } = props

  const [tab, setTabState] = useState<string>(() => readPref<string>(TAB_KEY, 'home'))
  const [collapsed, setCollapsedState] = useState<boolean>(() => readPref<boolean>(COLLAPSE_KEY, false))
  const [open, setOpen] = useState<CellsPanel[]>([])
  const [pinned, setPinned] = useState<CellsPanel[]>(() => readPref<CellsPanel[]>(PINS_KEY, []))

  const changeTab = useCallback((id: string) => {
    setTabState(id)
    writePref(TAB_KEY, id)
  }, [])
  const changeCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v)
    writePref(COLLAPSE_KEY, v)
  }, [])

  const isPanelOpen = useCallback((p: CellsPanel) => open.includes(p), [open])
  const togglePanel = useCallback(
    (p: CellsPanel) => setOpen((o) => (o.includes(p) ? o.filter((x) => x !== p) : [...o, p])),
    []
  )
  const closePanel = useCallback((p: CellsPanel) => setOpen((o) => o.filter((x) => x !== p)), [])
  const setPin = useCallback((p: CellsPanel, v: boolean) => {
    setPinned((cur) => {
      const next = v ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)
      writePref(PINS_KEY, next)
      return next
    })
  }, [])

  const sidePane: CellsSidePane | null = aiOpen ? 'ai' : null
  const toggleSidePane = useCallback(() => onAiOpen(!aiOpen), [aiOpen, onAiOpen])

  const ctx: CCtx = useMemo(
    () => ({
      a: actions,
      readOnly,
      commands,
      fmt: props.activeFormat,
      activeFont: props.activeFont,
      isMerged: props.isMerged,
      mergeCells: props.onMergeCells,
      insertLookup: props.onInsertLookup,
      macros: props.onMacros,
      query: props.onQuery,
      togglePanel,
      isPanelOpen,
      sidePane,
      toggleSidePane
    }),
    [actions, readOnly, commands, props, togglePanel, isPanelOpen, sidePane, toggleSidePane]
  )

  const railItems = useMemo(() => cellsRailItems(), [])
  const activeTab = resolveActiveTab(CELLS_TABS, ctx, tab)

  const panes: SidePane[] = useMemo(
    () => [
      {
        id: 'ai',
        title: 'PlexiiAssist',
        icon: 'auto_awesome',
        tabTestid: 'sheet-tab-ai',
        render: props.renderAssistant
      }
    ],
    [props.renderAssistant]
  )

  function panelBody(p: CellsPanel): ReactNode {
    if (p === 'office')
      return (
        <div className="py-1 text-[12px]">
          <button onClick={() => { closePanel('office'); actions.importFile() }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] rounded">
            <Icon name="upload_file" size={14} className="text-[var(--ink-40)]" /> Import .xlsx / .csv
          </button>
          <button onClick={() => { closePanel('office'); actions.exportFile('xlsx') }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] rounded">
            <Icon name="table_chart" size={14} className="text-[var(--ink-40)]" /> Export .xlsx
          </button>
          <button onClick={() => { closePanel('office'); actions.exportFile('csv') }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] rounded">
            <Icon name="description" size={14} className="text-[var(--ink-40)]" /> Export .csv
          </button>
        </div>
      )
    return panelBodies?.[p] ?? null
  }

  return (
    <OfficeShellLayout
      testid="sheet-shell"
      bar={
        <ContextBar
          testid="sheet-toolbar"
          tabs={CELLS_TABS}
          ctx={ctx}
          activeTab={activeTab}
          onTabChange={changeTab}
          collapsed={collapsed}
          onCollapsedChange={changeCollapsed}
          readOnly={readOnly}
          menuBar={menuBar}
          pinnedStart={
            <>
              {cmdButton(ctx, 'sheet-undo', { testid: 'sheet-undo' })}
              {cmdButton(ctx, 'sheet-redo', { testid: 'sheet-redo' })}
            </>
          }
          rightSlot={
            <BarButton
              icon="auto_awesome"
              label={aiOpen ? 'Hide PlexiiAssist' : 'Show PlexiiAssist'}
              onClick={toggleSidePane}
              controls={SIDE_PANE_DOM_ID}
              readOnlySafe
              testid="sheet-ai-toggle"
            />
          }
        />
      }
      rail={
        <ToolRail
          testid="sheet-rail"
          items={railItems}
          ctx={ctx}
          openPanels={sidePane ? [...open, sidePane] : open}
          readOnly={readOnly}
          ariaLabel="Sheet tools"
        />
      }
      rightPane={
        <ShellSidePane
          testid="sheet-side-panel"
          collapseTestid="sheet-ai-collapse"
          panes={panes}
          activeId={sidePane}
          onChange={(id) => onAiOpen(id === 'ai')}
        />
      }
      bottom={bottom}
      panels={
        open.length ? (
          <>
            {open.map((p) => {
              const meta = PANEL_META[p]
              return (
                <ShellPanel
                  key={p}
                  id={p}
                  title={meta.title}
                  icon={meta.icon}
                  width={meta.width}
                  open
                  pinnable={meta.pinnable}
                  pinned={pinned.includes(p)}
                  onPinnedChange={(v) => setPin(p, v)}
                  onClose={() => closePanel(p)}
                  testid={`sheet-panel-${p}`}
                >
                  {panelBody(p)}
                </ShellPanel>
              )
            })}
          </>
        ) : null
      }
    >
      {children}
    </OfficeShellLayout>
  )
}
