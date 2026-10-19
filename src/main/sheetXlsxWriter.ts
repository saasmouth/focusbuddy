import ExcelJS from 'exceljs'
import type { SheetBodyV2, SheetCellFormat, SheetValidation, SheetCondRule } from '@shared/types'
import { toExcelNumFmt, hexToArgb } from '@shared/sheetNumFmt'

const NUM_OP: Record<string, ExcelJS.DataValidationOperator> = {
  gt: 'greaterThan',
  lt: 'lessThan',
  ge: 'greaterThanOrEqual',
  le: 'lessThanOrEqual',
  eq: 'equal',
  between: 'between'
}

// Parse an A1 range ("B2:C20" or a single "B2") into 1-based row/col bounds.
function parseA1(range: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const cell = (a: string): { r: number; c: number } | null => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(a.trim())
    if (!m) return null
    let c = 0
    for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64)
    return { c, r: Number(m[2]) }
  }
  const [a, b] = range.split(':')
  const s = cell(a)
  if (!s) return null
  const e = b ? cell(b) : s
  if (!e) return null
  return { r1: Math.min(s.r, e.r), c1: Math.min(s.c, e.c), r2: Math.max(s.r, e.r), c2: Math.max(s.c, e.c) }
}

// Map our validation rule to an exceljs data-validation model. Returns null for a
// rule exceljs cannot represent, so nothing invalid is written.
function validationModel(v: SheetValidation): ExcelJS.DataValidation | null {
  const allowBlank = !v.strict
  const r = v.rule
  if (r.kind === 'list') {
    if (!r.values.length) return null
    // A quoted, comma-joined literal list is Excel's inline dropdown source.
    return { type: 'list', allowBlank, formulae: [`"${r.values.join(',').replace(/"/g, "'")}"`] }
  }
  if (r.kind === 'number') {
    return {
      type: 'decimal',
      operator: NUM_OP[r.op] ?? 'greaterThan',
      allowBlank,
      formulae: r.op === 'between' && r.value2 != null ? [String(r.value), String(r.value2)] : [String(r.value)]
    }
  }
  if (r.kind === 'textNotEmpty') {
    return { type: 'textLength', operator: 'greaterThan', allowBlank: false, formulae: ['0'] }
  }
  return null
}

// Styled .xlsx writer (exceljs). Kept out of sheetIo.ts so it carries no electron
// import and stays unit-testable: a test can build a workbook and read it back to
// confirm fonts, fills, number formats and column widths survive into real Excel.

// Apply a cell's visual format to an exceljs cell: font (bold/italic/underline/
// family/colour), solid fill, horizontal alignment, and number format.
export function applyExcelStyle(cell: ExcelJS.Cell, fmt: SheetCellFormat): void {
  const font: Partial<ExcelJS.Font> = {}
  if (fmt.bold) font.bold = true
  if (fmt.italic) font.italic = true
  if (fmt.underline) font.underline = true
  if (fmt.fontFamily) font.name = fmt.fontFamily
  const textArgb = hexToArgb(fmt.color)
  if (textArgb) font.color = { argb: textArgb }
  if (Object.keys(font).length > 0) cell.font = font
  const fillArgb = hexToArgb(fmt.bg)
  if (fillArgb) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } }
  if (fmt.align) cell.alignment = { horizontal: fmt.align }
  const z = toExcelNumFmt(fmt.numFmt)
  if (z) cell.numFmt = z
}

const CELLIS_OP: Record<string, string> = {
  gt: 'greaterThan',
  lt: 'lessThan',
  ge: 'greaterThanOrEqual',
  le: 'lessThanOrEqual',
  eq: 'equal',
  ne: 'notEqual',
  between: 'between'
}

// The top-left cell of an A1 range, used as the relative anchor for expression
// rules (Excel applies them across the whole ref by offsetting from top-left).
function topLeftCell(range: string): string {
  return range.split(':')[0]
}

// A number formula stays bare; text is quoted so cellIs compares as a string.
function condFormula(v: string | undefined): string {
  if (v == null) return '0'
  return Number.isFinite(Number(v)) && v.trim() !== '' ? v : `"${v.replace(/"/g, "'")}"`
}

// The exceljs dxf style for a compare rule (fill + font). Conditional-format fills
// use bgColor in OOXML's dxf, which is the exceljs quirk we mirror.
function condStyle(rule: SheetCondRule): Record<string, unknown> {
  const style: Record<string, unknown> = {}
  const fill = hexToArgb(rule.bg)
  if (fill) style.fill = { type: 'pattern', pattern: 'solid', bgColor: { argb: fill } }
  const font: Record<string, unknown> = {}
  if (rule.bold) font.bold = true
  const color = hexToArgb(rule.color)
  if (color) font.color = { argb: color }
  if (Object.keys(font).length) style.font = font
  return style
}

// Map one of our conditional-format rules to an exceljs conditional-formatting
// rule object. Compare rules round-trip fully; colour-scale / data-bar / icon-set
// are exported for Excel but not yet re-imported (documented in the reader).
function condRuleModel(rule: SheetCondRule, priority: number): Record<string, unknown> | null {
  const kind = rule.kind ?? 'compare'
  if (kind === 'colorScale') {
    const colors = [rule.minColor, rule.midColor, rule.maxColor].filter(Boolean).map((c) => ({ argb: hexToArgb(c) }))
    if (colors.length < 2) return null
    const cfvo =
      colors.length === 3
        ? [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }]
        : [{ type: 'min' }, { type: 'max' }]
    return { type: 'colorScale', cfvo, color: colors, priority }
  }
  if (kind === 'dataBar') {
    return { type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: hexToArgb(rule.barColor) || 'FF638EC6' }, priority }
  }
  if (kind === 'iconSet') {
    const name = rule.iconSet === 'traffic' ? '3TrafficLights1' : rule.iconSet === 'triangles' ? '3Triangles' : '3Arrows'
    return {
      type: 'iconSet',
      iconSet: name,
      cfvo: [
        { type: 'percent', value: 0 },
        { type: 'percent', value: 33 },
        { type: 'percent', value: 67 }
      ],
      priority
    }
  }
  // compare
  const style = condStyle(rule)
  if (rule.op === 'notEmpty') {
    return { type: 'expression', formulae: [`LEN(TRIM(${topLeftCell(rule.range)}))>0`], style, priority }
  }
  if (rule.op === 'contains') {
    return { type: 'containsText', operator: 'containsText', text: rule.value ?? '', style, priority }
  }
  const op = CELLIS_OP[rule.op]
  if (!op) return null
  const formulae = rule.op === 'between' && rule.value2 != null ? [condFormula(rule.value), condFormula(rule.value2)] : [condFormula(rule.value)]
  return { type: 'cellIs', operator: op, formulae, style, priority }
}

// Build a fully-styled .xlsx workbook from the sheet body.
export async function buildStyledXlsx(body: SheetBodyV2): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'PlexiiDesk'
  for (const tab of body.sheets) {
    const ws = wb.addWorksheet((tab.name || 'Sheet').slice(0, 31))
    if (tab.colWidths) {
      for (const [c, px] of Object.entries(tab.colWidths)) {
        if (px) ws.getColumn(Number(c) + 1).width = Math.max(2, Math.round(px / 7))
      }
    }
    if (tab.rowHeights) {
      // exceljs row height is in points; our stored heights are px (96dpi).
      for (const [r, px] of Object.entries(tab.rowHeights)) {
        if (px) ws.getRow(Number(r) + 1).height = Math.round((px * 72) / 96)
      }
    }
    for (let r = 0; r < tab.rows.length; r++) {
      for (let c = 0; c < tab.rows[r].length; c++) {
        const raw = tab.rows[r][c]
        const cell = ws.getCell(r + 1, c + 1)
        if (raw.startsWith('=')) cell.value = { formula: raw.slice(1) }
        else {
          const n = Number(raw)
          cell.value = raw.trim() !== '' && Number.isFinite(n) ? n : raw
        }
        const fmt = tab.formats?.[`${r},${c}`]
        if (fmt) applyExcelStyle(cell, fmt)
      }
    }
    if (tab.freeze && (tab.freeze.rows > 0 || tab.freeze.cols > 0)) {
      ws.views = [{ state: 'frozen', xSplit: tab.freeze.cols, ySplit: tab.freeze.rows }]
    }
    for (const m of tab.merges ?? []) {
      // exceljs is 1-based (top row, left col, bottom row, right col).
      try {
        ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1)
      } catch {
        // Overlapping/invalid merges are skipped rather than aborting the export.
      }
    }
    // Data validation (dropdown lists, number bounds, non-empty text) so a
    // constrained cell keeps its rule in Excel. exceljs sets validation per cell,
    // so apply the model across the rule's range.
    for (const v of tab.validations ?? []) {
      const model = validationModel(v)
      const box = parseA1(v.range)
      if (!model || !box) continue
      for (let r = box.r1; r <= box.r2; r++) {
        for (let c = box.c1; c <= box.c2; c++) {
          ws.getCell(r, c).dataValidation = { ...model }
        }
      }
    }
    // Conditional formatting so highlight rules / colour scales survive into Excel.
    let cfPriority = 1
    for (const rule of tab.condRules ?? []) {
      const model = condRuleModel(rule, cfPriority++)
      if (model) ws.addConditionalFormatting({ ref: rule.range, rules: [model as unknown as ExcelJS.ConditionalFormattingRule] })
    }
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}
