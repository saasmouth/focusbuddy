import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeckTheme, Slide, SlideElement, SlideLayout, SlidesBody, SlideTransition } from '@shared/types'
import { resolveTheme, layoutElements, applyThemeToDeck, BUILTIN_THEMES } from '@shared/slideThemes'
import { SLIDE_TEMPLATES } from '@shared/slideTemplates'
import { migrateSlidesBody } from '@shared/slidesMigrate'
import SlideFace from './slides/SlideFace'
import SlideCanvas from './slides/SlideCanvas'
import { acceptsWidgetDrag, widgetIdFromDrop } from '../../lib/widgetDropInsert'
import SlidesMenuBar from './editor/SlidesMenuBar'
import SlideTemplateGallery from './slides/SlideTemplateGallery'
import PresentOverlay from './slides/PresentOverlay'
import AiSlidePanel from './slides/AiSlidePanel'
import SlideAssistantPane, { LayoutsAndThemes } from './slides/SlidesSidePanel'
import { BarButton, BarToggle, ContextBar, OfficeShellLayout, PANEL_SHEET_BELOW, ShellPanel, ShellSidePane, SIDE_PANE_DOM_ID, ToolRail } from '../office/shell'
import { DECK_TABS, deckRailItems, railIdForTool, TOOL_DEFAULT, type DeckCtx, type DeckPanel, type DeckSidePane, type DeckTool } from './slides/ribbon'
import { useSlideAi } from './slides/useSlideAi'
import CropDialog from './slides/CropDialog'
import ChartLinkDialog from './slides/ChartLinkDialog'
import { buildChartData } from '../../lib/chartData'
import type { SheetTab } from '@shared/types'
import { checkSlidesA11y } from '../../lib/slidesA11y'
import type { A11yIssue } from '../../lib/docA11y'
import {
  addElement,
  updateElement,
  deleteElement,
  duplicateElement,
  reorderZ,
  setElementText,
  styleTextElement,
  setParagraphAlign,
  setListStyle,
  elementId,
  alignElements,
  distributeElements,
  groupElements,
  ungroupElements,
  moveElementsBy,
  withGroupMembers,
  type AlignEdge
} from './slides/slideOps'
import { useElementClipboard } from './slides/useElementClipboard'
import { useRegisterEditorCommands, type EditorCommand } from '../../stores/editorCommands'
import Icon from '../Icon'
import WidgetPickerDialog from './embed/WidgetPickerDialog'

// PowerPoint-class slides editor on the office shell (SPEC §6.4). The deck is
// held as v2 (element-based) in local state; legacy decks migrate on mount. The
// ToolRail arms tools, the ContextBar's tabs hold every setting (the right
// inspector is retired, D1), the slide thumbnails are the navigator, the canvas
// edits the selected slide, PlexiiAssist sits in the shared right side pane and
// speaker notes stay under the canvas. Edits flow to onChange (debounced autosave).

const TAB_KEY = 'plexii.slides.ribbonTab'
const COLLAPSE_KEY = 'plexii.slides.ribbonCollapsed'
const PINS_KEY = 'plexii.slides.pinnedPanels'
const SIDE_KEY = 'plexii.slides.sidePane'
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

interface Props {
  body: SlidesBody
  title: string
  onChange: (body: SlidesBody) => void
}

export default function SlidesEditor({ body: rawBody, title, onChange }: Props): JSX.Element {
  const [body, setBody] = useState<SlidesBody>(() => migrateSlidesBody(rawBody))
  // Accept live external updates (co-editing): fold a new body prop into the
  // deck without disturbing the current slide selection or any active element
  // edit. Only fires on a real prop change (remote merges), not our own echoes.
  useEffect(() => {
    setBody(migrateSlidesBody(rawBody))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawBody])
  const [sel, setSel] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [presenting, setPresenting] = useState(false)
  const [cropId, setCropId] = useState<string | null>(null)
  const [chartLinkFor, setChartLinkFor] = useState<string | null>(null)
  const [a11yIssues, setA11yIssues] = useState<A11yIssue[] | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [widgetPickerOpen, setWidgetPickerOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [canvasW, setCanvasW] = useState(720)
  // Shell state: the active tab, Row 2 collapse (D5), the overlay panels and the
  // right side pane, each remembered per app.
  const [tab, setTab] = useState<string>(() => readPref(TAB_KEY, 'home'))
  const [collapsed, setCollapsed] = useState<boolean>(() => readPref(COLLAPSE_KEY, false))
  const [openPanels, setOpenPanels] = useState<DeckPanel[]>([])
  // Selection-driven panels (Edit cells) are used WITH a selection, so they
  // start pinned: an unpinned panel closes on the canvas click that is the job.
  const [pinned, setPinned] = useState<DeckPanel[]>(() => readPref<DeckPanel[]>(PINS_KEY, ['cells']))
  // The assistant was a permanent column before the shell; it starts open the
  // first time and is remembered after that.
  const sidePaneUnset = useRef(readPref<string | null | undefined>(SIDE_KEY, undefined) === undefined)
  const [sidePane, setSidePaneState] = useState<DeckSidePane | null>(() => {
    const v = readPref<string | null>(SIDE_KEY, 'ai')
    return v === 'ai' || v === 'generate' ? v : null
  })
  const rootRef = useRef<HTMLDivElement | null>(null)
  // ...but never as a sheet over the slide: in a narrow desk widget the first-run
  // default stays collapsed to its edge tab (an explicit choice is honoured).
  useEffect(() => {
    if (sidePaneUnset.current && (rootRef.current?.getBoundingClientRect().width ?? Infinity) < PANEL_SHEET_BELOW) setSidePaneState(null)
  }, [])
  const setSidePane = useCallback((p: DeckSidePane | null) => {
    setSidePaneState(p)
    writePref(SIDE_KEY, p)
  }, [])
  // Armed tools (D4): armed until it places something, then back to Select, as
  // PowerPoint and Canva do. Double-click a rail tool to lock it; Esc disarms.
  const [tool, setToolState] = useState<DeckTool>('select')
  const [toolLocked, setToolLocked] = useState(false)
  // The shapes flyout shows the last shape used as the group's visible member (host-owned, SPEC §2.2).
  const [lastShape, setLastShape] = useState('tool-rect')
  // Pinned overlay panels float over the canvas's left edge (SPEC §2.4); the slide
  // is laid out past them so nothing on it sits under a panel you cannot click through.
  const panelRects = useRef<Record<string, DOMRect | null>>({})
  const [panelInset, setPanelInset] = useState(0)
  const notesRef = useRef<HTMLTextAreaElement | null>(null)

  const undo = useRef<SlidesBody[]>([])
  const redo = useRef<SlidesBody[]>([])
  const canvasWrap = useRef<HTMLDivElement | null>(null)

  const theme = resolveTheme(body.theme)
  const slides = body.slides
  const slideIdx = Math.min(sel, slides.length - 1)
  const slide = slides[slideIdx]
  // The inspector edits a single element; with 0 or 2+ selected it shows nothing
  // and the multi-select align toolbar takes over.
  const selectedElId = selectedIds.length === 1 ? selectedIds[0] : null
  const selectedEl = (slide?.elements ?? []).find((e) => e.id === selectedElId) ?? null
  // The current slide's text, fed to the AI "make this slide beautiful" action.
  const slideSummary = (slide?.elements ?? [])
    .flatMap((e) =>
      e.type === 'text' ? [e.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').trim()] : []
    )
    .filter(Boolean)
    .join('\n')

  // Keep the current slide's text in a ref so the per-slide AI hook always reads
  // the slide the writer is looking at right now (the hook holds a stable getter).
  const slideTextRef = useRef(slideSummary)
  slideTextRef.current = slideSummary
  const ai = useSlideAi(() => slideTextRef.current)

  // Select an element. additive (Shift/Cmd-click) toggles it in the selection;
  // a plain click replaces. Either way the selection expands to whole groups so
  // a grouped element never selects alone.
  function selectElement(id: string | null, additive: boolean): void {
    if (id === null) {
      setSelectedIds([])
      return
    }
    setSelectedIds((prev) => {
      if (!additive) return withGroupMembers(slide, [id])
      if (prev.includes(id)) {
        const groupOfId = new Set(withGroupMembers(slide, [id]))
        return prev.filter((x) => !groupOfId.has(x))
      }
      return withGroupMembers(slide, [...prev, id])
    })
  }
  function selectMany(ids: string[]): void {
    setSelectedIds(ids.length ? withGroupMembers(slide, ids) : [])
  }
  function setTool(next: DeckTool, lock = false): void {
    setToolState(next)
    setToolLocked(lock && next !== 'select')
    if (next !== 'select') setSelectedIds([])
    if (next !== 'select' && next !== 'text') setLastShape(`tool-${next}`)
  }

  // Measure the canvas column so the slide scales to fit.
  useEffect(() => {
    const el = canvasWrap.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setCanvasW(Math.max(320, Math.min(w - 32, 1100)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function commit(next: SlidesBody): void {
    undo.current.push(body)
    if (undo.current.length > 80) undo.current.shift()
    redo.current = [] // a fresh edit invalidates the redo branch
    setBody(next)
    onChange(next)
  }
  function setSlides(slidesNext: Slide[], extra?: Partial<SlidesBody>): void {
    commit({ ...body, slides: slidesNext, ...extra })
  }
  function mutateSlide(fn: (s: Slide) => Slide): void {
    setSlides(slides.map((s, i) => (i === slideIdx ? fn(s) : s)))
  }
  function updateEl(id: string, patch: Partial<SlideElement>): void {
    mutateSlide((s) => updateElement(s, id, patch))
  }

  function undoLast(): void {
    const prev = undo.current.pop()
    if (!prev) return
    redo.current.push(body)
    setBody(prev)
    onChange(prev)
  }
  function redoLast(): void {
    const next = redo.current.pop()
    if (!next) return
    undo.current.push(body)
    setBody(next)
    onChange(next)
  }

  // Deck-level undo/redo on Cmd/Ctrl+Z (and Shift for redo), except while editing
  // text in an input or textarea (where the browser's own text undo should win).
  // A document listener rather than a div handler so it fires regardless of which
  // child has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const tag = (document.activeElement?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      e.preventDefault()
      e.shiftKey ? redoLast() : undoLast()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body])

  // ── Slide rail ops ────────────────────────────────────────────────────────
  // Insert a new slide built from a starter template, right after the current
  // one so it lands where the user is working.
  function addSlideFromTemplate(templateId: string): void {
    const tpl = SLIDE_TEMPLATES.find((t) => t.id === templateId)
    const elements = tpl ? tpl.build(theme) : layoutElements('title-content', theme)
    const s: Slide = {
      id: `sl-${Date.now().toString(36)}`,
      notes: '',
      layout: templateId === 'blank' ? 'blank' : 'title-content',
      elements,
      transition: 'none',
      background: { type: 'solid', color: theme.background },
      schemaVersion: 2
    }
    const insertAt = slideIdx + 1
    commit({ ...body, slides: [...slides.slice(0, insertAt), s, ...slides.slice(insertAt)] })
    setSel(insertAt)
    setSelectedIds([])
    setGalleryOpen(false)
  }
  /**
   * Copy a slide, with everything on it, straight after itself.
   *
   * Deep copies with fresh element ids: two slides sharing an element id makes
   * selection ambiguous, and two slides sharing a fill or a paragraph object
   * means editing one edits the other — the bug fixed in 6d22bff2 for ⌘D on a
   * single element, one level up.
   */
  function duplicateSlide(i: number): void {
    const src = slides[i]
    if (!src) return
    const copy: Slide = {
      ...structuredClone(src),
      id: `sl-${Date.now().toString(36)}`,
      elements: (src.elements ?? []).map((el) => ({ ...structuredClone(el), id: elementId() }))
    }
    const at = i + 1
    commit({ ...body, slides: [...slides.slice(0, at), copy, ...slides.slice(at)] })
    setSel(at)
    setSelectedIds([])
  }
  function deleteSlide(i: number): void {
    if (slides.length <= 1) return
    setSlides(slides.filter((_, si) => si !== i))
    setSel(Math.max(0, i - 1))
    setSelectedIds([])
  }
  function moveSlide(i: number, dir: -1 | 1): void {
    const j = i + dir
    if (j < 0 || j >= slides.length) return
    const next = [...slides]
    ;[next[i], next[j]] = [next[j], next[i]]
    setSlides(next)
    setSel(j)
  }

  // ── Insert elements ───────────────────────────────────────────────────────
  function insertText(): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'text',
      x: 240,
      y: 300,
      w: 800,
      h: 140,
      z: 10,
      fontFamily: theme.fontBody,
      vAlign: 'top',
      paragraphs: [{ runs: [{ text: 'Text', fontSize: theme.bodyStyle.fontSize, color: theme.textColor }], align: 'left' }]
    }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
  }
  function insertShape(shape: 'rect' | 'ellipse' | 'roundRect' | 'triangle'): void {
    const el: SlideElement = { id: elementId(), type: 'shape', shape, x: 440, y: 240, w: 400, h: 240, z: 10, fill: { type: 'solid', color: theme.accent } }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
  }
  function insertLine(): void {
    const el: SlideElement = { id: elementId(), type: 'line', x: 300, y: 320, w: 680, h: 0, z: 10, x2: 980, y2: 320, stroke: theme.accent, strokeWidth: 4, arrowEnd: true }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
  }
  async function insertImage(): Promise<void> {
    const res = await window.api.office.pickImage()
    if (!res.ok || !res.dataUrl) return
    const src = res.dataUrl
    // Measure the image so the frame starts at its true aspect ratio (rather
    // than a fixed box that distorts it), and so aspect-lock has a ratio to use.
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth || 600, h: img.naturalHeight || 360 })
      img.onerror = () => resolve({ w: 600, h: 360 })
      img.src = src
    })
    const ratio = Math.min(720 / dims.w, 480 / dims.h, 1)
    const w = Math.max(80, Math.round(dims.w * ratio))
    const h = Math.max(60, Math.round(dims.h * ratio))
    const el: SlideElement = {
      id: elementId(),
      type: 'image',
      src,
      fit: 'cover',
      lockAspect: true,
      naturalW: dims.w,
      naturalH: dims.h,
      x: Math.round((1280 - w) / 2),
      y: Math.round((720 - h) / 2),
      w,
      h,
      z: 10
    }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
  }
  // Insert a live desk-widget embed sized like a content card. The element only
  // stores the widget id; rendering resolves the current content every time.
  function insertWidget(widgetId: string): void {
    const el: SlideElement = { id: elementId(), type: 'widget', widgetId, x: 400, y: 200, w: 480, h: 320, z: 10 }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
  }
  // Insert a 3x3 table with a header row; edit cells + rows/cols from the inspector.
  function insertTable(): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'table',
      x: 240,
      y: 200,
      w: 800,
      h: 300,
      z: 10,
      headerRow: true,
      accent: theme.accent,
      cells: [
        ['Column 1', 'Column 2', 'Column 3'],
        ['', '', ''],
        ['', '', '']
      ]
    }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
  }
  // Insert a chart. It starts on clearly-labelled placeholder data; the inspector
  // links it to a real sheet range and refreshes the snapshot from live values.
  function insertChart(): void {
    const el: SlideElement = {
      id: elementId(),
      type: 'chart',
      x: 340,
      y: 170,
      w: 600,
      h: 380,
      z: 10,
      chart: {
        type: 'bar',
        title: 'Chart (sample data — link a sheet)',
        data: {
          categories: ['Q1', 'Q2', 'Q3', 'Q4'],
          series: [{ name: 'Series 1', values: [4, 7, 5, 9] }]
        }
      }
    }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
  }
  /**
   * Place what an armed tool makes, in the rect the person drew on the canvas
   * (slide coordinates; a plain click gives the default size centred on the
   * press). The same elements the Insert tab's one-shot buttons make, so a tool
   * and its button can never drift apart in what they create.
   */
  function placeTool(kind: string, rect: { x: number; y: number; w: number; h: number }): void {
    const def = TOOL_DEFAULT[kind as Exclude<DeckTool, 'select'>]
    if (!def) return
    const pageW = body.size?.w ?? 1280
    const pageH = body.size?.h ?? 720
    const w = Math.max(kind === 'line' ? 8 : 16, Math.round(rect.w))
    const h = kind === 'line' ? Math.round(rect.h) : Math.max(16, Math.round(rect.h))
    // Keep what is placed ON the slide: a click near an edge with a wide default
    // (a text box is 800 wide) would otherwise land half off it.
    const fit = (want: number, size: number, limit: number): number => Math.max(0, Math.min(Math.round(want), Math.round(limit - size)))
    const x = fit(rect.x, w, pageW)
    const y = fit(rect.y, kind === 'line' ? 0 : h, pageH)
    let el: SlideElement
    if (kind === 'text') {
      el = {
        id: elementId(),
        type: 'text',
        x,
        y,
        w,
        h,
        z: 10,
        fontFamily: theme.fontBody,
        vAlign: 'top',
        paragraphs: [{ runs: [{ text: 'Text', fontSize: theme.bodyStyle.fontSize, color: theme.textColor }], align: 'left' }]
      }
    } else if (kind === 'line') {
      el = { id: elementId(), type: 'line', x, y, w, h: 0, z: 10, x2: x + w, y2: y + h, stroke: theme.accent, strokeWidth: 4, arrowEnd: true }
    } else {
      el = { id: elementId(), type: 'shape', shape: kind as 'rect' | 'ellipse' | 'roundRect' | 'triangle', x, y, w, h, z: 10, fill: { type: 'solid', color: theme.accent } }
    }
    mutateSlide((s) => addElement(s, el))
    setSelectedIds([el.id])
    if (!toolLocked) setToolState('select')
  }
  // Resolve a sheet document's first tab and build ChartData from a range on it.
  async function dataFromSource(source: { sheetDocId: string; range: string; headerRow?: boolean; headerCol?: boolean }): Promise<ReturnType<typeof buildChartData> | null> {
    const doc = await window.api.documents.get(source.sheetDocId)
    if (!doc || doc.docType !== 'sheet') return null
    const sheet = (doc.body as { sheets?: SheetTab[] })?.sheets?.[0]
    if (!sheet) return null
    return buildChartData({ range: source.range, headerRow: source.headerRow, headerCol: source.headerCol }, sheet)
  }
  // Apply a fresh link: pull the data now, store it as the snapshot + the source.
  async function linkChart(id: string, source: { sheetDocId: string; range: string; headerRow?: boolean; headerCol?: boolean }, sheetTitle: string): Promise<void> {
    setChartLinkFor(null)
    const data = await dataFromSource(source)
    if (!data) {
      setStatus('Could not read that sheet range.')
      return
    }
    mutateSlide((s) =>
      updateElement(s, id, (() => {
        const e = (s.elements ?? []).find((x) => x.id === id)
        if (!e || e.type !== 'chart') return {}
        return { chart: { ...e.chart, data, title: e.chart.title === 'Chart (sample data — link a sheet)' ? sheetTitle : e.chart.title }, source }
      })())
    )
  }
  // Re-pull a linked chart's data from its source range.
  async function refreshChart(id: string): Promise<void> {
    const e = (slide?.elements ?? []).find((x) => x.id === id)
    if (!e || e.type !== 'chart' || !e.source) return
    const data = await dataFromSource(e.source)
    if (!data) {
      setStatus('Could not refresh: the linked sheet or range is unavailable.')
      return
    }
    mutateSlide((s) =>
      updateElement(s, id, (() => {
        const cur = (s.elements ?? []).find((x) => x.id === id)
        return cur && cur.type === 'chart' ? { chart: { ...cur.chart, data } } : {}
      })())
    )
    setStatus('Chart refreshed from sheet.')
  }
  function applyLayout(layout: SlideLayout): void {
    mutateSlide((s) => ({ ...s, layout, elements: layoutElements(layout, theme) }))
    setSelectedIds([])
  }
  function applyTheme(t: DeckTheme): void {
    commit(applyThemeToDeck(body, t))
  }

  // Apply the per-slide AI result to the real deck, routed by the action kind:
  //   notes     -> write the drafted notes into the slide's notes field
  //   design    -> match the recommended theme name to a real theme and apply it
  //   transform -> replace the slide's body text element with the rewritten text
  // Each path uses an existing real mutation; nothing here invents content.
  function applyAiResult(): void {
    const result = ai.result
    if (!result) return
    if (ai.kind === 'notes') {
      mutateSlide((s) => ({ ...s, notes: result }))
    } else if (ai.kind === 'design') {
      // The recommendation's first line names a theme; match it to a real theme.
      const firstLine = result.split('\n')[0].toLowerCase()
      const match = BUILTIN_THEMES.find((t) => firstLine.includes(t.name.toLowerCase()))
      if (match) applyTheme(match)
      else { setStatus('The design suggestion did not name a theme we have. Pick one from the Layout tab.'); ai.clearResult(); return }
    } else {
      // Replace the body text element (or the first text element) with the rewrite.
      const els = slide.elements ?? []
      const target = els.find((e) => e.type === 'text' && e.styleRole === 'body') ?? els.find((e) => e.type === 'text')
      if (!target) { setStatus('This slide has no text element to apply the rewrite to.'); ai.clearResult(); return }
      mutateSlide((s) => updateElement(s, target.id, (() => {
        const e = (s.elements ?? []).find((x) => x.id === target.id)
        return e && e.type === 'text' ? setElementText(e, result) : {}
      })()))
    }
    ai.clearResult()
  }

  // ── AI ────────────────────────────────────────────────────────────────────
  function applyAi(mode: 'deck' | 'append' | 'redesign', aiBody: SlidesBody): void {
    const migrated = migrateSlidesBody(aiBody)
    if (mode === 'deck') {
      commit(migrated)
      setSel(0)
    } else if (mode === 'append') {
      commit({ ...body, slides: [...slides, ...migrated.slides] })
      setSel(slides.length)
    } else {
      const redesigned = migrated.slides[0]
      if (redesigned) mutateSlide((s) => ({ ...s, elements: redesigned.elements, background: redesigned.background ?? s.background }))
    }
    setSidePane('ai')
    setSelectedIds([])
  }

  // ── Import / export ───────────────────────────────────────────────────────
  async function exportFile(format: 'pptx' | 'pdf'): Promise<void> {
    setStatus('Exporting…')
    try {
      const res = await window.api.slides.export({ body, title, format })
      setStatus(res.ok ? `Saved ${res.path}` : res.error ?? null)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }
  async function importFile(): Promise<void> {
    setStatus('Importing…')
    try {
      const res = await window.api.slides.import()
      if (res.ok && res.body) {
        const migrated = migrateSlidesBody(res.body)
        undo.current.push(body)
        setBody(migrated)
        onChange(migrated)
        setSel(0)
        setStatus('Imported. PowerPoint import is best-effort: text and basic layout only.')
      } else if (res.error) setStatus(res.error)
      else setStatus(null)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }

  // ── Selection operations (work on one element or many) ───────────────────
  // Centre the whole selection's bounding box on the slide.
  function centreSelection(axis: 'h' | 'v'): void {
    const els = (slide.elements ?? []).filter((e) => selectedIds.includes(e.id))
    if (!els.length) return
    if (axis === 'h') {
      const minX = Math.min(...els.map((e) => e.x))
      const maxR = Math.max(...els.map((e) => e.x + e.w))
      mutateSlide((s) => moveElementsBy(s, selectedIds, (1280 - (maxR - minX)) / 2 - minX, 0))
    } else {
      const minY = Math.min(...els.map((e) => e.y))
      const maxB = Math.max(...els.map((e) => e.y + e.h))
      mutateSlide((s) => moveElementsBy(s, selectedIds, 0, (720 - (maxB - minY)) / 2 - minY))
    }
  }
  function doAlign(edge: AlignEdge): void {
    mutateSlide((s) => alignElements(s, selectedIds, edge))
  }
  function doDistribute(axis: 'h' | 'v'): void {
    mutateSlide((s) => distributeElements(s, selectedIds, axis))
  }
  function doGroup(): void {
    if (selectedIds.length >= 2) mutateSlide((s) => groupElements(s, selectedIds))
  }
  function doUngroup(): void {
    mutateSlide((s) => ungroupElements(s, selectedIds))
  }
  function reorderSelection(dir: 'front' | 'back' | 'forward' | 'backmost'): void {
    mutateSlide((s) => selectedIds.reduce((acc, id) => reorderZ(acc, id, dir), s))
  }
  function duplicateSelection(): void {
    if (!selectedIds.length) return
    let s = slide
    const newIds: string[] = []
    for (const id of selectedIds) {
      const r = duplicateElement(s, id)
      s = r.slide
      newIds.push(r.newId)
    }
    mutateSlide(() => s)
    setSelectedIds(newIds)
  }
  // Cut / Copy / Paste, shared with PlexiiDesign: the hook owns the DOM
  // clipboard events, so ⌘C/⌘V and the native Edit menu run the same code.
  const clipboard = useElementClipboard({
    canvas: () => ({ w: body.size?.w ?? 1280, h: body.size?.h ?? 720 }),
    selected: () => {
      const ids = new Set(selectedIds)
      return (slides[slideIdx]?.elements ?? []).filter((e) => ids.has(e.id))
    },
    topZ: () => (slides[slideIdx]?.elements ?? []).reduce((m, e) => Math.max(m, e.z ?? 0), 0),
    newId: elementId,
    onPaste: (els) => {
      mutateSlide((s) => els.reduce((acc, el) => addElement(acc, el), s))
      setSelectedIds(els.map((e) => e.id))
    },
    onCut: (ids) => {
      mutateSlide((s) => ids.reduce((acc, id) => deleteElement(acc, id), s))
      setSelectedIds([])
    },
    // No `enabled` guard needed here: a slide's text is edited in a real
    // <textarea> inside SlideCanvas, and the hook already declines any
    // clipboard event whose target is a field. PlexiiDesign needs the guard
    // because its on-page caret is not a field.
  })

  function deleteSelection(): void {
    if (!selectedIds.length) return
    mutateSlide((s) => selectedIds.reduce((acc, id) => deleteElement(acc, id), s))
    setSelectedIds([])
  }
  const anyGrouped = (slide.elements ?? []).some((e) => selectedIds.includes(e.id) && e.groupId)

  // Keyboard-direct manipulation of the selection: arrow keys nudge the whole
  // selection by 1 (10 with Shift), Cmd/Ctrl+D duplicates, Delete/Backspace
  // removes, Cmd/Ctrl+G groups and Shift+Cmd/Ctrl+G ungroups — never while a text
  // field is focused, so typing and the notes box are unaffected.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (document.activeElement as HTMLElement | null)?.isContentEditable) return
      const mod = e.metaKey || e.ctrlKey
      // Armed tools (D4). This is the app's one key handler; the rail never
      // listens for keys. Plain letters only, so Cut/Copy/Group keep theirs.
      if (!mod && !e.altKey) {
        if (e.key === 'Escape' && tool !== 'select') {
          e.preventDefault()
          setTool('select')
          return
        }
        const arm: Record<string, DeckTool> = { v: 'select', t: 'text', m: 'rect', l: 'ellipse', '\\': 'line' }
        const next = arm[e.key.toLowerCase()]
        if (next) {
          e.preventDefault()
          setTool(next)
          return
        }
      }
      if (!selectedIds.length) return
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelectedIds([])
        return
      }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (e.shiftKey) doUngroup()
        else doGroup()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        duplicateSelection()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      const step = e.shiftKey ? 10 : 1
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else return
      e.preventDefault()
      mutateSlide((s) => moveElementsBy(s, selectedIds, dx, dy))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, slideIdx, body, tool])

  // Publish the deck's commands to the Cmd+K palette under the 'Slides' scope.
  // Selection-only actions appear with a selection; align/distribute/group only
  // when several elements are selected.
  useRegisterEditorCommands(
    'Slides',
    () => {
      const n = selectedIds.length
      const multi = n >= 2
      const cmds: EditorCommand[] = [
        { id: 'sl-text', label: 'Insert text box', icon: 'title', group: 'Insert', run: insertText },
        { id: 'sl-shape', label: 'Insert shape', icon: 'crop_square', group: 'Insert', keywords: 'rectangle box', run: () => insertShape('rect') },
        { id: 'sl-ellipse', label: 'Insert ellipse', icon: 'circle', group: 'Insert', keywords: 'oval circle', run: () => insertShape('ellipse') },
        { id: 'sl-image', label: 'Insert image', icon: 'image', group: 'Insert', keywords: 'picture photo', run: () => void insertImage() },
        { id: 'sl-line', label: 'Insert line', icon: 'horizontal_rule', group: 'Insert', keywords: 'arrow connector', run: insertLine },
        { id: 'sl-widget', label: 'Insert work widget from a desk', icon: 'widgets', group: 'Insert', keywords: 'embed desk canvas', run: () => setWidgetPickerOpen(true) },
        { id: 'sl-chart', label: 'Insert chart', icon: 'bar_chart', group: 'Insert', keywords: 'graph plot data sheet', run: insertChart },
        { id: 'sl-table', label: 'Insert table', icon: 'table_chart', group: 'Insert', keywords: 'grid rows columns cells', run: insertTable },
        { id: 'sl-new', label: 'New slide', icon: 'add_to_photos', group: 'Slide', keywords: 'add template', run: () => setGalleryOpen(true) },
        { id: 'sl-present', label: 'Present deck', icon: 'play_arrow', group: 'Slide', keywords: 'slideshow play', run: () => setPresenting(true) },
        { id: 'sl-ai', label: 'AI: generate or redesign slides', icon: 'auto_awesome', group: 'AI', keywords: 'design make beautiful', run: () => setSidePane('generate') },
        { id: 'sl-undo', label: 'Undo', icon: 'undo', shortcut: '⌘Z', group: 'Edit', run: undoLast },
        { id: 'sl-redo', label: 'Redo', icon: 'redo', shortcut: '⇧⌘Z', group: 'Edit', run: redoLast },
        { id: 'sl-import', label: 'Import PowerPoint (.pptx)', icon: 'upload_file', group: 'File', keywords: 'open pptx', run: () => void importFile() },
        { id: 'sl-export-pptx', label: 'Export PowerPoint (.pptx)', icon: 'slideshow', group: 'File', keywords: 'save pptx', run: () => void exportFile('pptx') },
        { id: 'sl-export-pdf', label: 'Export PDF', icon: 'picture_as_pdf', group: 'File', keywords: 'save pdf', run: () => void exportFile('pdf') }
      ]
      if (n >= 1) {
        cmds.push(
          { id: 'sl-dup', label: multi ? `Duplicate ${n} elements` : 'Duplicate element', icon: 'content_copy', shortcut: '⌘D', group: 'Arrange', run: duplicateSelection },
          { id: 'sl-del', label: multi ? `Delete ${n} elements` : 'Delete element', icon: 'delete', group: 'Arrange', keywords: 'remove', run: deleteSelection },
          { id: 'sl-ch', label: 'Centre on slide horizontally', icon: 'align_horizontal_center', group: 'Arrange', keywords: 'align center middle slide', run: () => centreSelection('h') },
          { id: 'sl-cv', label: 'Centre on slide vertically', icon: 'align_vertical_center', group: 'Arrange', keywords: 'align center middle slide', run: () => centreSelection('v') },
          { id: 'sl-front', label: 'Bring to front', icon: 'flip_to_front', group: 'Arrange', keywords: 'z order top', run: () => reorderSelection('front') },
          { id: 'sl-forward', label: 'Bring forward', icon: 'arrow_upward', group: 'Arrange', keywords: 'z order', run: () => reorderSelection('forward') },
          { id: 'sl-backward', label: 'Send backward', icon: 'arrow_downward', group: 'Arrange', keywords: 'z order', run: () => reorderSelection('back') },
          { id: 'sl-back', label: 'Send to back', icon: 'flip_to_back', group: 'Arrange', keywords: 'z order bottom', run: () => reorderSelection('backmost') }
        )
      }
      if (multi) {
        cmds.push(
          { id: 'sl-al', label: 'Align left edges', icon: 'align_horizontal_left', group: 'Align', keywords: 'left', run: () => doAlign('left') },
          { id: 'sl-acx', label: 'Align horizontal centres', icon: 'align_horizontal_center', group: 'Align', keywords: 'center middle', run: () => doAlign('centerX') },
          { id: 'sl-ar', label: 'Align right edges', icon: 'align_horizontal_right', group: 'Align', keywords: 'right', run: () => doAlign('right') },
          { id: 'sl-at', label: 'Align top edges', icon: 'align_vertical_top', group: 'Align', keywords: 'top', run: () => doAlign('top') },
          { id: 'sl-amy', label: 'Align vertical centres', icon: 'align_vertical_center', group: 'Align', keywords: 'middle center', run: () => doAlign('middleY') },
          { id: 'sl-ab', label: 'Align bottom edges', icon: 'align_vertical_bottom', group: 'Align', keywords: 'bottom', run: () => doAlign('bottom') },
          { id: 'sl-group', label: `Group ${n} elements`, icon: 'group_work', shortcut: '⌘G', group: 'Arrange', keywords: 'combine link', run: doGroup }
        )
        if (n >= 3) {
          cmds.push(
            { id: 'sl-dh', label: 'Distribute horizontally', icon: 'horizontal_distribute', group: 'Align', keywords: 'space even', run: () => doDistribute('h') },
            { id: 'sl-dv', label: 'Distribute vertically', icon: 'vertical_distribute', group: 'Align', keywords: 'space even', run: () => doDistribute('v') }
          )
        }
      }
      if (anyGrouped) {
        cmds.push({ id: 'sl-ungroup', label: 'Ungroup', icon: 'category', shortcut: '⇧⌘G', group: 'Arrange', keywords: 'split separate', run: doUngroup })
      }
      return cmds
    },
    [selectedIds, slideIdx, body, anyGrouped]
  )

  // The bar's and the rail's view of the editor, rebuilt each render.
  const isPanelOpen = (p: DeckPanel): boolean => openPanels.includes(p)
  const openPanel = (p: DeckPanel): void => setOpenPanels((o) => (o.includes(p) ? o : [...o, p]))
  const closePanel = (p: DeckPanel): void => setOpenPanels((o) => o.filter((x) => x !== p))
  const togglePanel = (p: DeckPanel): void => setOpenPanels((o) => (o.includes(p) ? o.filter((x) => x !== p) : [...o, p]))
  const setPin = (p: DeckPanel, v: boolean): void =>
    setPinned((cur) => {
      const next = v ? [...new Set([...cur, p])] : cur.filter((x) => x !== p)
      writePref(PINS_KEY, next)
      return next
    })
  const selectedEls = (slide?.elements ?? []).filter((e) => selectedIds.includes(e.id))
  const textUpdate = (id: string, fn: (e: Extract<SlideElement, { type: 'text' }>) => Partial<SlideElement>): void =>
    mutateSlide((s) =>
      updateElement(s, id, (() => {
        const e = (s.elements ?? []).find((x) => x.id === id)
        return e && e.type === 'text' ? fn(e) : {}
      })())
    )
  const ctx: DeckCtx = {
    slide,
    theme,
    selected: selectedEls,
    el: selectedEl,
    anyGrouped,
    readOnly: false,
    tool,
    setTool,
    isPanelOpen,
    togglePanel,
    openPanel,
    sidePane,
    openSidePane: (p) => setSidePane(p),
    toggleSidePane: (p) => setSidePane(sidePane === p ? null : p),
    ed: {
      insertText,
      insertShape,
      insertLine,
      insertImage: () => void insertImage(),
      insertTable,
      insertChart,
      insertWidget: () => setWidgetPickerOpen(true),
      openGallery: () => setGalleryOpen(true),
      duplicateSlide: () => duplicateSlide(slideIdx),
      applyLayout,
      applyTheme,
      setBackground: (color) => mutateSlide((s) => ({ ...s, background: { type: 'solid', color } })),
      setTransition: (t: SlideTransition) => mutateSlide((s) => ({ ...s, transition: t })),
      updateEl,
      styleText: (id, patch) => textUpdate(id, (e) => styleTextElement(e, patch)),
      alignText: (id, align) => textUpdate(id, (e) => setParagraphAlign(e, align)),
      setList: (id, style) => textUpdate(id, (e) => setListStyle(e, style)),
      align: doAlign,
      distribute: doDistribute,
      centre: centreSelection,
      group: doGroup,
      ungroup: doUngroup,
      reorder: reorderSelection,
      duplicateSelection,
      deleteSelection,
      crop: (id) => setCropId(id),
      linkChart: (id) => setChartLinkFor(id),
      refreshChart: (id) => void refreshChart(id),
      checkA11y: () => setA11yIssues(checkSlidesA11y(body)),
      focusNotes: () => {
        notesRef.current?.scrollIntoView({ block: 'nearest' })
        notesRef.current?.focus()
      }
    }
  }
  const railItems = useMemo(() => deckRailItems(), [])
  // A pinned panel reports its rect; the inset is its right edge measured from the
  // canvas column's own left (the panel is absolute, so the padding never moves it:
  // no feedback loop). Unpinned panels are transient and may cover the canvas.
  // Stable per panel: ShellPanel re-runs its rect effect when this identity changes,
  // and its cleanup reports null, so an inline arrow here would loop through state.
  const reportPanelRect = useMemo(() => {
    const report = (id: string, rect: DOMRect | null): void => {
      panelRects.current[id] = rect
      const left = canvasWrap.current?.parentElement?.getBoundingClientRect().left ?? 0
      const right = Math.max(0, ...Object.values(panelRects.current).map((r) => (r ? Math.ceil(r.right - left) : 0)))
      setPanelInset((cur) => (cur === right ? cur : right))
    }
    return { layouts: (r: DOMRect | null) => report('layouts', r), cells: (r: DOMRect | null) => report('cells', r) }
  }, [])
  const tableEl = selectedEl?.type === 'table' ? selectedEl : null

  if (!slide) return <div className="p-6 text-[var(--ink-40)]">Empty deck.</div>

  return (
    <div ref={rootRef} className="h-full min-w-0 flex flex-col">
      <OfficeShellLayout
        testid="slides-shell"
        asideLabel="Slides"
        bar={
          <ContextBar<DeckCtx>
            testid="slides-toolbar"
            tabs={DECK_TABS}
            ctx={ctx}
            activeTab={tab}
            onTabChange={(t) => {
              setTab(t)
              writePref(TAB_KEY, t)
            }}
            collapsed={collapsed}
            onCollapsedChange={(v) => {
              setCollapsed(v)
              writePref(COLLAPSE_KEY, v)
            }}
            menuBar={
              <SlidesMenuBar
          actions={{
            title,
            undo: undoLast,
            redo: redoLast,
            canUndo: undo.current.length > 0,
            canRedo: redo.current.length > 0,
            present: () => setPresenting(true),
            checkA11y: () => setA11yIssues(checkSlidesA11y(body)),
            newSlide: () => addSlideFromTemplate('blank'),
            duplicateSlide: () => duplicateSlide(slideIdx),
            deleteSlide: () => deleteSlide(slideIdx),
            copySelection: clipboard.copy,
            cutSelection: clipboard.cut,
            pasteClipboard: clipboard.paste,
            canPaste: clipboard.hasClip,
            hasSelection: selectedIds.length > 0,
            moveSlideUp: () => moveSlide(slideIdx, -1),
            moveSlideDown: () => moveSlide(slideIdx, 1),
            duplicateSelection,
            deleteSelection,
            insertText,
            insertImage: () => void insertImage(),
            insertShape,
            insertLine,
            insertWidget: () => setWidgetPickerOpen(true),
            insertChart,
            insertTable,
            align: (dir) => doAlign(dir),
            group: doGroup,
            ungroup: doUngroup,
            exportFile: (f) => void exportFile(f),
            importFile: () => void importFile()
          }}
              />
            }
            pinnedStart={
              <>
                <BarButton icon="undo" label="Undo" shortcut="⌘Z" disabled={undo.current.length === 0} onClick={undoLast} testid="slides-undo" />
                <BarButton icon="redo" label="Redo" shortcut="⇧⌘Z" disabled={redo.current.length === 0} onClick={redoLast} testid="slides-redo" />
              </>
            }
            rightSlot={
              <>
                <BarButton icon="play_arrow" label="Present" showLabel onClick={() => setPresenting(true)} testid="slides-present" readOnlySafe />
                <BarToggle icon="right_panel_open" label="Side pane" pressed={sidePane !== null} onChange={(v) => setSidePane(v ? 'ai' : null)} controls={SIDE_PANE_DOM_ID} testid="slides-sidepane-toggle" readOnlySafe />
              </>
            }
          />
        }
        rail={
          <ToolRail<DeckCtx>
            testid="slides-rail"
            items={railItems}
            ctx={ctx}
            activeId={railIdForTool(tool)}
            openPanels={[...openPanels, ...(sidePane === 'ai' ? ['ai'] : [])]}
            lastUsed={{ shapes: lastShape }}
            onFlyoutPick={(_f, id) => setLastShape(id)}
            ariaLabel="Slide tools"
          />
        }
        leftAside={
          // The navigator (SPEC §1): slide thumbnails, not tools or settings, as in PowerPoint.
          <div className="w-40 h-full overflow-auto p-2 space-y-2" data-testid="slides-thumbnails">
            {slides.map((s, i) => (
              <div key={s.id} className="group relative">
                <button
                  onClick={() => { setSel(i); setSelectedIds([]) }}
                  className={`block w-full rounded-md overflow-hidden border-2 ${i === slideIdx ? 'border-accent' : 'border-[var(--edge-soft)]'}`}
                  aria-label={`Slide ${i + 1}`}
                  aria-current={i === slideIdx ? 'true' : undefined}
                >
                  <SlideFace slide={s} theme={theme} width={140} />
                </button>
                <span className="absolute top-1 left-1 text-[9px] font-semibold text-white bg-black/40 rounded px-1">{i + 1}</span>
                <div className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex flex-col gap-0.5">
                  <button onClick={() => moveSlide(i, -1)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5" title="Move up"><Icon name="keyboard_arrow_up" size={12} /></button>
                  <button onClick={() => moveSlide(i, 1)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5" title="Move down"><Icon name="keyboard_arrow_down" size={12} /></button>
                  <button onClick={() => duplicateSlide(i)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5" title="Duplicate this slide" data-testid={`slides-duplicate-${i}`}><Icon name="file_copy" size={12} /></button>
                  <button onClick={() => deleteSlide(i)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5 text-red-500" title="Delete" data-testid={`slides-delete-${i}`}><Icon name="close" size={12} /></button>
                </div>
              </div>
            ))}
            <button onClick={() => setGalleryOpen(true)} className="w-full aspect-video rounded-md border-2 border-dashed border-[var(--edge-firm)] text-[var(--ink-40)] hover:text-accent hover:border-accent flex items-center justify-center" data-testid="slides-add" aria-label="New slide">
              <Icon name="add" size={20} />
            </button>
          </div>
        }
        panels={
          openPanels.length ? (
            <>
              <ShellPanel
                id="layouts"
                title="Layouts and themes"
                icon="view_quilt"
                open={isPanelOpen('layouts')}
                onClose={() => closePanel('layouts')}
                pinnable
                pinned={pinned.includes('layouts')}
                onPinnedChange={(v) => setPin('layouts', v)}
                onRectChange={reportPanelRect.layouts}
                fill
                testid="slides-panel-layouts"
              >
                <LayoutsAndThemes slide={slide} theme={theme} onApplyLayout={applyLayout} onApplyTheme={applyTheme} />
              </ShellPanel>
              <ShellPanel
                id="cells"
                title="Table cells"
                icon="edit_note"
                open={isPanelOpen('cells') && !!tableEl}
                onClose={() => closePanel('cells')}
                pinnable
                pinned={pinned.includes('cells')}
                onPinnedChange={(v) => setPin('cells', v)}
                onRectChange={reportPanelRect.cells}
                testid="slides-panel-cells"
              >
                {tableEl && (
                  <div className="space-y-1 max-h-72 overflow-auto p-2" data-testid="table-cells">
                    {tableEl.cells.map((row, r) => (
                      <div key={r} className="flex gap-1">
                        {row.map((cell, c) => (
                          <input
                            key={c}
                            aria-label={`Row ${r + 1}, column ${c + 1}`}
                            className="fb-field min-w-0 flex-1 px-1 py-0.5 text-[11px]"
                            value={cell}
                            onChange={(e) => {
                              const next = tableEl.cells.map((rr) => rr.slice())
                              next[r][c] = e.target.value
                              updateEl(tableEl.id, { cells: next })
                            }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </ShellPanel>
            </>
          ) : undefined
        }
        rightPane={
          <ShellSidePane
            testid="slides-side-panel"
            panes={[
              {
                id: 'ai',
                title: 'PlexiiAssist',
                icon: 'auto_awesome',
                testid: 'slides-ai-assistant',
                render: () => <SlideAssistantPane slide={slide} ai={ai} onApplyAi={applyAiResult} onDeckGenerate={() => setSidePane('generate')} />
              },
              {
                id: 'generate',
                title: 'Generate deck',
                icon: 'slideshow',
                testid: 'slides-ai-generate',
                render: () => (
                  <div className="p-3">
                    <AiSlidePanel theme={theme} slideSummary={slideSummary} onApply={applyAi} onClose={() => setSidePane('ai')} />
                  </div>
                )
              }
            ]}
            activeId={sidePane}
            onChange={(id) => setSidePane(id === 'ai' || id === 'generate' ? id : null)}
          />
        }
      >
        {/* Canvas column */}
        <div
          ref={canvasWrap}
          // Named so the surface that accepts a drop is addressable. It had
          // no testid, which is why a test aimed at a neighbouring element
          // and reported a working drop as broken.
          data-testid="slides-canvas"
          className="absolute inset-0 min-w-0 overflow-auto bg-stone-100 dark:bg-stone-950/40 p-4"
          style={panelInset ? { paddingLeft: panelInset + 16 } : undefined}
          // Drag a work widget from the side menu straight onto the slide.
          // Until now the only way in was "Insert work widget from a desk",
          // which could not reach a widget that has no desk — i.e. most of
          // them, since 4.3.32 made every work widget a file.
          onDragOver={(e) => {
            if (!acceptsWidgetDrag(e.dataTransfer)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(e) => {
            if (!acceptsWidgetDrag(e.dataTransfer)) return
            e.preventDefault()
            void widgetIdFromDrop(e.dataTransfer).then((id) => {
              if (id) insertWidget(id)
            })
          }}
        >
          {status && (
            <div className="mb-2 text-[12px] text-[var(--ink-50)] flex items-center gap-1.5" data-testid="slides-status">
              <span>{status}</span>
              <button onClick={() => setStatus(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]"><Icon name="close" size={12} /></button>
            </div>
          )}
          <div className="flex justify-center" data-tool={tool}>
            <SlideCanvas
              slide={slide}
              theme={theme}
              width={canvasW}
              selectedIds={selectedIds}
              onSelect={selectElement}
              onSelectMany={selectMany}
              onUpdateElement={updateEl}
              onMoveMany={(ids, dx, dy) => mutateSlide((s) => moveElementsBy(s, ids, dx, dy))}
              onSetText={(id, text) =>
                mutateSlide((s) => updateElement(s, id, (() => {
                  const e = (s.elements ?? []).find((x) => x.id === id)
                  return e && e.type === 'text' ? setElementText(e, text) : {}
                })()))
              }
              placing={tool === 'select' ? null : { kind: tool, defaultW: TOOL_DEFAULT[tool].w, defaultH: TOOL_DEFAULT[tool].h }}
              onPlace={placeTool}
            />
          </div>
          {/* Speaker notes stay under the canvas (owner ruling, SPEC §6.4). */}
          <div className="max-w-3xl mx-auto mt-3">
            <label htmlFor="slides-notes" className="block text-[11px] uppercase tracking-wide text-[var(--ink-40)] mb-1">Speaker notes</label>
            <textarea
              id="slides-notes"
              ref={notesRef}
              data-testid="slides-notes-editor"
              value={slide.notes}
              onChange={(e) => mutateSlide((s) => ({ ...s, notes: e.target.value }))}
              rows={2}
              placeholder="What to actually say on this slide"
              className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-[13px] resize-none"
            />
          </div>
        </div>
      </OfficeShellLayout>

      {galleryOpen && (
        <SlideTemplateGallery theme={theme} onPick={addSlideFromTemplate} onClose={() => setGalleryOpen(false)} />
      )}

      {widgetPickerOpen && (
        <WidgetPickerDialog
          onPick={(widgetId) => {
            setWidgetPickerOpen(false)
            insertWidget(widgetId)
          }}
          onClose={() => setWidgetPickerOpen(false)}
        />
      )}

      {presenting && <PresentOverlay slides={slides} theme={theme} startIndex={slideIdx} onClose={() => setPresenting(false)} />}

      {cropId &&
        (() => {
          const target = (slide.elements ?? []).find((e) => e.id === cropId)
          if (!target || target.type !== 'image') return null
          return (
            <CropDialog
              el={target}
              onApply={(crop) => {
                updateEl(cropId, { crop })
                setCropId(null)
              }}
              onClose={() => setCropId(null)}
            />
          )
        })()}

      {chartLinkFor &&
        (() => {
          const target = (slide.elements ?? []).find((e) => e.id === chartLinkFor)
          if (!target || target.type !== 'chart') return null
          return (
            <ChartLinkDialog
              current={target.source}
              onApply={(source, sheetTitle) => void linkChart(chartLinkFor, source, sheetTitle)}
              onClose={() => setChartLinkFor(null)}
            />
          )
        })()}

      {a11yIssues !== null && (
        <div className="fb-scrim fixed inset-0 z-[60] flex items-center justify-center" onMouseDown={() => setA11yIssues(null)}>
          <div
            className="fb-card w-[380px] p-4"
            data-testid="slides-a11y-modal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[14px] font-semibold text-[var(--ink-90)]">Accessibility check</h3>
              <button onClick={() => setA11yIssues(null)} className="icon-btn" title="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
            {a11yIssues.length === 0 ? (
              <div className="flex items-center gap-2 text-[13px] text-emerald-600" data-testid="slides-a11y-clean">
                <Icon name="check_circle" size={16} />
                <span>No accessibility issues found.</span>
              </div>
            ) : (
              <div className="space-y-2" data-testid="slides-a11y-issues">
                {a11yIssues.map((it, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px]" data-testid="slides-a11y-issue">
                    <Icon
                      name={it.severity === 'error' ? 'error' : 'warning'}
                      size={15}
                      className={it.severity === 'error' ? 'text-rose-500 shrink-0 mt-0.5' : 'text-amber-500 shrink-0 mt-0.5'}
                    />
                    <span className="text-[var(--ink-70)]">{it.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
