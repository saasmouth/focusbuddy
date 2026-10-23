// The spreadsheet grid surface. Cells render as divs (fast), with a single
// floating <input> mounted over the cell being edited (the Excel model). It owns
// no data: selection, the active/editing cell, and all mutations are driven by
// SheetEditor through props. Formatting (bold/colour/align/number format) is
// applied per cell from the tab's sparse format map.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SheetTab } from '@shared/types'
import { displayCell, buildSpillMap, sparklineForCell, type Grid, type Workbook } from '../../../lib/sheetFormula'
import { formatValue } from '../../../lib/sheetFormat'
import { cellFormat, colLabel } from '../../../lib/sheetBody'
import {
  applyCondFormat,
  validationForCell,
  valueIsValid,
  distinctValues,
  isVisualCond,
  condNumber,
  colorScaleColor,
  dataBarPct,
  iconForValue,
  parseA1Range,
  rangeHas
} from '../../../lib/sheetCond'
import Icon from '../../Icon'
import { loadGoogleFont, familyLabel } from '../../../lib/googleFonts'
import type { CellRange } from './sheetOps'

interface Props {
  tab: SheetTab
  selection: CellRange | null
  active: { r: number; c: number } | null
  editing: { r: number; c: number } | null
  editValue: string
  colWidthOf: (c: number) => number
  rowHeightOf?: (r: number) => number
  onRowResizeStart?: (r: number, e: React.MouseEvent) => void
  onEditValue: (v: string) => void
  onCellMouseDown: (r: number, c: number, shift: boolean) => void
  onCellMouseEnter: (r: number, c: number) => void
  onCellDoubleClick: (r: number, c: number) => void
  onCommitEdit: (move: 'up' | 'down' | 'left' | 'right' | 'none') => void
  // When true, the edit began by typing over the cell (Excel "enter mode"), so an
  // arrow key commits the value and moves that direction. When false (F2 / double-
  // click), arrows move the text caret instead.
  commitOnArrow?: boolean
  onCancelEdit: () => void
  onHeaderRename: (c: number, name: string) => void
  /**
   * A reader, not an editor. The grid's one always-mounted input is the column
   * header rename; the cell editor is rendered only while editing, which a
   * read-only SheetEditor never starts. The rename already wrote nothing — it
   * goes through the guarded commit — but a caret that takes typing and snaps
   * back is the app pretending, so the input is made read-only too.
   */
  readOnly?: boolean
  onColResizeStart: (c: number, e: React.MouseEvent) => void
  onColAutoFit?: (c: number) => void
  onHeaderContextMenu: (c: number, x: number, y: number) => void
  // When editing a formula, clicking another cell inserts its reference instead
  // of moving the selection. The parent exposes the edit input (so it can read
  // the caret and write the ref) and tells the grid it is in reference mode (so
  // a cell click keeps the input focused rather than blurring + committing).
  editInputRef?: React.MutableRefObject<HTMLInputElement | null>
  formulaRefMode?: boolean
  // Arrow-key cell referencing while editing a formula (Excel point mode). The
  // parent returns true when it consumed the arrow. `pointCell` is the cell it is
  // currently pointing at, drawn with a dashed outline.
  onFormulaArrow?: (dir: 'up' | 'down' | 'left' | 'right', shift: boolean) => boolean
  pointCell?: { r: number; c: number } | null
  // Excel-style header selection. Clicking the top-left corner selects the whole
  // grid; clicking a column letter or a row number selects that column/row, and
  // dragging across headers (or shift-clicking) extends the selection.
  onSelectAll?: () => void
  onColHeaderMouseDown?: (c: number, shift: boolean) => void
  onColHeaderMouseEnter?: (c: number) => void
  onRowHeaderMouseDown?: (r: number, shift: boolean) => void
  onRowHeaderMouseEnter?: (r: number) => void
  onRowHeaderContextMenu?: (r: number, x: number, y: number) => void
  // The live drop-target while a header is being dragged to reorder it.
  reorderOver?: { kind: 'col' | 'row'; over: number } | null
  // The fill handle: a live preview rectangle while dragging it, a start hook
  // (mousedown on the handle), and a fill-to-end hook (double-click the handle).
  fillPreview?: CellRange | null
  onFillStart?: () => void
  onFillToEnd?: () => void
  // Directly set a cell value (used by the data-validation in-cell dropdown).
  onSetCell?: (r: number, c: number, value: string) => void
  // The whole workbook, so cross-sheet references (Sheet2!A1) resolve at render.
  workbook?: Workbook
  // Named ranges the formula engine resolves (e.g. =SUM(Revenue)).
  names?: Map<string, string>
  // Column filters: rows to hide, whether funnels show, the current per-column
  // hide-sets, and a setter. SheetGrid owns the funnel dropdown UI.
  hiddenRows?: Set<number> | null
  hiddenCols?: Set<number> | null
  filterActive?: boolean
  filters?: Record<number, string[]>
  onSetColumnFilter?: (c: number, hidden: string[]) => void
  // Outline groups: a collapse/expand chevron shows on each group's first
  // row/column header; toggling hides or reveals the members.
  rowGroups?: Array<{ start: number; end: number; collapsed: boolean }>
  colGroups?: Array<{ start: number; end: number; collapsed: boolean }>
  onToggleRowGroup?: (groupIndex: number) => void
  onToggleColGroup?: (groupIndex: number) => void
}

export const ROW_HEADER_W = 44
// The column-label header row is a fixed height so frozen-row sticky offsets are
// deterministic. (The old note here said DEFAULT_ROW_PX mirrored the editor's
// 0.75cm default, which is ~28px — that described the pre-b63d8053 value and
// contradicted the line below it.)
export const HEADER_H = 30
export const DEFAULT_ROW_PX = 20 // Excel default row height (15pt at 96dpi)

function inRange(range: CellRange | null, r: number, c: number): boolean {
  if (!range) return false
  return r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
}

export default function SheetGrid(props: Props): JSX.Element {
  const { tab, selection, active, editing } = props
  const grid: Grid = { columns: tab.columns, rows: tab.rows }
  const maxR = tab.rows.length - 1
  const maxC = tab.columns.length - 1
  // A column/row header reads as "selected" (tinted) when the selection spans the
  // full height/width over it, matching Excel's highlighted headers.
  const colFullySelected = (c: number): boolean =>
    !!selection && selection.r0 === 0 && selection.r1 === maxR && c >= selection.c0 && c <= selection.c1
  const rowFullySelected = (r: number): boolean =>
    !!selection && selection.c0 === 0 && selection.c1 === maxC && r >= selection.r0 && r <= selection.r1

  // Freeze panes. freeze.cols / freeze.rows are counts of leading data columns /
  // rows that stay pinned while the rest scrolls. The column-label header row is
  // always pinned to the top and the row-number column to the left; these add
  // frozen DATA lines on top of that. Offsets are cumulative so a frozen line
  // sits flush against the previous one (header row is a fixed height).
  const fCols = Math.min(tab.freeze?.cols ?? 0, maxC + 1)
  const fRows = Math.min(tab.freeze?.rows ?? 0, maxR + 1)
  const colLeft = (c: number): number => {
    let x = ROW_HEADER_W
    // Collapsed (hidden) columns are not rendered, so they must not add to the
    // sticky-left offset of a frozen column or a gap opens up.
    for (let i = 0; i < c; i++) if (!props.hiddenCols?.has(i)) x += props.colWidthOf(i)
    return x
  }
  const rowTop = (r: number): number => {
    let y = HEADER_H
    for (let i = 0; i < r; i++) if (!props.hiddenRows?.has(i)) y += props.rowHeightOf?.(i) ?? DEFAULT_ROW_PX
    return y
  }
  // The outline-group (if any) that starts on a given row/column, so its header
  // can carry the collapse/expand chevron. -1 when none starts there.
  const rowGroupAt = (r: number): number => (props.rowGroups ?? []).findIndex((g) => g.start === r)
  const colGroupAt = (c: number): number => (props.colGroups ?? []).findIndex((g) => g.start === c)
  // Spill map for array formulas (SEQUENCE/UNIQUE/SORT/FILTER/TRANSPOSE), built
  // once per data change rather than per cell. Drives both the anchor's value and
  // the cells the result spills into.
  const spill = useMemo(
    () => buildSpillMap({ columns: tab.columns, rows: tab.rows }, props.workbook, props.names),
    [tab.columns, tab.rows, props.workbook, props.names]
  )
  // Merged cells: the top-left anchor spans its range (colSpan/rowSpan on the
  // native table cell); the covered cells are not rendered.
  const { mergeCovered, mergeAnchor } = useMemo(() => {
    const covered = new Set<string>()
    const anchor = new Map<string, { rowSpan: number; colSpan: number }>()
    for (const m of tab.merges ?? []) {
      anchor.set(`${m.r1},${m.c1}`, { rowSpan: m.r2 - m.r1 + 1, colSpan: m.c2 - m.c1 + 1 })
      for (let r = m.r1; r <= m.r2; r++)
        for (let c = m.c1; c <= m.c2; c++) if (!(r === m.r1 && c === m.c1)) covered.add(`${r},${c}`)
    }
    return { mergeCovered: covered, mergeAnchor: anchor }
  }, [tab.merges])
  // Range extents for colour-scale / data-bar / icon-set rules, computed once per
  // data change so each cell can map its value onto the range's min..max.
  const condStats = useMemo(() => {
    const g: Grid = { columns: tab.columns, rows: tab.rows }
    return (tab.condRules ?? []).filter(isVisualCond).map((rule) => {
      const rg = parseA1Range(rule.range)
      let min = Infinity
      let max = -Infinity
      if (rg) {
        for (let r = rg.r1; r <= rg.r2; r++) {
          for (let c = rg.c1; c <= rg.c2; c++) {
            const n = condNumber(displayCell(g, r, c, props.workbook, spill, props.names))
            if (n !== null) {
              if (n < min) min = n
              if (n > max) max = n
            }
          }
        }
      }
      return { rule, min, max, ok: min <= max }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.condRules, tab.columns, tab.rows, props.workbook, props.names, spill])
  const editRef = useRef<HTMLInputElement | null>(null)
  // Which cell's data-validation list dropdown is open (null = none).
  const [openList, setOpenList] = useState<{ r: number; c: number } | null>(null)
  // Which column header's filter funnel dropdown is open (null = none).
  const [openFilter, setOpenFilter] = useState<number | null>(null)

  useEffect(() => {
    if (editing) editRef.current?.focus()
  }, [editing])

  // The table's own width must equal the sum of the row-header + every visible
  // column, otherwise a fixed-layout table with no explicit width collapses the
  // columns to fit the container (making Excel-width cells render as narrow
  // squares). With this, columns keep their real widths and the grid scrolls.
  const totalGridWidth = useMemo(() => {
    let w = ROW_HEADER_W
    for (let c = 0; c < tab.columns.length; c++) if (!props.hiddenCols?.has(c)) w += props.colWidthOf(c)
    return w
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.columns.length, props.colWidthOf, props.hiddenCols])

  return (
    <div
      className="fb-card h-full overflow-auto"
      data-testid="sheet-grid"
    >
      <table className="border-collapse text-[13px]" style={{ tableLayout: 'fixed', width: totalGridWidth }}>
        <colgroup>
          <col style={{ width: ROW_HEADER_W }} />
          {tab.columns.map((_, c) =>
            props.hiddenCols?.has(c) ? null : <col key={c} style={{ width: props.colWidthOf(c) }} />
          )}
        </colgroup>
        <thead>
          <tr className="sticky top-0 z-20" style={{ height: HEADER_H }}>
            <th
              data-testid="sheet-select-all"
              title="Select all cells"
              onMouseDown={(e) => {
                e.preventDefault()
                props.onSelectAll?.()
              }}
              className="sticky left-0 z-30 bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)] border-b border-[var(--edge-firm)] border-r border-[var(--edge-soft)] cursor-pointer hover:bg-accent/10 transition-colors"
            />
            {tab.columns.map((col, c) => {
              if (props.hiddenCols?.has(c)) return null
              const cGroup = colGroupAt(c)
              return (
              <th
                key={c}
                data-testid={`col-header-${c}`}
                onContextMenu={(e) => {
                  e.preventDefault()
                  props.onHeaderContextMenu(c, e.clientX, e.clientY)
                }}
                style={c < fCols ? { position: 'sticky', left: colLeft(c), zIndex: 25 } : undefined}
                className={`relative border-b border-[var(--edge-firm)] border-r p-0 transition-colors ${
                  c === fCols - 1 ? 'border-r-2 border-r-[var(--edge-firm)]' : 'border-[var(--edge-soft)]'
                } ${
                  colFullySelected(c) ? 'bg-accent/20' : 'bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)]'
                } ${props.reorderOver?.kind === 'col' && props.reorderOver.over === c ? 'shadow-[inset_2px_0_0_0_var(--accent)]' : ''}`}
              >
                <div className="flex items-center">
                  {cGroup >= 0 && (
                    <button
                      data-testid={`col-group-toggle-${c}`}
                      title={props.colGroups?.[cGroup]?.collapsed ? 'Expand group' : 'Collapse group'}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        props.onToggleColGroup?.(cGroup)
                      }}
                      className="pl-0.5 text-[9px] text-[var(--ink-40)] hover:text-accent leading-none"
                    >
                      {props.colGroups?.[cGroup]?.collapsed ? '▸' : '▾'}
                    </button>
                  )}
                  <span
                    data-testid={`col-select-${c}`}
                    title="Click to select column · drag to select several"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      props.onColHeaderMouseDown?.(c, e.shiftKey)
                    }}
                    onMouseEnter={() => props.onColHeaderMouseEnter?.(c)}
                    className="px-1.5 text-[10px] text-[var(--ink-40)] select-none cursor-pointer hover:text-accent"
                  >
                    {colLabel(c)}
                  </span>
                  <input
                    value={col}
                    readOnly={props.readOnly}
                    onChange={(e) => props.onHeaderRename(c, e.target.value)}
                    className="w-full bg-transparent px-1 py-1.5 text-[12px] font-semibold text-stone-700 dark:text-stone-200 min-w-0"
                  />
                </div>
                {/* Column resize handle. Drag to set the width (which drives the
                    sheet's total width); double-click to auto-fit to content. */}
                <span
                  onMouseDown={(e) => props.onColResizeStart(c, e)}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    props.onColAutoFit?.(c)
                  }}
                  title="Drag to resize · double-click to fit"
                  className="absolute top-0 right-0 h-full w-[8px] translate-x-1/2 z-20 cursor-col-resize hover:bg-accent/40"
                />
                {/* Filter funnel (Data > Create a filter). Highlighted when this
                    column has an active filter. */}
                {props.filterActive && (
                  <button
                    data-testid={`col-filter-${c}`}
                    title="Filter this column"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setOpenFilter(openFilter === c ? null : c)
                    }}
                    className={`absolute right-1.5 top-1/2 -translate-y-1/2 z-10 ${
                      props.filters?.[c]?.length
                        ? 'text-accent'
                        : 'text-[var(--ink-40)] hover:text-[var(--ink-70)]'
                    }`}
                  >
                    <Icon name="filter_alt" size={13} />
                  </button>
                )}
                {props.filterActive && openFilter === c && (
                  <FilterDropdown
                    values={distinctValues(
                      tab.rows.map((_, r) => displayCell(grid, r, c, props.workbook, spill, props.names))
                    )}
                    hidden={props.filters?.[c] ?? []}
                    onApply={(hidden) => {
                      props.onSetColumnFilter?.(c, hidden)
                    }}
                    onClose={() => setOpenFilter(null)}
                  />
                )}
              </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {tab.rows.map((_row, r) => {
            // Filtered-out rows are not rendered, but r stays the true data index
            // so selection, fill, and every formula reference are unaffected.
            if (props.hiddenRows?.has(r)) return null
            return (
            <tr key={r} className="group" style={{ height: props.rowHeightOf?.(r) }}>
              <td
                data-testid={`row-header-${r}`}
                title="Click to select row · drag to select several · right-click for options"
                onMouseDown={(e) => {
                  e.preventDefault()
                  props.onRowHeaderMouseDown?.(r, e.shiftKey)
                }}
                onMouseEnter={() => props.onRowHeaderMouseEnter?.(r)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  props.onRowHeaderContextMenu?.(r, e.clientX, e.clientY)
                }}
                style={r < fRows ? { position: 'sticky', top: rowTop(r), left: 0, zIndex: 25 } : undefined}
                className={`relative sticky left-0 z-10 text-center text-[11px] text-[var(--ink-40)] border-r border-[var(--edge-soft)] select-none cursor-pointer hover:text-accent transition-colors ${
                  r === fRows - 1 ? 'border-b-2 border-b-[var(--edge-firm)]' : 'border-b border-[var(--edge-soft)]'
                } ${rowFullySelected(r) ? 'bg-accent/20' : 'bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)]'} ${
                  props.reorderOver?.kind === 'row' && props.reorderOver.over === r ? 'shadow-[inset_0_2px_0_0_var(--accent)]' : ''
                }`}
              >
                {rowGroupAt(r) >= 0 && (
                  <button
                    data-testid={`row-group-toggle-${r}`}
                    title={props.rowGroups?.[rowGroupAt(r)]?.collapsed ? 'Expand group' : 'Collapse group'}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      props.onToggleRowGroup?.(rowGroupAt(r))
                    }}
                    className="absolute left-0.5 top-1/2 -translate-y-1/2 text-[9px] text-[var(--ink-40)] hover:text-accent leading-none"
                  >
                    {props.rowGroups?.[rowGroupAt(r)]?.collapsed ? '▸' : '▾'}
                  </button>
                )}
                {r + 1}
                {/* Drag the bottom edge to resize the row height. */}
                {props.onRowResizeStart && (
                  <span
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      props.onRowResizeStart?.(r, e)
                    }}
                    title="Drag to resize row"
                    // Sits INSIDE its own header cell. It used to carry
                    // `translate-y-1/2`, which pushed half of it across the row
                    // boundary — and because this span's z-20 lives inside a
                    // `sticky z-10` <td>, it cannot paint above the NEXT row's
                    // header, which is a sibling at the same z-10. So the strip
                    // centred on the boundary was covered by row r+1 and only
                    // the 3px above the line could be grabbed. Keeping it in
                    // its own cell makes the whole 6px reachable.
                    className="absolute bottom-0 left-0 right-0 h-[6px] z-20 cursor-row-resize hover:bg-accent/40"
                  />
                )}
              </td>
              {tab.columns.map((_, c) => {
                if (props.hiddenCols?.has(c)) return null
                // A cell covered by a merge is not drawn; the anchor spans it.
                if (mergeCovered.has(`${r},${c}`)) return null
                const mergeSpan = mergeAnchor.get(`${r},${c}`)
                const isActive = active?.r === r && active?.c === c
                const isEditing = editing?.r === r && editing?.c === c
                const selected = inRange(selection, r, c)
                const inFillPreview = inRange(props.fillPreview ?? null, r, c) && !selected
                // The fill handle sits on the bottom-right cell of the selection.
                const showHandle =
                  !isEditing &&
                  !!selection &&
                  !!props.onFillStart &&
                  r === selection.r1 &&
                  c === selection.c1
                const computed = displayCell(grid, r, c, props.workbook, spill, props.names)
                // A =SPARKLINE(...) cell is drawn as a mini chart instead of text.
                // Only a cell that holds the formula qualifies (sparklineForCell
                // returns null for empty/spilled cells), so nothing else can be
                // mistaken for a sparkline.
                const sparkline = sparklineForCell(grid, r, c, props.workbook, props.names)
                // A spilled cell shows a value an array formula produced in a
                // neighbour, while its own raw is empty — rendered muted so it
                // reads as computed, not typed.
                const isSpilled = (tab.rows[r]?.[c] ?? '').trim() === '' && spill.has(`${r},${c}`)
                // Base cell format, then overlay any matching conditional-format
                // rule (paint only — the true value is unchanged).
                const fmt = applyCondFormat(cellFormat(tab, r, c), tab.condRules, r, c, computed)
                const shown = formatValue(computed, fmt?.numFmt)
                // Rich conditional formats: colour scale (a computed bg), data bar
                // (a proportional bar behind the value), icon set (an icon before
                // it). Only numeric cells inside a rule's range are decorated.
                let scaleBg: string | undefined
                let dataBar: { pct: number; color: string } | undefined
                let condIcon: { char: string; color: string } | undefined
                if (condStats.length) {
                  const cv = condNumber(computed)
                  if (cv !== null) {
                    for (const s of condStats) {
                      if (!s.ok || !rangeHas(s.rule.range, r, c)) continue
                      if (s.rule.kind === 'colorScale') scaleBg = colorScaleColor(s.rule, cv, s.min, s.max) ?? scaleBg
                      else if (s.rule.kind === 'dataBar')
                        dataBar = { pct: dataBarPct(cv, s.min, s.max), color: s.rule.barColor ?? '#63be7b' }
                      else if (s.rule.kind === 'iconSet') {
                        const ic = iconForValue(s.rule, cv, s.min, s.max)
                        if (ic) condIcon = ic
                      }
                    }
                  }
                }
                // Data validation: a list rule shows an in-cell dropdown; any rule
                // flags an invalid current value (the value is never auto-changed).
                const validation = validationForCell(tab.validations, r, c)
                const invalid = validation ? !valueIsValid(computed, validation.rule) : false
                const listValues =
                  validation && validation.rule.kind === 'list' ? validation.rule.values : null
                const listOpen = !!openList && openList.r === r && openList.c === c
                // Any Excel-style error value (#ERR, #DIV/0!, #N/A, #VALUE!, #NAME?, #NUM!, #REF!, #SPILL!) renders red.
                const isErr = /^#(ERR|DIV\/0!|N\/A|VALUE!|NAME\?|NUM!|REF!|SPILL!)$/.test(computed)
                if (fmt?.fontFamily) loadGoogleFont(familyLabel(fmt.fontFamily))
                const style: React.CSSProperties = {
                  fontWeight: fmt?.bold ? 700 : undefined,
                  fontStyle: fmt?.italic ? 'italic' : undefined,
                  textDecoration: fmt?.underline ? 'underline' : undefined,
                  color: isErr ? '#ef4444' : isSpilled ? '#7c6cf0' : fmt?.color,
                  backgroundColor: scaleBg ?? fmt?.bg,
                  fontFamily: fmt?.fontFamily || undefined,
                  textAlign: fmt?.align ?? (computed !== '' && Number.isFinite(Number(computed)) ? 'right' : 'left')
                }
                const isPoint = props.pointCell?.r === r && props.pointCell?.c === c
                // Freeze-pane stickiness: pinned leading columns/rows stay put
                // while the rest scrolls. Pinned cells need an opaque background so
                // scrolled content doesn't show through, and the last pinned line
                // carries a firmer divider.
                const frozenL = c < fCols
                const frozenT = r < fRows
                const tdStyle: React.CSSProperties = {}
                if (isPoint) {
                  tdStyle.outline = '2px dashed var(--accent)'
                  tdStyle.outlineOffset = '-1px'
                }
                if (frozenL || frozenT) {
                  tdStyle.position = 'sticky'
                  if (frozenL) tdStyle.left = colLeft(c)
                  if (frozenT) tdStyle.top = rowTop(r)
                  tdStyle.zIndex = frozenL && frozenT ? 16 : frozenL ? 13 : 12
                  if (!selected && !inFillPreview) tdStyle.background = 'var(--surface-raised)'
                }
                if (c === fCols - 1 && fCols > 0) tdStyle.borderRight = '2px solid var(--edge-firm)'
                if (r === fRows - 1 && fRows > 0) tdStyle.borderBottom = '2px solid var(--edge-firm)'
                return (
                  <td
                    key={c}
                    data-testid={`cell-${r}-${c}`}
                    data-spill={isSpilled ? '1' : undefined}
                    colSpan={mergeSpan?.colSpan}
                    rowSpan={mergeSpan?.rowSpan}
                    style={Object.keys(tdStyle).length ? tdStyle : undefined}
                    onMouseDown={(e) => {
                      // In formula reference mode, prevent the default focus
                      // shift so the edit input keeps focus (no blur -> no
                      // commit). Clicking inside an input (the editing cell, or
                      // a header) is left alone so the caret can be placed.
                      if (props.formulaRefMode && !(e.target instanceof HTMLInputElement)) e.preventDefault()
                      props.onCellMouseDown(r, c, e.shiftKey)
                    }}
                    onMouseEnter={() => props.onCellMouseEnter(r, c)}
                    onDoubleClick={() => props.onCellDoubleClick(r, c)}
                    className={`relative border-b border-r border-[var(--edge-soft)] p-0 align-middle transition-colors ${
                      selected
                        ? 'bg-accent/[0.10]'
                        : inFillPreview
                          ? 'bg-accent/[0.06]'
                          : 'group-hover:bg-[color-mix(in_oklab,var(--surface-sunken)_40%,transparent)]'
                    } ${isActive ? 'outline outline-2 -outline-offset-1 outline-accent' : ''}`}
                  >
                    {showHandle && (
                      // Fill handle: the white/dark contrast ring keeps it visible over any cell colour.
                      <span
                        data-testid="sheet-fill-handle"
                        title="Drag to fill. Double-click to fill down to the end of your data."
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          props.onFillStart?.()
                        }}
                        onDoubleClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          props.onFillToEnd?.()
                        }}
                        className="absolute -bottom-[3px] -right-[3px] z-10 h-[7px] w-[7px] cursor-crosshair rounded-[1px] bg-accent border border-white dark:border-stone-900"
                      />
                    )}
                    {/* Conditional-format data bar: a proportional bar behind the value. */}
                    {dataBar && !isEditing && (
                      <div
                        data-testid={`cell-databar-${r}-${c}`}
                        aria-hidden
                        className="absolute left-0 top-[3px] bottom-[3px] z-0 rounded-sm pointer-events-none"
                        style={{ width: `${Math.round(dataBar.pct * 100)}%`, backgroundColor: dataBar.color, opacity: 0.35 }}
                      />
                    )}
                    {/* Data validation: invalid-value marker (a small red corner). */}
                    {invalid && !isEditing && (
                      <span
                        data-testid={`cell-invalid-${r}-${c}`}
                        title="Value does not match this cell's data validation"
                        className="absolute top-0 right-0 z-10 h-0 w-0 border-t-[6px] border-l-[6px] border-t-red-500 border-l-transparent"
                      />
                    )}
                    {/* Data validation: in-cell dropdown for a list rule. */}
                    {listValues && !isEditing && (
                      <button
                        data-testid={`cell-list-${r}-${c}`}
                        title="Choose a value"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setOpenList(listOpen ? null : { r, c })
                        }}
                        className="absolute bottom-0 right-0 z-10 flex h-4 w-4 items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-70)]"
                      >
                        <span className="text-[9px] leading-none">▾</span>
                      </button>
                    )}
                    {listValues && listOpen && (
                      <>
                        <div className="fixed inset-0 z-20" onMouseDown={() => setOpenList(null)} />
                        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 top-full z-30 min-w-full max-h-40 overflow-auto py-1">
                          {listValues.map((v) => (
                            <button
                              key={v}
                              data-testid={`cell-list-opt-${r}-${c}-${v}`}
                              onMouseDown={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                props.onSetCell?.(r, c, v)
                                setOpenList(null)
                              }}
                              className="block w-full text-left px-3 py-1 text-[12px] hover:bg-[var(--surface-sunken)] whitespace-nowrap"
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {isEditing ? (
                      <input
                        ref={(el) => {
                          editRef.current = el
                          if (props.editInputRef) props.editInputRef.current = el
                        }}
                        value={props.editValue}
                        onChange={(e) => props.onEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          const arrow =
                            e.key === 'ArrowUp'
                              ? 'up'
                              : e.key === 'ArrowDown'
                                ? 'down'
                                : e.key === 'ArrowLeft'
                                  ? 'left'
                                  : e.key === 'ArrowRight'
                                    ? 'right'
                                    : null
                          // While typing a formula, arrow keys point at a cell to
                          // insert its reference (Excel point mode). The parent
                          // returns true when it consumed the arrow, so the text
                          // caret does not also move.
                          if (arrow && props.onFormulaArrow?.(arrow, e.shiftKey)) {
                            e.preventDefault()
                            return
                          }
                          // In enter mode (typed a fresh value), an arrow commits
                          // the value and moves that direction, like Excel. Formulas
                          // are excluded so their arrows keep driving point mode /
                          // the caret; edit mode (F2 / double-click) is excluded so
                          // arrows can reposition the caret mid-value.
                          if (arrow && props.commitOnArrow && !props.editValue.startsWith('=')) {
                            e.preventDefault()
                            props.onCommitEdit(arrow)
                            return
                          }
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            props.onCommitEdit('down')
                          } else if (e.key === 'Tab') {
                            e.preventDefault()
                            props.onCommitEdit('right')
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            props.onCancelEdit()
                          }
                        }}
                        onBlur={() => props.onCommitEdit('none')}
                        className="w-full px-1.5 py-0.5 bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 font-mono leading-[1.3]"
                      />
                    ) : sparkline ? (
                      <div
                        className="px-2.5 py-1 select-none text-accent"
                        title={`Sparkline of ${sparkline.values.length} value${sparkline.values.length === 1 ? '' : 's'}`}
                      >
                        <SparklineCell
                          r={r}
                          c={c}
                          values={sparkline.values}
                          type={sparkline.type}
                          width={props.colWidthOf(c) - 16}
                        />
                      </div>
                    ) : (
                      <div
                        style={style}
                        className={`relative z-[1] px-1.5 py-0.5 whitespace-pre-wrap break-words select-none text-stone-800 dark:text-stone-100 leading-[1.3] ${listValues ? 'pr-4' : ''}`}
                        title={shown}
                      >
                        {condIcon && (
                          <span
                            data-testid={`cell-icon-${r}-${c}`}
                            aria-hidden
                            className="mr-1 text-[11px] leading-none"
                            style={{ color: condIcon.color }}
                          >
                            {condIcon.char}
                          </span>
                        )}
                        {shown}
                      </div>
                    )}
                  </td>
                )
              })}
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// A mini in-cell chart for a =SPARKLINE(...) cell. Draws a polyline (line) or
// thin bars (bar) across the cell width, normalised to the value range. The SVG
// uses currentColor so it inherits the accent set on the wrapper and stays crisp
// in dark mode. With fewer than the points a chart needs, or no numeric values at
// all, it renders a faint baseline placeholder rather than inventing data.
function SparklineCell({
  r,
  c,
  values,
  type,
  width
}: {
  r: number
  c: number
  values: number[]
  type: 'line' | 'bar'
  width: number
}): JSX.Element {
  const w = Math.max(24, Math.round(width))
  const h = 18
  const testid = `sparkline-${r}-${c}`
  // A line needs two points; a single value or none has nothing to plot. Show a
  // faint baseline so the cell reads as an empty chart, never a fabricated trend.
  const drawable = type === 'bar' ? values.length >= 1 : values.length >= 2
  if (!drawable) {
    return (
      <svg
        data-testid={testid}
        data-sparkline-empty="1"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="text-[var(--ink-30)]"
        aria-hidden="true"
      >
        <line x1={0} y1={h - 2} x2={w} y2={h - 2} stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" />
      </svg>
    )
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pad = 2
  if (type === 'bar') {
    const gap = values.length > 20 ? 0.5 : 1
    const barW = (w - gap * (values.length - 1)) / values.length
    const baseMax = max <= 0 ? 1 : max
    return (
      <svg
        data-testid={testid}
        data-sparkline-type="bar"
        data-sparkline-count={values.length}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden="true"
      >
        {values.map((v, i) => {
          const barH = Math.max(1, (Math.max(0, v) / baseMax) * (h - pad))
          return (
            <rect
              key={i}
              x={(barW + gap) * i}
              y={h - barH}
              width={Math.max(0.5, barW)}
              height={barH}
              rx={0.5}
              fill="currentColor"
            />
          )
        })}
      </svg>
    )
  }
  const d = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2)
      const y = h - pad - ((v - min) / range) * (h - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      data-testid={testid}
      data-sparkline-type="line"
      data-sparkline-count={values.length}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={d} stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// The filter funnel dropdown: a checkbox list of the column's distinct values.
// Checked = visible; unchecking adds the value to the column's hide-set.
function FilterDropdown({
  values,
  hidden,
  onApply,
  onClose
}: {
  values: string[]
  hidden: string[]
  onApply: (hidden: string[]) => void
  onClose: () => void
}): JSX.Element {
  const hide = new Set(hidden)
  const toggle = (v: string): void => {
    const next = new Set(hide)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onApply([...next])
  }
  return (
    <>
      <div className="fixed inset-0 z-30" onMouseDown={onClose} />
      <div
        data-testid="sheet-filter-dropdown"
        className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 top-full z-40 mt-0.5 w-48"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--edge-soft)] text-[11px]">
          <button className="text-accent hover:underline" onMouseDown={() => onApply([])}>
            Select all
          </button>
          <button
            className="text-[var(--ink-50)] hover:underline"
            onMouseDown={() => onApply(values.slice())}
          >
            Clear
          </button>
        </div>
        <div className="max-h-52 overflow-auto py-1">
          {values.map((v) => (
            <label
              key={v}
              className="flex items-center gap-2 px-2 py-1 text-[12px] hover:bg-[var(--surface-sunken)] cursor-pointer"
            >
              <input type="checkbox" checked={!hide.has(v)} onChange={() => toggle(v)} />
              <span className="truncate">{v === '' ? '(blanks)' : v}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  )
}
