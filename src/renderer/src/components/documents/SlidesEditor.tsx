import { dragCarriesFiles } from '../../lib/filesDrag'
import { filesDropRefs, pagePointFromDrop, runContentDrop } from '../../lib/filesContentDrop'
import { pasteConverted } from '../../lib/clipboardPaste'
import { widgetFileGroupId } from '@shared/widgetFiles'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DeckTheme, Slide, SlideElement, SlideLayout, SlidesBody, SlideTransition } from '@shared/types'
import { resolveTheme, layoutElements, applyThemeToDeck, BUILTIN_THEMES } from '@shared/slideThemes'
import { SLIDE_TEMPLATES } from '@shared/slideTemplates'
import { migrateSlidesBody } from '@shared/slidesMigrate'
import SlideFace from './slides/SlideFace'
import type { DocumentOps } from './editor/documentOps'
import { usePrintSource } from './editor/printSource'
import SlideCanvas from './slides/SlideCanvas'
import { acceptsWidgetDrag, widgetIdFromDrop } from '../../lib/widgetDropInsert'
import SlidesMenuBar from './editor/SlidesMenuBar'
import { buildDeckCommands } from './slides/deckCommands'
import { barProps, ctxRow, paletteEntries } from '../../lib/menus/officeCommand'
import { runCommandKey } from '../../lib/menus/commandKeys'
import RecordFindReplace from './editor/RecordFindReplace'
import CanvasContextMenu from '../CanvasContextMenu'
import { canvasMenu, objectMenu } from '../../lib/menus/officeContextMenu'
import { replaceInRuns, type FindRecord, type RecordHit } from '../../lib/recordFind'
import SlideTemplateGallery from './slides/SlideTemplateGallery'
import PresentOverlay from './slides/PresentOverlay'
import AiSlidePanel from './slides/AiSlidePanel'
import SlideAssistantPane, { LayoutsAndThemes } from './slides/SlidesSidePanel'
import { BarButton, BarToggle, ContextBar, OfficeShellLayout, PANEL_SHEET_BELOW, ShellPanel, ShellSidePane, SIDE_PANE_DOM_ID, ToolRail, useShellChrome } from '../office/shell'
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
  reorderMany,
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
import { useRegisterEditorCommands } from '../../stores/editorCommands'
import Icon from '../Icon'
import WidgetPickerDialog from './embed/WidgetPickerDialog'
import SnippetLibrary from '../snippets/SnippetLibrary'
import SaveSnippetDialog from '../snippets/SaveSnippetDialog'
import type { Snippet, SlideSnippetBody } from '@shared/snippets'
import { DECK_PAGE, deckSnippetTargetId, slideBodyFromSelection, slideElementsFromSnippet, suggestedSlideSnippetName, useDeckSnippetTarget } from './slides/deckSnippets'
import { officeAccepts } from '../../lib/officeSnippets'
import { pastedSnippet } from '../../lib/clipboardPaste'
import type { SnippetKind } from '@shared/snippets'
import { EmbedDisplayWriterContext, type EmbedDisplayWriter } from '../../lib/widgetSurface'

// PowerPoint-class slides editor on the office shell (SPEC §6.4). The deck is
// held as v2 (element-based) in local state; legacy decks migrate on mount. The
// ToolRail arms tools, the ContextBar's tabs hold every setting (the right
// inspector is retired, D1), the slide thumbnails are the navigator, the canvas
// edits the selected slide, PlexiiAssist sits in the shared right side pane and
// speaker notes stay under the canvas. Edits flow to onChange (debounced autosave).

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

/** Stable, so the library's refresh effect (keyed on kinds) runs once per open. */
// Every kind with a conversion into this app, derived from the builders.
const SLIDE_KINDS: SnippetKind[] = officeAccepts('slide')

interface Props {
  body: SlidesBody
  title: string
  onChange: (body: SlidesBody) => void
  /**
   * Show the deck without letting it change: no edit commits (commit, undo,
   * redo and import are the only ways out, and all four refuse), the stage is
   * the static slide face, the shell disables every control that is not
   * readOnlySafe, and the navigator offers no move/duplicate/delete/add.
   * onChange is never called.
   */
  readOnly?: boolean
  /**
   * Edit one slide with no deck around it (a slide snippet, which is a fragment):
   * the navigator is hidden and every slide-level command (new, duplicate,
   * delete, move, templates) refuses, so nothing can be added that the snippet
   * would have nowhere to keep.
   */
  singleSlide?: boolean
  /**
   * The document this deck IS, bound by the host (createDocumentOps): what the
   * File menu's document items act on. Absent (a snippet session) → those items
   * are not shown. The editor itself never knows a document id.
   */
  documentOps?: DocumentOps
}

export default function SlidesEditor({ body: rawBody, title, onChange, readOnly = false, singleSlide = false, documentOps }: Props): JSX.Element {
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
  // Saved snippets: the library (insert) and the save dialog (capture). The
  // dialog gets an EMPTY body when nothing is selected, so it can say so
  // rather than the menu item appearing to do nothing.
  const [snippetLibraryOpen, setSnippetLibraryOpen] = useState(false)
  const [snippetDraft, setSnippetDraft] = useState<SlideSnippetBody | null>(null)
  // This mounted editor, as a snippet destination: two decks open at once are
  // two destinations, so the id is the mount, not the document.
  const snippetScope = useId()
  const [status, setStatus] = useState<string | null>(null)
  const [canvasW, setCanvasW] = useState(720)
  // Shell state: the active tab (opens on Home), Row 2 collapse (D5, remembered)
  // and the shapes flyout's last pick, the same in every app (SPEC §3.9); then
  // the overlay panels and the right side pane.
  const chrome = useShellChrome('slides', { shapes: 'tool-rect' })
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
  // Find and replace (SPEC §9.2) over the whole deck: every text box's
  // paragraphs, every table cell and the speaker notes, as Google Slides does.
  // A key addresses one piece of text: t|slide|element|paragraph,
  // c|slide|element|row|col, n|slide.
  const [findOpen, setFindOpen] = useState<false | 'find' | 'replace'>(false)
  // Right-click on the slide (SPEC §9.3): an element gets the object menu, the
  // empty slide the canvas menu. A text box being typed in is text, and gets
  // the native text menu. `at` is the slide point, for "Add … here".
  const [deckMenu, setDeckMenu] = useState<{ x: number; y: number; onElement: boolean; at: { x: number; y: number } } | null>(null)
  function openDeckMenu(e: React.MouseEvent): void {
    if (readOnly) return
    const t = e.target as HTMLElement
    if (t.closest('textarea, input, [contenteditable="true"]')) return
    const page = t.closest('[data-testid="slide-canvas"]')
    if (!page) return
    // The element's frame (react-draggable) holds the element's content node,
    // which carries the id (the content itself takes no pointer events).
    const elId = t.closest('.react-draggable')?.querySelector('[data-element-id]')?.getAttribute('data-element-id') ?? null
    e.preventDefault()
    if (elId && !selectedIds.includes(elId)) selectElement(elId, false)
    if (!elId) setSelectedIds([])
    const box = page.getBoundingClientRect()
    const pageW = body.size?.w ?? 1280
    const pageH = body.size?.h ?? 720
    setDeckMenu({
      x: e.clientX,
      y: e.clientY,
      onElement: !!elId,
      at: { x: ((e.clientX - box.left) / box.width) * pageW, y: ((e.clientY - box.top) / box.height) * pageH }
    })
  }
  function placeHere(kind: 'text' | 'rect', at: { x: number; y: number }): void {
    const d = TOOL_DEFAULT[kind]
    placeTool(kind, { x: at.x - d.w / 2, y: at.y - d.h / 2, w: d.w, h: d.h })
  }
  const findRecords = useMemo(
    () =>
      slides.flatMap((s, si) => [
        ...(s.elements ?? []).flatMap((e) =>
          e.type === 'text'
            ? e.paragraphs.map((p, pi) => ({ key: `t|${si}|${e.id}|${pi}`, text: p.runs.map((r) => r.text).join('') }))
            : e.type === 'table'
              ? e.cells.flatMap((row, r) => row.map((text, c) => ({ key: `c|${si}|${e.id}|${r}|${c}`, text })))
              : []
        ),
        ...(s.notes ? [{ key: `n|${si}`, text: s.notes }] : [])
      ]),
    [slides]
  )
  function goToHit(key: string): void {
    const [kind, si, elId] = key.split('|') as [string, string, string]
    const target = slides[Number(si)]
    if (!target) return
    setSel(Number(si))
    setSelectedIds(kind === 'n' ? [] : withGroupMembers(target, [elId]))
  }
  function replaceText(changes: FindRecord[], hits: RecordHit[], replacement: string): void {
    if (!changes.length) return
    const ranges = new Map<string, RecordHit[]>()
    for (const h of hits) ranges.set(h.key, [...(ranges.get(h.key) ?? []), h])
    const next = slides.map((s, si) => {
      const mine = changes.filter((ch) => ch.key.split('|')[1] === String(si))
      if (!mine.length) return s
      let out: Slide = s
      for (const ch of mine) {
        const [kind, , elId, a, b] = ch.key.split('|') as [string, string, string, string, string]
        if (kind === 'n') {
          out = { ...out, notes: ch.text }
          continue
        }
        out = {
          ...out,
          elements: (out.elements ?? []).map((e) => {
            if (e.id !== elId) return e
            if (e.type === 'text' && kind === 't') {
              const pi = Number(a)
              // Keep each run's formatting: the replacement takes the style of
              // the run its match starts in (recordFind.replaceInRuns).
              return { ...e, paragraphs: e.paragraphs.map((p, i) => (i === pi ? { ...p, runs: replaceInRuns(p.runs, ranges.get(ch.key) ?? [], replacement) } : p)) }
            }
            if (e.type === 'table' && kind === 'c') {
              const r = Number(a)
              const c = Number(b)
              return { ...e, cells: e.cells.map((row, ri) => (ri === r ? row.map((v, ci) => (ci === c ? ch.text : v)) : row)) }
            }
            return e
          })
        }
      }
      return out
    })
    setSlides(next)
  }

  function setTool(next: DeckTool, lock = false): void {
    setToolState(next)
    setToolLocked(lock && next !== 'select')
    if (next !== 'select') setSelectedIds([])
    if (next !== 'select' && next !== 'text') chrome.onFlyoutPick('shapes', `tool-${next}`)
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
    if (readOnly) return
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
    if (readOnly) return
    const prev = undo.current.pop()
    if (!prev) return
    redo.current.push(body)
    setBody(prev)
    onChange(prev)
  }
  function redoLast(): void {
    if (readOnly) return
    const next = redo.current.pop()
    if (!next) return
    undo.current.push(body)
    setBody(next)
    onChange(next)
  }

  // Undo / Redo keys run from the command registry in the editor's key
  // handler below (one binding per key; SPEC §9.9).

  // ── Slide rail ops ────────────────────────────────────────────────────────
  // Insert a new slide built from a starter template, right after the current
  // one so it lands where the user is working.
  function openGallery(): void {
    if (singleSlide) return
    setGalleryOpen(true)
  }
  function addSlideFromTemplate(templateId: string): void {
    if (singleSlide) return
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
    if (singleSlide) return
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
    if (singleSlide) return
    if (slides.length <= 1) return
    setSlides(slides.filter((_, si) => si !== i))
    setSel(Math.max(0, i - 1))
    setSelectedIds([])
  }
  function moveSlide(i: number, dir: -1 | 1): void {
    if (singleSlide) return
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

  // Print… prints what Download ▸ PDF saves: the same deck (main renders both
  // through slidesPrintRender), one slide per page.
  usePrintSource(documentOps, () => ({ app: 'deck', title, body }))

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
    if (readOnly || singleSlide) return
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
    mutateSlide((s) => reorderMany(s, selectedIds, dir))
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
  // Capture: the selection becomes a slide snippet body (positions relative to
  // its top-left), or an empty one so the dialog can say there is nothing to save.
  function saveSelectionAsSnippet(): void {
    setSnippetDraft(slideBodyFromSelection(slide, selectedIds) ?? { kind: 'slide', elements: [] })
  }
  // Insertion: a duplicate onto the CURRENT slide, through the paste engine
  // (fresh ids, groups remapped, on top, on the page), selected afterwards, as
  // ONE commit so one undo takes it all back. Declines while presenting.
  // `centre` (optional, additive): where the block goes, in slide coordinates,
  // for a drop from Files. Absent: centred, as before.
  function insertSlideSnippet(snippet: Snippet, centre?: { x: number; y: number }): boolean {
    if (!slides[slideIdx]) return false
    const els = slideElementsFromSnippet(snippet, {
      canvas: { w: body.size?.w ?? DECK_PAGE.w, h: body.size?.h ?? DECK_PAGE.h },
      topZ: (slides[slideIdx]?.elements ?? []).reduce((m, e) => Math.max(m, e.z ?? 0), 0),
      newId: elementId,
      readOnly: presenting || readOnly,
      ...(centre ? { centre } : {})
    })
    if (!els) return false
    mutateSlide((s) => els.reduce((acc, el) => addElement(acc, el), s))
    setTool('select')
    setSelectedIds(els.map((e) => e.id))
    return true
  }
  // Cut / Copy / Paste, shared with PlexiiDesign: the hook owns the DOM
  // clipboard events, so ⌘C/⌘V and the native Edit menu run the same code.
  const clipboard = useElementClipboard({
    app: 'slide',
    insertConverted: (b) => insertSlideSnippet(pastedSnippet(b)),
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
  useDeckSnippetTarget(snippetScope, title, insertSlideSnippet)

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
      // Every keyed Deck command, from its definition (slides/deckCommands,
      // lib/menus/commandKeys): the key a menu or the ribbon shows is the key
      // that runs it, and a command that is off is not run. ⌘Z / ⇧⌘Z, ⌘A, ⌘D,
      // ⌫, ⌘G / ⇧⌘G, ⇧⌘] / ⇧⌘[ and ⌘B / ⌘I / ⌘U all arrive here.
      if (runCommandKey(Object.values(cmdsRef.current), e)) {
        e.preventDefault()
        return
      }
      // ⌘Y also redoes (E-13: ⇧⌘Z is the Redo shown; ⌘Y stays bound, unshown).
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redoLast()
        return
      }
      if (!selectedIds.length) return
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelectedIds([])
        return
      }
      // Forward-delete does what ⌫ does, through the same gate (off for a viewer).
      if (e.key === 'Delete') {
        const del = cmdsRef.current.remove
        if (del.enabled && !del.enabled()) return
        e.preventDefault()
        del.run()
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
  // Every Deck action, defined once (SPEC §9): the menu bar, the ribbon, the
  // right-click menu and the palette all render from this record.
  const cmds = buildDeckCommands({
    readOnly,
    selected: selectedIds.length,
    anyGrouped,
    canUndo: undo.current.length > 0,
    canRedo: redo.current.length > 0,
    canPaste: clipboard.hasClip,
    textMarks: selectedEl?.type === 'text' ? (selectedEl.paragraphs[0]?.runs[0] ?? {}) : null,
    toggleMark: (mark) => {
      if (selectedEl?.type !== 'text') return
      const on = !selectedEl.paragraphs[0]?.runs[0]?.[mark]
      textUpdate(selectedEl.id, (e) => styleTextElement(e, { [mark]: on }))
    },
    singleSlide,
    undo: undoLast,
    redo: redoLast,
    cut: clipboard.cut,
    copy: clipboard.copy,
    paste: clipboard.paste,
    duplicate: duplicateSelection,
    remove: deleteSelection,
    selectAll: () => selectMany((slide?.elements ?? []).map((e) => e.id)),
    find: () => setFindOpen('find'),
    findAndReplace: () => setFindOpen('replace'),
    saveSnippet: saveSelectionAsSnippet,
    insertSnippet: () => setSnippetLibraryOpen(true),
    group: doGroup,
    ungroup: doUngroup,
    reorder: reorderSelection,
    align: doAlign,
    distribute: doDistribute,
    centre: centreSelection,
    insertText,
    insertShape,
    insertImage: () => void insertImage(),
    insertLine,
    insertTable,
    insertChart,
    insertWidget: () => setWidgetPickerOpen(true),
    newSlide: openGallery,
    duplicateSlide: () => duplicateSlide(slideIdx),
    deleteSlide: () => deleteSlide(slideIdx),
    present: () => setPresenting(true),
    checkA11y: () => setA11yIssues(checkSlidesA11y(body)),
    importFile: () => void importFile(),
    exportFile: (f) => void exportFile(f),
    openAi: () => setSidePane('generate')
  })
  const cmdsRef = useRef(cmds)
  cmdsRef.current = cmds

  // The palette (Cmd+K) lists the live ones.
  useRegisterEditorCommands('Slides', () => paletteEntries(Object.values(cmdsRef.current)), [selectedIds, slideIdx, body, anyGrouped, clipboard.hasClip])

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
    readOnly,
    singleSlide,
    tool,
    setTool,
    isPanelOpen,
    togglePanel,
    openPanel,
    sidePane,
    openSidePane: (p) => setSidePane(p),
    toggleSidePane: (p) => setSidePane(sidePane === p ? null : p),
    cmds,
    ed: {
      insertText,
      insertShape,
      insertLine,
      insertImage: () => void insertImage(),
      insertTable,
      insertChart,
      insertWidget: () => setWidgetPickerOpen(true),
      insertSnippet: () => setSnippetLibraryOpen(true),
      saveSnippet: saveSelectionAsSnippet,
      openGallery,
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

  // An embedded work widget's display (data or original object) is saved on
  // its slide element. A viewer gets no writer, so no toggle is offered.
  const embedDisplayWriter: EmbedDisplayWriter | null = readOnly
    ? null
    : (id, display) => updateEl(id, { embedDisplay: display } as Partial<SlideElement>)

  return (
    <EmbedDisplayWriterContext.Provider value={embedDisplayWriter}>
    <div ref={rootRef} className="h-full min-w-0 flex flex-col">
      <OfficeShellLayout
        testid="slides-shell"
        asideLabel="Slides"
        bar={
          <ContextBar<DeckCtx>
            testid="slides-toolbar"
            tabs={DECK_TABS}
            ctx={ctx}
            readOnly={readOnly}
            activeTab={chrome.tab}
            onTabChange={chrome.setTab}
            collapsed={chrome.collapsed}
            onCollapsedChange={chrome.setCollapsed}
            menuBar={
              <SlidesMenuBar
          actions={{
            title,
            cmds,
            slideOps: !singleSlide,
            documentOps,
            insertShape,
            moveSlideUp: () => moveSlide(slideIdx, -1),
            moveSlideDown: () => moveSlide(slideIdx, 1)
          }}
              />
            }
            pinnedStart={
              <>
                <BarButton {...barProps(cmds.undo)} onClick={cmds.undo.run} testid="slides-undo" />
                <BarButton {...barProps(cmds.redo)} onClick={cmds.redo.run} testid="slides-redo" />
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
            readOnly={readOnly}
            activeId={railIdForTool(tool)}
            openPanels={[...openPanels, ...(sidePane === 'ai' ? ['ai'] : [])]}
            lastUsed={chrome.lastUsed}
            onFlyoutPick={chrome.onFlyoutPick}
            ariaLabel="Slide tools"
          />
        }
        leftAside={
          singleSlide ? undefined :
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
                {!readOnly && <div className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex flex-col gap-0.5">
                  <button onClick={() => moveSlide(i, -1)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5" title="Move up"><Icon name="keyboard_arrow_up" size={12} /></button>
                  <button onClick={() => moveSlide(i, 1)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5" title="Move down"><Icon name="keyboard_arrow_down" size={12} /></button>
                  <button onClick={() => duplicateSlide(i)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5" title="Duplicate this slide" data-testid={`slides-duplicate-${i}`}><Icon name="file_copy" size={12} /></button>
                  <button onClick={() => deleteSlide(i)} className="bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] rounded p-0.5 text-red-500" title="Delete" data-testid={`slides-delete-${i}`}><Icon name="close" size={12} /></button>
                </div>}
              </div>
            ))}
            {!readOnly && <button onClick={openGallery} className="w-full aspect-video rounded-md border-2 border-dashed border-[var(--edge-firm)] text-[var(--ink-40)] hover:text-accent hover:border-accent flex items-center justify-center" data-testid="slides-add" aria-label="New slide">
              <Icon name="add" size={20} />
            </button>}
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
        {deckMenu && (
          <CanvasContextMenu
            testid="slides-context-menu"
            x={deckMenu.x}
            y={deckMenu.y}
            onClose={() => setDeckMenu(null)}
            items={
              deckMenu.onElement
                ? objectMenu({
                    cut: cmds.cut,
                    copy: cmds.copy,
                    paste: cmds.paste,
                    duplicate: cmds.duplicate,
                    bringToFront: cmds.bringToFront,
                    sendToBack: cmds.sendToBack,
                    group: selectedIds.length >= 2 ? cmds.group : undefined,
                    ungroup: anyGrouped ? cmds.ungroup : undefined,
                    saveAsSnippet: cmds.saveSnippet,
                    more: [ctxRow(cmds.bringForward), ctxRow(cmds.sendBackward)],
                    del: cmds.remove
                  })
                : canvasMenu({
                    paste: cmds.paste,
                    insertSnippet: cmds.insertSnippet,
                    create: [
                      { label: 'Add text here', icon: 'title', onClick: () => placeHere('text', deckMenu.at) },
                      { label: 'Add a box here', icon: 'crop_square', onClick: () => placeHere('rect', deckMenu.at) }
                    ],
                    selectAll: cmds.selectAll
                  })
            }
          />
        )}
        {findOpen && (
          <RecordFindReplace
            testid="slides-find"
            scope="Find in this deck"
            replace={findOpen === 'replace'}
            records={findRecords}
            onGo={(h) => goToHit(h.key)}
            onReplace={replaceText}
            onClose={() => setFindOpen(false)}
          />
        )}
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
            if (dragCarriesFiles(e.dataTransfer)) {
              e.preventDefault()
              e.dataTransfer.dropEffect = readOnly || presenting ? 'none' : 'copy'
              return
            }
            if (!acceptsWidgetDrag(e.dataTransfer)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(e) => {
            // From Files: Deck's own converted paste (never the system
            // clipboard) with our read, landing where it was dropped. A work
            // widget file stays a live widget element, as its own drag lands.
            if (dragCarriesFiles(e.dataTransfer)) {
              e.preventDefault()
              e.stopPropagation()
              const refs = filesDropRefs(e.dataTransfer)
              if (!refs?.length) return
              const canvas = { w: body.size?.w ?? DECK_PAGE.w, h: body.size?.h ?? DECK_PAGE.h }
              const at = pagePointFromDrop(e.currentTarget, e.clientX, e.clientY, canvas) ?? undefined
              const alt = e.altKey
              void runContentDrop(refs, { target: 'slide', alt, readOnly: readOnly || presenting, ownDocumentId: documentOps?.id ?? null }, async (read, ref) => {
                if (ref.kind === 'doc' && ref.docType === 'widget' && ref.docId && !alt) {
                  insertWidget(widgetFileGroupId(ref.docId))
                  return true
                }
                return pasteConverted('slide', (b) => insertSlideSnippet(pastedSnippet(b), at), { read })
              })
              return
            }
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
          <div className="flex justify-center" data-tool={tool} onContextMenu={openDeckMenu}>
            {readOnly ? (
              <div data-testid="slides-readonly-stage">
                <SlideFace slide={slide} theme={theme} width={canvasW} />
              </div>
            ) : (
            <SlideCanvas
              embedsInteractive
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
            )}
          </div>
          {/* Speaker notes stay under the canvas (owner ruling, SPEC §6.4). Not in
              a single-slide session: a slide snippet is a fragment of elements
              with nowhere to keep notes, so a notes box there would take text a
              successful Save then drops. */}
          {!singleSlide && <div className="max-w-3xl mx-auto mt-3">
            <label htmlFor="slides-notes" className="block text-[11px] uppercase tracking-wide text-[var(--ink-40)] mb-1">Speaker notes</label>
            <textarea
              id="slides-notes"
              ref={notesRef}
              data-testid="slides-notes-editor"
              value={slide.notes}
              onChange={(e) => mutateSlide((s) => ({ ...s, notes: e.target.value }))}
              readOnly={readOnly}
              rows={2}
              placeholder="What to actually say on this slide"
              className="fb-field w-full bg-[var(--surface-raised)] px-3 py-2 text-[13px] resize-none"
            />
          </div>}
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

      {snippetLibraryOpen && (
        <SnippetLibrary kinds={SLIDE_KINDS} targetId={deckSnippetTargetId(snippetScope)} onClose={() => setSnippetLibraryOpen(false)} />
      )}

      {snippetDraft && (
        <SaveSnippetDialog body={snippetDraft} suggestedName={suggestedSlideSnippetName(snippetDraft)} onClose={() => setSnippetDraft(null)} />
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
    </EmbedDisplayWriterContext.Provider>
  )
}
