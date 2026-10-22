import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import Icon from '../Icon'
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
import StylesPanel from './editor/StylesPanel'
import type { HeadingStyle, HeadingStyles, PageOrientation, PaperSize } from './editor/headingStyles'
import { officeMenuItems, WRITE_TABS, writeRailItems, type WCtx, type WriteDialog, type WritePanel, type WriteSidePane } from './editor/writeRibbon'

// The PlexiiWrite frame on the shared office shell (SPEC §6.2): the menu bar
// and ribbon tabs on one row, the active tab's controls under them, the tool
// rail on the left, the document, the reading strip along the bottom, overlay
// panels beside the rail, and the shared right side pane for content (Outline,
// Comments, the assistant). No property inspector — owner ruling D1, as
// amended by §2.5a, which is what keeps the three content panes on the right.
//
// It owns which tab, panels and pane are open. The document, its editor and
// every flow that touches a file or the store stay with DocEditor and arrive
// here as props: this component places chrome, it does not own the document.

const TAB_KEY = 'plexii.doc.ribbonTab'
const COLLAPSE_KEY = 'plexii.doc.ribbonCollapsed'
const PINS_KEY = 'plexii.doc.pinnedPanels'

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

export interface WriteChromeProps {
  editor: Editor
  readOnly: boolean
  /** <DocMenuBar> — it shares row 1 with the tabs (owner ruling D2). */
  menuBar: ReactNode
  // ── formatting state the tabs read
  styleLabel: string
  currentHeadingLevel: number | null
  headingStyles: HeadingStyles
  onSetHeadingStyle: (level: number, patch: Partial<HeadingStyle>) => void
  wordCount: number
  // ── page setup
  pageView: boolean
  onSetPageView: (v: boolean) => void
  orientation: PageOrientation
  paperSize: PaperSize
  onSetPageSetup: (patch: { orientation?: PageOrientation; size?: PaperSize }) => void
  showRuler: boolean
  onSetShowRuler: (v: boolean) => void
  // ── track changes
  suggesting: boolean
  onSetSuggesting: (v: boolean) => void
  hasTracked: boolean
  onAcceptAll: () => void
  onRejectAll: () => void
  // ── the one right content pane
  sidePane: WriteSidePane | null
  onSidePane: (p: WriteSidePane | null) => void
  /** Write's content panes — build them with docSidePanes() from DocSidePanel. */
  panes: SidePane[]
  // ── host-owned flows
  onInsertImage: () => void
  onInsertWidget: () => void
  onInsertSnippet: () => void
  onSaveSnippet: () => void
  onOpenLink: () => void
  onImportDocx: () => void
  onExportDocx: () => void
  onExportPdf: () => void
  onAskAi: () => void
  /** PlexiiAssist: the one assistant. See WCtx.openAssistant. */
  onOpenAssistant: () => void
  onFocusMode: () => void
  onFind: () => void
  onWordCount: () => void
  onA11y: () => void
  /** Panel bodies DocEditor owns: the margins form and the header/footer form. */
  marginsPanel?: ReactNode
  headerFooterPanel?: ReactNode
  /** The reading strip (words, pages, layout toggle) along the bottom. */
  bottom?: ReactNode
  /** The document itself. */
  children: ReactNode
}

const PANEL_META: Record<WritePanel, { title: string; icon: string; width?: number; pinnable?: boolean }> = {
  styles: { title: 'Styles', icon: 'format_size', width: 340, pinnable: true },
  margins: { title: 'Margins', icon: 'straighten', width: 300 },
  headerfooter: { title: 'Header and footer', icon: 'description', width: 320 },
  office: { title: 'Office files', icon: 'folder_open', width: 240 }
}

export default function WriteChrome(props: WriteChromeProps): JSX.Element {
  const {
    editor,
    readOnly,
    menuBar,
    sidePane,
    onSidePane,
    marginsPanel,
    headerFooterPanel,
    bottom,
    children
  } = props

  // Re-render on every editor transaction, so the mark toggles, the alignment
  // state and the contextual Table tab reflect where the cursor actually is.
  // Toolbar.tsx carried this listener; the bar it replaced would otherwise show
  // whatever was true when the chrome last rendered for another reason.
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = (): void => setTick((t) => t + 1)
    editor.on('transaction', bump)
    return () => {
      editor.off('transaction', bump)
    }
  }, [editor])

  const [tab, setTabState] = useState<string>(() => readPref<string>(TAB_KEY, 'home'))
  const [collapsed, setCollapsedState] = useState<boolean>(() => readPref<boolean>(COLLAPSE_KEY, false))
  const [open, setOpen] = useState<WritePanel[]>([])
  const [pinned, setPinned] = useState<WritePanel[]>(() => readPref<WritePanel[]>(PINS_KEY, []))

  const changeTab = useCallback((id: string) => {
    setTabState(id)
    writePref(TAB_KEY, id)
  }, [])
  const changeCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v)
    writePref(COLLAPSE_KEY, v)
  }, [])

  const isPanelOpen = useCallback((p: WritePanel) => open.includes(p), [open])
  const togglePanel = useCallback(
    (p: WritePanel) => setOpen((o) => (o.includes(p) ? o.filter((x) => x !== p) : [...o, p])),
    []
  )
  const closePanel = useCallback((p: WritePanel) => setOpen((o) => o.filter((x) => x !== p)), [])
  const setPin = useCallback((p: WritePanel, v: boolean) => {
    setPinned((cur) => {
      const next = v ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)
      writePref(PINS_KEY, next)
      return next
    })
  }, [])

  const toggleSidePane = useCallback(
    (p: WriteSidePane) => onSidePane(sidePane === p ? null : p),
    [sidePane, onSidePane]
  )

  const openDialog = useCallback(
    (d: WriteDialog) => {
      if (d === 'find') props.onFind()
      else if (d === 'wordcount') props.onWordCount()
      else props.onA11y()
    },
    [props]
  )

  const ctx: WCtx = useMemo(
    () => ({
      editor,
      readOnly,
      styleLabel: props.styleLabel,
      headingStyles: props.headingStyles,
      setHeadingStyle: props.onSetHeadingStyle,
      wordCount: props.wordCount,
      pageView: props.pageView,
      setPageView: props.onSetPageView,
      orientation: props.orientation,
      paperSize: props.paperSize,
      setPageSetup: props.onSetPageSetup,
      showRuler: props.showRuler,
      setShowRuler: props.onSetShowRuler,
      suggesting: props.suggesting,
      setSuggesting: props.onSetSuggesting,
      hasTracked: props.hasTracked,
      acceptAll: props.onAcceptAll,
      rejectAll: props.onRejectAll,
      togglePanel,
      isPanelOpen,
      sidePane,
      toggleSidePane,
      openDialog,
      insertImage: props.onInsertImage,
      insertWidget: props.onInsertWidget,
      insertSnippet: props.onInsertSnippet,
      saveSnippet: props.onSaveSnippet,
      openLink: props.onOpenLink,
      importDocx: props.onImportDocx,
      exportDocx: props.onExportDocx,
      exportPdf: props.onExportPdf,
      askAi: props.onAskAi,
      openAssistant: props.onOpenAssistant,
      focusMode: props.onFocusMode
    }),
    [editor, readOnly, props, togglePanel, isPanelOpen, sidePane, toggleSidePane, openDialog]
  )

  const railItems = useMemo(() => writeRailItems(), [])
  // Which tab is really showing: the remembered one while it is visible, else Home.
  const activeTab = resolveActiveTab(WRITE_TABS, ctx, tab)

  function panelBody(p: WritePanel): ReactNode {
    if (p === 'styles')
      return (
        <StylesPanel
          editor={editor}
          currentHeadingLevel={props.currentHeadingLevel}
          headingStyles={props.headingStyles}
          onApplyLevel={(lvl) =>
            lvl === 0
              ? editor.chain().focus().setParagraph().run()
              : editor.chain().focus().setHeading({ level: lvl as 1 | 2 | 3 | 4 | 5 | 6 }).run()
          }
          onSet={props.onSetHeadingStyle}
          onOpenLink={() => {
            closePanel('styles')
            props.onOpenLink()
          }}
        />
      )
    if (p === 'margins') return marginsPanel
    if (p === 'headerfooter') return headerFooterPanel
    return (
      <div className="py-1 text-[12px]">
        {officeMenuItems(ctx).map((it) => (
          <button
            key={it.label}
            onClick={() => {
              closePanel('office')
              it.run()
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)] rounded"
          >
            <Icon name={it.icon} size={14} className="text-[var(--ink-40)]" /> {it.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <OfficeShellLayout
      testid="doc-shell"
      bar={
        <ContextBar
          testid="doc-toolbar"
          tabs={WRITE_TABS}
          ctx={ctx}
          activeTab={activeTab}
          onTabChange={changeTab}
          collapsed={collapsed}
          onCollapsedChange={changeCollapsed}
          readOnly={readOnly}
          menuBar={menuBar}
          pinnedStart={
            <>
              <BarButton icon="undo" label="Undo" shortcut="⌘Z" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} testid="doc-undo" />
              <BarButton icon="redo" label="Redo" shortcut="⇧⌘Z" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} testid="doc-redo" />
            </>
          }
          rightSlot={
            <>
              <span className="shrink-0 px-1 text-[11px] text-[var(--ink-40)] fb-tabular">{props.wordCount} words</span>
              <BarButton icon="search" label="Find & replace" shortcut="⌘F" onClick={props.onFind} readOnlySafe testid="doc-find" />
              <BarButton
                icon="right_panel_open"
                label={sidePane ? 'Hide the side pane' : 'Show the side pane'}
                onClick={() => onSidePane(sidePane ? null : 'comments')}
                controls={SIDE_PANE_DOM_ID}
                readOnlySafe
                testid="doc-sidepane-toggle"
              />
            </>
          }
        />
      }
      rail={
        <ToolRail
          testid="doc-rail"
          items={railItems}
          ctx={ctx}
          openPanels={sidePane ? [...open, sidePane] : open}
          readOnly={readOnly}
          ariaLabel="Document tools"
        />
      }
      rightPane={
        <ShellSidePane
          testid="doc-side-panel"
          panes={props.panes}
          activeId={sidePane}
          onChange={(id) => onSidePane((id as WriteSidePane | null) ?? null)}
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
                  testid={`doc-panel-${p}`}
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
