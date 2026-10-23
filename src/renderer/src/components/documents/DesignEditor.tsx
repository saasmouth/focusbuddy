import { dragCarriesFiles } from '../../lib/filesDrag'
import { filesDropRefs, pagePointFromDrop, runContentDrop } from '../../lib/filesContentDrop'
import { pasteConverted } from '../../lib/clipboardPaste'
import { widgetFileGroupId } from '@shared/widgetFiles'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DeckTheme, Slide, SlideElement, SlideTextElement } from '@shared/types'
import SlideCanvas from './slides/SlideCanvas'
import {
  addElement,
  alignElements,
  deleteElement,
  distributeElements,
  duplicateElement,
  elementId,
  elementText,
  groupElements,
  moveElementsBy,
  reorderMany,
  setElementText,
  ungroupElements,
  updateElement,
  type AlignEdge,
  styleTextElement,
  setParagraphAlign
} from './slides/slideOps'
import {
  BASE_LAYER_ID,
  DESIGN_TEMPLATES,
  composeDesign,
  buildDesignVariations,
  designFromTemplate,
  designLayers,
  elementLocked,
  elementVisible,
  findDesignSize,
  masterForPage,
  normalizeDesignBody,
  pageCountOf,
  pageNumberOf,
  resizeDesign,
  resolveMasterElements,
  snapTargets,
  spreadsOf,
  storyFrames,
  type DesignBody,
  type DesignLayer,
  type DesignMaster,
  type DesignSize,
  withPages
} from '@shared/design'
import { applyStoryFlows, linkFrames, pruneOrphanStories, setStoryText as writeStoryText, storyText, unlinkFrame } from '@shared/designStories'
import { findLayoutStyle } from '@shared/designAutoLayout'
import type { ContentDoc } from '@shared/designContent'
import RedesignWizard from './design/RedesignWizard'
import StoryEditor from './design/StoryEditor'
import FrameTextEditor, { caretFromClick } from './design/FrameTextEditor'
import { paragraphsForStory } from '@shared/designStories'
import { caretDocStart, type DocCaret, type DocSelection } from '@shared/designTextEdit'
import type { FlowMeasurer } from '@shared/designFlow'
import LayoutOverlay from './design/LayoutOverlay'
import LayoutPanel from './design/LayoutPanel'
import PreflightPanel from './design/PreflightPanel'
import { useElementClipboard } from './slides/useElementClipboard'
import StylesPanel from './design/StylesPanel'
import StartFromMenu from './design/StartFromMenu'
import { DESIGN_TABS, type DesignCtx, type DesignPanelId } from './design/ribbon'
import { BarButton, ContextBar, escapeIntent, OfficeShellLayout, PANEL_SHEET_BELOW, ShellPanel, ShellSidePane, SIDE_PANE_DOM_ID, ToolRail, useShellChrome, type SidePane } from '../office/shell'
import { designRailIdForTool, designRailItems, type DesignRailCmds } from './design/rail'
import SwatchesPanel from './design/SwatchesPanel'
import { preflight, preflightSummary } from '@shared/designPreflight'
import DesignRulers from './design/DesignRulers'
import Icon from '../Icon'
import SlideElementView from './slides/SlideElementView'
import { acceptsWidgetDrag, widgetIdFromDrop } from '../../lib/widgetDropInsert'
import { useBrandStore } from '../../stores/brand'
import BrandKitModal from './BrandKitModal'
import { GOOGLE_FONTS, loadGoogleFont, familyLabel } from '../../lib/googleFonts'
import DesignAiPanel from './DesignAiPanel'
import DesignMenuBar from './editor/DesignMenuBar'
import RecordFindReplace from './editor/RecordFindReplace'
import { applyDesignReplacements, designFindRecords, frameForRecord } from './design/designFind'
import type { FindRecord, RecordHit } from '../../lib/recordFind'
import type { FindOptions } from '../../lib/docFind'
import { marksForElement } from './design/designFindHighlights'
import type { DocumentOps } from './editor/documentOps'
import { usePrintSource } from './editor/printSource'
import { useAccountStore } from '../../stores/account'
import { personDisplayName } from '../../lib/personName'
import WidgetPickerDialog from './embed/WidgetPickerDialog'
import { checkDesignA11y } from '../../lib/designA11y'
import SnippetLibrary from '../snippets/SnippetLibrary'
import SaveSnippetDialog from '../snippets/SaveSnippetDialog'
import type { DesignSnippetBody, Snippet } from '@shared/snippets'
import { designBodyFromSelection, designSnippetTargetId, insertDesignSnippet, suggestedDesignSnippetName, useDesignSnippetTarget } from './design/designSnippets'
import { officeAccepts } from '../../lib/officeSnippets'
import { pastedSnippet } from '../../lib/clipboardPaste'
import type { SnippetKind } from '@shared/snippets'
import CanvasContextMenu from '../CanvasContextMenu'
import { canvasMenu, objectMenu } from '../../lib/menus/officeContextMenu'
import { barProps, ctxRow } from '../../lib/menus/officeCommand'
import { runCommandKey } from '../../lib/menus/commandKeys'
import { buildDesignCommands, type DesignCommands } from './design/designCommands'

// PlexiDesign — the on-platform design studio. A design is a single arbitrary-size
// canvas of the same elements a slide uses, so this editor reuses the proven slide
// canvas (drag, resize, snap guides, marquee) at the design's own size. The studio
// adds the design-specific layer: size presets, brand-aware templates, AI copy and
// AI image generation, brand colors, and per-element styling.

interface Props {
  content: unknown
  title: string
  onChange: (body: unknown) => void
  /**
   * A VIEWER of this document: it may be read, never changed. Set by
   * LiveDocEditorView from the live document's member role (myRole, which the
   * signal server returns as of v123).
   *
   * Nothing writes while this is true — not an edit, not a re-flow, not undo
   * or redo — so no change reaches onChange and none reaches the local
   * document either. Greying the controls is NOT the mechanism; it is the
   * courtesy on top of the four guards below, because a disabled button is
   * not a permission check.
   *
   * It is not security on its own either: the enforcement that matters is the
   * signal server refusing a viewer's Yjs updates (yjsDocAuth.ts).
   */
  readOnly?: boolean
  // Live co-editing only. When true, a change in the content prop's identity is
  // folded in as a peer's merge. Off by default for the single-user editor, where
  // our own saves come back as a new identity and folding them would fight local
  // editing.
  foldExternal?: boolean
  /**
   * The document this editor is showing, bound by the HOST (documentOps.ts).
   * Passed straight through to the menu bar, which reads no store: it used to
   * act on the documents store's `active`, so in a desk widget File › Move to
   * trash trashed whatever Documents last opened (shipped in public 4.3.33).
   * Absent in a snippet session, which has no document, and the document
   * items are then not offered at all.
   */
  documentOps?: DocumentOps
}




/** Stable, so the library's refresh effect (keyed on kinds) runs once per open. */
// Every kind with a conversion into this app, derived from the builders.
const DESIGN_KINDS: SnippetKind[] = officeAccepts('design')

// Which right-hand pane was last open, remembered per app like the other
// office editors' (plexii.diagram.sidePane, plexii.slides.pinnedPanels).
const SIDE_PANE_KEY = 'plexii.design.sidePane'

// Glyph measurement for the flow engine, using the browser's own font engine
// through one reused offscreen context. Returning 0 without a DOM (tests, the
// main process) is deliberate: the caller then gets an empty flow rather than a
// made-up one.
let flowCtx: CanvasRenderingContext2D | null = null
const domFlowMeasure: FlowMeasurer = (text, font) => {
  if (!flowCtx) {
    if (typeof document === 'undefined') return 0
    flowCtx = document.createElement('canvas').getContext('2d')
  }
  if (!flowCtx) return 0
  flowCtx.font = font
  return flowCtx.measureText(text).width
}

// A neutral theme for the canvas; designs carry their own colors per element, so
// the theme only supplies a fallback background and text color.
const NEUTRAL_THEME: DeckTheme = {
  id: 'design',
  name: 'Design',
  background: '#ffffff',
  fontHeading: 'Inter, system-ui, sans-serif',
  fontBody: 'Inter, system-ui, sans-serif',
  accent: '#6d5dfc',
  textColor: '#1c1917',
  titleStyle: { fontSize: 48, bold: true, color: '#1c1917' },
  bodyStyle: { fontSize: 24, color: '#44403c' }
}

/** The tools the rail can arm. 'select' is the resting state. */
export type DesignTool = 'select' | 'text' | 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'line'

/**
 * What a plain click places, as a fraction of the canvas width — the same
 * proportions the old one-shot buttons used, so a click still produces the
 * element people were used to getting.
 */
const TOOL_DEFAULT: Record<Exclude<DesignTool, 'select'>, { w: number; h: number }> = {
  text: { w: 0.8, h: 0.14 },
  rect: { w: 0.3, h: 0.3 },
  roundRect: { w: 0.3, h: 0.3 },
  ellipse: { w: 0.3, h: 0.3 },
  triangle: { w: 0.3, h: 0.3 },
  line: { w: 0.6, h: 0 }
}

export default function DesignEditor({
  content,
  title,
  onChange,
  documentOps,
  readOnly = false,
  foldExternal = false
}: Props): JSX.Element {
  const [design, setDesign] = useState<DesignBody>(() => normalizeDesignBody(content))
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // Find… (⌘F) and Find and replace… (⇧⌘H) share one panel; which opened it
  // decides whether the Replace row shows. Design was the last office app
  // without them (SPEC §9.6).
  const [findOpen, setFindOpen] = useState<false | 'find' | 'replace'>(false)
  // What the panel is searching for, and the hit it is on, so the canvas can
  // MARK them in the text it draws. A decoration: nothing here is written to
  // the design, so searching never makes a document dirty and a read-only
  // design can still be searched.
  const [findMark, setFindMark] = useState<{ query: string; opts: FindOptions; current: RecordHit | null }>({
    query: '',
    opts: {},
    current: null
  })
  // A brand-new, empty design: the Start-from menu opens itself once, which is
  // the first-run help the permanent chip grid used to provide.
  const [startEmpty, setStartEmpty] = useState(() => normalizeDesignBody(content).elements.length === 0)

  // ── Armed tools (spec §3.2, owner decision D4) ─────────────────────────────
  // A tool is armed until it places something, then the editor returns to
  // Select — as PowerPoint and Canva do. Double-clicking a tool locks it, as
  // Illustrator's tool lock does, and Esc always returns to Select.
  // Which ContextBar tab is showing, whether its row is collapsed (D5,
  // remembered) and the shapes flyout's last pick: the same host state as
  // every office app (SPEC §3.9). Design opens on Home like the others; an
  // empty design's Start-from menu opens itself once, the first time Layout
  // is shown while the design is still empty (startEmpty, below). Anchoring
  // that to the EDITOR rather than the control's mount is what stops the menu
  // springing open again every time someone returns to the Layout tab.
  // Panels you use WITH a selection — swatches, styles, layout, preflight —
  // open PINNED, because an unpinned overlay closes on an outside click and
  // the outside click is the whole job: select a shape, then give it a
  // colour. Unpinned they shut the moment you touched the canvas.
  const [pinnedPanels, setPinnedPanels] = useState<string[]>(['layout', 'styles', 'swatches', 'preflight'])

  const chrome = useShellChrome('design', { shapes: 'tool-rect' })
  const [tool, setTool] = useState<DesignTool>('select')
  const [toolLocked, setToolLocked] = useState(false)
  function armTool(next: DesignTool, lock = false): void {
    setTool(next)
    setToolLocked(lock && next !== 'select')
    if (next !== 'select') setSelectedIds([])
    // A shape armed by its key is the flyout's last pick too, as in Deck.
    if (next !== 'select' && next !== 'text') chrome.onFlyoutPick('shapes', `tool-${next}`)
  }
  const [panel, setPanel] = useState<DesignPanelId | 'none'>(
    () => 'none'
  )
  const [aiPrompt, setAiPrompt] = useState('')
  const [imgPrompt, setImgPrompt] = useState('')
  const [stockQuery, setStockQuery] = useState('')
  const [stockResults, setStockResults] = useState<Array<{ id: string; thumb: string; full: string; alt: string; photographer: string }>>([])
  const [variations, setVariations] = useState<DesignBody[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // The canvas wrapper's measured box, and the rect of whichever ShellPanel is
  // pinned open over it. Both feed the page's fit, below.
  const [wrapBox, setWrapBox] = useState({ w: 688, left: 0 })
  const [panelRect, setPanelRect] = useState<DOMRect | null>(null)
  const [brandOpen, setBrandOpen] = useState(false)
  // The non-printing layout aids — margin box, column grid, guides, wrap
  // outlines. On by default, because a layout program that hides its grid is
  // just a poster tool.
  const [showLayoutAids, setShowLayoutAids] = useState(true)
  // The story open in the story editor, or null when it is closed. Threaded copy
  // is written here rather than in a frame on the canvas — a five-page article
  // cannot be typed inside a two-inch column.
  const [openStoryId, setOpenStoryId] = useState<string | null>(null)
  // Typing on the page: which story the caret is in, and where. Null means the
  // canvas is in its ordinary object-selection mode.
  const [textEdit, setTextEdit] = useState<{ storyId: string; selection: DocSelection } | null>(null)
  const textDragging = useRef(false)
  // When the last keystroke landed, so a run of typing is one undo step.
  const lastTypedAt = useRef(0)
  const [widgetPickerOpen, setWidgetPickerOpen] = useState(false)
  // Saved snippets: the library (insert) and the save dialog (capture). The
  // dialog gets an EMPTY body when nothing is selected, so it can say so
  // rather than the menu item appearing to do nothing.
  const [snippetLibraryOpen, setSnippetLibraryOpen] = useState(false)
  // Right-click on the page (SPEC §9.3): a frame gets the object menu, the empty
  // page the canvas menu; text being typed in keeps the native text menu.
  const [designMenu, setDesignMenu] = useState<{ x: number; y: number; onElement: boolean } | null>(null)
  const dcmdsRef = useRef<DesignCommands | null>(null)
  const [snippetDraft, setSnippetDraft] = useState<DesignSnippetBody | null>(null)
  // This mounted editor, as a snippet destination: the same design open in the
  // editor and in a desk widget is two destinations, so the id is the mount.
  const snippetScope = useId()
  // Which of the shared right pane's panes is showing, or null for collapsed
  // (SPEC §2.5a). The host owns it and remembers it per app, exactly as
  // Diagrams and Write do; PlexiiAssist is the default so the assistant stays
  // discoverable.
  const [sidePane, setSidePane] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(SIDE_PANE_KEY)
      return v === null ? 'assist' : (JSON.parse(v) as string | null)
    } catch {
      return 'assist'
    }
  })
  const changeSidePane = (id: string | null): void => {
    // Collapsing the story pane closes the story: the chain would otherwise
    // stay "open" with nothing on screen to show or close it.
    if (id === null && sidePane === 'story') setOpenStoryId(null)
    setSidePane(id)
    try {
      localStorage.setItem(SIDE_PANE_KEY, JSON.stringify(id))
    } catch {
      /* the remembered pane is a convenience */
    }
  }
  // The signed-in user's name for the assistant greeting. Falls back to a neutral
  // greeting when signed out (no fabricated name).
  const account = useAccountStore((s) => s.account)
  const userName = account ? personDisplayName(account, account.email) : null
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Undo / redo history. designRef always holds the current body so a commit can
  // record the prior state without a stale closure.
  const designRef = useRef<DesignBody>(design)
  designRef.current = design
  const [past, setPast] = useState<DesignBody[]>([])
  const [future, setFuture] = useState<DesignBody[]>([])
  // Mirror history to refs so the handlers (and the keyboard shortcuts, whose
  // effect closure would otherwise be stale) always read the current stacks.
  const pastRef = useRef<DesignBody[]>(past)
  pastRef.current = past
  const futureRef = useRef<DesignBody[]>(future)
  futureRef.current = future

  // The org brand kit, read live from the brand store. Until a brand is saved it
  // is the default brand, exactly like a fresh Canva account, so every action is
  // always on a usable brand.
  const brand = useBrandStore((s) => s.kit)
  const loadBrand = useBrandStore((s) => s.load)
  useEffect(() => {
    void loadBrand()
  }, [loadBrand])

  // Fold live co-editing merges. When the content prop changes identity (a peer's
  // edit arrived through the CRDT; our own edits reconcile under a private origin
  // that never refreshes the prop, so this only fires for remote merges), replace
  // the design with the merged body. We do not push this onto the undo stack — a
  // peer's edit is not our action to undo. The first run is skipped because the
  // initial state already reflects the first content.
  const firstFold = useRef(true)
  useEffect(() => {
    if (!foldExternal) return
    if (firstFold.current) {
      firstFold.current = false
      return
    }
    const next = normalizeDesignBody(content)
    designRef.current = next
    setDesign(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, foldExternal])

  // Ensure every Google font the design (and the brand) uses is loaded, so the
  // canvas renders in the right typeface rather than a fallback.
  useEffect(() => {
    loadGoogleFont(familyLabel(brand.fontHeading))
    loadGoogleFont(familyLabel(brand.fontBody))
    for (const el of design.elements) {
      if (el.type === 'text' && el.fontFamily) loadGoogleFont(familyLabel(el.fontFamily))
    }
  }, [design.elements, brand.fontHeading, brand.fontBody])

  // Re-flow every threaded story whenever the document changes. The measurer is
  // the browser's own font engine, so the breaks stored on each frame are the
  // real ones — which is what lets the exporter reproduce the page exactly.
  //
  // applyStoryFlows returns the SAME body when nothing moved, so this settles in
  // one pass and never loops; and the result is written with `replace`, not
  // `commit`, because re-flowing is a consequence of an edit, not an edit.
  useEffect(() => {
    // The brand kit decides the body and heading families and the accent, so
    // it has to be the SAME kit the caret arithmetic uses (paragraphsForStory,
    // below). Without it the page was typeset in the default families while
    // the caret was measured in the person's own — so for anyone with a brand
    // font, the caret drifted along the line.
    if (readOnly) return
    const next = applyStoryFlows(design, domFlowMeasure, brand)
    if (next !== design) {
      designRef.current = next
      setDesign(next)
      onChange(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design])

  // Measure the canvas wrapper: its width fits the page, its left edge decides
  // whether a pinned panel is over it.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWrapBox({ w: el.clientWidth, left: el.getBoundingClientRect().left })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A pinned ShellPanel floats over the canvas's left edge by design (SPEC
  // §2.4) and reports its rect so the host can inset its viewport. Here the
  // page IS the work, so it must never sit behind the glass: in a 1694px
  // window the Page layout panel covered the left 113px of an A4 page. When
  // the centred page would run under the panel, the page is inset past it
  // instead — and when it would clear the panel anyway, nothing moves.
  //
  // The decision is made on the un-inset geometry, so it cannot oscillate.
  // A panel in sheet mode (a narrow window, where it spans the full width and
  // sits at the bottom) is left alone; there the canvas scrolls.
  const { canvasW, canvasInset } = useMemo(() => {
    const plain = Math.max(280, Math.min(wrapBox.w - 48, 720))
    let inset = 0
    if (panelRect && panelRect.width <= wrapBox.w / 2) {
      const pageLeft = wrapBox.left + 24 + (wrapBox.w - 48 - plain) / 2
      if (pageLeft < panelRect.right + 8) {
        inset = Math.max(0, Math.round(panelRect.right + 8 - wrapBox.left - 24))
      }
    }
    return { canvasW: Math.max(280, Math.min(wrapBox.w - 48 - inset, 720)), canvasInset: inset }
  }, [wrapBox, panelRect])

  // One handler for all four pinnable panels: only ever one is open (`panel` is
  // a single id), and ShellPanel reports null as it closes or is unpinned. The
  // identity must be stable, or the panel's reporting effect re-runs on every
  // render of this editor.
  const reportPanelRect = useCallback((r: DOMRect | null) => setPanelRect(r), [])

  const size: DesignSize = findDesignSize(`${design.width}x${design.height}`) ?? {
    id: 'custom',
    category: design.category ?? 'custom',
    label: `${design.width} × ${design.height}`,
    w: design.width,
    h: design.height
  }

  // Keep pages[activePage] in step with the live top-level elements/background,
  // so the multi-page array is always the source of truth.
  function syncActivePage(b: DesignBody): DesignBody {
    // While a master is being edited, the top-level elements ARE the master's,
    // so mirroring them onto the page would overwrite the page's own content.
    if (b.editingMasterId) return b
    // withPages first: a design with no pages array has ONE implied page, and
    // mapping over `pages ?? []` silently dropped it — which is how adding a
    // second page to a fresh design deleted the first one's artwork.
    const base = withPages(b)
    const active = base.activePage ?? 0
    const pages = (base.pages ?? []).map((p, i) => (i === active ? { ...p, elements: b.elements, background: b.background } : p))
    return { ...base, pages }
  }

  // The single writer: records the prior body on the undo stack, clears redo, and
  // persists. Every change to the design flows through here.
  function commit(next: DesignBody): void {
    if (readOnly) return
    const synced = syncActivePage(next)
    setPast([...pastRef.current.slice(-59), designRef.current])
    setFuture([])
    designRef.current = synced
    setDesign(synced)
    onChange(synced)
    lastTypedAt.current = 0
  }

  /**
   * A keystroke. Consecutive typing COALESCES into one undo entry rather than one
   * per character — otherwise undo would walk backwards a letter at a time,
   * which is useless in a document of several thousand words. A pause, or any
   * other kind of edit, closes the run.
   */
  function commitTyping(next: DesignBody): void {
    if (readOnly) return
    const now = Date.now()
    const synced = syncActivePage(next)
    const continuing = now - lastTypedAt.current < 900 && pastRef.current.length > 0
    if (!continuing) {
      setPast([...pastRef.current.slice(-59), designRef.current])
      setFuture([])
    }
    lastTypedAt.current = now
    designRef.current = synced
    setDesign(synced)
    onChange(synced)
  }

  const pages = design.pages ?? []
  const activePage = design.activePage ?? 0

  // Every searchable piece of text: a threaded story's blocks, and the
  // paragraphs of frames that carry their own text (designFind.ts says why
  // those are the two places and why a story's frames are not searched).
  const findRecords = useMemo(() => designFindRecords(design), [design])

  /** Show a hit: switch to its page, select its frame, bring it on screen. */
  function goToHit(hit: RecordHit): void {
    setFindMark((m) => ({ ...m, current: hit }))
    const key = hit.key
    const target = frameForRecord(designRef.current, key)
    if (!target) return
    // goToPage clears the selection, so select after it rather than before.
    if (target.pageIndex !== (designRef.current.activePage ?? 0)) goToPage(target.pageIndex)
    setSelectedIds([target.elementId])
    // Best effort: the element may not be mounted yet on a page just switched
    // to, and a hit already on screen needs no scrolling.
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-element-id="${CSS.escape(target.elementId)}"]`)
        ?.scrollIntoView({ block: 'center', inline: 'center' })
    })
  }

  /** Replace-all is ONE undo entry: one body, committed once. */
  function replaceText(_changes: FindRecord[], hits: RecordHit[], replacement: string): void {
    if (readOnly || !hits.length) return
    commit(applyDesignReplacements(designRef.current, hits, replacement))
  }

  function goToPage(i: number): void {
    const d = designRef.current
    const ps = d.pages ?? []
    if (i < 0 || i >= ps.length || i === (d.activePage ?? 0)) return
    const saved = syncActivePage(d)
    const target = saved.pages![i]
    commit({ ...saved, activePage: i, elements: target.elements, background: target.background })
    setSelectedIds([])
  }
  function addPage(): void {
    const saved = syncActivePage(designRef.current)
    const np: import('@shared/design').DesignPage = { id: `pg-${Date.now().toString(36)}`, background: { type: 'solid', color: '#ffffff' }, elements: [] }
    const nextPages = [...(saved.pages ?? []), np]
    commit({ ...saved, pages: nextPages, activePage: nextPages.length - 1, elements: np.elements, background: np.background })
    setSelectedIds([])
  }
  /**
   * Copy a page, with everything on it, and put it straight after.
   *
   * Every element needs a fresh id and a deep copy: two pages sharing an
   * element id makes selection ambiguous, and two pages sharing a fill object
   * means recolouring one recolours the other.
   */
  function duplicatePage(i: number): void {
    const saved = withPages(syncActivePage(designRef.current))
    const ps = saved.pages ?? []
    const src = ps[i]
    if (!src) return
    const copy: import('@shared/design').DesignPage = {
      ...structuredClone(src),
      id: `pg-${Date.now().toString(36)}`,
      elements: (src.elements ?? []).map((el) => ({ ...structuredClone(el), id: elementId() }))
    }
    const nextPages = [...ps.slice(0, i + 1), copy, ...ps.slice(i + 1)]
    commit({
      ...saved,
      pages: nextPages,
      activePage: i + 1,
      elements: copy.elements,
      background: copy.background ?? saved.background
    })
    setSelectedIds([])
  }

  function deletePage(i: number): void {
    const saved = syncActivePage(designRef.current)
    const ps = saved.pages ?? []
    if (ps.length <= 1) return
    const nextPages = ps.filter((_, idx) => idx !== i)
    const cur = saved.activePage ?? 0
    const newActive = Math.max(0, Math.min(nextPages.length - 1, cur > i ? cur - 1 : cur))
    const target = nextPages[newActive]
    commit({ ...saved, pages: nextPages, activePage: newActive, elements: target.elements, background: target.background })
    setSelectedIds([])
  }

  function update(patch: Partial<DesignBody>): void {
    commit({ ...designRef.current, ...patch })
  }

  // Run a slide-op against whatever surface is being edited — the page's own
  // elements, or the open master's furniture — and persist the result.
  //
  // `body` carries document-level fields the same op has to write (pasting a
  // threaded frame brings its story). Folded into the same commit on purpose:
  // two commits would be two undo steps, and undoing half of a paste would
  // leave a frame pointing at a story that is no longer there.
  function mutate(fn: (s: Slide) => Slide, body?: Partial<DesignBody>): void {
    const d = designRef.current
    const editingId = d.editingMasterId
    if (editingId) {
      const m = (d.masters ?? []).find((x) => x.id === editingId)
      if (!m) return
      const next = fn({ id: 'master', notes: '', elements: m.elements, background: m.background, schemaVersion: 2 })
      commit({
        ...d,
        ...(body ?? {}),
        masters: (d.masters ?? []).map((x) => (x.id === editingId ? { ...x, elements: next.elements ?? [], background: next.background } : x))
      })
      return
    }
    const slide: Slide = { id: 'design', notes: '', elements: d.elements, background: d.background, schemaVersion: 2 }
    const next = fn(slide)
    update({ ...(body ?? {}), elements: next.elements ?? [], background: next.background })
  }

  function undo(): void {
    if (readOnly) return
    const p = pastRef.current
    if (!p.length) return
    const prev = p[p.length - 1]
    setPast(p.slice(0, -1))
    setFuture([designRef.current, ...futureRef.current.slice(0, 59)])
    designRef.current = prev
    setDesign(prev)
    onChange(prev)
  }
  function redo(): void {
    if (readOnly) return
    const f = futureRef.current
    if (!f.length) return
    const next = f[0]
    setFuture(f.slice(1))
    setPast([...pastRef.current.slice(-59), designRef.current])
    designRef.current = next
    setDesign(next)
    onChange(next)
  }

  const topZ = design.elements.reduce((m, e) => Math.max(m, e.z), 0)

  // ── Selection operations ───────────────────────────────────────────────────
  function deleteSelected(): void {
    if (!selectedIds.length) return
    mutate((s) => selectedIds.reduce((acc, id) => deleteElement(acc, id), s))
    setSelectedIds([])
  }
  // Everything the canvas is editing (the master's furniture in master-edit
  // mode) that a person could click: hidden and locked layers stay out, as they
  // do for a click or a marquee. Read through the ref, so the key handler's
  // closure never selects a stale page.
  function selectAll(): void {
    const d = designRef.current
    const master = d.editingMasterId ? (d.masters ?? []).find((m) => m.id === d.editingMasterId) : null
    const els = master ? master.elements : d.elements
    setSelectedIds(els.filter((el) => elementVisible(d, el) && !elementLocked(d, el)).map((el) => el.id))
  }
  function duplicateSelected(): void {
    if (!selectedIds.length) return
    const newIds: string[] = []
    mutate((s) =>
      selectedIds.reduce((acc, id) => {
        const d = duplicateElement(acc, id)
        newIds.push(d.newId)
        return d.slide
      }, s)
    )
    setSelectedIds(newIds)
  }
  // Cut / Copy / Paste. The hook owns the DOM clipboard events — which is what
  // makes ⌘C/⌘V and the native Edit menu run the same code — and the three
  // functions it returns are what this editor's own Edit menu calls.
  const clipboard = useElementClipboard({
    app: 'design',
    insertConverted: (b) => insertSnippetHere(pastedSnippet(b)),
    canvas: () => ({ w: designRef.current.width, h: designRef.current.height }),
    selected: () => {
      const els = designRef.current.elements ?? []
      const ids = new Set(selectedIds)
      return els.filter((e) => ids.has(e.id))
    },
    topZ: () => (designRef.current.elements ?? []).reduce((m, e) => Math.max(m, e.z ?? 0), 0),
    newId: elementId,
    // A threaded frame's words live in design.stories, not on the element, so
    // a copy has to take the story with it and a paste has to land it under a
    // fresh id. Without this, pasting into the same document extended the
    // ORIGINAL story (the article silently reflowed through the new frame) and
    // pasting into another document left the id dangling and the frame empty.
    stories: () => designRef.current.stories ?? {},
    newStoryId: () => `st-${Math.random().toString(36).slice(2, 9)}`,
    onPaste: (els, stories) => {
      mutate(
        (s) => els.reduce((acc, el) => addElement(acc, el), s),
        stories
          ? { stories: { ...(designRef.current.stories ?? {}), ...(stories as Record<string, ContentDoc>) } }
          : undefined
      )
      setSelectedIds(els.map((e) => e.id))
    },
    onCut: (ids) => {
      mutate((s) => ids.reduce((acc, id) => deleteElement(acc, id), s))
      setSelectedIds([])
    },
    // While the caret is in text on the page, ⌘C means "copy these words".
    enabled: () => !textEdit
  })

  // Capture: the selection becomes a design snippet body (positions relative
  // to its top-left, with the stories and swatches it points at), or an empty
  // one so the dialog can say there is nothing to save.
  function saveSelectionAsSnippet(): void {
    setSnippetDraft(designBodyFromSelection(designRef.current, selectedIds) ?? { kind: 'design', elements: [] })
  }
  // Insertion: a duplicate onto the page being edited, through the paste
  // engine (fresh element and story ids, groups remapped, on top, clamped onto
  // the page), with its swatches resolved by name. ONE commit, so one undo
  // takes it all back, and the copy is selected afterwards. A design has no
  // read-only state today, so the only refusals are the snippet's own (another
  // kind, nothing drawable, threaded text aimed at a master page), and each
  // says why on the status line.
  // `centre` (optional, additive): where the block goes, in page coordinates,
  // for a drop from Files. Absent: centred, as before.
  function insertSnippetHere(snippet: Snippet, centre?: { x: number; y: number }): boolean {
    const landing = insertDesignSnippet(designRef.current, snippet, { newId: elementId, readOnly: false, brand, ...(centre ? { centre } : {}) })
    if ('declined' in landing) {
      setStatus(landing.declined)
      return false
    }
    // Inserting is an object edit: leave text editing first, as a click on
    // the canvas would.
    setTextEdit(null)
    commit(landing.body)
    setTool('select')
    setSelectedIds(landing.ids)
    return true
  }
  useDesignSnippetTarget(snippetScope, title, insertSnippetHere)

  function align(edge: AlignEdge): void {
    if (selectedIds.length < 1) return
    mutate((s) => alignElements(s, selectedIds, edge))
  }
  function distribute(axis: 'h' | 'v'): void {
    if (selectedIds.length < 3) return
    mutate((s) => distributeElements(s, selectedIds, axis))
  }
  function group(): void {
    if (selectedIds.length < 2) return
    mutate((s) => groupElements(s, selectedIds))
  }
  function ungroup(): void {
    if (!selectedIds.length) return
    mutate((s) => ungroupElements(s, selectedIds))
  }
  function reorderSelected(dir: 'front' | 'backmost' | 'forward' | 'back'): void {
    if (!selectedIds.length) return
    mutate((s) => reorderMany(s, selectedIds, dir))
  }
  function openDesignMenu(e: React.MouseEvent): void {
    if (readOnly) return
    const t = e.target as HTMLElement
    if (t.closest('textarea, input, [contenteditable="true"]')) return
    if (!t.closest('[data-testid="slide-canvas"]')) return
    const elId = t.closest('.react-draggable')?.querySelector('[data-element-id]')?.getAttribute('data-element-id') ?? null
    e.preventDefault()
    if (elId && !selectedIds.includes(elId)) setSelectedIds([elId])
    if (!elId) setSelectedIds([])
    setDesignMenu({ x: e.clientX, y: e.clientY, onElement: !!elId })
  }

  // Keyboard: undo/redo, duplicate, delete. Inert while typing in a field or
  // editing text on the canvas, so it never eats a keystroke meant for content.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey
      const t = e.target as HTMLElement | null
      const editing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const key = e.key.toLowerCase()
      // ⌘Y also redoes (E-13: ⇧⌘Z is the Redo shown, run from the registry below).
      if (mod && key === 'y') {
        if (editing) return
        e.preventDefault()
        redo()
        return
      }
      if (editing) return

      // Armed tools (D4). One key handler for the app, as the spec requires:
      // the rail never listens for keys. Plain letters only — a modifier here
      // would collide with Cut, Copy and the rest.
      if (!mod) {
        // Esc: an armed tool goes back to Select, otherwise the selection is
        // cleared — the same in every canvas app (SPEC §3.2).
        if (e.key === 'Escape') {
          const intent = escapeIntent(tool, selectedIds.length > 0)
          if (intent) e.preventDefault()
          if (intent === 'disarm') armTool('select')
          else if (intent === 'deselect') setSelectedIds([])
          return
        }
        const armed: Record<string, DesignTool> = {
          v: 'select',
          t: 'text',
          m: 'rect',
          l: 'ellipse',
          '\\': 'line'
        }
        const next = armed[key]
        if (next) {
          e.preventDefault()
          armTool(next)
          return
        }
      }

      // Every keyed Design command, from its definition (design/designCommands,
      // lib/menus/commandKeys): the key a menu or the ribbon shows is the key
      // that runs it, and a command that is off is not run. ⌘Z / ⇧⌘Z, ⌘D, ⌫,
      // ⌘A, ⌘G / ⇧⌘G, ⇧⌘] / ⇧⌘[ and ⌘B / ⌘I / ⌘U all arrive here.
      const c = dcmdsRef.current
      if (c && runCommandKey(Object.values(c), e)) {
        e.preventDefault()
        return
      }
      // Forward-delete does what ⌫ does, through the same gate (off for a viewer).
      if (e.key === 'Delete' && selectedIds.length && (c?.remove.enabled?.() ?? true)) {
        e.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, tool])

  function addText(): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'text',
      x: Math.round(design.width * 0.1),
      y: Math.round(design.height * 0.1),
      w: Math.round(design.width * 0.8),
      h: Math.round(design.height * 0.14),
      z: topZ + 1,
      fontFamily: brand.fontBody,
      paragraphs: [{ runs: [{ text: 'Your text', fontSize: Math.round(design.width * 0.05), color: '#1c1917' }] }]
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
  }

  /**
   * Drop a page-number frame. On a master it carries the {#} token so every page
   * that inherits it prints its own folio; on an ordinary page the token would
   * only ever resolve to that page, so the frame is placed with the number
   * already resolved and a note in the tooltip.
   */
  function insertPageNumberFrame(): void {
    const onMaster = !!designRef.current.editingMasterId
    const d = designRef.current
    const el: SlideElement = {
      id: elementId(),
      type: 'text',
      x: Math.round(d.width / 2 - 60),
      y: Math.round(d.height - (d.margins?.bottom ?? Math.round(d.height * 0.06)) - 28),
      w: 120,
      h: 28,
      z: topZ + 1,
      fontFamily: brand.fontBody,
      paragraphs: [
        {
          align: 'center',
          runs: [{ text: onMaster ? '{#}' : String(pageNumberOf(d, d.activePage ?? 0)), fontSize: 14, color: '#57534e' }]
        }
      ]
    }
    mutate((sl) => addElement(sl, el))
    setSelectedIds([el.id])
    if (!onMaster) {
      setStatus('Placed on this page only. Put it on a master page to number every page automatically.')
    }
  }

  /**
   * Build the element an armed tool places. One function for both paths: the
   * rail's armed placement passes the rect the person drew, and the Insert
   * menu passes nothing and gets the default placement it always had.
   */
  function placeTool(kind: string, rect?: { x: number; y: number; w: number; h: number }): void {
    const d = designRef.current
    const def = TOOL_DEFAULT[kind as Exclude<DesignTool, 'select'>]
    if (!def) return
    const w = rect ? Math.max(8, rect.w) : Math.round(d.width * def.w)
    const h = rect ? Math.max(kind === 'line' ? 0 : 8, rect.h) : Math.round(kind === 'line' ? 0 : d.width * def.h)
    // Keep what is placed ON the page. A click near an edge with a wide
    // default — a text frame is 80% of the page — would otherwise land half
    // off it, where it cannot be seen or clicked, and preflight would
    // immediately report it as outside the trim. Anything larger than the
    // page keeps its top-left corner on it so it can still be grabbed.
    const fit = (want: number, size: number, limit: number): number =>
      Math.max(0, Math.min(Math.round(want), Math.round(limit - size)))
    const x = fit(rect ? rect.x : d.width * (kind === 'text' ? 0.1 : kind === 'line' ? 0.2 : 0.3), w, d.width)
    const y = fit(rect ? rect.y : d.height * (kind === 'text' ? 0.1 : kind === 'line' ? 0.5 : 0.3), h, d.height)
    const z = (d.elements ?? []).reduce((m, e) => Math.max(m, e.z ?? 0), 0) + 1

    let el: SlideElement
    if (kind === 'text') {
      el = {
        id: elementId(),
        type: 'text',
        x,
        y,
        w,
        h,
        z,
        fontFamily: brand.fontBody,
        paragraphs: [{ runs: [{ text: 'Your text', fontSize: Math.round(d.width * 0.05), color: '#1c1917' }] }]
      }
    } else if (kind === 'line') {
      el = {
        id: elementId(),
        type: 'line',
        x,
        y,
        w,
        h: 0,
        z,
        x2: x + w,
        y2: y + (rect ? rect.h : 0),
        stroke: brand.colorPrimary,
        strokeWidth: Math.max(2, Math.round(d.width * 0.004))
      }
    } else {
      el = {
        id: elementId(),
        type: 'shape',
        shape: kind as 'rect' | 'ellipse' | 'roundRect' | 'triangle',
        x,
        y,
        w,
        h,
        z,
        fill: { type: 'solid', color: brand.colorPrimary }
      }
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
    // Back to Select unless the tool was locked with a double-click.
    if (!toolLocked) setTool('select')
  }

  function addShape(shape: 'rect' | 'ellipse' | 'roundRect' | 'triangle'): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'shape',
      shape,
      x: Math.round(design.width * 0.3),
      y: Math.round(design.height * 0.3),
      w: Math.round(design.width * 0.3),
      h: Math.round(design.width * 0.3),
      z: topZ + 1,
      fill: { type: 'solid', color: brand.colorPrimary }
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
  }

  function addLine(): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'line',
      x: Math.round(design.width * 0.2),
      y: Math.round(design.height * 0.5),
      w: Math.round(design.width * 0.6),
      h: 0,
      z: topZ + 1,
      x2: Math.round(design.width * 0.8),
      y2: Math.round(design.height * 0.5),
      stroke: brand.colorPrimary,
      strokeWidth: Math.max(2, Math.round(design.width * 0.004))
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
  }

  async function addImageFromFile(): Promise<void> {
    const res = await window.api.office.pickImage()
    if (res.ok && res.dataUrl) placeImage(res.dataUrl)
  }

  // Place a live desk-widget embed on the canvas. Only the id is stored; the
  // renderer resolves the widget's current content every time.
  function addWidget(widgetId: string): void {
    const w = Math.round(design.width * 0.4)
    const el: SlideElement = {
      id: elementId(),
      type: 'widget',
      widgetId,
      x: Math.round(design.width * 0.3),
      y: Math.round(design.height * 0.3),
      w,
      h: Math.round(w * 0.7),
      z: topZ + 1
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
  }

  // Drop the brand logo onto the canvas. If no brand logo is set, open the brand
  // editor so the user can add one rather than doing nothing.
  function placeLogo(): void {
    if (!brand.logoUrl) {
      setBrandOpen(true)
      return
    }
    const sizeW = Math.round(design.width * 0.22)
    const el: SlideElement = {
      id: elementId(),
      type: 'image',
      src: brand.logoUrl,
      x: Math.round(design.width * 0.06),
      y: Math.round(design.height * 0.06),
      w: sizeW,
      h: sizeW,
      z: topZ + 1,
      fit: 'contain'
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
  }

  function placeImage(src: string): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'image',
      src,
      x: Math.round(design.width * 0.1),
      y: Math.round(design.height * 0.1),
      w: Math.round(design.width * 0.5),
      h: Math.round(design.height * 0.5),
      z: topZ + 1,
      fit: 'cover'
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
  }

  async function generateImage(): Promise<void> {
    const prompt = imgPrompt.trim()
    if (!prompt) return
    setBusy('Generating image…')
    setStatus(null)
    try {
      const res = await window.api.design.generateImage({ prompt, width: design.width, height: design.height })
      if (res.ok && res.dataUrl) {
        placeImage(res.dataUrl)
        setImgPrompt('')
      } else if (res.needsKey) {
        setStatus(res.error ?? 'Add your OpenAI API key in Settings → AI · API keys to generate images.')
      } else {
        setStatus(res.error ?? 'Image generation failed.')
      }
    } finally {
      setBusy(null)
    }
  }

  async function searchStock(): Promise<void> {
    const q = stockQuery.trim()
    if (!q) return
    setBusy('Searching photos…')
    setStatus(null)
    try {
      const res = await window.api.design.searchPhotos({ query: q })
      if (res.ok && res.photos) {
        setStockResults(res.photos)
        if (!res.photos.length) setStatus('No photos found for that search.')
      } else if (res.needsKey) {
        setStockResults([])
        setStatus(res.error ?? 'Add a free Pexels API key in Settings → AI · API keys to search stock photos.')
      } else {
        setStatus(res.error ?? 'Stock search failed.')
      }
    } finally {
      setBusy(null)
    }
  }

  async function insertStock(photo: { full: string }): Promise<void> {
    setBusy('Adding photo…')
    try {
      const res = await window.api.design.fetchImage({ url: photo.full })
      if (res.ok && res.dataUrl) placeImage(res.dataUrl)
      else setStatus(res.error ?? 'Could not add that photo.')
    } finally {
      setBusy(null)
    }
  }

  async function removeBgSelected(): Promise<void> {
    if (!selected || selected.type !== 'image') return
    setBusy('Removing background…')
    setStatus(null)
    try {
      const res = await window.api.design.removeBackground({ dataUrl: selected.src })
      if (res.ok && res.dataUrl) {
        const id = selected.id
        mutate((s) => updateElement(s, id, { src: res.dataUrl }))
      } else if (res.needsKey) {
        setStatus(res.error ?? 'Add a remove.bg API key in Settings → AI · API keys to remove backgrounds.')
      } else {
        setStatus(res.error ?? 'Background removal failed.')
      }
    } finally {
      setBusy(null)
    }
  }

  async function generateVariations(): Promise<void> {
    const prompt = aiPrompt.trim()
    if (!prompt) return
    setBusy('Generating variations…')
    setStatus(null)
    try {
      const res = await window.api.design.generateVariations({ prompt, designKind: size.label, count: 6 })
      if (res.ok && res.concepts) {
        setVariations(buildDesignVariations(size, brand, res.concepts))
      } else if (res.needsApiKey) {
        setStatus(res.error ?? 'Add your Anthropic API key in Settings to generate designs.')
      } else {
        setStatus(res.error ?? 'Could not generate variations.')
      }
    } finally {
      setBusy(null)
    }
  }

  function applyVariation(v: DesignBody): void {
    commit(v)
    setVariations([])
    setSelectedIds([])
    setPanel('none')
    setAiPrompt('')
  }

  async function generateDesign(): Promise<void> {
    const prompt = aiPrompt.trim()
    if (!prompt) return
    setBusy('Designing…')
    setStatus(null)
    try {
      const res = await window.api.design.generateContent({ prompt, designKind: size.label })
      if (res.ok && res.content) {
        const body = composeDesign(size, brand, res.content)
        commit(body)
        setSelectedIds([])
        setPanel('none')
        setAiPrompt('')
      } else if (res.needsApiKey) {
        setStatus(res.error ?? 'Add your Anthropic API key in Settings to generate designs.')
      } else {
        setStatus(res.error ?? 'Design generation failed.')
      }
    } finally {
      setBusy(null)
    }
  }

  function applyTemplate(templateId: string): void {
    const tpl = DESIGN_TEMPLATES.find((t) => t.id === templateId)
    if (!tpl) return
    const tsize = findDesignSize(tpl.sizeId) ?? size
    const body = designFromTemplate(tpl, tsize, brand)
    commit(body)
    setSelectedIds([])
    setPanel('none')
  }

  function changeSize(s: DesignSize): void {
    // Magic resize: reflow the existing layout into the new size rather than just
    // changing the canvas under fixed elements. A blank canvas just takes the size.
    commit(design.elements.length ? resizeDesign(designRef.current, s) : { ...designRef.current, width: s.w, height: s.h, category: s.category })
    setPanel('none')
  }

  // Brandify: recolor shapes to the brand primary and text to a readable tone, so
  // an off-brand design snaps to the brand palette in one click.
  function brandify(): void {
    const els = design.elements.map((e) => {
      if (e.type === 'shape') return { ...e, fill: { type: 'solid' as const, color: brand.colorPrimary } }
      if (e.type === 'text')
        return {
          ...e,
          fontFamily: brand.fontHeading,
          paragraphs: e.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, color: r.color === '#ffffff' ? '#ffffff' : brand.colorPrimary })) }))
        }
      return e
    })
    update({ elements: els, brandApplied: true })
  }

  // Print… prints what Download ▸ PDF saves: the same design, every page at its
  // own size (main renders both through designPrintRender).
  usePrintSource(documentOps, () => ({ app: 'design', title: title || 'design', design }))

  async function exportAs(format: 'png' | 'pdf', printMarks = false): Promise<void> {
    setBusy(printMarks ? 'Exporting print PDF…' : `Exporting ${format.toUpperCase()}…`)
    setStatus(null)
    try {
      const res = await window.api.design.export({ design, title: title || 'design', format, printMarks })
      if (res.ok) setStatus(`Saved ${res.path}`)
      else if (res.error) setStatus(res.error)
    } finally {
      setBusy(null)
    }
  }

  const selected = design.elements.find((e) => e.id === selectedIds[0]) ?? null

  // ── Page-layout state and commands ─────────────────────────────────────────
  // Everything below is what makes this a layout program rather than a poster
  // tool: master pages, threaded stories, layers, guides and the margin grid.

  const editingMasterId = design.editingMasterId ?? null
  const editingMaster: DesignMaster | null = editingMasterId ? (design.masters ?? []).find((m) => m.id === editingMasterId) ?? null : null

  // Which elements the canvas is editing right now: a master's own furniture
  // while in master-edit mode, otherwise the page's content.
  const canvasElements = editingMaster ? editingMaster.elements : design.elements
  // Master furniture drawn beneath the page, with its page-number tokens
  // resolved for THIS page. Absent while editing the master itself, where the
  // furniture is the editable content.
  const master = editingMaster ? null : masterForPage(design, (design.pages ?? [])[design.activePage ?? 0])
  const underlay = master ? resolveMasterElements(master, { page: pageNumberOf(design, design.activePage ?? 0), pages: pageCountOf(design) }) : undefined

  // Hidden layers are not rendered; locked layers are rendered but inert.
  const visibleElements = canvasElements.filter((el) => elementVisible(design, el))
  const lockedIds = visibleElements.filter((el) => elementLocked(design, el)).map((el) => el.id)
  const snaps = snapTargets(design)

  /** A pointer event in logical page coordinates, via the scaled stage. */
  function stagePoint(e: React.PointerEvent): { x: number; y: number } | null {
    const host = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const scale = canvasW / designRef.current.width
    if (!scale) return null
    return { x: (e.clientX - host.left) / scale, y: (e.clientY - host.top) / scale }
  }

  function patchLayout(patch: Partial<DesignBody>): void {
    commit({ ...designRef.current, ...patch })
  }

  function addGuide(axis: 'v' | 'h', at: number): void {
    const g = designRef.current.guides ?? { v: [], h: [] }
    const list = axis === 'v' ? g.v : g.h
    // A guide dropped on one that already exists is a no-op, not a duplicate.
    if (list.some((x) => Math.abs(x - at) < 1)) return
    patchLayout({ guides: axis === 'v' ? { ...g, v: [...g.v, at] } : { ...g, h: [...g.h, at] } })
  }
  function removeGuide(axis: 'v' | 'h', at: number): void {
    const g = designRef.current.guides ?? { v: [], h: [] }
    patchLayout({ guides: axis === 'v' ? { ...g, v: g.v.filter((x) => x !== at) } : { ...g, h: g.h.filter((y) => y !== at) } })
  }

  function addMaster(): void {
    const masters = designRef.current.masters ?? []
    const next: DesignMaster = { id: `master-${Date.now().toString(36)}`, name: `Master ${String.fromCharCode(65 + masters.length)}`, elements: [] }
    patchLayout({ masters: [...masters, next] })
  }
  function renameMaster(id: string, name: string): void {
    patchLayout({ masters: (designRef.current.masters ?? []).map((m) => (m.id === id ? { ...m, name } : m)) })
  }
  function deleteMaster(id: string): void {
    const d = designRef.current
    // Pages that used it are explicitly detached rather than silently falling
    // through to a different master's furniture.
    const pages = (d.pages ?? []).map((pg) => (pg.masterId === id ? { ...pg, masterId: null } : pg))
    patchLayout({ masters: (d.masters ?? []).filter((m) => m.id !== id), pages, editingMasterId: d.editingMasterId === id ? null : d.editingMasterId })
  }
  function editMaster(id: string | null): void {
    setSelectedIds([])
    patchLayout({ editingMasterId: id })
  }
  function assignMaster(pageIndex: number, masterId: string | null): void {
    const d = designRef.current
    patchLayout({ pages: (d.pages ?? []).map((pg, i) => (i === pageIndex ? { ...pg, masterId } : pg)) })
  }

  function addLayer(): void {
    const existing = designRef.current.layers ?? designLayers(designRef.current)
    const next: DesignLayer = { id: `layer-${Date.now().toString(36)}`, name: `Layer ${existing.length + 1}`, visible: true, locked: false }
    patchLayout({ layers: [...existing, next] })
  }
  function patchLayer(id: string, patch: Partial<DesignLayer>): void {
    const existing = designRef.current.layers ?? designLayers(designRef.current)
    patchLayout({ layers: existing.map((l) => (l.id === id ? { ...l, ...patch } : l)) })
  }
  function deleteLayer(id: string): void {
    const d = designRef.current
    const existing = d.layers ?? designLayers(d)
    if (existing.length <= 1) return
    // Objects on a deleted layer fall back to the base layer rather than
    // disappearing with it.
    const pages = (d.pages ?? []).map((pg) => ({
      ...pg,
      elements: pg.elements.map((el) => (el.layerId === id ? { ...el, layerId: undefined } : el))
    }))
    const active = pages[d.activePage ?? 0]
    patchLayout({ layers: existing.filter((l) => l.id !== id), pages, elements: active ? active.elements : d.elements })
  }
  function moveSelectionToLayer(layerId: string): void {
    if (!selectedIds.length) return
    mutate((sl) => ({
      ...sl,
      elements: (sl.elements ?? []).map((el) => (selectedIds.includes(el.id) ? { ...el, layerId: layerId === BASE_LAYER_ID ? undefined : layerId } : el))
    }))
  }

  // ── Threaded text ──────────────────────────────────────────────────────────
  const selectedTextFrames = selectedIds
    .map((id) => design.elements.find((e) => e.id === id))
    .filter((e): e is SlideTextElement => !!e && e.type === 'text')

  function linkSelectedFrames(): void {
    if (selectedTextFrames.length < 2) return
    let next = designRef.current
    for (let i = 0; i < selectedTextFrames.length - 1; i++) {
      next = linkFrames(next, selectedTextFrames[i].id, selectedTextFrames[i + 1].id)
    }
    commit(next)
  }
  function unlinkSelected(): void {
    let next = designRef.current
    for (const f of selectedTextFrames) next = unlinkFrame(next, f.id)
    commit(pruneOrphanStories(next))
  }
  /**
   * Write a story's text. This is the ONLY way threaded copy changes: a threaded
   * frame renders the flow engine's output, so writing to the frame's own
   * paragraphs (which is what the canvas used to do) put the text somewhere
   * nothing ever reads.
   */
  function setStoryText(storyId: string, text: string): void {
    commit(writeStoryText(designRef.current, storyId, text))
  }

  /** The story a frame belongs to, if any. */
  function storyOfFrame(frameId: string): string | null {
    const el = design.elements.find((e) => e.id === frameId)
    return el && el.type === 'text' && el.storyId ? el.storyId : null
  }

  // The flowed paragraphs of the story being typed into, which is what maps a
  // caret to a point on the page and back.
  // The print check's standing verdict, for the Tools menu item. Arithmetic
  // over the elements, so it costs what the live review costs and keeps the
  // answer in front of someone instead of behind a menu they have to think to
  // open.
  const preflightHint = useMemo(() => preflightSummary(preflight(design)), [design])

  const editParagraphs = useMemo(
    () => (textEdit ? paragraphsForStory(design, textEdit.storyId, brand) : []),
    [design, textEdit?.storyId, brand]
  )

  /** Put the caret in a story at the point that was clicked. */
  function beginTextEdit(storyId: string, point: { x: number; y: number }): void {
    const paras = paragraphsForStory(designRef.current, storyId, brand)
    const doc = designRef.current.stories?.[storyId]
    if (!doc) return
    const caret =
      caretFromClick(designRef.current, storyId, paras, { pageIndex: designRef.current.activePage ?? 0, x: point.x, y: point.y }, domFlowMeasure) ??
      caretDocStart(doc)
    setSelectedIds([])
    // The panel and the page are two ways to write the same story; only one may
    // hold the keyboard, or they trade focus endlessly.
    setOpenStoryId(null)
    setTextEdit({ storyId, selection: { anchor: caret, focus: caret } })
  }

  /** Write the story back after a keystroke and keep the caret where it belongs. */
  function applyTextEdit(nextDoc: ContentDoc, caret: DocCaret): void {
    if (!textEdit) return
    const d = designRef.current
    commitTyping({ ...d, stories: { ...(d.stories ?? {}), [textEdit.storyId]: nextDoc } })
    setTextEdit({ storyId: textEdit.storyId, selection: { anchor: caret, focus: caret } })
  }

  /** Add a page of frames threaded onto the end of a story, for overset copy. */
  function continueStoryOnNewPage(storyId: string): void {
    const d = syncActivePage(designRef.current)
    const pages = d.pages ?? []
    const template = storyFrames(d, storyId).slice(-1)[0]?.element
    if (!template) return
    const maxOrder = storyFrames(d, storyId).reduce((m, f) => Math.max(m, f.element.storyOrder ?? 0), 0)
    const cols = d.columns?.count ?? 1
    const gutter = d.columns?.gutter ?? 0
    const m = d.margins ?? { top: 0, right: 0, bottom: 0, left: 0 }
    const boxW = d.width - m.left - m.right
    const colW = (boxW - gutter * (cols - 1)) / cols
    const elements: SlideElement[] = []
    for (let c = 0; c < cols; c++) {
      elements.push({
        ...template,
        id: elementId(),
        x: Math.round(m.left + c * (colW + gutter)),
        y: Math.round(m.top),
        w: Math.round(colW),
        h: Math.round(d.height - m.top - m.bottom),
        storyOrder: maxOrder + 1 + c,
        flowLines: undefined,
        overset: undefined
      } as SlideElement)
    }
    const nextPages = [...pages, { id: `pg-${Date.now().toString(36)}`, background: pages[0]?.background ?? d.background, elements }]
    commit({ ...d, pages: nextPages, activePage: nextPages.length - 1, elements, background: nextPages[nextPages.length - 1].background })
    setSelectedIds([])
  }

  /** Replace the whole document with a freshly laid-out one from the wizard. */
  function applyRedesign(next: DesignBody, content: ContentDoc, styleId: string): void {
    commit({ ...next, sourceContent: content, layoutStyleId: styleId })
    setPanel('none')
    setSelectedIds([])
    // The page is the primary writing surface now, so the document simply opens
    // ready to be typed into rather than with a panel in the way.
    setOpenStoryId(null)
    setTextEdit(null)
    setStatus(`Laid out ${next.pages?.length ?? 1} page${(next.pages?.length ?? 1) === 1 ? '' : 's'} in the ${findLayoutStyle(styleId).name} style.`)
  }

  // ── AI Assistant panel helpers ──────────────────────────────────────────────
  // The plain text of the selected element when it is a text element, so the panel
  // can rewrite the real content. Null for any non-text selection.
  const selectedTextValue = selected && selected.type === 'text' ? elementText(selected) : null

  // Replace the selected text element's text with the AI result, going through the
  // same setElementText writer the canvas uses so styling is preserved.
  function applyAiText(text: string): void {
    if (!selected || selected.type !== 'text') return
    const id = selected.id
    mutate((s) => {
      const e = (s.elements ?? []).find((x) => x.id === id)
      return e && e.type === 'text' ? updateElement(s, id, setElementText(e, text)) : s
    })
  }

  // Insert the AI result as a new text element on the canvas, then select it.
  function insertAiText(text: string): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'text',
      x: Math.round(design.width * 0.1),
      y: Math.round(design.height * 0.1),
      w: Math.round(design.width * 0.8),
      h: Math.round(design.height * 0.18),
      z: topZ + 1,
      fontFamily: brand.fontBody,
      paragraphs: text.split('\n').map((line) => ({
        runs: [{ text: line, fontSize: Math.round(design.width * 0.05), color: '#1c1917' }]
      }))
    }
    mutate((s) => addElement(s, el))
    setSelectedIds([el.id])
  }

  // The rail's items, in the common order the spec fixes for every app
  // (§3.1): Navigate, then Create, then Insert. Armed tools carry
  // `design-tool-*` ids — the old `design-add-*` ids meant "adds one now" and
  // keeping them on something that only arms a mode is how a test passes while
  // placing nothing (§4.1).
  const railItems = useMemo(() => designRailItems(), [])
  const railCmds: DesignRailCmds = {
    armTool,
    addImage: () => void addImageFromFile(),
    placeLogo: () => placeLogo(),
    insertWidget: () => setWidgetPickerOpen(true),
    togglePanel: (id) => setPanel((p) => (p === id ? 'none' : id)),
    toggleGenerate: () => changeSidePane(sidePane === 'generate' ? null : 'generate')
  }

  // ── The ContextBar's context ──────────────────────────────────────────────
  // Every property the right-hand inspector used to show, as commands the
  // tabs call (SPEC §6.3, owner ruling D1). The tabs are declarative; all the
  // document knowledge stays here, where it already was.
  const selectedEls = (design.elements ?? []).filter((e) => selectedIds.includes(e.id))
  // The shared actions, defined once (design/designCommands): the ribbon, the
  // menu bar and the right-click menu render from this record.
  const firstText = selectedEls[0]?.type === 'text' ? selectedEls[0] : null
  const dcmds = buildDesignCommands({
    readOnly,
    selected: selectedIds.length,
    textMarks: firstText ? (firstText.paragraphs[0]?.runs[0] ?? {}) : null,
    grouped: canvasElements.some((el) => selectedIds.includes(el.id) && el.groupId),
    canPaste: clipboard.hasClip,
    undo,
    redo,
    cut: clipboard.cut,
    copy: clipboard.copy,
    paste: clipboard.paste,
    duplicate: duplicateSelected,
    remove: deleteSelected,
    selectAll,
    group,
    ungroup,
    reorder: reorderSelected,
    saveSnippet: saveSelectionAsSnippet,
    insertSnippet: () => setSnippetLibraryOpen(true),
    toggleMark: (m) => barCtx.cmd.patchText({ [m]: !firstText?.paragraphs[0]?.runs[0]?.[m] }),
    removeBackground: () => void removeBgSelected(),
    addPage,
    addText,
    addImage: () => void addImageFromFile(),
    addShape,
    addLine,
    insertPageNumber: insertPageNumberFrame,
    addWidget: () => setWidgetPickerOpen(true),
    openLayout: () => setPanel('layout'),
    openStyles: () => setPanel('styles'),
    openSwatches: () => setPanel('swatches'),
    guidesVisible: showLayoutAids,
    toggleGuides: () => setShowLayoutAids((v) => !v),
    facing: design.facing === true,
    toggleFacing: () => patchLayout({ facing: !designRef.current.facing }),
    masters: (design.masters ?? []).map((m) => ({ id: m.id, name: m.name })),
    editingMasterId,
    addMaster,
    editMaster,
    duplicatePage: () => duplicatePage(design.activePage ?? 0),
    canLink: selectedTextFrames.length >= 2,
    canUnlink: selectedTextFrames.some((f) => !!f.storyId),
    linkFrames: linkSelectedFrames,
    unlinkFrame: unlinkSelected,
    find: () => setFindOpen('find'),
    findAndReplace: () => setFindOpen('replace'),
    checkA11y: () => {
      const issues = checkDesignA11y(designRef.current)
      setStatus(issues.length ? `Accessibility: ${issues[0].message}` : 'Accessibility: no issues found.')
    }
  })
  dcmdsRef.current = dcmds
  const barCtx: DesignCtx = {
    cmds: dcmds,
    design,
    selected: selectedEls,
    first: selectedEls[0] ?? null,
    fonts: GOOGLE_FONTS,
    palette: [brand.colorPrimary, brand.colorSecondary, brand.colorNeutral, '#1c1917', '#ffffff'].filter(Boolean) as string[],
    startFrom: (
      <StartFromMenu
        size={{ w: design.width, h: design.height }}
        onTemplate={applyTemplate}
        onSize={changeSize}
        // Never in a narrow desk widget: there the menu would cover the tabs
        // and the page (Deck's first-run side pane follows the same rule).
        autoOpen={startEmpty && (design.elements ?? []).length === 0 && wrapBox.w >= PANEL_SHEET_BELOW}
        onAutoOpened={() => setStartEmpty(false)}
      />
    ),
    guidesVisible: showLayoutAids,
    facing: design.facing === true,
    bleed: design.bleed ?? 0,
    layers: designLayers(design).map((l) => ({ id: l.id, name: l.name })),
    cmd: {
      patchElement: (patch) => {
        const id = selectedIds[0]
        if (id) mutate((sl) => updateElement(sl, id, patch))
      },
      patchText: ({ fontFamily, ...runPatch }) => {
        const id = selectedIds[0]
        if (!id) return
        mutate((sl) => {
          const el = (sl.elements ?? []).find((e) => e.id === id)
          if (!el || el.type !== 'text') return sl
          // The family is a property of the element; weight, slant, size and
          // colour are properties of its runs.
          const next = Object.keys(runPatch).length ? styleTextElement(el, runPatch) : el
          // The styled element first, the family after it: `next` is the whole
          // element, so spreading it last would put the OLD family back.
          return updateElement(sl, id, { ...next, ...(fontFamily ? { fontFamily } : {}) })
        })
      },
      setAlign: (al) => {
        const id = selectedIds[0]
        if (!id) return
        mutate((sl) => {
          const el = (sl.elements ?? []).find((e) => e.id === id)
          return el && el.type === 'text' ? updateElement(sl, id, setParagraphAlign(el, al)) : sl
        })
      },
      setBackground: (color) => patchLayout({ background: { type: 'solid', color } }),
      align,
      distribute,
      group,
      ungroup,
      // The same reorder as the keys and right-click: every selected frame, in
      // its own order (it used to move only the first one).
      order: reorderSelected,
      duplicate: duplicateSelected,
      remove: deleteSelected,
      saveSnippet: saveSelectionAsSnippet,
      insertSnippet: () => setSnippetLibraryOpen(true),
      setLayer: moveSelectionToLayer,
      setWrap: (mode, offset) => {
        const id = selectedIds[0]
        if (!id) return
        // `wrap` is an object on the element — { mode, offset } — not a string
        // with a sibling field. Writing the wrong shape armed nothing: the
        // flow engine reads wrap.mode, so text would never have wrapped.
        mutate((sl) => {
          const el = (sl.elements ?? []).find((e) => e.id === id) as { wrap?: { mode: 'none' | 'square'; offset?: number } } | undefined
          const current = el?.wrap
          return updateElement(sl, id, {
            wrap: { mode, offset: offset ?? current?.offset ?? 12 }
          } as unknown as Partial<SlideElement>)
        })
      },
      openStory: () => {
        const el = selectedEls[0] as { storyId?: string } | undefined
        if (!el?.storyId) return
        setOpenStoryId(el.storyId)
        // Asking to edit a story IS the request to see it, so this one does
        // switch the pane — unlike a selection, which never does (D3).
        changeSidePane('story')
      },
      linkFrames: linkSelectedFrames,
      unlinkFrame: unlinkSelected,
      setStoryColumns: (n) =>
        patchLayout({
          columns: { count: Math.max(1, Math.min(6, n)), gutter: designRef.current.columns?.gutter ?? 16 }
        }),
      setStoryStyle: (id) => patchLayout({ layoutStyleId: id }),
      setAlt: (text) => {
        const id = selectedIds[0]
        if (id) mutate((sl) => updateElement(sl, id, { alt: text } as Partial<SlideElement>))
      },
      removeBackground: () => void removeBgSelected(),
      addPage,
      duplicatePage: () => duplicatePage(design.activePage ?? 0),
      toggleFacing: () => patchLayout({ facing: !designRef.current.facing }),
      // Clamped as the retired control clamped it: 0-100 logical px, whole
      // numbers. designPrintSize reads design.bleed, and with no way to set it
      // the "Print PDF (bleed + crop marks)" export promised a bleed that was
      // always zero.
      setBleed: (px) => patchLayout({ bleed: Math.min(100, Math.max(0, Math.round(px || 0))) }),
      brandify,
      openBrandKit: () => setBrandOpen(true),
      openPanel: (id) => setPanel(id),
      exportAs: (f) => void exportAs(f),
      exportPrint: () => void exportAs('pdf', true)
    }
  }

  // The existing menu bar, now rendered inside the ContextBar's first row
  // beside the tab strip (SPEC §1, owner decision D2).
  const menuBar = (
        <DesignMenuBar
          documentOps={documentOps}
          actions={{
            title,
            cmds: dcmds,
            exportAs: (f) => void exportAs(f),
            openPreflight: () => setPanel('preflight'),
            saveSelectionAsSnippet,
            hasSelection: selectedIds.length > 0,
            preflightHint,
            editMaster,
            masters: (design.masters ?? []).map((m) => ({ id: m.id, name: m.name })),
            editingMasterId,
            exportPrint: () => void exportAs('pdf', true)
          }}
        />
  )

  // The shared right pane's panes (SPEC §2.5a): the assistant always, and the
  // story editor while a threaded story is open. Both are content you read and
  // type in, which is what this pane is for — the property controls are
  // ContextBar tabs and the tool panels are ShellPanel overlays.
  const sidePanes: SidePane[] = [
    {
      id: 'assist',
      title: 'PlexiiAssist',
      icon: 'auto_awesome',
      testid: 'design-ai-panel',
      render: () => (
        <DesignAiPanel
          body={design}
          selectedText={selectedTextValue}
          onApplyText={applyAiText}
          onInsertText={insertAiText}
          userName={userName}
        />
      )
    }
  ]
  // AI design: generates a layout (or an image) from a prompt. It is content
  // you type into, so it is a pane here beside PlexiiAssist, as Deck's
  // Generate deck and Diagrams' AI diagram are (SPEC §3.9), opened from the
  // rail's last item.
  sidePanes.push({
    id: 'generate',
    title: 'AI design',
    icon: 'auto_awesome',
    testid: 'design-generate-pane',
    render: () => (
      <div className="space-y-2 p-3">
        <div>
          <div className="text-[11px] text-[var(--ink-50)] mb-1">Describe the design — AI writes on-brand copy and lays it out. Generate variations to pick from a set of on-brand options.</div>
          <div className="flex gap-1.5">
            <input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="e.g. a launch announcement for our new pricing"
              data-testid="design-ai-prompt"
              onKeyDown={(e) => e.key === 'Enter' && void generateVariations()}
              className="fb-field flex-1 px-2.5 py-1.5 text-[12px]"
            />
            <button onClick={() => void generateVariations()} disabled={!!busy} data-testid="design-ai-variations" className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50">
              Variations
            </button>
            <button onClick={() => void generateDesign()} disabled={!!busy} data-testid="design-ai-go" className="fb-btn-surface text-[12px] px-3 py-1.5 hover:border-accent disabled:opacity-50">
              One
            </button>
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--ink-50)] mb-1">Generate an image to place on the canvas (OpenAI gpt-image-1).</div>
          <div className="flex gap-1.5">
            <input
              value={imgPrompt}
              onChange={(e) => setImgPrompt(e.target.value)}
              placeholder="e.g. a minimal abstract gradient background"
              data-testid="design-image-prompt"
              onKeyDown={(e) => e.key === 'Enter' && void generateImage()}
              className="fb-field flex-1 px-2.5 py-1.5 text-[12px]"
            />
            <button onClick={() => void generateImage()} disabled={!!busy} data-testid="design-image-go" className="fb-btn-surface text-[12px] px-3 py-1.5 hover:border-accent disabled:opacity-50">
              Image
            </button>
          </div>
        </div>
      </div>
    )
  })
  if (openStoryId && design.stories?.[openStoryId]) {
    const storyId = openStoryId
    sidePanes.push({
      id: 'story',
      title: 'Story',
      icon: 'edit_note',
      testid: 'design-story-editor',
      render: () => (
        <StoryEditor
          design={design}
          storyId={storyId}
          text={storyText(design, storyId)}
          overset={storyFrames(design, storyId).some((f) => f.element.overset === true)}
          onChange={(t) => setStoryText(storyId, t)}
          onClose={() => {
            setOpenStoryId(null)
            changeSidePane('assist')
          }}
          onAddPage={() => continueStoryOnNewPage(storyId)}
        />
      )
    })
  }

  const shellPanels = (
    <>
      {panel === 'redesign' && (
        <ShellPanel
          id="redesign"
          title="Pour in your text and lay it out"
          open
          onClose={() => setPanel('none')}
          testid="design-panel-redesign"
        >
          <RedesignWizard
            size={size}
            brand={brand}
            measure={domFlowMeasure}
            theme={NEUTRAL_THEME}
            initialContent={design.sourceContent ?? firstStoryContent(design)}
            onApply={applyRedesign}
            onCancel={() => setPanel('none')}
          />
        </ShellPanel>
      )}

      {panel === 'layout' && (
        <ShellPanel
          id="layout"
          pinnable
          pinned={pinnedPanels.includes('layout')}
          onRectChange={reportPanelRect}
          onPinnedChange={(v) => setPinnedPanels((list) => (v ? [...list, 'layout'] : list.filter((x) => x !== 'layout')))}
          title="Page layout"
          open
          onClose={() => setPanel('none')}
          testid="design-panel-layout"
        >
          <LayoutPanel
            design={design}
            activePage={design.activePage ?? 0}
            onPatch={patchLayout}
            onEditMaster={editMaster}
            onAddMaster={addMaster}
            onRenameMaster={renameMaster}
            onDeleteMaster={deleteMaster}
            onAssignMaster={assignMaster}
            onAddLayer={addLayer}
            onPatchLayer={patchLayer}
            onDeleteLayer={deleteLayer}
            onMoveSelectionToLayer={moveSelectionToLayer}
            hasSelection={selectedIds.length > 0}
          />
        </ShellPanel>
      )}

      {panel === 'styles' && (
        <ShellPanel
          id="styles"
          pinnable
          pinned={pinnedPanels.includes('styles')}
          onRectChange={reportPanelRect}
          onPinnedChange={(v) => setPinnedPanels((list) => (v ? [...list, 'styles'] : list.filter((x) => x !== 'styles')))}
          title="Paragraph styles"
          open
          onClose={() => setPanel('none')}
          testid="design-panel-styles"
        >
          <StylesPanel design={design} brand={brand} onPatch={patchLayout} />
        </ShellPanel>
      )}

      {panel === 'swatches' && (
        <ShellPanel
          id="swatches"
          pinnable
          pinned={pinnedPanels.includes('swatches')}
          onRectChange={reportPanelRect}
          onPinnedChange={(v) => setPinnedPanels((list) => (v ? [...list, 'swatches'] : list.filter((x) => x !== 'swatches')))}
          title="Swatches &amp; spot inks"
          open
          onClose={() => setPanel('none')}
          testid="design-panel-swatches"
        >
          <SwatchesPanel design={design} brand={brand} selectedIds={selectedIds} onBody={(next) => commit(next)} />
        </ShellPanel>
      )}

      {panel === 'preflight' && (
        <ShellPanel
          id="preflight"
          pinnable
          pinned={pinnedPanels.includes('preflight')}
          onRectChange={reportPanelRect}
          onPinnedChange={(v) => setPinnedPanels((list) => (v ? [...list, 'preflight'] : list.filter((x) => x !== 'preflight')))}
          title="Preflight for print"
          open
          onClose={() => setPanel('none')}
          testid="design-panel-preflight"
        >
          <PreflightPanel
            design={design}
            onReveal={(page, elementId) => {
              goToPage(page)
              if (elementId) setSelectedIds([elementId])
            }}
          />
        </ShellPanel>
      )}

      {panel === 'stock' && (
        <ShellPanel
          id="stock"
          title="Stock photos"
          open
          onClose={() => setPanel('none')}
          testid="design-panel-stock"
        >
          <div className="flex gap-1.5 mb-2">
            <input
              value={stockQuery}
              onChange={(e) => setStockQuery(e.target.value)}
              placeholder="Search free photos (e.g. mountains, office, coffee)"
              data-testid="design-stock-query"
              onKeyDown={(e) => e.key === 'Enter' && void searchStock()}
              className="fb-field flex-1 px-2.5 py-1.5 text-[12px]"
            />
            <button onClick={() => void searchStock()} disabled={!!busy} data-testid="design-stock-go" className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50">
              Search
            </button>
          </div>
          {stockResults.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5 max-h-48 overflow-auto" data-testid="design-stock-results">
              {stockResults.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void insertStock(p)}
                  title={p.alt || `Photo by ${p.photographer}`}
                  className="fb-btn-surface aspect-square overflow-hidden hover:border-accent"
                >
                  <img src={p.thumb} alt={p.alt} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <p className="text-[10px] text-[var(--ink-40)] mt-1.5">Photos from Pexels. A free Pexels API key (Settings → AI · API keys) enables search.</p>
        </ShellPanel>
      )}

      {(busy || status) && (
        <div className="px-3 py-1.5 text-[12px] text-[var(--ink-50)] flex items-center gap-1.5" data-testid="design-status">
          {busy && <Icon name="autorenew" size={13} className="animate-spin" />}
          <span>{busy ?? status}</span>
          {status && !busy && (
            <button onClick={() => setStatus(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]">
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      )}

      {/* Canvas + inspector */}
    </>
  )

  const shellRail = (
    <>
        {/* The shared office ToolRail (spec §2.1). Tools arm a mode; the rail
            shows which, and never listens for keys — this editor's one key
            handler does that. */}
        <ToolRail
          items={railItems}
          ctx={railCmds}
          activeId={designRailIdForTool(tool)}
          openPanels={[...(panel !== 'none' ? [`panel-${panel}`] : []), ...(sidePane === 'generate' ? ['ai-generate'] : [])]}
          lastUsed={chrome.lastUsed}
          onFlyoutPick={chrome.onFlyoutPick}
          readOnly={readOnly}
          testid="design-rail"
          ariaLabel="Design tools"
        />
    </>
  )

  const pageRail = (
    <>
        {/* Page rail — switch, add, delete pages of a multi-page document. */}
        <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-t border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] overflow-x-auto" data-testid="design-page-rail">
          {/* Pages, grouped into spreads when the document is set to facing
              pages, so a booklet's rail reads the way the booklet does. Each
              button shows the PRINTED page number and the master it inherits. */}
          {spreadsOf(design).map((spread, si) => (
            <div key={`sp-${si}`} className="shrink-0 flex items-center gap-0.5 px-0.5 rounded" style={design.facing ? { background: 'color-mix(in oklab, var(--edge-soft) 60%, transparent)' } : undefined}>
              {spread.map((i) => {
                const pg = pages[i]
                if (!pg) return null
                const pgMaster = masterForPage(design, pg)
                return (
                  <div key={pg.id} className="relative group/pg shrink-0">
                    <button
                      onClick={() => goToPage(i)}
                      data-testid={`design-page-${i}`}
                      className={`h-7 min-w-7 px-2 rounded text-[12px] border ${
                        i === activePage ? 'border-accent bg-accent/10 text-accent font-medium' : 'border-[var(--edge-soft)] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                      }`}
                      title={`Page ${pageNumberOf(design, i)}${pgMaster ? ` — ${pgMaster.name}` : ' — no master'}`}
                    >
                      {pageNumberOf(design, i)}
                      {pgMaster && <span className="ml-0.5 text-[9px] opacity-60">{pgMaster.name.replace(/^Master\s*/, '')}</span>}
                    </button>
                    {pages.length > 1 && (
                      <button
                        onClick={() => deletePage(i)}
                        data-testid={`design-page-delete-${i}`}
                        className="absolute -top-1 -right-1 hidden group-hover/pg:flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--surface-raised)] border border-[var(--edge-firm)] text-[var(--ink-50)] hover:text-rose-500"
                        title={`Delete page ${pageNumberOf(design, i)}`}
                      >
                        <Icon name="close" size={9} />
                      </button>
                    )}
                    <button
                        onClick={(e) => {
                          e.stopPropagation()
                          duplicatePage(i)
                        }}
                        data-testid={`design-page-duplicate-${i}`}
                        className="absolute -top-1 -left-1 hidden group-hover/pg:block rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] p-0.5 text-[var(--ink-60)] hover:text-accent"
                        title={`Duplicate page ${pageNumberOf(design, i)}`}
                      >
                        <Icon name="file_copy" size={9} />
                      </button>
                  </div>
                )
              })}
            </div>
          ))}
          {/* The add control reads as a button, not as a grey label. The owner
              reported "I can't see where to add the second page" against the
              old version of this: an unbordered, low-contrast "+ Page" at the
              end of a strip that, on a single-page design, had nothing else in
              it at all (see withPages). */}
          <button
            onClick={addPage}
            data-testid="design-page-add"
            className="fb-btn-surface h-7 shrink-0 px-2.5 rounded text-[12px] text-[var(--ink-80)] hover:border-accent inline-flex items-center gap-1"
            title="Add a page at the end"
          >
            <Icon name="add" size={14} /> Add page
          </button>
        </div>
    </>
  )

  return (
    <div
      className="flex flex-col h-full"
      data-testid="design-editor"
      onContextMenu={openDesignMenu}
      onDragOver={(e) => {
        if (dragCarriesFiles(e.dataTransfer)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          return
        }
        if (!acceptsWidgetDrag(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        // From Files: Design's own converted paste with our read, landing
        // where it was dropped. A work widget file stays a live widget.
        if (dragCarriesFiles(e.dataTransfer)) {
          e.preventDefault()
          e.stopPropagation()
          const refs = filesDropRefs(e.dataTransfer)
          if (!refs?.length) return
          const d = designRef.current
          const at = pagePointFromDrop(e.currentTarget, e.clientX, e.clientY, { w: d.width, h: d.height }) ?? undefined
          const alt = e.altKey
          void runContentDrop(refs, { target: 'design', alt, ownDocumentId: documentOps?.id ?? null }, async (read, ref) => {
            if (ref.kind === 'doc' && ref.docType === 'widget' && ref.docId && !alt) {
              addWidget(widgetFileGroupId(ref.docId))
              return true
            }
            return pasteConverted('design', (b) => insertSnippetHere(pastedSnippet(b), at), { read })
          })
          return
        }
        if (!acceptsWidgetDrag(e.dataTransfer)) return
        e.preventDefault()
        void widgetIdFromDrop(e.dataTransfer).then((id) => {
          if (id) addWidget(id)
        })
      }}
    >
      {/* Row 1 and Row 2 of the office shell: the menu bar and the tab strip
          share a row, and the active tab's controls are the row beneath
          (SPEC §1, D2). This is where the right-hand inspector went (D1). */}

      <OfficeShellLayout
        testid="design-shell"
        bar={
        <ContextBar
          tabs={DESIGN_TABS}
          ctx={barCtx}
          activeTab={chrome.tab}
          onTabChange={chrome.setTab}
          collapsed={chrome.collapsed}
          onCollapsedChange={chrome.setCollapsed}
          menuBar={menuBar}
          readOnly={readOnly}
          pinnedStart={
            <>
              {/* The shared primitive, as Deck, Write, Cells and Diagrams all
                  use for these two: hand-rolled buttons here were 27x23 against
                  28x28 everywhere else, carried a `title` and no accessible
                  name, and showed no shortcut. Found by d8's cross-app style
                  report, where it was the only divergence across six apps. */}
              <BarButton {...barProps(dcmds.undo)} disabled={past.length === 0} onClick={undo} testid="design-undo" />
              <BarButton {...barProps(dcmds.redo)} disabled={future.length === 0} onClick={redo} testid="design-redo" />
            </>
          }
          rightSlot={
            <>
              <span className="px-1.5 text-[11px] text-[var(--ink-50)] fb-tabular" data-testid="design-status-slot">{status}</span>
              {/* The side pane's toggle belongs in the bar, not the rail: the
                  rail is tools (SPEC §3.1), and this is where Write's and
                  Diagrams' live, so the shell reads the same in every app. */}
              <BarButton
                icon="right_panel_open"
                label={sidePane ? 'Hide the side pane' : 'Show the side pane'}
                onClick={() => changeSidePane(sidePane ? null : 'assist')}
                controls={SIDE_PANE_DOM_ID}
                readOnlySafe
                testid="design-sidepane-toggle"
              />
            </>
          }
          testid="design-toolbar"
        />
        }
        rail={shellRail}
        bottom={pageRail}
        panels={shellPanels}
        rightPane={
          <ShellSidePane
            testid="design-sidepane"
            panes={sidePanes}
            // The story pane goes away whenever its story does — typing on the
            // page closes it, and so does the redesign wizard. Fall back to the
            // assistant rather than to collapsed: those paths used to close the
            // story editor and LEAVE the assistant up, and collapsing the whole
            // pane because a story ended would take away more than was asked.
            activeId={sidePanes.some((p) => p.id === sidePane) ? sidePane : sidePane === null ? null : 'assist'}
            onChange={changeSidePane}
          />
        }
      >
        <div className="h-full min-h-0 flex flex-col">
        <div
          ref={wrapRef}
          className="flex-1 min-w-0 overflow-auto bg-stone-200/50 dark:bg-black/30 flex items-start justify-center p-6"
          style={canvasInset ? { paddingLeft: 24 + canvasInset } : undefined}
        >
          <div>
            {editingMaster && (
              <div
                className="mb-1.5 px-2 py-1 rounded bg-accent/15 text-accent text-[11px] inline-flex items-center gap-1.5"
                data-testid="design-master-banner"
              >
                <Icon name="auto_stories" size={13} />
                Editing {editingMaster.name} — changes here appear on every page that uses it.
                <button onClick={() => editMaster(null)} className="underline underline-offset-2">
                  Done
                </button>
              </div>
            )}
            <DesignRulers width={design.width} height={design.height} scale={canvasW / design.width} onAddGuide={addGuide}>
              <SlideCanvas
                slide={{
                  id: 'design',
                  notes: '',
                  elements: visibleElements,
                  background: editingMaster ? editingMaster.background ?? design.background : design.background,
                  schemaVersion: 2
                }}
                theme={NEUTRAL_THEME}
                width={canvasW}
                logicalW={design.width}
                logicalH={design.height}
                selectedIds={selectedIds}
                marksFor={(el) =>
                  findMark.query && el.type === 'text'
                    ? marksForElement(designRef.current, el, findMark.query, findMark.opts, findMark.current)
                    : undefined
                }
                underlay={underlay}
                lockedIds={lockedIds}
                extraSnapX={snaps.xs}
                extraSnapY={snaps.ys}
                overlay={
                  <>
                    <LayoutOverlay
                      design={design}
                      scale={canvasW / design.width}
                      show={{
                        margins: showLayoutAids,
                        columns: showLayoutAids,
                        guides: showLayoutAids,
                        wrap: showLayoutAids,
                        baseline: showLayoutAids
                      }}
                      onRemoveGuide={removeGuide}
                    />
                    {textEdit && design.stories?.[textEdit.storyId] && (
                      <>
                        {/* While the caret is in text this layer owns the pointer,
                            so clicking and dragging move the caret and select
                            words instead of nudging the frame underneath. */}
                        <div
                          data-testid="design-text-surface"
                          className="absolute inset-0"
                          style={{ pointerEvents: 'auto', cursor: 'text', zIndex: 9995 }}
                          onPointerDown={(e) => {
                            const pt = stagePoint(e)
                            if (!pt) return
                            // A click OUTSIDE the story's own frames means the
                            // author is done with the text and is reaching for
                            // something else on the page. Leave text editing and
                            // let the click through rather than swallowing it.
                            const inFrame = storyFrames(design, textEdit.storyId).some(
                              (f) =>
                                f.pageIndex === activePage &&
                                pt.x >= f.element.x &&
                                pt.x <= f.element.x + f.element.w &&
                                pt.y >= f.element.y &&
                                pt.y <= f.element.y + f.element.h
                            )
                            if (!inFrame) {
                              setTextEdit(null)
                              return
                            }
                            e.stopPropagation()
                            const caret = caretFromClick(design, textEdit.storyId, editParagraphs, { pageIndex: activePage, ...pt }, domFlowMeasure)
                            if (!caret) return
                            // A click in the text is also how focus comes back
                            // after the author used a toolbar control.
                            ;(document.querySelector('[data-testid="design-text-input"]') as HTMLElement | null)?.focus({ preventScroll: true })
                            textDragging.current = true
                            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            setTextEdit({ storyId: textEdit.storyId, selection: { anchor: caret, focus: caret } })
                          }}
                          onPointerMove={(e) => {
                            if (!textDragging.current) return
                            const pt = stagePoint(e)
                            if (!pt) return
                            const caret = caretFromClick(design, textEdit.storyId, editParagraphs, { pageIndex: activePage, ...pt }, domFlowMeasure)
                            if (caret) setTextEdit({ storyId: textEdit.storyId, selection: { anchor: textEdit.selection.anchor, focus: caret } })
                          }}
                          onPointerUp={() => {
                            textDragging.current = false
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                        />
                        <FrameTextEditor
                          design={design}
                          storyId={textEdit.storyId}
                          doc={design.stories[textEdit.storyId]}
                          paragraphs={editParagraphs}
                          selection={textEdit.selection}
                          measure={domFlowMeasure}
                          pageIndex={activePage}
                          scale={canvasW / design.width}
                          onSelection={(sel) => setTextEdit({ storyId: textEdit.storyId, selection: sel })}
                          onChange={applyTextEdit}
                          onExit={() => setTextEdit(null)}
                          onGoToPage={goToPage}
                        />
                      </>
                    )}
                  </>
                }
                onSelect={(id, additive) => setSelectedIds(id == null ? [] : additive ? [...new Set([...selectedIds, id])] : [id])}
                onSelectMany={setSelectedIds}
                onUpdateElement={(id, patch) => mutate((s) => updateElement(s, id, patch))}
                onMoveMany={(ids, dx, dy) => mutate((s) => moveElementsBy(s, ids, dx, dy))}
                onSetText={(id, text) => {
                  // A threaded frame's words live in its story; writing them to
                  // the frame would put them where nothing renders them.
                  const sid = storyOfFrame(id)
                  if (sid) {
                    setStoryText(sid, text)
                    return
                  }
                  mutate((s) => {
                    const e = (s.elements ?? []).find((x) => x.id === id)
                    return e && e.type === 'text' ? updateElement(s, id, setElementText(e, text)) : s
                  })
                }}
                textOf={(el) => (el.storyId ? storyText(design, el.storyId) : elementText(el))}
                placing={
                  tool === 'select'
                    ? null
                    : {
                        kind: tool,
                        defaultW: Math.round(design.width * TOOL_DEFAULT[tool].w),
                        defaultH: Math.round(
                          tool === 'line' ? 0 : design.width * TOOL_DEFAULT[tool].h
                        )
                      }
                }
                onPlace={(kind, rect) => placeTool(kind, rect)}
                onEditRequest={(el, point) => {
                  if (!el.storyId) return false
                  // Threaded copy is typed ON THE PAGE. The canvas hands the
                  // gesture over and a caret appears where the pointer was.
                  beginTextEdit(el.storyId, point)
                  return true
                }}
              />
            </DesignRulers>
          </div>
        </div>
        </div>
      </OfficeShellLayout>

      {brandOpen && <BrandKitModal onClose={() => setBrandOpen(false)} />}

      {designMenu && (
        <CanvasContextMenu
          testid="design-context-menu"
          x={designMenu.x}
          y={designMenu.y}
          onClose={() => setDesignMenu(null)}
          items={
            designMenu.onElement
              ? objectMenu({
                  cut: dcmds.cut,
                  copy: dcmds.copy,
                  paste: dcmds.paste,
                  duplicate: dcmds.duplicate,
                  bringToFront: dcmds.bringToFront,
                  sendToBack: dcmds.sendToBack,
                  group: selectedIds.length >= 2 ? dcmds.group : undefined,
                  ungroup: dcmds.ungroup.enabled?.() ? dcmds.ungroup : undefined,
                  saveAsSnippet: dcmds.saveSnippet,
                  more: [ctxRow(dcmds.bringForward), ctxRow(dcmds.sendBackward)],
                  del: dcmds.remove
                })
              : canvasMenu({
                  paste: dcmds.paste,
                  insertSnippet: dcmds.insertSnippet,
                  selectAll: dcmds.selectAll
                })
          }
        />
      )}
      {findOpen && (
        <RecordFindReplace
          testid="design-find"
          scope="Find in this design"
          replace={findOpen === 'replace'}
          records={findRecords}
          onGo={goToHit}
          onSearch={(query, opts) => setFindMark((m) => ({ ...m, query, opts }))}
          onReplace={replaceText}
          onClose={() => {
            setFindOpen(false)
            // Marks never outlive the panel.
            setFindMark({ query: '', opts: {}, current: null })
          }}
        />
      )}

      {snippetLibraryOpen && (
        <SnippetLibrary kinds={DESIGN_KINDS} targetId={designSnippetTargetId(snippetScope)} onClose={() => setSnippetLibraryOpen(false)} />
      )}

      {snippetDraft && (
        <SaveSnippetDialog body={snippetDraft} suggestedName={suggestedDesignSnippetName(snippetDraft)} onClose={() => setSnippetDraft(null)} />
      )}

      {widgetPickerOpen && (
        <WidgetPickerDialog
          onPick={(widgetId) => {
            setWidgetPickerOpen(false)
            addWidget(widgetId)
          }}
          onClose={() => setWidgetPickerOpen(false)}
        />
      )}

      {variations.length > 0 && (
        <div className="fb-scrim fixed inset-0 z-[200] flex items-center justify-center p-6" onClick={() => setVariations([])} data-testid="design-variations-modal">
          <div className="fb-card fb-press w-full max-w-4xl max-h-[88vh] overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <Icon name="auto_awesome" size={18} className="text-accent" />
              <h2 className="text-[15px] font-semibold text-[var(--ink-100)]">Pick a design</h2>
              <span className="text-[12px] text-[var(--ink-40)]">{variations.length} on-brand options</span>
              <button onClick={() => setVariations([])} className="ml-auto text-[var(--ink-40)] hover:text-[var(--ink-70)]">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {variations.map((v, i) => (
                <button
                  key={i}
                  onClick={() => applyVariation(v)}
                  data-testid={`design-variation-${i}`}
                  className="fb-btn-surface overflow-hidden hover:border-accent hover:ring-2 hover:ring-accent/30 transition"
                  title="Use this design"
                >
                  <DesignThumb design={v} width={232} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// A small, faithful, non-interactive render of a design, used in the variations
// picker. Reuses SlideElementView (the same renderer as the canvas) scaled down.
function DesignThumb({ design, width }: { design: DesignBody; width: number }): JSX.Element {
  const scale = width / design.width
  const height = width * (design.height / design.width)
  const bg = design.background?.type === 'solid' ? design.background.color ?? '#ffffff' : '#ffffff'
  return (
    <div style={{ width, height, position: 'relative', overflow: 'hidden', background: bg }}>
      <div style={{ width: design.width, height: design.height, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'absolute', top: 0, left: 0 }}>
        {design.elements
          .slice()
          .sort((a, b) => a.z - b.z)
          .map((el) => (
            <SlideElementView key={el.id} el={el} />
          ))}
      </div>
    </div>
  )
}

/**
 * The content to seed the wizard with for a document that has a story but no
 * recorded source — an older layout, or one built by hand. Reading the story
 * back is lossy only in that the headline lives on the page rather than in the
 * thread, which is exactly what sourceContent exists to avoid going forward.
 */
function firstStoryContent(design: DesignBody): ContentDoc | undefined {
  const first = Object.values(design.stories ?? {})[0]
  return first && first.blocks.length ? first : undefined
}



