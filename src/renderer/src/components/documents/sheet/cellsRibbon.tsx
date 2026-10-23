import type { SheetCellFormat, SheetNumberFormat } from '@shared/types'
import {
  BarButton,
  BarColor,
  BarCustom,
  BarDialogButton,
  BarMenu,
  BarSelect,
  BarSep,
  BarToggle,
  shellPanelDomId,
  SIDE_PANE_DOM_ID,
  railGroup,
  type BarTab,
  type RailItem
} from '../../office/shell'
import FontPicker from '../editor/FontPicker'
import type { SheetMenuActions } from '../editor/SheetMenuBar'

// PlexiiCells on the office shell (SPEC §6.3): the ToolRail items and every
// ContextBar tab. Owner ruling D1 moved the formatting row's controls into tabs
// here. The assistant stays on the right in the shared ShellSidePane (D1 as
// amended, §2.5a), keeping `sheet-ai-collapse` as its collapse control.
//
// Every control keeps the testid it had in SheetToolbar.tsx — sheet-merge-btn,
// sheet-number-format, sheet-condformat-btn, sheet-validation-btn,
// sheet-filter-btn, sheet-pivot-btn, sheet-insert-sparkline, sheet-lookup-btn,
// sheet-macros-btn, sheet-query-btn — so the sheet specs address the same
// things. Controls that had no testid get none.
//
// One behaviour does change, deliberately. SheetToolbar's Bold / Italic /
// Underline buttons passed `{ bold: true }`, and applyFormat merges rather than
// toggles, so they could set a mark but never clear one and never showed which
// marks the cell already had. The Format menu has always toggled correctly
// (`bold: !fmt?.bold`), so the capability was there and only the toolbar was
// wrong. As BarToggles they read `activeFormat` and toggle, which makes the bar
// agree with the menu.

// The panels Cells really has. Only `office` is one: its rail item calls
// togglePanel and CellsChrome draws its body. Conditional formatting, data
// validation, macros, query and named ranges are each still SheetEditor's own
// modal — reachable and working, but not ShellPanels — and this type listed all
// six, so five ShellPanels were declared that no caller could open and no body
// could fill. Converting those modals to panels is a real change with a visible
// UX difference (a centred dialog becomes a docked panel), so it is a follow-up
// rather than something to half-declare here. Add an id back in the same change
// that gives it an opener and a body.
export type CellsPanel = 'office'
export type CellsSidePane = 'ai'

/** The live sheet state every tab reads. */
export interface CCtx {
  a: SheetMenuActions
  readOnly: boolean
  /** Format of the active cell, for the mark toggles and alignment state. */
  fmt: SheetCellFormat | undefined
  activeFont?: string
  isMerged: boolean
  mergeCells: () => void
  insertLookup: () => void
  macros: () => void
  query: () => void
  togglePanel: (p: CellsPanel) => void
  isPanelOpen: (p: CellsPanel) => boolean
  sidePane: CellsSidePane | null
  toggleSidePane: (p: CellsSidePane) => void
}

const NUMBER_FORMATS: Array<{ label: string; fmt: SheetNumberFormat }> = [
  { label: 'General', fmt: { kind: 'general' } },
  { label: 'Number (1,234.50)', fmt: { kind: 'number', decimals: 2, thousands: true } },
  { label: 'Integer (1,234)', fmt: { kind: 'number', decimals: 0, thousands: true } },
  { label: 'Currency ($)', fmt: { kind: 'currency', decimals: 2, symbol: '$' } },
  { label: 'Percent (%)', fmt: { kind: 'percent', decimals: 1 } },
  { label: 'Date (YYYY-MM-DD)', fmt: { kind: 'date', pattern: 'YYYY-MM-DD' } }
]

/**
 * A sheet has no document theme to read a palette from — the old controls were
 * bare `<input type="color">`. These are the swatches BarColor offers; the
 * native picker is one click further in.
 */
const TEXT_PALETTE = ['#111827', '#374151', '#6b7280', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0f766e', '#1d4ed8', '#6d28d9', '#be185d']
const FILL_PALETTE = ['#ffffff', '#f3f4f6', '#fef9c3', '#dcfce7', '#dbeafe', '#fae8ff', '#ffe4e6', '#fff7ed']

const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'scatter'] as const

// ── Home ─────────────────────────────────────────────────────────────────────

const homeTab: BarTab<CCtx> = {
  id: 'home',
  label: 'Home',
  role: 'home',
  render: (c) => {
    const { a, fmt } = c
    return (
      <>
        <BarCustom label="Font" semantic="font-family">
          <FontPicker value={c.activeFont} onChange={(v) => a.format({ fontFamily: v })} compact />
        </BarCustom>
        <BarToggle icon="format_bold" semantic="bold" label="Bold" shortcut="⌘B" pressed={!!fmt?.bold} onChange={(v) => a.format({ bold: v })} />
        <BarToggle icon="format_italic" semantic="italic" label="Italic" shortcut="⌘I" pressed={!!fmt?.italic} onChange={(v) => a.format({ italic: v })} />
        <BarToggle icon="format_underlined" semantic="underline" label="Underline" shortcut="⌘U" pressed={!!fmt?.underline} onChange={(v) => a.format({ underline: v })} />
        <BarSep />
        <BarColor icon="format_color_text" semantic="text-color" label="Text colour" value={fmt?.color} palette={TEXT_PALETTE} onChange={(v) => a.format({ color: v })} />
        <BarColor icon="format_color_fill" label="Fill colour" allowNone value={fmt?.bg} palette={FILL_PALETTE} onChange={(v) => a.format({ bg: v })} />
        <BarSep />
        <BarToggle icon="format_align_left" semantic="align-left" label="Align left" pressed={fmt?.align === 'left'} onChange={() => a.format({ align: 'left' })} />
        <BarToggle icon="format_align_center" semantic="align-center" label="Align center" pressed={fmt?.align === 'center'} onChange={() => a.format({ align: 'center' })} />
        <BarToggle icon="format_align_right" semantic="align-right" label="Align right" pressed={fmt?.align === 'right'} onChange={() => a.format({ align: 'right' })} />
        <BarToggle
          icon={c.isMerged ? 'call_split' : 'call_merge'}
          label={c.isMerged ? 'Unmerge cells' : 'Merge the selected cells'}
          pressed={c.isMerged}
          onChange={c.mergeCells}
          testid="sheet-merge-btn"
        />
        <BarSep />
        <BarSelect
          label="Number format"
          width={132}
          value=""
          options={[{ value: '', label: 'Format' }, ...NUMBER_FORMATS.map((f, i) => ({ value: String(i), label: f.label }))]}
          onChange={(v) => {
            const i = Number(v)
            if (NUMBER_FORMATS[i]) a.numberFormat(NUMBER_FORMATS[i].fmt)
          }}
          testid="sheet-number-format"
        />
        <BarSep />
        <BarButton
          icon="format_clear"
          label="Clear formatting"
          shortcut="⌘\"
          onClick={() => a.format({ bold: false, italic: false, underline: false, numFmt: { kind: 'general' } })}
        />
      </>
    )
  }
}

// ── Insert ───────────────────────────────────────────────────────────────────

const insertTab: BarTab<CCtx> = {
  id: 'insert',
  label: 'Insert',
  role: 'insert',
  render: (c) => (
    <>
      <BarButton icon="add_row_above" label="Insert row above" onClick={c.a.insertRowAbove} />
      <BarButton icon="add_row_below" label="Insert row below" onClick={c.a.insertRowBelow} />
      <BarButton icon="add_column_left" label="Insert column left" onClick={c.a.insertColLeft} />
      <BarButton icon="add_column_right" label="Insert column right" onClick={c.a.insertColRight} />
      <BarSep />
      <BarButton icon="delete" label="Delete row" onClick={c.a.deleteRow} />
      <BarButton icon="delete_sweep" label="Delete column" onClick={c.a.deleteCol} />
      <BarSep />
      <BarMenu
        icon="bar_chart"
        label="Insert chart"
        showLabel={false}
        items={CHART_TYPES.map((t) => ({
          label: `${t[0].toUpperCase()}${t.slice(1)} chart`,
          run: () => c.a.insertChart(t)
        }))}
      />
      <BarButton icon="show_chart" label="Insert a sparkline of the selection into the next cell" onClick={c.a.insertSparkline} testid="sheet-insert-sparkline" />
      <BarButton icon="search" label="Insert a lookup (XLOOKUP) into the active cell" onClick={c.insertLookup} testid="sheet-lookup-btn" />
      <BarSep />
      <BarDialogButton icon="bookmarks" label="Saved snippet" onOpen={c.a.insertSnippet} testid="sheet-insert-snippet" />
      <BarSep />
      <BarButton icon="add" label="Add a sheet" onClick={c.a.addSheet} />
    </>
  )
}

// ── Data ─────────────────────────────────────────────────────────────────────

const dataTab: BarTab<CCtx> = {
  id: 'data',
  label: 'Data',
  role: 'app',
  render: (c) => (
    <>
      <BarButton icon="arrow_upward" label="Sort ascending" onClick={() => c.a.sort('asc')} />
      <BarButton icon="arrow_downward" label="Sort descending" onClick={() => c.a.sort('desc')} />
      <BarToggle icon="filter_alt" label="Create a filter (funnels on the headers)" pressed={c.a.filterActive} onChange={c.a.toggleFilter} testid="sheet-filter-btn" />
      <BarSep />
      <BarButton icon="palette" label="Conditional formatting for the selection" onClick={c.a.conditionalFormat} testid="sheet-condformat-btn" />
      <BarButton icon="rule" label="Data validation for the selection" onClick={c.a.dataValidation} testid="sheet-validation-btn" />
      <BarSep />
      <BarButton icon="pivot_table_chart" label="Pivot table from the selection" onClick={c.a.insertPivot} testid="sheet-pivot-btn" />
      <BarButton icon="account_tree" label="Query — shape data with refreshable transform steps" onClick={c.query} testid="sheet-query-btn" />
      <BarButton icon="label" label="Named ranges" onClick={c.a.namedRanges} />
      <BarDialogButton icon="bookmark_add" label="Save as snippet" onOpen={c.a.saveSnippet} readOnlySafe testid="sheet-save-snippet" />
    </>
  )
}

// ── Tools ────────────────────────────────────────────────────────────────────

const toolsTab: BarTab<CCtx> = {
  id: 'tools',
  label: 'Tools',
  role: 'app',
  render: (c) => (
    <>
      <BarButton icon="code" label="Macros — automate the sheet with a script" showLabel onClick={c.macros} testid="sheet-macros-btn" />
      <BarSep />
      <BarButton icon="upload_file" label="Import .xlsx / .csv" showLabel onClick={c.a.importFile} readOnlySafe />
      <BarButton icon="table_chart" label="Export .xlsx" showLabel onClick={() => c.a.exportFile('xlsx')} readOnlySafe />
      <BarButton icon="description" label="Export .csv" showLabel onClick={() => c.a.exportFile('csv')} readOnlySafe />
    </>
  )
}

export const CELLS_TABS: BarTab<CCtx>[] = [homeTab, insertTab, dataTab, toolsTab]

// ── Rail ─────────────────────────────────────────────────────────────────────

const CHART_ICON: Record<(typeof CHART_TYPES)[number], string> = { bar: 'bar_chart', line: 'show_chart', area: 'area_chart', pie: 'pie_chart', scatter: 'scatter_plot' }

/**
 * Cells' rail, in the one order every app shares (SPEC §3.9). No drawing
 * tools, so it starts at Insert: the Chart flyout (it shows the chart kind
 * last used), Pivot, Sparkline, Lookup. Then the sheet's own tools: Filter is
 * an on/off toggle reading the same state as the Data tab's (§3.7), and
 * Conditional formatting, Validation, Macros and Query open SheetEditor's
 * modals (dialog items, never panels: §5a.14). The bottom holds the one real
 * overlay panel (Import / export) and AI fill last.
 */
export function cellsRailItems(): RailItem<CCtx>[] {
  return [
    ...CHART_TYPES.map(
      (t, i): RailItem<CCtx> => ({
        id: `chart-${t}`,
        label: `${t[0]!.toUpperCase()}${t.slice(1)} chart`,
        icon: CHART_ICON[t],
        kind: 'action',
        role: 'insert',
        group: railGroup('insert'),
        order: i,
        flyout: 'chart',
        onSelect: (c) => c.a.insertChart(t),
        testid: `sheet-rail-chart-${t}`
      })
    ),
    { id: 'pivot', label: 'Pivot table', icon: 'pivot_table_chart', kind: 'action', role: 'insert', group: railGroup('insert'), order: 10, onSelect: (c) => c.a.insertPivot(), testid: 'sheet-rail-pivot' },
    { id: 'sparkline', label: 'Insert a sparkline of the selection into the next cell', icon: 'show_chart', kind: 'action', role: 'insert', group: railGroup('insert'), order: 11, onSelect: (c) => c.a.insertSparkline(), testid: 'sheet-rail-sparkline' },
    { id: 'lookup', label: 'Insert a lookup (XLOOKUP) into the active cell', icon: 'search', kind: 'action', role: 'insert', group: railGroup('insert'), order: 12, onSelect: (c) => c.insertLookup(), testid: 'sheet-rail-lookup' },
    {
      id: 'filter',
      label: 'Create a filter',
      icon: 'filter_alt',
      kind: 'toggle',
      role: 'app',
      group: railGroup('app'),
      order: 0,
      pressed: (c) => c.a.filterActive,
      onSelect: (c) => c.a.toggleFilter(),
      testid: 'sheet-rail-filter'
    },
    { id: 'condformat', label: 'Conditional formatting', icon: 'palette', kind: 'action', dialog: true, role: 'app', group: railGroup('app'), order: 1, onSelect: (c) => c.a.conditionalFormat(), testid: 'sheet-rail-condformat' },
    { id: 'validation', label: 'Data validation', icon: 'rule', kind: 'action', dialog: true, role: 'app', group: railGroup('app'), order: 2, onSelect: (c) => c.a.dataValidation(), testid: 'sheet-rail-validation' },
    { id: 'macros', label: 'Macros', icon: 'code', kind: 'action', dialog: true, role: 'app', group: railGroup('app'), order: 3, onSelect: (c) => c.macros(), testid: 'sheet-rail-macros' },
    { id: 'query', label: 'Query', icon: 'account_tree', kind: 'action', dialog: true, role: 'app', group: railGroup('app'), order: 4, onSelect: (c) => c.query(), testid: 'sheet-rail-query' },
    {
      id: 'office',
      label: 'Import / export',
      icon: 'folder_open',
      kind: 'panel',
      role: 'panel',
      group: railGroup('panel'),
      order: 0,
      pinned: 'bottom',
      readOnlySafe: true,
      onSelect: (c) => c.togglePanel('office'),
      testid: 'sheet-rail-office'
    },
    { id: 'ai', label: 'AI fill', icon: 'auto_awesome', kind: 'action', role: 'ai', group: railGroup('ai'), order: 0, pinned: 'bottom', onSelect: (c) => c.a.aiFill(), testid: 'sheet-rail-ai' }
  ]
}

export { shellPanelDomId, SIDE_PANE_DOM_ID }
