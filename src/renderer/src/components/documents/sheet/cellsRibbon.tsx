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
  type BarTab,
  type RailItem
} from '../../office/shell'
import FontPicker from '../editor/FontPicker'
import { barProps, type OfficeCommand } from '../../../lib/menus/officeCommand'
import type { CellsCommands } from './cellsCommands'
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
  /**
   * PlexiiCells' command registry (cellsCommands.ts). Every control here that
   * also exists in the menu bar or the Cmd+K palette renders from it, so the
   * surfaces cannot drift — they had, in five labels, and the ribbon's Import
   * button was marked read-only safe while `importFile` refuses a viewer.
   */
  commands: CellsCommands
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

/** A registry command by id. A missing id is a programming error, not a blank button. */
function cmd(c: CCtx, id: string): OfficeCommand {
  const found = c.commands[id]
  if (!found) throw new Error(`cellsRibbon: no command "${id}" in the registry`)
  return found
}

/**
 * `readOnlySafe` is derived, not declared: a command with no `enabled` gate
 * changes nothing in the sheet, which is exactly what the shell means by
 * read-only safe. So the registry decides a viewer's ribbon too, and a control
 * cannot be live here while its menu row is greyed out.
 */
const safe = (k: OfficeCommand): { readOnlySafe?: true } => (k.enabled ? {} : { readOnlySafe: true })

export function cmdToggle(c: CCtx, id: string, extra: Partial<Parameters<typeof BarToggle>[0]> = {}): JSX.Element {
  const k = cmd(c, id)
  return <BarToggle {...barProps(k)} {...safe(k)} pressed={!!k.checked?.()} onChange={k.run} {...extra} />
}

export function cmdButton(c: CCtx, id: string, extra: Partial<Parameters<typeof BarButton>[0]> = {}): JSX.Element {
  const k = cmd(c, id)
  return <BarButton {...barProps(k)} {...safe(k)} onClick={k.run} {...extra} />
}

/** A control that opens a dialog; BarDialogButton gives it its ellipsis. */
export function cmdDialogButton(c: CCtx, id: string, extra: Partial<Parameters<typeof BarDialogButton>[0]> = {}): JSX.Element {
  const k = cmd(c, id)
  return <BarDialogButton {...barProps(k)} {...safe(k)} onOpen={k.run} {...extra} />
}

const homeTab: BarTab<CCtx> = {
  id: 'home',
  label: 'Home',
  render: (c) => {
    const { a, fmt } = c
    return (
      <>
        {cmdToggle(c, 'sheet-bold')}
        {cmdToggle(c, 'sheet-italic')}
        {cmdToggle(c, 'sheet-underline')}
        <BarCustom label="Font">
          <FontPicker value={c.activeFont} onChange={(v) => a.format({ fontFamily: v })} compact />
        </BarCustom>
        <BarSep />
        <BarColor icon="format_color_text" label="Text colour" value={fmt?.color} palette={TEXT_PALETTE} onChange={(v) => a.format({ color: v })} />
        <BarColor icon="format_color_fill" label="Fill colour" allowNone value={fmt?.bg} palette={FILL_PALETTE} onChange={(v) => a.format({ bg: v })} />
        <BarSep />
        {cmdToggle(c, 'sheet-align-left')}
        {cmdToggle(c, 'sheet-align-center')}
        {cmdToggle(c, 'sheet-align-right')}
        {cmdToggle(c, 'sheet-merge', { testid: 'sheet-merge-btn' })}
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
        {cmdButton(c, 'sheet-clear-format')}
      </>
    )
  }
}

// ── Insert ───────────────────────────────────────────────────────────────────

const insertTab: BarTab<CCtx> = {
  id: 'insert',
  label: 'Insert',
  render: (c) => (
    <>
      {cmdButton(c, 'sheet-row-above')}
      {cmdButton(c, 'sheet-row-below')}
      {cmdButton(c, 'sheet-col-left')}
      {cmdButton(c, 'sheet-col-right')}
      <BarSep />
      {cmdButton(c, 'sheet-delete-row')}
      {cmdButton(c, 'sheet-delete-col')}
      <BarSep />
      <BarMenu
        icon="bar_chart"
        label="Insert chart"
        showLabel={false}
        items={CHART_TYPES.map((t) => {
          const k = cmd(c, `sheet-chart-${t}`)
          return { label: k.shortLabel ?? k.label, run: k.run }
        })}
      />
      {cmdButton(c, 'sheet-sparkline', { testid: 'sheet-insert-sparkline' })}
      {cmdButton(c, 'sheet-lookup', { testid: 'sheet-lookup-btn' })}
      <BarSep />
      {cmdDialogButton(c, 'sheet-insert-snippet', { testid: 'sheet-insert-snippet' })}
      <BarSep />
      {cmdButton(c, 'sheet-add-sheet')}
    </>
  )
}

// ── Data ─────────────────────────────────────────────────────────────────────

const dataTab: BarTab<CCtx> = {
  id: 'data',
  label: 'Data',
  render: (c) => (
    <>
      {cmdButton(c, 'sheet-sort-asc')}
      {cmdButton(c, 'sheet-sort-desc')}
      {cmdToggle(c, 'sheet-filter', { testid: 'sheet-filter-btn' })}
      <BarSep />
      {cmdButton(c, 'sheet-cond-format', { testid: 'sheet-condformat-btn' })}
      {cmdButton(c, 'sheet-validation', { testid: 'sheet-validation-btn' })}
      <BarSep />
      {cmdButton(c, 'sheet-pivot', { testid: 'sheet-pivot-btn' })}
      {cmdButton(c, 'sheet-query', { testid: 'sheet-query-btn' })}
      {cmdButton(c, 'sheet-named-ranges')}
      {cmdDialogButton(c, 'sheet-save-snippet', { testid: 'sheet-save-snippet' })}
    </>
  )
}

// ── Tools ────────────────────────────────────────────────────────────────────

const toolsTab: BarTab<CCtx> = {
  id: 'tools',
  label: 'Tools',
  render: (c) => (
    <>
      {cmdButton(c, 'sheet-macros', { showLabel: true, testid: 'sheet-macros-btn' })}
      <BarSep />
      {cmdButton(c, 'sheet-import', { showLabel: true })}
      {cmdButton(c, 'sheet-export-xlsx', { showLabel: true })}
      {cmdButton(c, 'sheet-export-csv', { showLabel: true })}
    </>
  )
}

export const CELLS_TABS: BarTab<CCtx>[] = [homeTab, insertTab, dataTab, toolsTab]

// ── Rail ─────────────────────────────────────────────────────────────────────

/**
 * Cells has no drawing tools either, so its rail carries the panel openers and
 * the two data tools, with AI fill pinned to the bottom.
 */
export function cellsRailItems(): RailItem<CCtx>[] {
  return [
    {
      id: 'condformat',
      label: 'Conditional formatting',
      icon: 'palette',
      kind: 'panel',
      group: 0,
      order: 0,
      onSelect: (c) => c.a.conditionalFormat(),
      testid: 'sheet-rail-condformat'
    },
    {
      id: 'validation',
      label: 'Data validation',
      icon: 'rule',
      kind: 'panel',
      group: 0,
      order: 1,
      onSelect: (c) => c.a.dataValidation(),
      testid: 'sheet-rail-validation'
    },
    {
      id: 'query',
      label: 'Query',
      icon: 'account_tree',
      kind: 'panel',
      group: 0,
      order: 2,
      onSelect: (c) => c.query(),
      testid: 'sheet-rail-query'
    },
    {
      id: 'macros',
      label: 'Macros',
      icon: 'code',
      kind: 'panel',
      group: 0,
      order: 3,
      onSelect: (c) => c.macros(),
      testid: 'sheet-rail-macros'
    },
    {
      id: 'filter',
      label: 'Create a filter',
      icon: 'filter_alt',
      kind: 'action',
      group: 1,
      order: 0,
      onSelect: (c) => c.a.toggleFilter(),
      testid: 'sheet-rail-filter'
    },
    {
      id: 'pivot',
      label: 'Pivot table',
      icon: 'pivot_table_chart',
      kind: 'action',
      group: 1,
      order: 1,
      onSelect: (c) => c.a.insertPivot(),
      testid: 'sheet-rail-pivot'
    },
    {
      id: 'office',
      label: 'Import / export',
      icon: 'folder_open',
      kind: 'panel',
      group: 1,
      order: 2,
      readOnlySafe: true,
      onSelect: (c) => c.togglePanel('office'),
      testid: 'sheet-rail-office'
    },
    {
      id: 'ai',
      label: 'AI fill',
      icon: 'auto_awesome',
      kind: 'action',
      group: 2,
      order: 0,
      pinned: 'bottom',
      onSelect: (c) => c.a.aiFill(),
      testid: 'sheet-rail-ai'
    }
  ]
}

export { shellPanelDomId, SIDE_PANE_DOM_ID }
