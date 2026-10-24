import { dragCarriesFiles } from '../../lib/filesDrag'
import { filesDropRefs, runContentDrop } from '../../lib/filesContentDrop'
import { widgetFileGroupId } from '@shared/widgetFiles'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SheetBody, SheetBodyV2, SheetCellFormat, SheetChartSpec, SheetNumberFormat, SheetTab } from '@shared/types'
import { SHEET_FUNCTIONS } from '../../lib/sheetFormula'
import {
  normalizeBody,
  withTab,
  activeTab,
  emptyTab,
  colLabel,
  cellFormat
} from '../../lib/sheetBody'
import {
  setCell,
  setColumnName,
  addColumn,
  addRow,
  insertRowAt,
  deleteRowAt,
  insertColAt,
  deleteColAt,
  applyFormat,
  writeMatrix,
  fillSelection,
  tileMatrix,
  dataExtentBelow,
  sortByColumn,
  setColWidth,
  setRowHeight,
  parseTsv,
  rangeToTsv,
  normalizeRange,
  reorderRows,
  reorderColumns,
  moveOrder,
  type CellRange
} from './sheet/sheetOps'
import { extendSeries, canToggleSeries, numericFill } from '../../lib/sheetFill'
import { rewriteFormulaRefs, remapFormulaRefs, displayCell, buildSpillMap, makeWorkbook, makeNames } from '../../lib/sheetFormula'
import { isSingleCell } from '@shared/gridClipboard'
import SheetGrid, { ROW_HEADER_W, HEADER_H } from './sheet/SheetGrid'
import { acceptsWidgetDrag, widgetIdFromDrop } from '../../lib/widgetDropInsert'
import WidgetEmbed from './embed/WidgetEmbed'
import SheetMenuBar, { type SheetMenuActions } from './editor/SheetMenuBar'
import { buildCellsCommands } from './sheet/cellsCommands'
import type { OfficeCommand } from '../../lib/menus/officeCommand'
import {
  pageSetupOf,
  rangeToA1,
  remapTabPageSetup,
  rowsToA1,
  setPrintArea,
  setRepeatRows,
  setShowGridlines
} from '../../lib/sheetPageSetup'
import PageSetupDialog from './sheet/PageSetupDialog'
import { runCommandKey } from '../../lib/menus/commandKeys'
import ShortcutsModal from './editor/ShortcutsModal'
import { documentCommands, paletteEntries } from '../../lib/menus/officeCommand'
import { useRegisterEditorCommands } from '../../stores/editorCommands'
import RecordFindReplace from './editor/RecordFindReplace'
import CanvasContextMenu, { type CtxMenuItem } from '../CanvasContextMenu'
import { joinGroups, objectMenu } from '../../lib/menus/officeContextMenu'
import { ctxRow } from '../../lib/menus/officeCommand'
import type { DocumentOps } from './editor/documentOps'
import { usePrintSource } from './editor/printSource'
import { sheetPrintModel } from '../../lib/sheetPrintModel'
import { paperForLocale } from '@shared/sheetPrint'
import SheetTabStrip from './sheet/SheetTabStrip'
import SheetChart from './sheet/SheetChart'
import SheetPivot from './sheet/SheetPivot'
import PivotDialog from './sheet/PivotDialog'
import type { SheetPivotSpec } from '@shared/types'
import SheetAiFill from './sheet/SheetAiFill'
import SheetFormulaAssist, { type FormulaPlan } from './sheet/SheetFormulaAssist'
import CondFormatDialog from './sheet/CondFormatDialog'
import ValidationDialog from './sheet/ValidationDialog'
import { validationForCell, valueIsValid, isRowHidden, parseA1Range } from '../../lib/sheetCond'
import { runSheetScript, type SheetScriptResult } from '../../lib/sheetScript'
import { applyQuery, stepLabel, type QueryStep, type QueryTable, type SheetQuery } from '../../lib/sheetQuery'
import type { SheetCondRule, SheetValidation, SheetCondOp } from '@shared/types'
import SheetAiPanel from './sheet/SheetAiPanel'
import CellsChrome from './CellsChrome'
import { useSheetAi } from './sheet/useSheetAi'
import Icon from '../Icon'
import SnippetLibrary from '../snippets/SnippetLibrary'
import SaveSnippetDialog from '../snippets/SaveSnippetDialog'
import { markCellsCopy, readClipboardForms } from '../../lib/clipboardForms'
import { CELLS_CLIP_MIME } from '@shared/cellsClipboardFormat'
import { cellsCopyPayload } from './sheet/cellsClipboard'
import { fromAnotherApp, pasteConverted, pastedSnippet } from '../../lib/clipboardPaste'
import type { SheetSnippetBody, Snippet, SnippetInsertResult, SnippetKind } from '@shared/snippets'
import { officeAccepts } from '../../lib/officeSnippets'
import {
  cellsSnippetTargetId,
  insertSheetSnippet,
  newValidationId,
  sheetBodyFromSelection,
  sheetSnippetNotKept,
  suggestedSheetSnippetName,
  useCellsSnippetTarget
} from './sheet/cellsSnippets'

/** The library opened from a spreadsheet shows only what a spreadsheet can take. */
// Every kind with a conversion into this app, derived from the builders.
const SHEET_KINDS: SnippetKind[] = officeAccepts('sheet')

// Excel-class spreadsheet editor. The body is held locally as v2 (legacy v1
// bodies are lifted on mount); every edit pushes an undo snapshot and flows to
// onChange (the store's debounced autosave). Cells carry real formatting and
// number formats; formulas compute for real and show #ERR rather than a fake
// number.

interface Props {
  body: SheetBody
  title: string
  onChange: (body: SheetBody) => void
  /**
   * The spreadsheet this editor is editing, bound by the HOST to its id — what
   * the File menu's document items and Insert's Meeting act on. Omitted where
   * there is no document (a snippet session): those items are then not shown.
   */
  documentOps?: DocumentOps
  /**
   * A reader, not an editor. CellsChrome already had the machinery and this
   * editor hard-coded `false` into it, so a VIEWER of a shared spreadsheet got
   * a full one: they could type, and the server dropped it.
   *
   * It means onChange NEVER fires. Every write goes through `commit` (and
   * mutateTab through that), so the guard is central rather than per command —
   * the four paths that reach onChange without it are undo, redo, switching
   * sheet and import, and each is guarded where it is. Navigation still works:
   * switching sheet changes what is shown and writes nothing, because
   * activeSheet lives in the body.
   *
   * This is the client half. The server refuses a viewer's writes regardless
   * (yjsDocAuth.ts, and the viewer gate on PUT /livedocs/:id/body); the point
   * of this half is that the app stops pretending the edit landed.
   */
  readOnly?: boolean
}

interface Cell {
  r: number
  c: number
}

interface FuncMenu {
  items: typeof SHEET_FUNCTIONS
  tokenStart: number
  query: string
}

// Sizing defaults, in CSS px, matched to Excel: a column is 8.43 characters wide
// (64px at the default font) and a row is 15 points tall (20px at 96dpi), so a
// cell is a wide rectangle rather than a square. Both stay resizable by the user.
const DEFAULT_COL_W = 64 // Excel default column width (8.43 chars)
const DEFAULT_ROW_H = 20 // Excel default row height (15pt)

// Measure rendered text width for auto-fit, using a cached canvas so a column of
// mixed content fits its widest actual value (not a character-count guess).
let _measureCtx: CanvasRenderingContext2D | null = null
function measureTextPx(text: string, bold: boolean): number {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  if (!_measureCtx) return text.length * 7.3
  _measureCtx.font = `${bold ? '600 ' : ''}13px Inter, system-ui, sans-serif`
  return _measureCtx.measureText(text).width
}

// Signature help: find the innermost function call the caret sits inside, and
// which argument (0-based) it is on, so the editor can show that function's
// parameter list with the current argument highlighted while you type.
function enclosingCall(text: string, caret: number): { name: string; argIndex: number } | null {
  let depth = 0
  let argIndex = 0
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === ')') depth++
    else if (ch === '(') {
      if (depth === 0) {
        let j = i - 1
        let name = ''
        while (j >= 0 && /[A-Za-z0-9_]/.test(text[j])) {
          name = text[j] + name
          j--
        }
        return name ? { name: name.toUpperCase(), argIndex } : null
      }
      depth--
    } else if (ch === ',' && depth === 0) argIndex++
  }
  return null
}

// Structural edits that also fix formula references, so inserting, deleting or
// moving rows/columns keeps every formula pointing at the same data. A reference
// to a genuinely removed line becomes #REF! (never silently repointed). These
// wrap the pure sheetOps mutators and sweep every formula cell through
// remapFormulaRefs with the matching old->new index map.
const idIndex = (i: number): number => i
function fixFormulas(
  t: SheetTab,
  mapRow: (r: number) => number | null,
  mapCol: (c: number) => number | null
): SheetTab {
  // The PAGE SETUP moves with the data too, through the very same maps: a print
  // area and a repeat-rows range have to follow their rows and columns, and be
  // cleared rather than silently repointed when every line in them is deleted —
  // otherwise inserting one row above a print area prints the wrong block, and
  // deleting the area prints the rows that slid into its place.
  //
  // Done HERE, not at the six wrappers and drag-reorder paths that call this,
  // so none of them can be written without it.
  const base = remapTabPageSetup(t, mapRow, mapCol)
  return {
    ...base,
    rows: base.rows.map((row) =>
      row.map((cell) => (cell.trim().startsWith('=') ? remapFormulaRefs(cell, mapRow, mapCol) : cell))
    )
  }
}
function insertRowFixed(t: SheetTab, at: number): SheetTab {
  return fixFormulas(insertRowAt(t, at), (r) => (r >= at ? r + 1 : r), idIndex)
}
function deleteRowFixed(t: SheetTab, at: number): SheetTab {
  if (t.rows.length <= 1) return t
  return fixFormulas(deleteRowAt(t, at), (r) => (r === at ? null : r > at ? r - 1 : r), idIndex)
}
function insertColFixed(t: SheetTab, at: number): SheetTab {
  return fixFormulas(insertColAt(t, at), idIndex, (c) => (c >= at ? c + 1 : c))
}
function deleteColFixed(t: SheetTab, at: number): SheetTab {
  if (t.columns.length <= 1) return t
  return fixFormulas(deleteColAt(t, at), idIndex, (c) => (c === at ? null : c > at ? c - 1 : c))
}

// When the in-cell text is a formula, work out whether to show the function
// menu and which functions match. We assume the caret is at the end of the
// text (the normal left-to-right typing case), which keeps this free of
// render-time DOM caret reads. Trailing letters are treated as a function-name
// prefix; right after =, (, a comma or an operator we show the full list.
function computeFuncMenu(value: string): FuncMenu | null {
  if (!value.startsWith('=')) return null
  const idM = value.match(/([A-Za-z]+)$/)
  let query = ''
  let tokenStart = value.length
  if (idM) {
    query = idM[1].toUpperCase()
    tokenStart = value.length - idM[1].length
  } else if (/[=+\-*/&^<>]$/.test(value)) {
    // Right after = or a binary operator: offer the whole catalogue. We
    // deliberately skip ( and , so the menu closes after a function is picked
    // (where you usually type a reference, not nest another function).
    query = ''
    tokenStart = value.length
  } else {
    return null
  }
  const items = SHEET_FUNCTIONS.filter((f) => f.name.startsWith(query))
  if (!items.length) return null
  return { items, tokenStart, query }
}

export default function SheetEditor({ body: rawBody, title, onChange, documentOps, readOnly = false }: Props): JSX.Element {
  const [body, setBody] = useState<SheetBodyV2>(() => normalizeBody(rawBody))
  // Accept live external updates (co-editing): when the body prop changes to a
  // new version, fold it into the grid. We deliberately do NOT touch the active
  // cell edit (editing/editValue) or the selection (anchor/focus), so a peer's
  // edit lands without interrupting what you're typing. Only fires on a real
  // prop change; the parent feeds remote merges here, never our own echoes.
  useEffect(() => {
    setBody(normalizeBody(rawBody))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawBody])
  const [anchor, setAnchor] = useState<Cell>({ r: 0, c: 0 })
  const [focus, setFocus] = useState<Cell>({ r: 0, c: 0 })
  const [editing, setEditing] = useState<Cell | null>(null)
  const [editValue, setEditValue] = useState('')
  const [aiOpen, setAiOpen] = useState(false)
  const [formulaAiOpen, setFormulaAiOpen] = useState(false)
  const [condOpen, setCondOpen] = useState(false)
  const [validationOpen, setValidationOpen] = useState(false)
  const [pivotOpen, setPivotOpen] = useState(false)
  const [lookupOpen, setLookupOpen] = useState(false)
  const [macrosOpen, setMacrosOpen] = useState(false)
  const [queryOpen, setQueryOpen] = useState(false)
  // Help ▸ Keyboard shortcuts, owned here so the menu bar holds no state.
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Declared up here so onGridKeyDown, defined above where `doc` is built, can
  // close over a stable ref rather than a value that does not exist yet.
  const docRef = useRef<OfficeCommand[]>([])
  const [pageSetupOpen, setPageSetupOpen] = useState(false)
  // The right-side AI Assistant panel is shown by default and is collapsible.
  const [aiPanelOpen, setAiPanelOpen] = useState(true)
  const [liveWidth, setLiveWidth] = useState<{ c: number; w: number } | null>(null)
  const [liveHeight, setLiveHeight] = useState<{ r: number; h: number } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [colMenu, setColMenu] = useState<{ c: number; x: number; y: number } | null>(null)
  // Right-click on a cell that is not being typed in (a cell being typed in is
  // text, and gets the native text menu, SPEC §9.3).
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ r: number; x: number; y: number } | null>(null)
  // The live drop-target indicator while dragging a header to reorder it.
  const [reorderOver, setReorderOver] = useState<{ kind: 'col' | 'row'; over: number } | null>(null)
  // A pending reorder that would change formula results, awaiting the user's
  // choice to auto-fix references or move anyway. `order[newIndex] = oldIndex`.
  const [moveConfirm, setMoveConfirm] = useState<{
    kind: 'col' | 'row'
    order: number[]
    oldToNew: number[]
  } | null>(null)
  const [funcIndex, setFuncIndex] = useState(0)
  const [funcDismissed, setFuncDismissed] = useState(false)
  const [namesOpen, setNamesOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRef, setNewRef] = useState('')
  // Live preview rectangle while dragging the fill handle (cells about to be
  // filled), and the just-completed fill so we can offer an Excel-style
  // Copy/Series toggle for numeric fills.
  const [fillPreview, setFillPreview] = useState<CellRange | null>(null)
  const [lastFill, setLastFill] = useState<{
    source: CellRange
    target: CellRange
    mode: 'series' | 'copy'
  } | null>(null)

  const undoStack = useRef<SheetBodyV2[]>([])
  const redoStack = useRef<SheetBodyV2[]>([])
  const dragging = useRef(false)
  const gridWrapRef = useRef<HTMLDivElement | null>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)
  const refDrag = useRef<{ start: Cell; end: Cell } | null>(null)
  // Header selection drag: 'col' while dragging across column letters, 'row'
  // across row numbers. `anchor` is the header the drag started on so entering
  // another header extends a whole-column / whole-row block from it.
  const headerDrag = useRef<{ kind: 'col' | 'row'; anchor: number } | null>(null)
  // The header-selection anchor, kept across separate click gestures so a
  // shift-click on another header extends from it. (headerDrag is cleared on
  // every mouseup, so it can't hold this.)
  const headerAnchor = useRef<{ kind: 'col' | 'row'; index: number } | null>(null)
  // Header drag-REORDER (distinct from select-drag): armed when the user presses
  // on an already-selected column/row header and drags it to a new position.
  // `band` is the moved block, `over` the header currently under the cursor.
  const reorderArm = useRef<{ kind: 'col' | 'row'; band: [number, number]; moved: boolean; over: number } | null>(null)
  // Assigned every render (below) with a closure over the current tab + mutators
  // so the empty-dependency global mouseup listener resolves a reorder correctly.
  const finalizeReorderRef = useRef<() => void>(() => {})
  // Formula "point mode": while editing a formula, arrow keys (and clicks) insert
  // a cell reference. pointRef holds the cell being pointed at and the span of the
  // inserted ref text so the next arrow can replace it; pointCell drives the
  // dashed marker on the grid.
  const pointRef = useRef<{ r: number; c: number; from: number; to: number } | null>(null)
  const [pointCell, setPointCell] = useState<{ r: number; c: number } | null>(null)
  // True when the current edit began by typing over the cell (Excel "enter mode"),
  // so an arrow key commits the value and moves that direction. False for F2 /
  // double-click "edit mode", where arrows move the text caret instead.
  const [enterMode, setEnterMode] = useState(false)
  // Source selection captured when a fill-handle drag begins, the live preview
  // rectangle (mirrored as a ref so the global mouseup can read it), and a ref to
  // the latest fill executor (kept fresh each render so the mouseup closure isn't
  // stale).
  const fillDrag = useRef<CellRange | null>(null)
  const fillPreviewRef = useRef<CellRange | null>(null)
  const doFillRef = useRef<(source: CellRange, target: CellRange) => void>(() => {})
  // Remember the origin of the last in-app copy so a paste elsewhere can shift
  // formula references relative to the move (matching Excel/Sheets). Only applied
  // when the clipboard text still matches what we copied — an external copy is
  // pasted literally, since we can't know its origin.
  const clipboardCopy = useRef<{ text: string; r: number; c: number } | null>(null)
  // Saved snippets: the library (insert) and the save dialog (capture). The
  // draft carries the one line naming what the selection has that a snippet
  // will not keep, so the dialog can say so before anything is saved.
  const [snippetLibraryOpen, setSnippetLibraryOpen] = useState(false)
  const [snippetDraft, setSnippetDraft] = useState<{ body: SheetSnippetBody; notKept: string | null } | null>(null)
  // This mounted editor, as a snippet destination: the same workbook in the
  // editor and in a desk widget are two places, and a closed one is none.
  const snippetScope = useId()

  const idx = body.activeSheet ?? 0
  const tab = activeTab(body)
  const selection: CellRange = normalizeRange(anchor, focus)
  // The AI Assistant reads the live active sheet on each run. We keep the latest
  // tab in a ref so the hook's getter never closes over a stale snapshot.
  const tabRef = useRef(tab)
  tabRef.current = tab
  const sheetAi = useSheetAi(() => tabRef.current)
  // Workbook view for cross-sheet references (Sheet2!A1). Rebuilt when any tab's
  // name or data changes so a formula reading another tab stays current.
  const workbook = useMemo(() => makeWorkbook(body.sheets), [body.sheets])
  // Named ranges the formula engine resolves (e.g. =SUM(Revenue)). Workbook-level,
  // rebuilt only when the definitions change.
  const names = useMemo(() => makeNames(body.names), [body.names])
  // Rows hidden by the active column filters (by displayed value). null when no
  // filter is set, so the common path does no work. r stays the true data index.
  const hiddenRows = useMemo(() => {
    const set = new Set<number>()
    // Collapsed outline groups hide their members below the first row.
    for (const g of tab.rowGroups ?? []) {
      if (g.collapsed) for (let r = g.start + 1; r <= g.end; r++) set.add(r)
    }
    const filters = tab.filters
    const cols = filters
      ? Object.keys(filters)
          .map(Number)
          .filter((c) => filters[c]?.length)
      : []
    if (cols.length && filters) {
      const grid = { columns: tab.columns, rows: tab.rows }
      for (let r = 0; r < tab.rows.length; r++) {
        const rowValues: Record<number, string> = {}
        for (const c of cols) rowValues[c] = displayCell(grid, r, c, workbook)
        if (isRowHidden(rowValues, filters)) set.add(r)
      }
    }
    return set.size ? set : null
  }, [tab, workbook])
  // Columns hidden by a collapsed outline group (members right of the first).
  const hiddenCols = useMemo(() => {
    const set = new Set<number>()
    for (const g of tab.colGroups ?? []) {
      if (g.collapsed) for (let c = g.start + 1; c <= g.end; c++) set.add(c)
    }
    return set.size ? set : null
  }, [tab.colGroups])

  // ── Commit helpers ────────────────────────────────────────────────────────
  const commit = useCallback(
    (next: SheetBodyV2) => {
      if (readOnly) return
      undoStack.current.push(body)
      if (undoStack.current.length > 100) undoStack.current.shift()
      redoStack.current = []
      setBody(next)
      onChange(next)
    },
    [body, onChange, readOnly]
  )
  const mutateTab = useCallback(
    (fn: (t: SheetTab) => SheetTab) => commit(withTab(body, idx, fn(tab))),
    [body, idx, tab, commit]
  )

  // Whether the current selection exactly equals an existing merge, so the button
  // reads as unmerge and toggling removes it.
  const selectionIsMerged = (tab.merges ?? []).some(
    (m) => m.r1 === selection.r0 && m.c1 === selection.c0 && m.r2 === selection.r1 && m.c2 === selection.c1
  )

  // Merge the selection into one cell, or unmerge if it already is one. Merging
  // drops any merges the new range overlaps and clears the covered cells' values
  // (the anchor keeps its own), matching how Excel stores a merge.
  function toggleMerge(): void {
    const { r0, c0, r1, c1 } = selection
    if (r0 === r1 && c0 === c1 && !selectionIsMerged) return // nothing to merge
    mutateTab((t) => {
      const existing = t.merges ?? []
      if (selectionIsMerged) {
        return { ...t, merges: existing.filter((m) => !(m.r1 === r0 && m.c1 === c0 && m.r2 === r1 && m.c2 === c1)) }
      }
      const overlaps = (m: { r1: number; c1: number; r2: number; c2: number }): boolean =>
        r0 <= m.r2 && r1 >= m.r1 && c0 <= m.c2 && c1 >= m.c1
      const kept = existing.filter((m) => !overlaps(m))
      // Clear covered cells so only the anchor carries a value.
      const rows = t.rows.map((row) => [...row])
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) if (!(r === r0 && c === c0) && rows[r]?.[c] != null) rows[r][c] = ''
      return { ...t, rows, merges: [...kept, { r1: r0, c1: c0, r2: r1, c2: c1 }] }
    })
  }

  const undo = useCallback(() => {
    if (readOnly) return
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(body)
    setBody(prev)
    onChange(prev)
  }, [body, onChange, readOnly])
  const redo = useCallback(() => {
    if (readOnly) return
    const nxt = redoStack.current.pop()
    if (!nxt) return
    undoStack.current.push(body)
    setBody(nxt)
    onChange(nxt)
  }, [body, onChange, readOnly])

  const colWidthOf = useCallback(
    (c: number): number => (liveWidth?.c === c ? liveWidth.w : tab.colWidths?.[c] ?? DEFAULT_COL_W),
    [liveWidth, tab.colWidths]
  )
  const rowHeightOf = useCallback(
    (r: number): number => (liveHeight?.r === r ? liveHeight.h : tab.rowHeights?.[r] ?? DEFAULT_ROW_H),
    [liveHeight, tab.rowHeights]
  )

  // ── Placed work widgets: where a cell is, and what is under a point ──────
  //
  // Both use the SAME widths the grid draws with (colWidthOf / rowHeightOf)
  // and the grid's own exported header sizes, so an anchored widget sits on
  // the gridline rather than near it. Duplicating those numbers here is how
  // the overlay would drift the first time a default changed.
  const cellOffset = useCallback(
    (r: number, c: number): { x: number; y: number } => {
      let x = ROW_HEADER_W
      for (let i = 0; i < c; i++) x += colWidthOf(i)
      let y = HEADER_H
      for (let i = 0; i < r; i++) y += rowHeightOf(i)
      return { x, y }
    },
    [colWidthOf, rowHeightOf]
  )

  /** The cell under a point in grid space, or null past the end of the data. */
  const cellAtOffset = useCallback(
    (px: number, py: number): { r: number; c: number } | null => {
      if (px < ROW_HEADER_W || py < HEADER_H) return null
      let x = ROW_HEADER_W
      let c = -1
      for (let i = 0; i < tab.columns.length; i++) {
        const w = colWidthOf(i)
        if (px < x + w) { c = i; break }
        x += w
      }
      let y = HEADER_H
      let r = -1
      for (let i = 0; i < tab.rows.length; i++) {
        const h = rowHeightOf(i)
        if (py < y + h) { r = i; break }
        y += h
      }
      return r >= 0 && c >= 0 ? { r, c } : null
    },
    [tab.columns.length, tab.rows.length, colWidthOf, rowHeightOf]
  )


  // ── Selection + editing ───────────────────────────────────────────────────
  function focusGrid(): void {
    gridWrapRef.current?.focus()
  }
  // True while the cell being edited holds a formula, so a click on another
  // cell should insert its reference rather than move the selection.
  const inFormulaEdit = (): boolean => !!editing && editValue.startsWith('=')

  function onCellMouseDown(r: number, c: number, shift: boolean): void {
    if (inFormulaEdit()) {
      // Clicking the cell we're editing just places the caret in its input.
      if (editing && r === editing.r && c === editing.c) return
      refDrag.current = { start: { r, c }, end: { r, c } }
      dragging.current = true
      return
    }
    setEditing(null)
    // A cell click ends any header-selection anchor chain.
    if (!shift) headerAnchor.current = null
    if (shift) setFocus({ r, c })
    else {
      setAnchor({ r, c })
      setFocus({ r, c })
    }
    dragging.current = true
    focusGrid()
  }
  function onCellMouseEnter(r: number, c: number): void {
    if (fillDrag.current) {
      onFillEnter(r, c)
      return
    }
    if (refDrag.current) {
      refDrag.current = { start: refDrag.current.start, end: { r, c } }
      return
    }
    if (dragging.current) setFocus({ r, c })
  }
  useEffect(() => {
    // Reads only refs + colLabel + setEditValue (all stable), so the empty dep
    // list is safe and the handler never sees stale formula text — it pulls the
    // live value and caret straight from the input element.
    const up = (): void => {
      if (fillDrag.current) {
        const source = fillDrag.current
        const target = fillPreviewRef.current
        fillDrag.current = null
        fillPreviewRef.current = null
        dragging.current = false
        setFillPreview(null)
        if (target) doFillRef.current(source, target)
        return
      }
      if (refDrag.current) {
        const { start, end } = refDrag.current
        refDrag.current = null
        dragging.current = false
        const r0 = Math.min(start.r, end.r)
        const r1 = Math.max(start.r, end.r)
        const c0 = Math.min(start.c, end.c)
        const c1 = Math.max(start.c, end.c)
        const ref =
          r0 === r1 && c0 === c1
            ? `${colLabel(c0)}${r0 + 1}`
            : `${colLabel(c0)}${r0 + 1}:${colLabel(c1)}${r1 + 1}`
        const input = editInputRef.current
        if (input) {
          const s = input.selectionStart ?? input.value.length
          const e = input.selectionEnd ?? s
          const next = input.value.slice(0, s) + ref + input.value.slice(e)
          // A click-inserted reference supersedes any arrow-key point.
          pointRef.current = null
          setPointCell(null)
          setEditValue(next)
          const caret = s + ref.length
          requestAnimationFrame(() => {
            input.focus()
            try {
              input.setSelectionRange(caret, caret)
            } catch {
              /* input may have unmounted */
            }
          })
        }
        return
      }
      // A header drag-reorder resolves here (before clearing drag state) so a
      // move is applied / confirmed on release.
      if (reorderArm.current) {
        finalizeReorderRef.current()
        reorderArm.current = null
        setReorderOver(null)
      }
      dragging.current = false
      headerDrag.current = null
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // ── Formula function menu ─────────────────────────────────────────────────
  const funcMenu = useMemo(
    () => (editing && !funcDismissed ? computeFuncMenu(editValue) : null),
    [editing, editValue, funcDismissed]
  )
  // Signature help: when editing a formula and the name-completion menu is not
  // showing, if the caret sits inside a known function's parentheses, surface its
  // parameter list with the current argument highlighted.
  const signature = ((): { hint: string; argIndex: number } | null => {
    if (!editing || !editValue.startsWith('=') || funcMenu) return null
    const caret = editInputRef.current?.selectionStart ?? editValue.length
    const call = enclosingCall(editValue, caret)
    if (!call) return null
    const fn = SHEET_FUNCTIONS.find((f) => f.name === call.name)
    return fn ? { hint: fn.hint, argIndex: call.argIndex } : null
  })()
  function handleEditValue(v: string): void {
    // Typing anything locks the current point-mode reference in place.
    pointRef.current = null
    setPointCell(null)
    setEditValue(v)
    setFuncIndex(0)
    setFuncDismissed(false)
  }

  // Formula point mode: an arrow key while editing a formula points at a cell and
  // inserts (or moves) its reference. Returns true when the arrow was consumed so
  // the caller stops the text caret from also moving. Only engages when a
  // reference is expected — a point is active, or the caret sits at the end right
  // after =, an operator, "(" or ",". Otherwise arrows move the caret as usual.
  function handleFormulaArrow(dir: 'up' | 'down' | 'left' | 'right', _shift: boolean): boolean {
    if (!editing || !editValue.startsWith('=')) return false
    const input = editInputRef.current
    const atEnd = input ? input.selectionStart === editValue.length && input.selectionEnd === editValue.length : true
    const cur = pointRef.current
    if (!cur && !(atEnd && /[=+\-*/(,&<>^%: ]$/.test(editValue))) return false
    const base = cur ? { r: cur.r, c: cur.c } : { r: editing.r, c: editing.c }
    const dr = dir === 'up' ? -1 : dir === 'down' ? 1 : 0
    const dc = dir === 'left' ? -1 : dir === 'right' ? 1 : 0
    const nr = Math.max(0, Math.min(tab.rows.length - 1, base.r + dr))
    const nc = Math.max(0, Math.min(tab.columns.length - 1, base.c + dc))
    const ref = `${colLabel(nc)}${nr + 1}`
    let next: string
    let from: number
    if (cur) {
      next = editValue.slice(0, cur.from) + ref + editValue.slice(cur.to)
      from = cur.from
    } else {
      from = editValue.length
      next = editValue + ref
    }
    pointRef.current = { r: nr, c: nc, from, to: from + ref.length }
    setPointCell({ r: nr, c: nc })
    setEditValue(next)
    const caret = from + ref.length
    requestAnimationFrame(() => {
      const el = editInputRef.current
      if (el) {
        el.focus()
        try {
          el.setSelectionRange(caret, caret)
        } catch {
          /* input may have unmounted */
        }
      }
    })
    return true
  }
  function applyFunc(menu: FuncMenu, index: number): void {
    const fn = menu.items[index] ?? menu.items[0]
    if (!fn) return
    const input = editInputRef.current
    const caret = input?.selectionStart ?? editValue.length
    const next = editValue.slice(0, menu.tokenStart) + fn.name + '(' + editValue.slice(caret)
    setEditValue(next)
    setFuncIndex(0)
    const newCaret = menu.tokenStart + fn.name.length + 1
    requestAnimationFrame(() => {
      input?.focus()
      try {
        input?.setSelectionRange(newCaret, newCaret)
      } catch {
        /* noop */
      }
    })
  }
  // Drive the menu from the edit input's own keystrokes (capture phase, so this
  // runs before SheetGrid's Enter/Tab/Escape commit handlers and can stop them).
  useEffect(() => {
    const input = editInputRef.current
    if (!input || !funcMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setFuncIndex((i) => Math.min(funcMenu.items.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setFuncIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        applyFunc(funcMenu, funcIndex)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setFuncDismissed(true)
      }
    }
    input.addEventListener('keydown', onKey, true)
    return () => input.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funcMenu, funcIndex])

  function startEdit(cell: Cell, initial?: string): void {
    // A reader never enters the cell editor. The write would be refused by
    // `commit` anyway, but a caret that accepts typing and then discards it is
    // the app pretending an edit landed, which is worse than refusing it.
    if (readOnly) return
    pointRef.current = null
    setPointCell(null)
    setEditing(cell)
    setEditValue(initial ?? tab.rows[cell.r]?.[cell.c] ?? '')
    setFuncIndex(0)
    setFuncDismissed(false)
    // "Enter mode" (started by typing over the cell) commits on an arrow key and
    // moves that way, like Excel. "Edit mode" (F2 / double-click) instead lets the
    // arrows move the text caret, so a mid-value correction is possible.
    setEnterMode(initial !== undefined)
  }
  function endPointMode(): void {
    pointRef.current = null
    setPointCell(null)
  }
  function commitEdit(move: 'up' | 'down' | 'left' | 'right' | 'none'): void {
    if (!editing) return
    endPointMode()
    const { r, c } = editing
    // Strict data validation rejects an invalid entry rather than writing a value
    // the rule forbids. The cell keeps its previous content; we never silently
    // coerce it into something valid.
    const dv = validationForCell(tab.validations, r, c)
    if (dv?.strict && editValue.trim() !== '' && !valueIsValid(editValue, dv.rule)) {
      setStatus(`"${editValue}" is not allowed in ${colLabel(c)}${r + 1} by its data validation.`)
      setEditing(null)
      focusGrid()
      return
    }
    mutateTab((t) => setCell(t, r, c, editValue))
    setEditing(null)
    if (move === 'down') selectCell(Math.min(tab.rows.length - 1, r + 1), c)
    else if (move === 'up') selectCell(Math.max(0, r - 1), c)
    else if (move === 'right') selectCell(r, Math.min(tab.columns.length - 1, c + 1))
    else if (move === 'left') selectCell(r, Math.max(0, c - 1))
    focusGrid()
  }
  function selectCell(r: number, c: number): void {
    setAnchor({ r, c })
    setFocus({ r, c })
  }

  // Empty every cell in the selection (⌫, Cut, and Edit › Delete).
  function clearSelection(): void {
    mutateTab((t) => {
      let next = t
      for (let rr = selection.r0; rr <= selection.r1; rr++)
        for (let cc = selection.c0; cc <= selection.c1; cc++) next = setCell(next, rr, cc, '')
      return next
    })
  }

  // Find and replace (SPEC §9.2) over this sheet's cells, as typed: a formula is
  // searched and replaced as its text, as Excel's "Look in: Formulas" does.
  const [findOpen, setFindOpen] = useState<false | 'find' | 'replace'>(false)
  const findRecords = useMemo(
    () => tab.rows.flatMap((row, r) => row.flatMap((text, c) => (text ? [{ key: `${r},${c}`, text }] : []))),
    [tab.rows]
  )
  function goToHit(key: string): void {
    const [r, c] = key.split(',').map(Number) as [number, number]
    setEditing(null)
    setAnchor({ r, c })
    setFocus({ r, c })
    requestAnimationFrame(() =>
      gridWrapRef.current?.querySelector(`[data-testid="cell-${r}-${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    )
  }
  function replaceCells(changes: Array<{ key: string; text: string }>): void {
    if (!changes.length) return
    mutateTab((t) =>
      changes.reduce((acc, ch) => {
        const [r, c] = ch.key.split(',').map(Number) as [number, number]
        return setCell(acc, r, c, ch.text)
      }, t)
    )
  }

  // ── Header selection (Excel-style) ─────────────────────────────────────────
  function selectAllCells(): void {
    setEditing(null)
    headerDrag.current = null
    setAnchor({ r: 0, c: 0 })
    setFocus({ r: tab.rows.length - 1, c: tab.columns.length - 1 })
    focusGrid()
  }
  function selectColumn(c: number, shift: boolean): void {
    setEditing(null)
    const maxR = tab.rows.length - 1
    const fullCol = selection.r0 === 0 && selection.r1 === maxR
    // Pressing an already-selected column starts a reorder drag of that block;
    // the selection is kept until the drop (or a plain click) resolves.
    if (!shift && fullCol && c >= selection.c0 && c <= selection.c1) {
      reorderArm.current = { kind: 'col', band: [selection.c0, selection.c1], moved: false, over: c }
      return
    }
    const a = shift && headerAnchor.current?.kind === 'col' ? headerAnchor.current.index : c
    headerAnchor.current = { kind: 'col', index: a }
    headerDrag.current = { kind: 'col', anchor: a }
    reorderArm.current = null
    setAnchor({ r: 0, c: a })
    setFocus({ r: maxR, c })
    focusGrid()
  }
  function colHeaderEnter(c: number): void {
    if (reorderArm.current?.kind === 'col') {
      const [s, e] = reorderArm.current.band
      if (c < s || c > e) reorderArm.current.moved = true
      reorderArm.current.over = c
      setReorderOver({ kind: 'col', over: c })
      return
    }
    if (headerDrag.current?.kind !== 'col') return
    setAnchor({ r: 0, c: headerAnchor.current?.index ?? headerDrag.current.anchor })
    setFocus({ r: tab.rows.length - 1, c })
  }
  function selectRow(r: number, shift: boolean): void {
    setEditing(null)
    const maxC = tab.columns.length - 1
    const fullRow = selection.c0 === 0 && selection.c1 === maxC
    if (!shift && fullRow && r >= selection.r0 && r <= selection.r1) {
      reorderArm.current = { kind: 'row', band: [selection.r0, selection.r1], moved: false, over: r }
      return
    }
    const a = shift && headerAnchor.current?.kind === 'row' ? headerAnchor.current.index : r
    headerAnchor.current = { kind: 'row', index: a }
    headerDrag.current = { kind: 'row', anchor: a }
    reorderArm.current = null
    setAnchor({ r: a, c: 0 })
    setFocus({ r, c: maxC })
    focusGrid()
  }
  function rowHeaderEnter(r: number): void {
    if (reorderArm.current?.kind === 'row') {
      const [s, e] = reorderArm.current.band
      if (r < s || r > e) reorderArm.current.moved = true
      reorderArm.current.over = r
      setReorderOver({ kind: 'row', over: r })
      return
    }
    if (headerDrag.current?.kind !== 'row') return
    setAnchor({ r: headerAnchor.current?.index ?? headerDrag.current.anchor, c: 0 })
    setFocus({ r, c: tab.columns.length - 1 })
  }

  // Resolve a header drag-reorder on mouseup: compute the new order, and if it
  // would change any formula's references, ask whether to auto-fix; otherwise
  // apply the move directly. Kept in a ref so the (empty-dep) global mouseup
  // listener always calls the current closure (fresh tab + mutateTab).
  finalizeReorderRef.current = (): void => {
    const arm = reorderArm.current
    if (!arm || !arm.moved) return
    const { kind, band, over } = arm
    const [s, e] = band
    if (over >= s && over <= e) return // dropped back onto the block: no move
    const count = e - s + 1
    const n = kind === 'col' ? tab.columns.length : tab.rows.length
    const to = over < s ? over : over - count
    const order = moveOrder(n, s, count, to)
    const oldToNew: number[] = []
    order.forEach((oi, ni) => (oldToNew[oi] = ni))
    const reordered = kind === 'col' ? reorderColumns(tab, order) : reorderRows(tab, order)
    const fixed =
      kind === 'col'
        ? fixFormulas(reordered, idIndex, (c) => oldToNew[c] ?? c)
        : fixFormulas(reordered, (r) => oldToNew[r] ?? r, idIndex)
    const affectsFormulas = JSON.stringify(reordered.rows) !== JSON.stringify(fixed.rows)
    if (affectsFormulas) {
      setMoveConfirm({ kind, order, oldToNew })
    } else {
      mutateTab((t) => (kind === 'col' ? reorderColumns(t, order) : reorderRows(t, order)))
    }
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────
  // ⌘C / ⌘X, Edit › Cut / Copy in the app's menu (main/index.ts editAction:
  // webContents.cut/copy) and in this sheet's own menu bar all end in ONE DOM
  // copy or cut event, whose handler writes the range into that event's
  // DataTransfer: the TSV as text/plain, exactly as before, and PlexiiCells'
  // flavour beside it (shared/cellsClipboardFormat.ts). One event is one
  // clipboard entry, so the two can never disagree. The keys and this sheet's
  // menu ARM the event (they fire it with execCommand, which needs no focus
  // in the grid); the app menu's event is ours when the grid has focus and no
  // field or page text does. Where the event cannot be fired, the TSV is
  // written alone, as it always was.
  const clipboardArmed = useRef<'copy' | 'cut' | null>(null)

  function rememberCopy(text: string, kind: 'copy' | 'cut'): void {
    clipboardCopy.current = { text, r: selection.r0, c: selection.c0 }
    markCellsCopy(text, { r: selection.r0, c: selection.c0 })
    if (kind === 'cut') clearSelection()
  }

  /** The selection into a copy/cut event's DataTransfer (one write: TSV and the flavour). */
  function writeRangeTo(data: DataTransfer, kind: 'copy' | 'cut'): void {
    const grid = { columns: tab.columns, rows: tab.rows }
    const spill = buildSpillMap(grid, workbook, names)
    const out = cellsCopyPayload(tab, selection, (r, c) => displayCell(grid, r, c, workbook, spill, names))
    data.setData('text/plain', out.tsv)
    if (out.json) data.setData(CELLS_CLIP_MIME, out.json)
    rememberCopy(out.tsv, kind)
  }

  /** Copy or cut the selection: fire the clipboard event this sheet handles, or write the TSV alone. */
  function copyOrCut(kind: 'copy' | 'cut'): void {
    clipboardArmed.current = kind
    try {
      document.execCommand(kind)
    } catch {
      // Handled below: the event never reached the handler.
    }
    // The handler disarms once it has written.
    const wrote = clipboardArmed.current === null
    clipboardArmed.current = null
    if (wrote) return
    const text = rangeToTsv(tab, selection)
    void navigator.clipboard.writeText(text).catch(() => {})
    rememberCopy(text, kind)
  }

  /** ⌘V and Edit › Paste: the clipboard at the selection. */
  async function pasteClipboard(): Promise<void> {
    const text = await navigator.clipboard.readText().catch(() => '')
    // Another of our apps' content (a Write table, a Deck selection, a
    // drawing) lands as a converted sheet snippet would: rows of values
    // at the selection, or the reason it cannot (a picture). Cells' own
    // copies and plain text from anywhere keep the paste below unchanged.
    const ownCopy = !!clipboardCopy.current && clipboardCopy.current.text === text
    if (!ownCopy) {
      const read = await readClipboardForms()
      // A range copied in PlexiiCells somewhere other than this sheet (another
      // workbook, a desk widget, another window, before a restart) carries the
      // range as a saved snippet of it (its flavour): it lands as inserting
      // that snippet does, formats, merges and validation with it and
      // formulas shifted from where they were copied.
      const first = read.forms[0]
      if (read.kind === 'sheet' && !read.refused && first?.kind === 'native') {
        insertSnippetHere(pastedSnippet(first.value as SheetSnippetBody))
        return
      }
      // A newer PlexiiCells' range: its flavour is refused, but the TSV it
      // wrote beside it is plain text, which Cells' own paste below takes.
      const newerCells = !!read.refused && read.kind === 'sheet'
      if (!newerCells && (fromAnotherApp(read, 'sheet') || (!text && read.forms.length > 0))) {
        await pasteConverted('sheet', (body) => insertSnippetHere(pastedSnippet(body)), { read })
        return
      }
    }
    if (!text) return
    const matrix = parseTsv(text)
    // Only shift formulas when the clipboard is still our own copy (we know its
    // origin); an external paste is written literally.
    const origin = clipboardCopy.current && clipboardCopy.current.text === text ? clipboardCopy.current : null
    const isF = (s: string): boolean => s.trim().startsWith('=')
    const multiCell = selection.r0 !== selection.r1 || selection.c0 !== selection.c1
    if (isSingleCell(matrix) && multiCell) {
      const v = matrix[0][0]
      mutateTab((t) =>
        fillSelection(t, selection, v, (val, rr, cc) =>
          origin && isF(val) ? rewriteFormulaRefs(val, rr - origin.r, cc - origin.c) : val
        )
      )
    } else if (multiCell) {
      mutateTab((t) =>
        tileMatrix(t, selection, matrix, (val, destR, destC, si, sj) =>
          origin && isF(val) ? rewriteFormulaRefs(val, destR - origin.r - si, destC - origin.c - sj) : val
        )
      )
    } else {
      const shifted = origin
        ? matrix.map((row) =>
            row.map((val) =>
              isF(val) ? rewriteFormulaRefs(val, focus.r - origin.r, focus.c - origin.c) : val
            )
          )
        : matrix
      mutateTab((t) => writeMatrix(t, focus.r, focus.c, shifted))
    }
  }

  // The clipboard events, read through a ref so the listeners (added once)
  // always run this render's closures. Listened for on the window in the
  // capture phase, and stopped there when they are this sheet's: another
  // editor mounted at the same time (a drawing or a deck in a desk widget)
  // listens on the document, and must not also act on a copy of cells.
  const clipboardEventRef = useRef<(kind: 'copy' | 'cut' | 'paste', e: ClipboardEvent) => void>(() => {})
  clipboardEventRef.current = (kind, e) => {
    const armed = kind !== 'paste' && clipboardArmed.current === kind
    if (!armed) {
      if (editing) return
      const wrap = gridWrapRef.current
      const active = document.activeElement
      if (!wrap || !active || !wrap.contains(active)) return
      const el = (e.target instanceof Node ? (e.target.nodeType === 1 ? e.target : e.target.parentElement) : null) as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().length > 0) return
    }
    if (kind === 'paste') {
      e.preventDefault()
      e.stopPropagation()
      void pasteClipboard()
      return
    }
    if (!e.clipboardData) return
    e.preventDefault()
    e.stopPropagation()
    writeRangeTo(e.clipboardData, kind)
    clipboardArmed.current = null
  }
  useEffect(() => {
    const onCopy = (e: ClipboardEvent): void => clipboardEventRef.current('copy', e)
    const onCut = (e: ClipboardEvent): void => clipboardEventRef.current('cut', e)
    const onPaste = (e: ClipboardEvent): void => clipboardEventRef.current('paste', e)
    window.addEventListener('copy', onCopy, true)
    window.addEventListener('cut', onCut, true)
    window.addEventListener('paste', onPaste, true)
    return () => {
      window.removeEventListener('copy', onCopy, true)
      window.removeEventListener('cut', onCut, true)
      window.removeEventListener('paste', onPaste, true)
    }
  }, [])

  // ── Keyboard ──────────────────────────────────────────────────────────────
  async function onGridKeyDown(e: React.KeyboardEvent): Promise<void> {
    if (editing) return
    // Don't hijack keystrokes meant for a focused field (e.g. the column-header
    // rename input or the name-box) — otherwise typing there would move the
    // selection or start a cell edit instead of editing the header.
    const tgt = e.target as HTMLElement | null
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
    const { r, c } = focus
    const maxR = tab.rows.length - 1
    const maxC = tab.columns.length - 1
    const mod = e.metaKey || e.ctrlKey

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      e.shiftKey ? redo() : undo()
      return
    }
    // ⇧⌘Z is the Redo the menu shows; ⌘Y stays bound too (E-13).
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
      e.preventDefault()
      copyOrCut(e.key.toLowerCase() === 'x' ? 'cut' : 'copy')
      return
    }
    if (mod && e.key === 'Enter') {
      // Ctrl/Cmd+Enter fills the whole selection with the active cell's content,
      // shifting a formula's references per target cell.
      e.preventDefault()
      const v = tab.rows[focus.r]?.[focus.c] ?? ''
      mutateTab((t) =>
        fillSelection(t, selection, v, (val, rr, cc) =>
          val.trim().startsWith('=') ? rewriteFormulaRefs(val, rr - focus.r, cc - focus.c) : val
        )
      )
      return
    }
    if (mod && e.key.toLowerCase() === 'd') {
      // Fill down: copy the selection's top row into the rest, relative-shifting
      // formulas (Excel/Sheets Ctrl+D).
      e.preventDefault()
      mutateTab((t) => {
        const rows = t.rows.map((r) => [...r])
        for (let c = selection.c0; c <= selection.c1; c++) {
          const src = rows[selection.r0]?.[c] ?? ''
          for (let r = selection.r0 + 1; r <= selection.r1; r++)
            rows[r][c] = src.trim().startsWith('=') ? rewriteFormulaRefs(src, r - selection.r0, 0) : src
        }
        return { ...t, rows }
      })
      return
    }
    if (mod && e.key.toLowerCase() === 'r') {
      // Fill right (Ctrl+R).
      e.preventDefault()
      mutateTab((t) => {
        const rows = t.rows.map((r) => [...r])
        for (let r = selection.r0; r <= selection.r1; r++) {
          const src = rows[r]?.[selection.c0] ?? ''
          for (let c = selection.c0 + 1; c <= selection.c1; c++)
            rows[r][c] = src.trim().startsWith('=') ? rewriteFormulaRefs(src, 0, c - selection.c0) : src
        }
        return { ...t, rows }
      })
      return
    }
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      await pasteClipboard()
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      // Select the whole used grid so formatting (colour, bold, number format)
      // can be applied across every cell at once. It runs the SAME
      // selectAllCells the menu's Select all runs, where it used to be a second
      // copy of that function's first two setState calls — one implementation,
      // so the menu row and the key cannot diverge.
      //
      // No behaviour changes by it: the three lines the copy omitted close a
      // cell editor, drop a header drag and refocus the grid, and none is
      // reachable here because this handler returns at `if (editing)` above and
      // bails on INPUT targets. While a cell IS being edited, ⌘A selects that
      // cell's text, as in Excel and Sheets, and must keep doing so.
      e.preventDefault()
      selectAllCells()
      return
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(Math.max(0, r - 1), c, e.shiftKey); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(Math.min(maxR, r + 1), c, e.shiftKey); return }
    if (e.key === 'ArrowLeft') { e.preventDefault(); move(r, Math.max(0, c - 1), e.shiftKey); return }
    if (e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); move(r, Math.min(maxC, c + 1), e.shiftKey && e.key !== 'Tab'); return }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(focus); return }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      clearSelection()
      return
    }
    // Everything the registry binds that the branches above do not already
    // handle: ⌘B / ⌘I / ⌘U, Clear formatting ⌘\, Find ⌘F, Find and replace
    // ⇧⌘H, Keyboard shortcuts ⌘/. Each was advertised in the menu and bound
    // nowhere. Driven from the same `keys` the hint is formatted from, so the
    // menu and the keyboard cannot disagree, and a view-only sheet runs none
    // of them because the command reports itself disabled.
    // The document actions join the sheet's own, so ⌘P is bound wherever the
    // host can really print. Keyless ones never match.
    if (runCommandKey([...Object.values(commands), ...(docRef.current ?? [])], e)) {
      e.preventDefault()
      return
    }
    // A printable character starts editing with that character. preventDefault
    // is essential: without it the same keystroke is ALSO inserted into the
    // newly-focused cell input, duplicating the first character (1 -> 11, and
    // = -> ==, which silently broke every formula).
    if (e.key.length === 1 && !mod) {
      e.preventDefault()
      startEdit(focus, e.key)
    }
  }
  function move(r: number, c: number, extend: boolean): void {
    setFocus({ r, c })
    if (!extend) setAnchor({ r, c })
  }

  // ── Autofill (fill handle, double-click, Ctrl+D/R) ────────────────────────
  // Compute the new tab after extending `source` into `target`. Direction is
  // inferred from how target grows past source; numeric sources can be forced to
  // 'copy' or 'series' (the post-fill toggle). Formulas shift their relative
  // references along the fill axis via the engine.
  function computeFilledTab(
    t: SheetTab,
    source: CellRange,
    target: CellRange,
    modeOverride?: 'copy' | 'series'
  ): SheetTab {
    let axis: 'down' | 'up' | 'right' | 'left' | null = null
    if (target.r1 > source.r1) axis = 'down'
    else if (target.r0 < source.r0) axis = 'up'
    else if (target.c1 > source.c1) axis = 'right'
    else if (target.c0 < source.c0) axis = 'left'
    if (!axis) return t

    const rows = t.rows.map((r) => [...r])
    let columns = t.columns
    while (columns.length <= target.c1) columns = [...columns, colLabel(columns.length)]
    while (rows.length <= target.r1) rows.push(new Array(columns.length).fill(''))
    rows.forEach((r) => {
      while (r.length < columns.length) r.push('')
    })

    const forced = (strip: string[]): boolean => !!modeOverride && canToggleSeries(strip)
    if (axis === 'down' || axis === 'up') {
      for (let c = source.c0; c <= source.c1; c++) {
        const strip: string[] = []
        for (let r = source.r0; r <= source.r1; r++) strip.push(rows[r]?.[c] ?? '')
        if (axis === 'down') {
          const count = target.r1 - source.r1
          const vals = forced(strip)
            ? numericFill(strip, count, modeOverride!)
            : extendSeries(strip, count, (v, step) => rewriteFormulaRefs(v, step, 0))
          for (let k = 0; k < count; k++) rows[source.r1 + 1 + k][c] = vals[k]
        } else {
          const count = source.r0 - target.r0
          const rev = [...strip].reverse()
          const vals = forced(rev)
            ? numericFill(rev, count, modeOverride!)
            : extendSeries(rev, count, (v, step) => rewriteFormulaRefs(v, -step, 0))
          for (let k = 0; k < count; k++) rows[source.r0 - 1 - k][c] = vals[k]
        }
      }
    } else {
      for (let r = source.r0; r <= source.r1; r++) {
        const strip: string[] = []
        for (let c = source.c0; c <= source.c1; c++) strip.push(rows[r]?.[c] ?? '')
        if (axis === 'right') {
          const count = target.c1 - source.c1
          const vals = forced(strip)
            ? numericFill(strip, count, modeOverride!)
            : extendSeries(strip, count, (v, step) => rewriteFormulaRefs(v, 0, step))
          for (let k = 0; k < count; k++) rows[r][source.c1 + 1 + k] = vals[k]
        } else {
          const count = source.c0 - target.c0
          const rev = [...strip].reverse()
          const vals = forced(rev)
            ? numericFill(rev, count, modeOverride!)
            : extendSeries(rev, count, (v, step) => rewriteFormulaRefs(v, 0, -step))
          for (let k = 0; k < count; k++) rows[r][source.c0 - 1 - k] = vals[k]
        }
      }
    }
    return { ...t, columns, rows }
  }

  function runFill(source: CellRange, target: CellRange): void {
    if (target.r0 === source.r0 && target.r1 === source.r1 && target.c0 === source.c0 && target.c1 === source.c1)
      return
    mutateTab((t) => computeFilledTab(t, source, target))
    setFocus({ r: target.r1, c: target.c1 })
    setAnchor({ r: target.r0, c: target.c0 })
    // Offer the Copy/Series toggle only when the source is numeric, where the
    // distinction is meaningful (Excel's auto-fill options button).
    const flat: string[] = []
    for (let r = source.r0; r <= source.r1; r++)
      for (let c = source.c0; c <= source.c1; c++) flat.push(tab.rows[r]?.[c] ?? '')
    setLastFill(canToggleSeries(flat) ? { source, target, mode: 'series' } : null)
  }
  // Keep the mouseup-time executor fresh (it reads the current tab via mutateTab).
  doFillRef.current = runFill

  // Flip a completed numeric fill between Copy and Series (re-applies over the
  // same target).
  function toggleFillMode(): void {
    if (!lastFill) return
    const nextMode = lastFill.mode === 'series' ? 'copy' : 'series'
    mutateTab((t) => computeFilledTab(t, lastFill.source, lastFill.target, nextMode))
    setLastFill({ ...lastFill, mode: nextMode })
  }

  // The preview rectangle while dragging the handle: extend along whichever axis
  // the pointer moved furthest, in the pointer's direction.
  function fillPreviewFor(source: CellRange, r: number, c: number): CellRange {
    const dRow = r > source.r1 ? r - source.r1 : r < source.r0 ? r - source.r0 : 0
    const dCol = c > source.c1 ? c - source.c1 : c < source.c0 ? c - source.c0 : 0
    if (Math.abs(dRow) >= Math.abs(dCol) && dRow !== 0) {
      return dRow > 0
        ? { r0: source.r0, c0: source.c0, r1: r, c1: source.c1 }
        : { r0: r, c0: source.c0, r1: source.r1, c1: source.c1 }
    }
    if (dCol !== 0) {
      return dCol > 0
        ? { r0: source.r0, c0: source.c0, r1: source.r1, c1: c }
        : { r0: source.r0, c0: c, r1: source.r1, c1: source.c1 }
    }
    return source
  }

  function onFillStart(): void {
    fillDrag.current = selection
    setLastFill(null)
  }
  function onFillEnter(r: number, c: number): void {
    if (!fillDrag.current) return
    const range = fillPreviewFor(fillDrag.current, r, c)
    fillPreviewRef.current = range
    setFillPreview(range)
  }
  // Double-click the handle: fill down to the extent of the neighbouring data.
  function onFillToEnd(): void {
    const extent = dataExtentBelow(tab, selection)
    if (extent > selection.r1) runFill(selection, { ...selection, r1: extent })
  }

  // ── Formatting + structural ops ───────────────────────────────────────────
  const applyToSelection = (patch: Partial<SheetCellFormat>): void =>
    mutateTab((t) => applyFormat(t, selection, patch))
  const applyNumberFormat = (numFmt: SheetNumberFormat): void => applyToSelection({ numFmt })

  // ── Charts ────────────────────────────────────────────────────────────────
  function insertChart(type: 'bar' | 'line' | 'pie' | 'area' | 'scatter'): void {
    const ref = `${colLabel(selection.c0)}${selection.r0 + 1}:${colLabel(selection.c1)}${selection.r1 + 1}`
    const spec: SheetChartSpec = {
      id: `ch-${Date.now().toString(36)}`,
      type,
      range: ref,
      headerRow: selection.r1 > selection.r0,
      headerCol: selection.c1 > selection.c0
    }
    mutateTab((t) => ({ ...t, charts: [...(t.charts ?? []), spec] }))
  }
  function removeChart(id: string): void {
    mutateTab((t) => ({ ...t, charts: (t.charts ?? []).filter((ch) => ch.id !== id) }))
  }
  // Write =SPARKLINE(<selected range>) into a cell so the selected values draw as
  // a mini chart. A single-row selection lands the formula in the cell just to its
  // right (the "Trend" column pattern); otherwise it lands just below. The grid is
  // grown if the target sits past the current extent, and the new cell is selected.
  function insertSparkline(): void {
    const ref = `${colLabel(selection.c0)}${selection.r0 + 1}:${colLabel(selection.c1)}${selection.r1 + 1}`
    const singleRow = selection.r0 === selection.r1
    const target = singleRow
      ? { r: selection.r0, c: selection.c1 + 1 }
      : { r: selection.r1 + 1, c: selection.c0 }
    mutateTab((t) => {
      let next = t
      while (next.columns.length <= target.c) next = addColumn(next)
      while (next.rows.length <= target.r) next = addRow(next)
      return setCell(next, target.r, target.c, `=SPARKLINE(${ref})`)
    })
    selectCell(target.r, target.c)
  }
  // A "lookup cell": materialise an =XLOOKUP(...) into the active cell so the
  // result is a real, live-recomputing formula rather than a frozen copy. Given
  // the table's A1 range and 1-based match/return columns, it builds the match
  // and return column sub-ranges and writes the formula.
  function insertLookup(key: string, tableRange: string, matchCol: number, returnCol: number, ifMissing: string): void {
    const rg = parseA1Range(tableRange)
    if (!rg || !key.trim()) return
    const matchLetter = colLabel(rg.c1 + Math.max(1, matchCol) - 1)
    const returnLetter = colLabel(rg.c1 + Math.max(1, returnCol) - 1)
    const lookupArr = `${matchLetter}${rg.r1 + 1}:${matchLetter}${rg.r2 + 1}`
    const returnArr = `${returnLetter}${rg.r1 + 1}:${returnLetter}${rg.r2 + 1}`
    const miss = ifMissing.trim() ? `, "${ifMissing.replace(/"/g, '')}"` : ''
    const formula = `=XLOOKUP(${key.trim()}, ${lookupArr}, ${returnArr}${miss})`
    mutateTab((t) => setCell(t, focus.r, focus.c, formula))
    setLookupOpen(false)
  }
  function insertPivot(spec: SheetPivotSpec): void {
    mutateTab((t) => ({ ...t, pivots: [...(t.pivots ?? []), spec] }))
  }
  function removePivot(id: string): void {
    mutateTab((t) => ({ ...t, pivots: (t.pivots ?? []).filter((p) => p.id !== id) }))
  }
  function updatePivot(id: string, next: SheetPivotSpec): void {
    mutateTab((t) => ({ ...t, pivots: (t.pivots ?? []).map((p) => (p.id === id ? next : p)) }))
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  function switchTab(i: number): void {
    // activeSheet lives in the body, so remembering which sheet you are on is
    // a document write. A reader still gets to look at the other sheets; it
    // just is not recorded for everyone.
    setBody({ ...body, activeSheet: i })
    if (!readOnly) onChange({ ...body, activeSheet: i })
    selectCell(0, 0)
  }
  function addTab(): void {
    const next: SheetBodyV2 = { ...body, sheets: [...body.sheets, emptyTab(`Sheet ${body.sheets.length + 1}`)], activeSheet: body.sheets.length }
    commit(next)
  }
  function renameTab(i: number, name: string): void {
    commit({ ...body, sheets: body.sheets.map((s, si) => (si === i ? { ...s, name } : s)) })
  }
  function deleteTab(i: number): void {
    if (body.sheets.length <= 1) return
    const sheets = body.sheets.filter((_, si) => si !== i)
    commit({ ...body, sheets, activeSheet: Math.max(0, i - 1) })
  }

  // ── Column resize ─────────────────────────────────────────────────────────
  function onColResizeStart(c: number, e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colWidthOf(c)
    const onMove = (ev: MouseEvent): void => setLiveWidth({ c, w: Math.max(48, startW + ev.clientX - startX) })
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const w = Math.max(48, startW + ev.clientX - startX)
      setLiveWidth(null)
      mutateTab((t) => setColWidth(t, c, w))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Drag the bottom edge of a row header to resize its height (Excel-style).
  function onRowResizeStart(r: number, e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = rowHeightOf(r)
    const onMove = (ev: MouseEvent): void => setLiveHeight({ r, h: Math.max(20, startH + ev.clientY - startY) })
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const h = Math.max(20, startH + ev.clientY - startY)
      setLiveHeight(null)
      mutateTab((t) => setRowHeight(t, r, h))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Double-click the column boundary to auto-fit width to content (Excel). Sizes
  // to the widest displayed value in the column, clamped to a sane range.
  function onColAutoFit(c: number): void {
    const grid = { columns: tab.columns, rows: tab.rows }
    // Header is semibold; each cell is measured in its own weight so a bold value
    // widens the fit. The column grows to its widest actual content.
    let maxW = measureTextPx(tab.columns[c] ?? '', true)
    for (let r = 0; r < tab.rows.length; r++) {
      const v = displayCell(grid, r, c, workbook)
      if (!v) continue
      const w = measureTextPx(v, !!cellFormat(tab, r, c)?.bold)
      if (w > maxW) maxW = w
    }
    const w = Math.max(64, Math.min(600, Math.round(maxW) + 26))
    mutateTab((t) => setColWidth(t, c, w))
  }

  // ── Outline groups (Data > Group) ──────────────────────────────────────────
  function groupRows(): void {
    if (selection.r0 === selection.r1) return // a group needs at least two rows
    mutateTab((t) => ({
      ...t,
      rowGroups: [...(t.rowGroups ?? []), { start: selection.r0, end: selection.r1, collapsed: false }]
    }))
  }
  function ungroupRows(r: number): void {
    mutateTab((t) => ({ ...t, rowGroups: (t.rowGroups ?? []).filter((g) => !(r >= g.start && r <= g.end)) }))
  }
  function toggleRowGroup(index: number): void {
    mutateTab((t) => ({
      ...t,
      rowGroups: (t.rowGroups ?? []).map((g, i) => (i === index ? { ...g, collapsed: !g.collapsed } : g))
    }))
  }
  function groupCols(): void {
    if (selection.c0 === selection.c1) return
    mutateTab((t) => ({
      ...t,
      colGroups: [...(t.colGroups ?? []), { start: selection.c0, end: selection.c1, collapsed: false }]
    }))
  }
  function ungroupCols(c: number): void {
    mutateTab((t) => ({ ...t, colGroups: (t.colGroups ?? []).filter((g) => !(c >= g.start && c <= g.end)) }))
  }
  function toggleColGroup(index: number): void {
    mutateTab((t) => ({
      ...t,
      colGroups: (t.colGroups ?? []).map((g, i) => (i === index ? { ...g, collapsed: !g.collapsed } : g))
    }))
  }
  const rowInGroup = (r: number): boolean => (tab.rowGroups ?? []).some((g) => r >= g.start && r <= g.end)
  const colInGroup = (c: number): boolean => (tab.colGroups ?? []).some((g) => c >= g.start && c <= g.end)

  // ── Office import / export ────────────────────────────────────────────────
  async function importFile(): Promise<void> {
    if (readOnly) return
    setStatus('Importing…')
    try {
      const res = await window.api.sheet.import()
      if (res.ok && res.body) {
        const v2 = normalizeBody(res.body)
        undoStack.current.push(body)
        setBody(v2)
        onChange(v2)
        selectCell(0, 0)
        setStatus(`Imported ${res.name ?? 'file'}. Values + formulas where available; styling is approximate.`)
      } else if (res.error) setStatus(res.error)
      else setStatus(null)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }
  async function exportFile(format: 'xlsx' | 'csv'): Promise<void> {
    setStatus('Exporting…')
    try {
      const res = await window.api.sheet.export({ body, format, name: title })
      setStatus(res.ok ? `Saved ${res.path}` : res.error ?? null)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }

  // ── AI fill ───────────────────────────────────────────────────────────────
  // Step one: name the columns starting at the selection's left edge, growing
  // the grid as needed. The panel stays open and advances to the rows step.
  function applyAiColumns(columns: string[]): void {
    mutateTab((t) => {
      let next = t
      const need = selection.c0 + columns.length
      while (next.columns.length < need) next = addColumn(next)
      columns.forEach((name, i) => {
        next = setColumnName(next, selection.c0 + i, name)
      })
      return next
    })
  }
  // Step two: write the generated rows just below the header, anchored to the
  // selection's top-left so they land under the columns we just created.
  function applyAiMatrix(matrix: string[][]): void {
    mutateTab((t) => writeMatrix(t, selection.r0, selection.c0, matrix))
    setAiOpen(false)
  }

  // Apply an AI formula plan in a single undo step: create any proposed columns
  // (appended to the active tab), write the formula to the active cell, and add
  // any proposed tabs.
  function applyFormulaPlan(plan: FormulaPlan): void {
    const ai = body.activeSheet ?? 0
    let nextBody: SheetBodyV2 = body
    if (plan.columnsToAdd?.length) {
      let t = activeTab(nextBody)
      for (const name of plan.columnsToAdd) {
        t = addColumn(t)
        t = setColumnName(t, t.columns.length - 1, name)
      }
      nextBody = withTab(nextBody, ai, t)
    }
    nextBody = withTab(nextBody, ai, setCell(activeTab(nextBody), focus.r, focus.c, plan.formula))
    if (plan.tabsToAdd?.length) {
      nextBody = { ...nextBody, sheets: [...nextBody.sheets, ...plan.tabsToAdd.map((tb) => emptyTab(tb.name))] }
    }
    commit(nextBody)
    setFormulaAiOpen(false)
  }

  const activeRaw = tab.rows[focus.r]?.[focus.c] ?? ''
  const activeRef = `${colLabel(focus.c)}${focus.r + 1}`

  function addNamedRange(): void {
    const n = newName.trim()
    const ref = newRef.trim()
    if (!n || !ref) return
    const rest = (body.names ?? []).filter((x) => x.name.toLowerCase() !== n.toLowerCase())
    commit({ ...body, names: [...rest, { name: n, ref }] })
    setNewName('')
    setNewRef('')
  }
  function removeNamedRange(name: string): void {
    commit({ ...body, names: (body.names ?? []).filter((x) => x.name !== name) })
  }
  // Pre-fill the reference with the current selection, the common case.
  function openNames(): void {
    setNewRef(`${colLabel(selection.c0)}${selection.r0 + 1}:${colLabel(selection.c1)}${selection.r1 + 1}`)
    setNamesOpen((v) => !v)
  }

  // Capture: the selected range becomes a sheet snippet body (cell input with
  // formulas as written, the origin they are relative to, formats, merges and
  // validation), or an empty one so the dialog can say there is nothing to save.
  function saveSelectionAsSnippet(): void {
    setSnippetDraft({
      body: sheetBodyFromSelection(tab, selection) ?? { kind: 'sheet', rows: [] },
      notKept: sheetSnippetNotKept(tab, selection)
    })
  }
  // Insertion: a duplicate pasted at the selection's top-left, exactly as ⌘V
  // lands an in-app copy (relative references shifted, absolute kept, the
  // cells under it overwritten without asking). ONE mutateTab, so one undo
  // takes it back; the landed range becomes the selection, and every formula
  // recalculates on the render that follows. A refusal names its reason, on
  // the status line and, verbatim, in the library.
  // `at` (optional, additive): land at that cell instead of the selection,
  // for a drop from Files at the cell under the pointer.
  const lastLanding = useRef<{ r0: number; c0: number; r1: number; c1: number } | null>(null)
  function insertSnippetHere(snippet: Snippet, at?: { r: number; c: number }): SnippetInsertResult {
    const landing = insertSheetSnippet(tab, snippet, {
      at: at ?? { r: selection.r0, c: selection.c0 },
      readOnly,
      newId: newValidationId
    })
    if ('declined' in landing) {
      setStatus(landing.declined)
      return { ok: false, reason: landing.declined }
    }
    setEditing(null)
    lastLanding.current = landing.range
    mutateTab(() => landing.tab)
    // The landed range is the selection, with its top-left the active cell,
    // as after an Excel paste.
    setAnchor({ r: landing.range.r1, c: landing.range.c1 })
    setFocus({ r: landing.range.r0, c: landing.range.c0 })
    setStatus(null)
    return true
  }
  useCellsSnippetTarget(snippetScope, title, insertSnippetHere)
  // Print… and Download ▸ PDF (DocumentOps.print / exportPdf) both print the
  // active tab as the grid shows it, paged over-then-down on the locale's paper
  // (lib/sheetPrintModel.ts, shared/sheetPrint.ts).
  usePrintSource(documentOps, async () => {
    const t = activeTab(body)
    // Charts print as the editor drew them: a snapshot of each one's rendered
    // PlexiChart in the chart list below the grid (SheetChart, data-chart-id).
    const chartSnapshots: Record<string, { html: string; w: number; h: number }> = {}
    for (const spec of t.charts ?? []) {
      const drawn = document.querySelector<HTMLElement>(`[data-chart-id="${CSS.escape(spec.id)}"] .recharts-wrapper`)
      if (!drawn) continue
      const box = drawn.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) chartSnapshots[spec.id] = { html: drawn.outerHTML, w: Math.round(box.width), h: Math.round(box.height) }
    }
    // Placed work widgets print as named boxes: their names, by id.
    const widgetNames: Record<string, string> = {}
    await Promise.all(
      (t.widgets ?? []).map(async (pl) => {
        try {
          const w = pl.widgetId.startsWith('wf:')
            ? await window.api.widgetFiles.get(pl.widgetId.slice(3))
            : await window.api.widgets.get(pl.widgetId)
          if (w?.title) widgetNames[pl.widgetId] = w.title
        } catch {
          // A name we cannot read prints as "Work widget"; the box still prints.
        }
      })
    )
    return {
      app: 'cells',
      title: title || 'spreadsheet',
      sheet: sheetPrintModel(body, undefined, { chartSnapshots, widgetNames }),
      paper: paperForLocale(navigator.language)
    }
  })

  // The sheet's operations, built once. SheetMenuBar takes them as its
  // `actions`, and the ribbon reads the same object through CellsChrome —
  // so the menu and the bar can never offer different behaviour for the
  // same command.
  const sheetActions: SheetMenuActions = {
    title,
    activeFormat: cellFormat(tab, focus.r, focus.c),
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    cut: () => copyOrCut('cut'),
    copy: () => copyOrCut('copy'),
    paste: () => void pasteClipboard(),
    format: applyToSelection,
    numberFormat: applyNumberFormat,
    insertRowAbove: () => mutateTab((t) => insertRowFixed(t, selection.r0)),
    insertRowBelow: () => mutateTab((t) => insertRowFixed(t, selection.r1 + 1)),
    insertColLeft: () => mutateTab((t) => insertColFixed(t, selection.c0)),
    insertColRight: () => mutateTab((t) => insertColFixed(t, selection.c1 + 1)),
    deleteRow: () => mutateTab((t) => deleteRowFixed(t, selection.r0)),
    deleteCol: () => mutateTab((t) => deleteColFixed(t, selection.c0)),
    sort: (dir) => mutateTab((t) => sortByColumn(t, selection.c0, dir)),
    toggleFilter: () =>
      mutateTab((t) => ({
        ...t,
        filterActive: !t.filterActive,
        ...(t.filterActive ? { filters: {} } : {})
      })),
    filterActive: !!tab.filterActive,
    insertChart,
    insertSparkline,
    insertPivot: () => setPivotOpen(true),
    conditionalFormat: () => setCondOpen(true),
    dataValidation: () => setValidationOpen(true),
    addSheet: addTab,
    namedRanges: openNames,
    importFile: () => void importFile(),
    exportFile: (f) => void exportFile(f),
    aiFill: () => setAiOpen((v) => !v),
    saveSnippet: saveSelectionAsSnippet,
    selectAll: selectAllCells,
    deleteSelection: clearSelection,
    find: () => setFindOpen('find'),
    findAndReplace: () => setFindOpen('replace'),
    insertSnippet: () => setSnippetLibraryOpen(true),
    documentOps
  }

  // PlexiiCells' ONE command registry, built in render from the live sheet.
  // The menu bar, the ContextBar ribbon and the Cmd+K palette all render from
  // it, so an action has one label, one key and one enabled state everywhere
  // (SPEC §9). Built every render on purpose: `checked` and `enabled` read the
  // live cell format, the live undo stacks and the live view-only flag.
  const commands = buildCellsCommands({
    a: sheetActions,
    readOnly,
    isMerged: selectionIsMerged,
    mergeCells: toggleMerge,
    insertLookup: () => setLookupOpen(true),
    macros: () => setMacrosOpen(true),
    query: () => setQueryOpen(true),
    shortcuts: () => setShortcutsOpen(true),
    pageSetup: () => setPageSetupOpen(true),
    // Read structurally, as `print` is: the export engine adds the op, and
    // Download ▸ PDF is ABSENT rather than dead where it is missing.
    exportPdf:
      typeof (documentOps as { exportPdf?: unknown } | undefined)?.exportPdf === 'function'
        ? () => void (documentOps as unknown as { exportPdf: () => unknown }).exportPdf()
        : undefined
  })

  // File's document actions, built ONCE here from the host-bound ops. The menu
  // bar renders these and the grid's key handler matches them, so Print's ⌘P
  // hint and Print's binding are the same object — a copy built inside the menu
  // bar would show the hint while nothing bound the key.
  const doc = documentCommands(documentOps, 'sheet')

  // The palette reads through a ref so every row runs the CURRENT closures,
  // while the row LIST is rebuilt when view-only access changes: paletteEntries
  // drops whatever is disabled, because a palette row cannot show why it is
  // off. PlexiiCells had no palette entries at all before this.
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  docRef.current = doc ? Object.values(doc) : []
  // Every input a command's `enabled` or `label` reads: paletteEntries takes a
  // SNAPSHOT, so a missing dep leaves a stale list — Undo absent from ⌘K after
  // the first edit made it possible, or the filter row still reading "Create a
  // filter" once one exists.
  useRegisterEditorCommands(
    'Spreadsheet',
    () => paletteEntries(Object.values(commandsRef.current)),
    [readOnly, sheetActions.canUndo, sheetActions.canRedo, sheetActions.filterActive, selectionIsMerged]
  )

  return (
    <CellsChrome
      actions={sheetActions}
      readOnly={readOnly}
      commands={commands}
      menuBar={<SheetMenuBar commands={commands} doc={doc} />}
      activeFormat={cellFormat(tab, focus.r, focus.c)}
      activeFont={cellFormat(tab, focus.r, focus.c)?.fontFamily}
      isMerged={selectionIsMerged}
      onMergeCells={toggleMerge}
      onInsertLookup={() => setLookupOpen(true)}
      onMacros={() => setMacrosOpen(true)}
      onQuery={() => setQueryOpen(true)}
      aiOpen={aiPanelOpen}
      onAiOpen={setAiPanelOpen}
      renderAssistant={() => <SheetAiPanel ai={sheetAi} onImportSource={importFile} />}
      bottom={
        <SheetTabStrip body={body} onSwitch={switchTab} onAdd={addTab} onRename={renameTab} onDelete={deleteTab} />
      }
    >
      {/* The grid. `min-w-0` matters and is not decoration: SPEC §6 wants it
          on every flex item down to the shell, and the grid's own
          min-content width is wide — without it the shell cannot shrink
          inside a 480px desk widget and the bar overflows. The shell's
          canvas slot carries no overflow of its own, so the scroller here
          is the one the grid already had. */}
      <div className="flex h-full min-h-0 min-w-0 flex-col px-3 py-2">
        {/* A zero-height anchor, so the panel sits over the grid's top right
            without making this column a positioning context for the dialogs. */}
        {findOpen && (
          <div className="relative h-0 shrink-0 z-40">
            <RecordFindReplace
              testid="sheet-find"
              scope="Find in this sheet"
              replace={findOpen === 'replace'}
            records={findRecords}
              onGo={(h) => goToHit(h.key)}
              onReplace={replaceCells}
              onClose={() => {
                setFindOpen(false)
                focusGrid()
              }}
            />
          </div>
        )}
        {/* Formula bar */}
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <span className="text-[11px] font-mono text-[var(--ink-40)] w-12 text-center shrink-0">
            {colLabel(focus.c)}
            {focus.r + 1}
          </span>
          <input
            value={activeRaw}
            onChange={(e) => mutateTab((t) => setCell(t, focus.r, focus.c, e.target.value))}
            placeholder="Select a cell. Start with = for a formula, e.g. =SUM(A2:A9)"
            className="fb-field flex-1 px-3 py-1.5 text-[13px] font-mono"
          />
          <button
            onClick={() => setFormulaAiOpen((v) => !v)}
            data-testid="sheet-formula-ai-btn"
            title="Ask AI to write a formula"
            className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/[0.06] text-accent px-2.5 py-1.5 text-[12px] hover:bg-accent/[0.12]"
          >
            <Icon name="function" size={13} />
            AI
          </button>
          <button
            onClick={openNames}
            data-testid="sheet-names-toggle"
            title="Named ranges — give a cell or range a name to use in formulas"
            className={`shrink-0 inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] ${
              namesOpen
                ? 'border-accent bg-accent/[0.12] text-accent'
                : 'border-[var(--edge-firm)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <Icon name="label" size={13} />
            Names
          </button>
        </div>

        {namesOpen && (
          <div
            className="fb-card mb-2 p-2 space-y-1.5"
            data-testid="sheet-names-panel"
          >
            <div className="text-[11px] uppercase tracking-wide text-[var(--ink-40)]">Named ranges</div>
            {(body.names ?? []).length === 0 ? (
              <div className="text-[12px] text-[var(--ink-40)]">No names yet. Name the selection below, then use it in any formula.</div>
            ) : (
              (body.names ?? []).map((nm) => (
                <div key={nm.name} className="flex items-center gap-2 text-[12px]" data-testid={`sheet-name-row-${nm.name}`}>
                  <span className="font-mono font-medium text-[var(--ink-70)]">{nm.name}</span>
                  <span className="text-[var(--ink-40)]">→</span>
                  <span className="font-mono text-[var(--ink-50)] truncate flex-1 min-w-0">{nm.ref}</span>
                  <button
                    onClick={() => removeNamedRange(nm.name)}
                    data-testid={`sheet-name-del-${nm.name}`}
                    className="text-[var(--ink-40)] hover:text-rose-500 shrink-0"
                    title="Delete name"
                  >
                    <Icon name="delete" size={13} />
                  </button>
                </div>
              ))
            )}
            <div className="flex items-center gap-1.5 pt-1">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name"
                data-testid="sheet-name-input"
                className="fb-field w-28 px-2 py-1 text-[12px] font-mono"
              />
              <input
                value={newRef}
                onChange={(e) => setNewRef(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addNamedRange()
                }}
                placeholder="A1:B10"
                data-testid="sheet-ref-input"
                className="fb-field flex-1 px-2 py-1 text-[12px] font-mono"
              />
              <button
                onClick={addNamedRange}
                disabled={!newName.trim() || !newRef.trim()}
                data-testid="sheet-name-add"
                className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        )}

        {formulaAiOpen && (
          <SheetFormulaAssist
            headers={tab.columns}
            activeRef={activeRef}
            sample={tab.rows.slice(0, 5)}
            onApply={applyFormulaPlan}
            onClose={() => setFormulaAiOpen(false)}
          />
        )}

        {condOpen && (
          <CondFormatDialog
            range={`${colLabel(selection.c0)}${selection.r0 + 1}:${colLabel(selection.c1)}${selection.r1 + 1}`}
            rules={tab.condRules ?? []}
            onAdd={(rule: SheetCondRule) =>
              mutateTab((t) => ({ ...t, condRules: [...(t.condRules ?? []), rule] }))
            }
            onRemove={(id: string) =>
              mutateTab((t) => ({ ...t, condRules: (t.condRules ?? []).filter((x) => x.id !== id) }))
            }
            onClose={() => setCondOpen(false)}
          />
        )}

        {validationOpen && (
          <ValidationDialog
            range={`${colLabel(selection.c0)}${selection.r0 + 1}:${colLabel(selection.c1)}${selection.r1 + 1}`}
            validations={tab.validations ?? []}
            onAdd={(v: SheetValidation) =>
              mutateTab((t) => ({ ...t, validations: [...(t.validations ?? []), v] }))
            }
            onRemove={(id: string) =>
              mutateTab((t) => ({ ...t, validations: (t.validations ?? []).filter((x) => x.id !== id) }))
            }
            onClose={() => setValidationOpen(false)}
          />
        )}

        {snippetLibraryOpen && (
          <SnippetLibrary kinds={SHEET_KINDS} targetId={cellsSnippetTargetId(snippetScope)} onClose={() => setSnippetLibraryOpen(false)} />
        )}

        {snippetDraft && (
          <SaveSnippetDialog
            body={snippetDraft.body}
            notKept={snippetDraft.notKept}
            suggestedName={suggestedSheetSnippetName(snippetDraft.body)}
            onClose={() => setSnippetDraft(null)}
          />
        )}

        {status && (
          <div className="mb-2 text-[12px] text-[var(--ink-50)] flex items-center gap-1.5" data-testid="sheet-status">
            <span>{status}</span>
            <button onClick={() => setStatus(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}

        {/* Excel-style auto-fill options: after a numeric fill, flip between
            copying the value and continuing the series. */}
        {lastFill && (
          <div
            className="fb-card mb-2 inline-flex items-center gap-2 px-2 py-1 text-[12px]"
            data-testid="sheet-fill-options"
          >
            <Icon name="auto_awesome" size={13} className="text-accent" />
            <span className="text-[var(--ink-50)]">Filled as {lastFill.mode === 'series' ? 'series' : 'copy'}.</span>
            <button onClick={toggleFillMode} className="text-accent hover:underline">
              Switch to {lastFill.mode === 'series' ? 'copy' : 'series'}
            </button>
            <button onClick={() => setLastFill(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}

        {aiOpen && (
          <SheetAiFill
            headers={Array.from({ length: selection.c1 - selection.c0 + 1 }, (_, i) => tab.columns[selection.c0 + i] ?? colLabel(selection.c0 + i))}
            rangeRows={Math.max(1, selection.r1 - selection.r0 + 1)}
            onApplyColumns={applyAiColumns}
            onApply={applyAiMatrix}
            onClose={() => setAiOpen(false)}
          />
        )}

        <div
          ref={gridWrapRef}
          tabIndex={0}
          onKeyDown={(e) => void onGridKeyDown(e)}
          // `relative` so placed work widgets can be positioned against the
          // grid rather than the window. They live in this box, so they
          // scroll with the sheet.
          className="flex-1 min-h-0 relative"
          data-testid="sheet-grid-wrap"
          onContextMenu={(e) => {
            const t = e.target as HTMLElement
            if (t.closest('input, textarea, [contenteditable="true"]')) return
            const td = t.closest('[data-testid^="cell-"]')
            const m = td?.getAttribute('data-testid')?.match(/^cell-(\d+)-(\d+)$/)
            if (!m) return
            const r = Number(m[1])
            const c = Number(m[2])
            // A right-click outside the selection selects that cell first, as
            // every spreadsheet does; inside it, the selection is kept.
            if (r < selection.r0 || r > selection.r1 || c < selection.c0 || c > selection.c1) selectCell(r, c)
            e.preventDefault()
            setCellMenu({ x: e.clientX, y: e.clientY })
          }}
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
            // From Files: the content lands AT THE CELL under the pointer through
            // Cells' own converted paste (values, never pictures); a work widget
            // file anchors to that cell as its own drag does. Several items stack
            // down from it. Checked first: one item also carries the widget drag.
            if (dragCarriesFiles(e.dataTransfer)) {
              e.preventDefault()
              e.stopPropagation()
              const refs = filesDropRefs(e.dataTransfer)
              if (!refs?.length) return
              const box = e.currentTarget.getBoundingClientRect()
              const cell = cellAtOffset(e.clientX - box.left + e.currentTarget.scrollLeft, e.clientY - box.top + e.currentTarget.scrollTop) ?? { r: selection.r0, c: selection.c0 }
              let next = cell
              void runContentDrop(refs, { target: 'sheet', alt: e.altKey, ownDocumentId: documentOps?.id ?? null }, async (read, ref) => {
                if (ref.kind === 'doc' && ref.docType === 'widget' && ref.docId && !e.altKey) {
                  const at = next
                  mutateTab((t) => ({
                    ...t,
                    widgets: [...(t.widgets ?? []), { id: `sw-${Date.now().toString(36)}-${ref.docId!.slice(0, 6)}`, widgetId: widgetFileGroupId(ref.docId!), mode: 'cell' as const, r: at.r, c: at.c, w: 320, h: 220 }]
                  }))
                  next = { r: at.r + 10, c: at.c }
                  return true
                }
                lastLanding.current = null
                const out = await pasteConverted('sheet', (body) => insertSnippetHere(pastedSnippet(body), next), { read })
                if (lastLanding.current) next = { r: (lastLanding.current as { r1: number }).r1 + 2, c: cell.c }
                return out
              })
              return
            }
            if (!acceptsWidgetDrag(e.dataTransfer)) return
            e.preventDefault()
            // WHICH MODE A DROP MAKES. Dropped onto a cell it anchors to
            // that cell, because that is what the pointer was over and what
            // the user pointed at; the placement can be switched to floating
            // afterwards from the widget's own control. Dropped past the end
            // of the data there is no cell to belong to, so it floats.
            const box = e.currentTarget.getBoundingClientRect()
            const px = e.clientX - box.left + e.currentTarget.scrollLeft
            const py = e.clientY - box.top + e.currentTarget.scrollTop
            const cell = cellAtOffset(px, py)
            void widgetIdFromDrop(e.dataTransfer).then((widgetId) => {
              if (!widgetId) return
              mutateTab((t) => ({
                ...t,
                widgets: [
                  ...(t.widgets ?? []),
                  cell
                    ? { id: `sw-${Date.now().toString(36)}`, widgetId, mode: 'cell' as const, r: cell.r, c: cell.c, w: 320, h: 220 }
                    : { id: `sw-${Date.now().toString(36)}`, widgetId, mode: 'float' as const, x: Math.round(px), y: Math.round(py), w: 320, h: 220 }
                ]
              }))
            })
          }}
        >
          {/* Placed work widgets, both kinds, drawn over the grid. An
              anchored one derives its position from its cell every render,
              so it follows the data when columns are resized or rows are
              inserted; a floating one keeps the spot it was put. */}
          {(tab.widgets ?? []).map((pl) => {
            const at =
              pl.mode === 'cell'
                ? cellOffset(pl.r ?? 0, pl.c ?? 0)
                : { x: pl.x ?? 0, y: pl.y ?? 0 }
            return (
              <div
                key={pl.id}
                data-testid={`sheet-widget-${pl.id}`}
                data-mode={pl.mode}
                className="absolute z-20 rounded-lg overflow-hidden shadow-sm border border-[var(--edge-soft)] bg-[var(--surface-raised)]"
                style={{ left: at.x, top: at.y, width: pl.w, height: pl.h }}
              >
                <div className="h-5 flex items-center gap-1 px-1 bg-[var(--surface-sunken)] border-b border-[var(--edge-hairline)]">
                  <button
                    className="text-[10px] text-[var(--ink-50)] hover:text-accent px-1 rounded"
                    title={
                      pl.mode === 'cell'
                        ? 'Anchored to a cell — click to float it over the sheet'
                        : 'Floating over the sheet — click to anchor it to a cell'
                    }
                    onClick={() =>
                      mutateTab((t) => ({
                        ...t,
                        widgets: (t.widgets ?? []).map((w) =>
                          w.id !== pl.id
                            ? w
                            : w.mode === 'cell'
                              ? { ...w, mode: 'float' as const, x: cellOffset(w.r ?? 0, w.c ?? 0).x, y: cellOffset(w.r ?? 0, w.c ?? 0).y }
                              : { ...w, mode: 'cell' as const, ...(cellAtOffset(w.x ?? 0, w.y ?? 0) ?? { r: 0, c: 0 }) }
                        )
                      }))
                    }
                  >
                    {pl.mode === 'cell' ? 'In cell' : 'Floating'}
                  </button>
                  <button
                    className="ml-auto text-[10px] text-[var(--ink-40)] hover:text-rose-600 px-1"
                    // Removes the PLACEMENT only. The work widget is a file
                    // and stays in Files and on any desk holding it; this
                    // sheet simply stops showing it.
                    title="Remove from this sheet"
                    onClick={() =>
                      mutateTab((t) => ({ ...t, widgets: (t.widgets ?? []).filter((w) => w.id !== pl.id) }))
                    }
                  >
                    ×
                  </button>
                </div>
                <div style={{ height: pl.h - 20 }}>
                  <WidgetEmbed
                    widgetId={pl.widgetId}
                    display={pl.embedDisplay}
                    onDisplayChange={
                      readOnly
                        ? undefined
                        : (d) =>
                            mutateTab((t) => ({
                              ...t,
                              widgets: (t.widgets ?? []).map((w) => (w.id === pl.id ? { ...w, embedDisplay: d } : w))
                            }))
                    }
                  />
                </div>
              </div>
            )
          })}
          <SheetGrid
            tab={tab}
            selection={selection}
            active={focus}
            editing={editing}
            editValue={editValue}
            colWidthOf={colWidthOf}
            onEditValue={handleEditValue}
            onCellMouseDown={onCellMouseDown}
            onCellMouseEnter={onCellMouseEnter}
            onCellDoubleClick={(r, c) => startEdit({ r, c })}
            onCommitEdit={commitEdit}
            commitOnArrow={enterMode}
            onCancelEdit={() => { endPointMode(); setEditing(null) }}
            onFormulaArrow={handleFormulaArrow}
            pointCell={pointCell}
            onHeaderRename={(c, name) => mutateTab((t) => setColumnName(t, c, name))}
            readOnly={readOnly}
            onColResizeStart={onColResizeStart}
            onColAutoFit={onColAutoFit}
            rowHeightOf={rowHeightOf}
            onRowResizeStart={onRowResizeStart}
            onHeaderContextMenu={(c, x, y) => setColMenu({ c, x, y })}
            onSelectAll={selectAllCells}
            onColHeaderMouseDown={selectColumn}
            onColHeaderMouseEnter={colHeaderEnter}
            onRowHeaderMouseDown={selectRow}
            onRowHeaderMouseEnter={rowHeaderEnter}
            onRowHeaderContextMenu={(r, x, y) => setRowMenu({ r, x, y })}
            reorderOver={reorderOver}
            editInputRef={editInputRef}
            formulaRefMode={inFormulaEdit()}
            fillPreview={fillPreview}
            onFillStart={onFillStart}
            onFillToEnd={onFillToEnd}
            onSetCell={(r, c, v) => mutateTab((t) => setCell(t, r, c, v))}
            workbook={workbook}
            names={names}
            hiddenRows={hiddenRows}
            hiddenCols={hiddenCols}
            rowGroups={tab.rowGroups}
            colGroups={tab.colGroups}
            onToggleRowGroup={toggleRowGroup}
            onToggleColGroup={toggleColGroup}
            filterActive={tab.filterActive}
            filters={tab.filters}
            onSetColumnFilter={(c, hidden) =>
              mutateTab((t) => {
                const filters = { ...(t.filters ?? {}) }
                if (hidden.length) filters[c] = hidden
                else delete filters[c]
                return { ...t, filters }
              })
            }
          />
          {funcMenu && editInputRef.current && (
            <FormulaMenu
              rect={editInputRef.current.getBoundingClientRect()}
              menu={funcMenu}
              activeIndex={Math.min(funcIndex, funcMenu.items.length - 1)}
              onPick={(i) => applyFunc(funcMenu, i)}
            />
          )}
          {signature && editInputRef.current && (
            <SignatureHint
              rect={editInputRef.current.getBoundingClientRect()}
              hint={signature.hint}
              argIndex={signature.argIndex}
            />
          )}
        </div>

        {colMenu && (
          <HeaderMenu
            kind="col"
            x={colMenu.x}
            y={colMenu.y}
            canDelete={tab.columns.length > 1}
            onInsertBefore={() => { mutateTab((t) => insertColFixed(t, colMenu.c)); setColMenu(null) }}
            onInsertAfter={() => { mutateTab((t) => insertColFixed(t, colMenu.c + 1)); setColMenu(null) }}
            onDelete={() => { mutateTab((t) => deleteColFixed(t, colMenu.c)); setColMenu(null) }}
            freezeActive={(tab.freeze?.cols ?? 0) > 0}
            onFreeze={() => { mutateTab((t) => ({ ...t, freeze: { rows: t.freeze?.rows ?? 0, cols: colMenu.c + 1 } })); setColMenu(null) }}
            onUnfreeze={() => { mutateTab((t) => ({ ...t, freeze: { rows: t.freeze?.rows ?? 0, cols: 0 } })); setColMenu(null) }}
            canGroup={selection.c1 > selection.c0}
            grouped={colInGroup(colMenu.c)}
            onGroup={() => { groupCols(); setColMenu(null) }}
            onUngroup={() => { ungroupCols(colMenu.c); setColMenu(null) }}
            onClose={() => setColMenu(null)}
          />
        )}

        {cellMenu && (
          <CanvasContextMenu
            testid="sheet-cell-menu"
            x={cellMenu.x}
            y={cellMenu.y}
            onClose={() => setCellMenu(null)}
            // The same command definitions as the menu bar, ribbon and palette
            // (cellsCommands, through ctxRow): one label, hint and read-only
            // reason per action on every surface (SPEC §9.9; the 2e seam).
            items={objectMenu({
              cut: commands['sheet-cut'],
              copy: commands['sheet-copy'],
              paste: commands['sheet-paste'],
              saveAsSnippet: commands['sheet-save-snippet'],
              more: [
                ctxRow(commands['sheet-row-above']!),
                ctxRow(commands['sheet-row-below']!),
                ctxRow(commands['sheet-col-left']!),
                ctxRow(commands['sheet-col-right']!),
                { separator: true },
                ctxRow(commands['sheet-sort-asc']!),
                ctxRow(commands['sheet-sort-desc']!)
              ],
              del: commands['sheet-delete']
            })}
          />
        )}

        {rowMenu && (
          <HeaderMenu
            kind="row"
            x={rowMenu.x}
            y={rowMenu.y}
            canDelete={tab.rows.length > 1}
            onInsertBefore={() => { mutateTab((t) => insertRowFixed(t, rowMenu.r)); setRowMenu(null) }}
            onInsertAfter={() => { mutateTab((t) => insertRowFixed(t, rowMenu.r + 1)); setRowMenu(null) }}
            onDelete={() => { mutateTab((t) => deleteRowFixed(t, rowMenu.r)); setRowMenu(null) }}
            freezeActive={(tab.freeze?.rows ?? 0) > 0}
            onFreeze={() => { mutateTab((t) => ({ ...t, freeze: { cols: t.freeze?.cols ?? 0, rows: rowMenu.r + 1 } })); setRowMenu(null) }}
            onUnfreeze={() => { mutateTab((t) => ({ ...t, freeze: { cols: t.freeze?.cols ?? 0, rows: 0 } })); setRowMenu(null) }}
            canGroup={selection.r1 > selection.r0}
            grouped={rowInGroup(rowMenu.r)}
            onGroup={() => { groupRows(); setRowMenu(null) }}
            onUngroup={() => { ungroupRows(rowMenu.r); setRowMenu(null) }}
            onClose={() => setRowMenu(null)}
          />
        )}

        {moveConfirm && (
          <MoveConfirmDialog
            kind={moveConfirm.kind}
            onAutoFix={() => {
              const { kind, order, oldToNew } = moveConfirm
              mutateTab((t) =>
                kind === 'col'
                  ? fixFormulas(reorderColumns(t, order), idIndex, (c) => oldToNew[c] ?? c)
                  : fixFormulas(reorderRows(t, order), (r) => oldToNew[r] ?? r, idIndex)
              )
              setMoveConfirm(null)
            }}
            onMoveAnyway={() => {
              const { kind, order } = moveConfirm
              mutateTab((t) => (kind === 'col' ? reorderColumns(t, order) : reorderRows(t, order)))
              setMoveConfirm(null)
            }}
            onCancel={() => setMoveConfirm(null)}
          />
        )}

        <button
          onClick={() => mutateTab((t) => addRow(t))}
          className="mt-2 text-[12px] text-[var(--ink-50)] hover:text-accent inline-flex items-center gap-1"
        >
          <Icon name="add" size={14} /> Add row
        </button>

        {/* Charts */}
        {(tab.charts ?? []).length > 0 && (
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
            {tab.charts!.map((spec) => (
              <SheetChart key={spec.id} spec={spec} tab={tab} onRemove={() => removeChart(spec.id)} />
            ))}
          </div>
        )}

        {/* Pivots */}
        {(tab.pivots ?? []).length > 0 && (
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
            {tab.pivots!.map((spec) => (
              <SheetPivot
                key={spec.id}
                spec={spec}
                tab={tab}
                onRemove={() => removePivot(spec.id)}
                onUpdateSpec={(next) => updatePivot(spec.id, next)}
              />
            ))}
          </div>
        )}

        {pivotOpen && (
          <PivotDialog
            range={`${colLabel(selection.c0)}${selection.r0 + 1}:${colLabel(selection.c1)}${selection.r1 + 1}`}
            columns={Array.from({ length: selection.c1 - selection.c0 + 1 }, (_, i) => ({
              rel: i,
              label: tab.columns[selection.c0 + i] || colLabel(selection.c0 + i)
            }))}
            onCreate={insertPivot}
            onClose={() => setPivotOpen(false)}
          />
        )}

        {shortcutsOpen && <ShortcutsModal commands={commands} onClose={() => setShortcutsOpen(false)} />}

        {pageSetupOpen && (
          <PageSetupDialog
            // Read straight off the tab, so the dialog cannot disagree with what
            // will print — including after a structural edit moved the ranges.
            {...pageSetupOf(tab)}
            selectionA1={rangeToA1({ r1: selection.r0, c1: selection.c0, r2: selection.r1, c2: selection.c1 })}
            selectionRowsA1={rowsToA1({ r1: selection.r0, r2: selection.r1 })}
            // Through `commit`, so each change is undoable and a view-only sheet
            // writes nothing even if the dialog were somehow reached.
            onSetPrintArea={(a1) => commit(setPrintArea(body, idx, a1))}
            onSetRepeatRows={(a1) => commit(setRepeatRows(body, idx, a1))}
            onSetShowGridlines={(show) => commit(setShowGridlines(body, idx, show))}
            onClose={() => setPageSetupOpen(false)}
          />
        )}

        {lookupOpen && (
          <LookupDialog
            defaultKey={focus.c > 0 ? `${colLabel(focus.c - 1)}${focus.r + 1}` : ''}
            defaultTable={
              selection.c1 > selection.c0 || selection.r1 > selection.r0
                ? `${colLabel(selection.c0)}${selection.r0 + 1}:${colLabel(selection.c1)}${selection.r1 + 1}`
                : ''
            }
            target={`${colLabel(focus.c)}${focus.r + 1}`}
            onCreate={insertLookup}
            onClose={() => setLookupOpen(false)}
          />
        )}

        {macrosOpen && (
          <MacrosPanel
            onRun={async (code) => {
              const res = await runSheetScript(tab, code)
              if (!res.error) mutateTab(() => res.tab)
              return res
            }}
            onClose={() => setMacrosOpen(false)}
          />
        )}

        {queryOpen && (
          <QueryPanel
            columns={tab.columns}
            query={(tab.query as SheetQuery | undefined) ?? null}
            captureSource={() => ({ columns: tab.columns.slice(), rows: tab.rows.map((r) => r.slice()) })}
            onApply={(q) => {
              const out = applyQuery(q.source, q.steps)
              mutateTab((t) => ({ ...t, columns: out.columns, rows: out.rows, query: q }))
            }}
            onClose={() => setQueryOpen(false)}
          />
        )}
      </div>
    </CellsChrome>
  )
}

// Right-click on a column or row header: the kit's menu in the shared object
// shape (SPEC §9.3): insert on either side, freeze, group, then Delete last in
// the danger colour. Insert/delete reindex formula references (*Fixed helpers).
function HeaderMenu({
  kind,
  x,
  y,
  canDelete,
  onInsertBefore,
  onInsertAfter,
  onDelete,
  freezeActive,
  onFreeze,
  onUnfreeze,
  canGroup,
  grouped,
  onGroup,
  onUngroup,
  onClose
}: {
  kind: 'col' | 'row'
  x: number
  y: number
  canDelete: boolean
  onInsertBefore: () => void
  onInsertAfter: () => void
  onDelete: () => void
  freezeActive: boolean
  onFreeze: () => void
  onUnfreeze: () => void
  canGroup: boolean
  grouped: boolean
  onGroup: () => void
  onUngroup: () => void
  onClose: () => void
}): JSX.Element {
  const col = kind === 'col'
  const noun = col ? 'column' : 'row'
  const items: CtxMenuItem[] = joinGroups([
    [
      { label: col ? 'Insert column left' : 'Insert row above', icon: 'add', onClick: onInsertBefore },
      { label: col ? 'Insert column right' : 'Insert row below', icon: 'add', onClick: onInsertAfter }
    ],
    [
      { label: `Freeze up to this ${noun}`, icon: 'ac_unit', onClick: onFreeze },
      ...(freezeActive ? [{ label: `Unfreeze ${noun}s`, icon: 'close', onClick: onUnfreeze }] : [])
    ],
    [
      grouped
        ? { label: `Ungroup ${noun}s`, icon: 'unfold_more', onClick: onUngroup }
        : {
            label: `Group selected ${noun}s`,
            icon: 'unfold_less',
            onClick: onGroup,
            disabled: !canGroup,
            hint: canGroup ? undefined : `Select two or more ${noun}s first`
          }
    ],
    [
      {
        label: `Delete ${noun}`,
        icon: 'delete',
        danger: true,
        onClick: onDelete,
        disabled: !canDelete,
        hint: canDelete ? undefined : `A sheet keeps at least one ${noun}`
      }
    ]
  ])
  return <CanvasContextMenu testid={col ? 'sheet-col-menu' : 'sheet-row-menu'} x={x} y={y} items={items} onClose={onClose} />
}

// Shown when a drag-reorder would change formula results. Offers to auto-fix the
// references so the move is non-breaking, to move anyway (leaving formulas as
// written), or to cancel.
function MoveConfirmDialog({
  kind,
  onAutoFix,
  onMoveAnyway,
  onCancel
}: {
  kind: 'col' | 'row'
  onAutoFix: () => void
  onMoveAnyway: () => void
  onCancel: () => void
}): JSX.Element {
  const noun = kind === 'col' ? 'column' : 'row'
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="fb-scrim fixed inset-0 z-[130] flex items-center justify-center" onMouseDown={onCancel}>
      <div
        data-testid="sheet-move-confirm"
        className="fb-card w-[380px] p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-2">
          <Icon name="functions" size={16} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-[var(--ink-100)]">This move affects formulas</h3>
        </div>
        <p className="text-[12px] text-[var(--ink-60)] leading-relaxed">
          Moving this {noun} changes where some formulas point. You can auto-fix the references so
          every result stays the same, or move without changing the formula text.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-[12px] px-3 py-1.5 rounded-md text-[var(--ink-50)] hover:text-[var(--ink-80)]"
            data-testid="sheet-move-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onMoveAnyway}
            className="fb-btn-surface text-[12px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]"
            data-testid="sheet-move-anyway"
          >
            Move without fixing
          </button>
          <button
            onClick={onAutoFix}
            className="btn-primary text-[12px] px-3 py-1.5"
            data-testid="sheet-move-autofix"
          >
            Auto-fix &amp; move
          </button>
        </div>
      </div>
    </div>
  )
}

// A "lookup cell" builder. Collects a key, a table range, and which columns hold
// the match keys and the return values, then writes a real =XLOOKUP(...) into the
// active cell (the value recomputes live; nothing is copied or frozen).
function LookupDialog({
  defaultKey,
  defaultTable,
  target,
  onCreate,
  onClose
}: {
  defaultKey: string
  defaultTable: string
  target: string
  onCreate: (key: string, tableRange: string, matchCol: number, returnCol: number, ifMissing: string) => void
  onClose: () => void
}): JSX.Element {
  const [key, setKey] = useState(defaultKey)
  const [table, setTable] = useState(defaultTable)
  const [matchCol, setMatchCol] = useState('1')
  const [returnCol, setReturnCol] = useState('2')
  const [ifMissing, setIfMissing] = useState('')
  const field =
    'fb-field w-auto text-[12px] px-2 py-1.5'
  return (
    <div className="fb-scrim absolute inset-0 z-40 flex items-center justify-center" onMouseDown={onClose}>
      <div
        data-testid="sheet-lookup-dialog"
        className="fb-card w-[440px] max-w-[92%] p-4 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="search" size={15} className="text-accent" />
          Lookup a value
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="text-[11px] text-[var(--ink-50)]">
          Writes <span className="font-mono text-[var(--ink-70)]">=XLOOKUP(…)</span> into{' '}
          <span className="font-mono text-[var(--ink-70)]">{target}</span>. It looks the key up in the
          match column of the table and returns the matching return-column value, recomputing live.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-[var(--ink-60)]">
            Look up this key
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. A2 or 42" data-testid="lookup-key" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--ink-60)]">
            In this table range
            <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="e.g. A2:C50" data-testid="lookup-table" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--ink-60)]">
            Match column (in table)
            <input value={matchCol} onChange={(e) => setMatchCol(e.target.value)} type="number" min="1" data-testid="lookup-matchcol" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--ink-60)]">
            Return column (in table)
            <input value={returnCol} onChange={(e) => setReturnCol(e.target.value)} type="number" min="1" data-testid="lookup-returncol" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--ink-60)] col-span-2">
            If not found (optional)
            <input value={ifMissing} onChange={(e) => setIfMissing(e.target.value)} placeholder="leave blank for an error" className={field} />
          </label>
        </div>
        <div className="flex">
          <button
            onClick={() => onCreate(key, table, Number(matchCol) || 1, Number(returnCol) || 2, ifMissing)}
            data-testid="lookup-create"
            disabled={!key.trim() || !table.trim()}
            className="btn-primary ml-auto text-[12px] px-3 py-1.5 disabled:opacity-40"
          >
            Insert lookup
          </button>
        </div>
      </div>
    </div>
  )
}

// The Macros panel: write a JavaScript macro with a main(sheet) function and run
// it against the active tab. The result applies through the normal undo path;
// logs and any error are shown honestly (the sheet is untouched on error).
const MACRO_EXAMPLE = `// Double column A into column B for every row.
function main(sheet) {
  for (let r = 0; r < sheet.rowCount(); r++) {
    const n = Number(sheet.getValue(r, 0))
    if (!Number.isNaN(n)) sheet.setValue(r, 1, n * 2)
  }
  sheet.log('Updated', sheet.rowCount(), 'rows')
}`

function MacrosPanel({
  onRun,
  onClose
}: {
  onRun: (code: string) => Promise<SheetScriptResult>
  onClose: () => void
}): JSX.Element {
  const [code, setCode] = useState(MACRO_EXAMPLE)
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ran, setRan] = useState(false)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fb-scrim absolute inset-0 z-40 flex items-center justify-center" onMouseDown={onClose}>
      <div
        data-testid="sheet-macros-panel"
        className="fb-card w-[560px] max-w-[94%] p-4 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="code" size={15} className="text-accent" />
          Macros
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="text-[11px] text-[var(--ink-50)]">
          Automate this sheet with a script. Define <span className="font-mono">main(sheet)</span> and
          use <span className="font-mono">sheet.getValue / setValue / getColumn / setRange / addRow /
          addColumn / log</span>. It runs on this tab and applies with a single undo.
        </p>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          data-testid="macros-code"
          className="fb-field w-full h-56 font-mono text-[12px] p-2.5 resize-none"
        />
        {error && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-[12px] text-rose-500" data-testid="macros-error">
            {error}
          </div>
        )}
        {ran && !error && (
          <div className="rounded-md bg-[var(--surface-sunken)] px-2.5 py-2 text-[12px] text-[var(--ink-70)]" data-testid="macros-logs">
            {logs.length ? logs.map((l, i) => <div key={i} className="font-mono">{l}</div>) : 'Ran — no output logged.'}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md text-[var(--ink-50)] hover:text-[var(--ink-80)]">
            Close
          </button>
          <button
            data-testid="macros-run"
            className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1 disabled:opacity-50"
            disabled={running}
            onClick={async () => {
              setRunning(true)
              try {
                const res = await onRun(code)
                setError(res.error)
                setLogs(res.logs)
                setRan(true)
              } finally {
                setRunning(false)
              }
            }}
          >
            <Icon name="play_arrow" size={14} /> {running ? 'Running…' : 'Run macro'}
          </button>
        </div>
      </div>
    </div>
  )
}

// The Power-Query panel: turn the current sheet into a refreshable SOURCE, then
// stack transform STEPS (filter, sort, drop/keep/rename columns, dedupe, keep-top,
// skip, promote-headers, trim, change-case) that shape the output non-destructively.
// Editing a step re-applies the whole pipeline immediately; Refresh re-runs it.
const QUERY_OPS: Array<{ v: SheetCondOp; label: string }> = [
  { v: 'eq', label: 'equals' },
  { v: 'ne', label: 'does not equal' },
  { v: 'contains', label: 'contains' },
  { v: 'gt', label: '>' },
  { v: 'ge', label: '>=' },
  { v: 'lt', label: '<' },
  { v: 'le', label: '<=' },
  { v: 'notEmpty', label: 'is not empty' },
  { v: 'empty', label: 'is empty' }
]
const QUERY_KINDS: Array<{ v: QueryStep['kind']; label: string }> = [
  { v: 'filter', label: 'Filter rows' },
  { v: 'sort', label: 'Sort' },
  { v: 'removeColumns', label: 'Remove column' },
  { v: 'keepColumns', label: 'Keep only column' },
  { v: 'rename', label: 'Rename column' },
  { v: 'removeDuplicates', label: 'Remove duplicate rows' },
  { v: 'keepTop', label: 'Keep top N rows' },
  { v: 'skip', label: 'Skip first N rows' },
  { v: 'promoteHeaders', label: 'Use first row as headers' },
  { v: 'trim', label: 'Trim column whitespace' },
  { v: 'changeCase', label: 'Change column case' }
]

function QueryPanel({
  columns,
  query,
  captureSource,
  onApply,
  onClose
}: {
  columns: string[]
  query: SheetQuery | null
  captureSource: () => QueryTable
  onApply: (q: SheetQuery) => void
  onClose: () => void
}): JSX.Element {
  const [q, setQ] = useState<SheetQuery | null>(query)
  const [kind, setKind] = useState<QueryStep['kind']>('filter')
  const [col, setCol] = useState(0)
  const [op, setOp] = useState<SheetCondOp>('eq')
  const [value, setValue] = useState('')
  const [n, setN] = useState(10)
  const [name, setName] = useState('')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [to, setTo] = useState<'upper' | 'lower'>('upper')

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The shape the NEXT step will see: source folded through the current steps.
  const preview = q ? applyQuery(q.source, q.steps) : { columns, rows: [] }
  const pickCols = preview.columns.length ? preview.columns : columns

  function commit(next: SheetQuery): void {
    setQ(next)
    onApply(next)
  }

  function buildStep(): QueryStep | null {
    const c = Math.max(0, Math.min(col, Math.max(0, pickCols.length - 1)))
    switch (kind) {
      case 'filter':
        return { kind, col: c, op, value: op === 'empty' || op === 'notEmpty' ? undefined : value }
      case 'sort':
        return { kind, col: c, dir }
      case 'removeColumns':
        return { kind, cols: [c] }
      case 'keepColumns':
        return { kind, cols: [c] }
      case 'rename':
        return name.trim() ? { kind, col: c, name: name.trim() } : null
      case 'removeDuplicates':
        return { kind }
      case 'keepTop':
        return { kind, n: Math.max(0, n) }
      case 'skip':
        return { kind, n: Math.max(0, n) }
      case 'promoteHeaders':
        return { kind }
      case 'trim':
        return { kind, col: c }
      case 'changeCase':
        return { kind, col: c, to }
    }
  }

  function addStep(): void {
    if (!q) return
    const step = buildStep()
    if (!step) return
    commit({ source: q.source, steps: [...q.steps, step] })
  }
  function removeStep(i: number): void {
    if (!q) return
    commit({ source: q.source, steps: q.steps.filter((_, j) => j !== i) })
  }
  function moveStep(i: number, delta: number): void {
    if (!q) return
    const j = i + delta
    if (j < 0 || j >= q.steps.length) return
    const steps = q.steps.slice()
    ;[steps[i], steps[j]] = [steps[j], steps[i]]
    commit({ source: q.source, steps })
  }

  const needsCol = kind === 'filter' || kind === 'sort' || kind === 'removeColumns' || kind === 'keepColumns' || kind === 'rename' || kind === 'trim' || kind === 'changeCase'
  const sel = 'fb-field w-auto h-7 text-[12px] px-1.5 text-[var(--ink-70)]'

  return (
    <div className="fb-scrim absolute inset-0 z-40 flex items-center justify-center" onMouseDown={onClose}>
      <div
        data-testid="sheet-query-panel"
        className="fb-card w-[560px] max-w-[94%] p-4 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="account_tree" size={15} className="text-accent" />
          Query
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        {!q ? (
          <>
            <p className="text-[11px] text-[var(--ink-50)]">
              A query takes a snapshot of this sheet as its source, then shapes it with an ordered
              list of steps. The steps never touch the source, so you can refresh or reorder them
              at any time.
            </p>
            <button
              data-testid="query-capture"
              className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1"
              onClick={() => commit({ source: captureSource(), steps: [] })}
            >
              <Icon name="add" size={14} /> Use this sheet as the source
            </button>
          </>
        ) : (
          <>
            <p className="text-[11px] text-[var(--ink-50)]">
              Source: {q.source.columns.length} columns, {q.source.rows.length} rows. Output after{' '}
              {q.steps.length} step{q.steps.length === 1 ? '' : 's'}: {preview.columns.length} columns,{' '}
              {preview.rows.length} rows.
            </p>

            <div className="rounded-md bg-[var(--surface-sunken)] divide-y divide-[var(--edge-soft)]" data-testid="query-steps">
              {q.steps.length === 0 && (
                <div className="px-2.5 py-2 text-[12px] text-[var(--ink-40)]">No steps yet. Add one below.</div>
              )}
              {q.steps.map((s, i) => (
                <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]" data-testid={`query-step-${i}`}>
                  <span className="text-[var(--ink-40)] font-mono w-4">{i + 1}</span>
                  <span className="flex-1 text-[var(--ink-70)]">{stepLabel(s, i === 0 ? q.source.columns : applyQuery(q.source, q.steps.slice(0, i)).columns)}</span>
                  <button className="icon-btn" title="Move up" onClick={() => moveStep(i, -1)} disabled={i === 0}>
                    <Icon name="arrow_upward" size={13} />
                  </button>
                  <button className="icon-btn" title="Move down" onClick={() => moveStep(i, 1)} disabled={i === q.steps.length - 1}>
                    <Icon name="arrow_downward" size={13} />
                  </button>
                  <button className="icon-btn" title="Remove step" data-testid={`query-remove-${i}`} onClick={() => removeStep(i)}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap rounded-md bg-[var(--surface-sunken)] p-2">
              <select className={sel} data-testid="query-kind" value={kind} onChange={(e) => setKind(e.target.value as QueryStep['kind'])}>
                {QUERY_KINDS.map((k) => (
                  <option key={k.v} value={k.v}>{k.label}</option>
                ))}
              </select>
              {needsCol && (
                <select className={sel} data-testid="query-col" value={col} onChange={(e) => setCol(Number(e.target.value))}>
                  {pickCols.map((c, i) => (
                    <option key={i} value={i}>{c || `Col ${i + 1}`}</option>
                  ))}
                </select>
              )}
              {kind === 'filter' && (
                <>
                  <select className={sel} data-testid="query-op" value={op} onChange={(e) => setOp(e.target.value as SheetCondOp)}>
                    {QUERY_OPS.map((o) => (
                      <option key={o.v} value={o.v}>{o.label}</option>
                    ))}
                  </select>
                  {op !== 'empty' && op !== 'notEmpty' && (
                    <input className={sel + ' w-24'} data-testid="query-value" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
                  )}
                </>
              )}
              {kind === 'sort' && (
                <select className={sel} value={dir} onChange={(e) => setDir(e.target.value as 'asc' | 'desc')}>
                  <option value="asc">ascending</option>
                  <option value="desc">descending</option>
                </select>
              )}
              {kind === 'rename' && (
                <input className={sel + ' w-28'} data-testid="query-name" placeholder="new name" value={name} onChange={(e) => setName(e.target.value)} />
              )}
              {(kind === 'keepTop' || kind === 'skip') && (
                <input className={sel + ' w-16'} type="number" data-testid="query-n" value={n} onChange={(e) => setN(Number(e.target.value))} />
              )}
              {kind === 'changeCase' && (
                <select className={sel} value={to} onChange={(e) => setTo(e.target.value as 'upper' | 'lower')}>
                  <option value="upper">UPPERCASE</option>
                  <option value="lower">lowercase</option>
                </select>
              )}
              <button className="btn-ghost text-[12px] px-2.5 py-1 inline-flex items-center gap-1 ml-auto" data-testid="query-add" onClick={addStep}>
                <Icon name="add" size={13} /> Add step
              </button>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md text-[var(--ink-50)] hover:text-[var(--ink-80)]">
                Close
              </button>
              <button
                data-testid="query-refresh"
                className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1"
                onClick={() => commit({ source: captureSource(), steps: q.steps })}
              >
                <Icon name="refresh" size={14} /> Refresh from sheet
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// The formula function menu, anchored just under the cell being edited. Buttons
// use onMouseDown + preventDefault so picking one does not blur the edit input
// (a blur would commit the half-typed formula).
function FormulaMenu({
  rect,
  menu,
  activeIndex,
  onPick
}: {
  rect: DOMRect
  menu: FuncMenu
  activeIndex: number
  onPick: (index: number) => void
}): JSX.Element {
  const top = Math.min(rect.bottom + 2, window.innerHeight - 240)
  const left = Math.min(rect.left, window.innerWidth - 280)
  return (
    <div
      data-testid="sheet-formula-menu"
      className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fixed z-[120] w-[268px] max-h-[230px] overflow-auto py-1 text-[var(--ink-70)]"
      style={{ top, left }}
    >
      {menu.items.map((f, i) => (
        <button
          key={f.name}
          data-testid={`sheet-func-${f.name}`}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(i)
          }}
          className={`w-full text-left px-3 py-1.5 ${
            i === activeIndex ? 'bg-accent/15' : 'hover:bg-[var(--surface-sunken)]'
          }`}
        >
          <span className="font-mono text-[12px] font-semibold text-accent">{f.name}</span>
          <span className="block text-[11px] text-[var(--ink-50)] truncate">{f.hint}</span>
        </button>
      ))}
    </div>
  )
}

// Signature help shown under the edit input while the caret is inside a
// function's parentheses. Parses the catalog hint "NAME(p1, p2, [p3]) — desc"
// and bolds the parameter matching the current argument position.
function SignatureHint({
  rect,
  hint,
  argIndex
}: {
  rect: DOMRect
  hint: string
  argIndex: number
}): JSX.Element {
  const top = Math.min(rect.bottom + 2, window.innerHeight - 80)
  const left = Math.min(rect.left, window.innerWidth - 340)
  const m = hint.match(/^([A-Za-z0-9_]+)\((.*?)\)(.*)$/)
  const params = m ? m[2].split(',').map((s) => s.trim()) : []
  return (
    <div
      data-testid="sheet-signature"
      className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fixed z-[120] max-w-[340px] px-3 py-1.5 text-[12px] text-[var(--ink-60)]"
      style={{ top, left }}
    >
      {m ? (
        <span className="font-mono">
          <span className="text-accent font-semibold">{m[1]}</span>
          <span>(</span>
          {params.map((p, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <span
                className={
                  i === argIndex
                    ? 'text-[var(--ink-100)] font-semibold'
                    : 'text-[var(--ink-50)]'
                }
              >
                {p}
              </span>
            </span>
          ))}
          <span>)</span>
        </span>
      ) : (
        <span className="font-mono text-[var(--ink-70)]">{hint}</span>
      )}
    </div>
  )
}
