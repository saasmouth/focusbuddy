// Spreadsheet Office interop: import .xlsx/.csv into the v2 sheet body and
// export the body to .xlsx/.csv.
//
// Two libraries, on purpose. IMPORT and CSV export use SheetJS, which reads the
// workbook model we need (ranges, cell addressing, merges, column and row
// info). XLSX export goes through exceljs instead (buildStyledXlsx in
// sheetXlsxWriter.ts), because visual styles — fonts, fills, colours,
// alignment — have to survive into real Excel rather than arriving as bare
// values and number formats.
//
// Honest about fidelity: values always; formulas where SheetJS exposes them;
// number formats best-effort; merged cells collapse to their top-left value on
// import; styling beyond what the body models is dropped; charts are not
// round-tripped.
//
// Worth knowing about the SheetJS pin. 0.18.5 was the last build published to
// npm, and it carried high-severity advisories (prototype pollution, ReDoS).
// We are now on 0.20.3, installed from the vendor's own CDN
// (https://cdn.sheetjs.com/...tgz) because the project left npm. That is a URL
// dependency on purpose: npm has no newer build to resolve, and pinning the
// vulnerable one to keep a registry-shaped entry would be the worse trade.
// Check the tarball URL still resolves when bumping; a dead CDN fails the
// install rather than silently falling back.

import { dialog, BrowserWindow } from 'electron'
import { basename } from 'path'
import { readFile, writeFile } from 'fs/promises'
import * as XLSX from 'xlsx'
import type { SheetBodyV2, SheetTab, SheetNumberFormat, SheetValidation, SheetValidationRule, SheetCondRule, SheetCondOp } from '@shared/types'
import { mapNumFmt, toExcelNumFmt } from '@shared/sheetNumFmt'
import { buildStyledXlsx } from './sheetXlsxWriter'

export interface SheetImportResult {
  ok: boolean
  body?: SheetBodyV2
  name?: string
  error?: string
}
export interface SheetExportResult {
  ok: boolean
  path?: string
  error?: string
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

let seq = 0
function tabId(): string {
  seq += 1
  return `imp-${seq}`
}


function worksheetToTab(ws: XLSX.WorkSheet, name: string): SheetTab {
  const ref = ws['!ref']
  if (!ref) return { id: tabId(), name, columns: ['A'], rows: [['']] }
  const range = XLSX.utils.decode_range(ref)
  const nCols = range.e.c - range.s.c + 1
  const nRows = range.e.r - range.s.r + 1
  const columns = Array.from({ length: nCols }, (_, i) => XLSX.utils.encode_col(range.s.c + i))
  const rows: string[][] = []
  const formats: Record<string, SheetNumberFormat> = {}

  for (let r = 0; r < nRows; r++) {
    const row: string[] = []
    for (let c = 0; c < nCols; c++) {
      const addr = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })
      const cell = ws[addr] as XLSX.CellObject | undefined
      if (!cell) {
        row.push('')
        continue
      }
      // Prefer the formula (so it stays live in our engine); else the value.
      if (cell.f) row.push(`=${cell.f}`)
      else if (cell.w != null) row.push(String(cell.w))
      else if (cell.v != null) row.push(String(cell.v))
      else row.push('')
      const nf = mapNumFmt(cell.z as string | undefined)
      if (nf) formats[`${r},${c}`] = nf
    }
    rows.push(row)
  }

  const tab: SheetTab = { id: tabId(), name, columns, rows }
  if (Object.keys(formats).length) {
    tab.formats = Object.fromEntries(Object.entries(formats).map(([k, numFmt]) => [k, { numFmt }]))
  }

  // Column widths (Excel gives char units or px; we store px). Indexed relative
  // to the tab's first column so it lines up with our columns[] array.
  const cols = ws['!cols'] as XLSX.ColInfo[] | undefined
  if (cols) {
    const colWidths: Record<number, number> = {}
    for (let i = 0; i < nCols; i++) {
      const ci = cols[range.s.c + i]
      if (!ci) continue
      // Prefer char width (wch) * 7 to invert our writer's px→char (px/7); wpx is
      // SheetJS's own conversion at a different metric, so it drifts.
      const px =
        ci.wch != null ? Math.round(ci.wch * 7) : ci.width != null ? Math.round(ci.width * 7) : ci.wpx != null ? ci.wpx : null
      if (px != null && px > 0) colWidths[i] = px
    }
    if (Object.keys(colWidths).length) tab.colWidths = colWidths
  }

  // Merged cell ranges. SheetJS exposes these as absolute-coordinate ranges; we
  // store them relative to the tab's own origin.
  const merges = ws['!merges'] as XLSX.Range[] | undefined
  if (merges?.length) {
    const rel = merges
      .map((m) => ({ r1: m.s.r - range.s.r, c1: m.s.c - range.s.c, r2: m.e.r - range.s.r, c2: m.e.c - range.s.c }))
      .filter((m) => m.r1 >= 0 && m.c1 >= 0 && (m.r2 > m.r1 || m.c2 > m.c1))
    if (rel.length) tab.merges = rel
  }

  // Row heights (Excel gives px or points; we store px).
  const rowInfos = ws['!rows'] as XLSX.RowInfo[] | undefined
  if (rowInfos) {
    const rowHeights: Record<number, number> = {}
    for (let r = 0; r < nRows; r++) {
      const ri = rowInfos[range.s.r + r]
      if (!ri) continue
      // Prefer points (hpt) converted to px to invert our writer's px→pt; SheetJS's
      // hpx echoes the point value rather than a true 96dpi px.
      const px = ri.hpt != null ? Math.round((ri.hpt * 96) / 72) : ri.hpx != null ? ri.hpx : null
      if (px != null && px > 0) rowHeights[r] = px
    }
    if (Object.keys(rowHeights).length) tab.rowHeights = rowHeights
  }

  return tab
}

// Exposed for unit tests: convert a SheetJS worksheet to our tab model. Pure.
export function _worksheetToTabForTest(ws: XLSX.WorkSheet, name: string): SheetTab {
  return worksheetToTab(ws, name)
}

const CELLIS_TO_OP: Record<string, SheetCondOp> = {
  greaterThan: 'gt',
  lessThan: 'lt',
  greaterThanOrEqual: 'ge',
  lessThanOrEqual: 'le',
  equal: 'eq',
  notEqual: 'ne',
  between: 'between'
}

// An 8-digit ARGB (as Excel stores colours) to a #RRGGBB hex, dropping alpha.
function argbToHex(argb: string | undefined): string | undefined {
  if (!argb) return undefined
  const h = argb.length === 8 ? argb.slice(2) : argb
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : undefined
}

// Parse styles.xml <dxfs> into an indexed list of {bg,color,bold} — the styles a
// conditional-format compare rule points at via dxfId.
function parseDxfs(stylesXml: string): Array<{ bg?: string; color?: string; bold?: boolean }> {
  const block = /<dxfs\b[^>]*>([\s\S]*?)<\/dxfs>/.exec(stylesXml)?.[1] ?? ''
  return (block.match(/<dxf>[\s\S]*?<\/dxf>/g) ?? []).map((dxf) => {
    const font = /<font>[\s\S]*?<\/font>/.exec(dxf)?.[0] ?? ''
    const out: { bg?: string; color?: string; bold?: boolean } = {}
    if (/<b\/>|<b\s*\/>|<b>/.test(font)) out.bold = true
    const fontColor = argbToHex(/<color\b[^>]*\brgb="([0-9a-fA-F]+)"/.exec(font)?.[1])
    if (fontColor) out.color = fontColor
    const bg = argbToHex(/<bgColor\b[^>]*\brgb="([0-9a-fA-F]+)"/.exec(dxf)?.[1])
    if (bg) out.bg = bg
    return out
  })
}

// Conditional formatting keyed by sheet name. SheetJS drops it, so read the
// <conditionalFormatting> blocks from each worksheet and resolve compare-rule
// styling through the dxfs table. Colour-scale / data-bar / icon-set rules carry
// their colours inline, so they round-trip too.
export async function parseXlsxCondFormatting(data: Uint8Array): Promise<Record<string, SheetCondRule[]>> {
  const out: Record<string, SheetCondRule[]> = {}
  try {
    const { unzipSync, strFromU8 } = await import('fflate')
    const files = unzipSync(data) as XlsxFiles
    const stylesKey = Object.keys(files).find((n) => /xl\/styles\.xml$/i.test(n))
    const dxfs = stylesKey ? parseDxfs(strFromU8(files[stylesKey])) : []
    let id = 0
    for (const [name, xml] of worksheetsFromFiles(files, strFromU8)) {
      const rules: SheetCondRule[] = []
      for (const cf of xml.match(/<conditionalFormatting\b[\s\S]*?<\/conditionalFormatting>/g) ?? []) {
        const range = /sqref="([^"]+)"/.exec(cf)?.[1]?.split(/\s+/)[0]
        if (!range) continue
        // A cfRule is either self-closing or has children (colour-scale/data-bar
        // rules contain self-closing <cfvo/> that must not end the match early).
        for (const cr of cf.match(/<cfRule\b[^>]*\/>|<cfRule\b[^>]*>[\s\S]*?<\/cfRule>/g) ?? []) {
          const type = /type="([^"]+)"/.exec(cr)?.[1] ?? ''
          const dxfId = Number(/dxfId="(\d+)"/.exec(cr)?.[1] ?? -1)
          const style = dxfId >= 0 ? dxfs[dxfId] ?? {} : {}
          const decode = (s?: string): string | undefined => s?.replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()
          const formulae = [...cr.matchAll(/<formula>([\s\S]*?)<\/formula>/g)].map((m) => decode(m[1]) ?? '')
          let rule: SheetCondRule | null = null
          const base = { id: `imp-cf-${id++}`, range, ...style }
          if (type === 'cellIs') {
            const op = CELLIS_TO_OP[/operator="([^"]+)"/.exec(cr)?.[1] ?? '']
            if (op) {
              const val = (f?: string): string | undefined => (f == null ? undefined : /^".*"$/.test(f) ? f.slice(1, -1) : f)
              rule = { ...base, kind: 'compare', op, value: val(formulae[0]), ...(op === 'between' ? { value2: val(formulae[1]) } : {}) }
            }
          } else if (type === 'containsText') {
            const text = /SEARCH\(\s*"([^"]*)"/.exec(formulae[0] ?? '')?.[1] ?? /text="([^"]*)"/.exec(cr)?.[1]
            rule = { ...base, kind: 'compare', op: 'contains', value: text ?? '' }
          } else if (type === 'expression' && /LEN\(TRIM\(/.test(formulae[0] ?? '')) {
            rule = { ...base, kind: 'compare', op: 'notEmpty' }
          } else if (type === 'colorScale') {
            const colors = [...cr.matchAll(/<color\b[^>]*\brgb="([0-9a-fA-F]+)"/g)].map((m) => argbToHex(m[1]))
            if (colors.length >= 2) {
              rule = {
                id: base.id,
                range,
                kind: 'colorScale',
                op: 'gt',
                minColor: colors[0],
                ...(colors.length >= 3 ? { midColor: colors[1], maxColor: colors[2] } : { maxColor: colors[colors.length - 1] })
              }
            }
          } else if (type === 'dataBar') {
            const barColor = argbToHex([...cr.matchAll(/<color\b[^>]*\brgb="([0-9a-fA-F]+)"/g)].map((m) => m[1])[0])
            rule = { id: base.id, range, kind: 'dataBar', op: 'gt', ...(barColor ? { barColor } : {}) }
          } else if (type === 'iconSet') {
            const name2 = /<iconSet\b[^>]*iconSet="([^"]+)"/.exec(cr)?.[1] ?? ''
            const set = name2.includes('Traffic') ? 'traffic' : name2.includes('Triangle') ? 'triangles' : 'arrows'
            rule = { id: base.id, range, kind: 'iconSet', op: 'gt', iconSet: set }
          }
          if (rule) rules.push(rule)
        }
      }
      if (rules.length) out[name] = rules
    }
  } catch {
    // Malformed package: no conditional formatting recovered, never throw.
  }
  return out
}

type XlsxFiles = Record<string, Uint8Array>

// Resolve each worksheet's XML by sheet name (name → part XML) from an already
// unzipped package, reading the workbook's sheet list and rels. Shared by the
// freeze / validation / conditional-format readers, which recover structure
// SheetJS does not surface.
function worksheetsFromFiles(files: XlsxFiles, strFromU8: (u: Uint8Array) => string): Map<string, string> {
  const out = new Map<string, string>()
  const wbKey = Object.keys(files).find((n) => /xl\/workbook\.xml$/i.test(n))
  const relsKey = Object.keys(files).find((n) => /xl\/_rels\/workbook\.xml\.rels$/i.test(n))
  if (!wbKey || !relsKey) return out
  const rels = new Map<string, string>()
  for (const rel of strFromU8(files[relsKey]).match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /Id="([^"]+)"/.exec(rel)?.[1]
    const target = /Target="([^"]+)"/.exec(rel)?.[1]
    if (id && target) rels.set(id, target.replace(/^\//, '').replace(/^xl\//, ''))
  }
  for (const sheetTag of strFromU8(files[wbKey]).match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = /name="([^"]+)"/.exec(sheetTag)?.[1]
    const rid = /r:id="([^"]+)"/.exec(sheetTag)?.[1]
    if (!name || !rid) continue
    const target = rels.get(rid)
    if (!target) continue
    const key = Object.keys(files).find((n) => n.toLowerCase() === `xl/${target.toLowerCase()}`)
    if (key) out.set(name, strFromU8(files[key]))
  }
  return out
}

async function worksheetXmlByName(data: Uint8Array): Promise<Map<string, string>> {
  const { unzipSync, strFromU8 } = await import('fflate')
  return worksheetsFromFiles(unzipSync(data) as XlsxFiles, strFromU8)
}

// Frozen panes keyed by sheet name. SheetJS does not surface freeze panes, so we
// read them straight from the package XML (<pane xSplit ySplit state="frozen">).
// xSplit is the number of frozen columns, ySplit the frozen rows.
export async function parseXlsxFreeze(data: Uint8Array): Promise<Record<string, { rows: number; cols: number }>> {
  const out: Record<string, { rows: number; cols: number }> = {}
  try {
    for (const [name, xml] of await worksheetXmlByName(data)) {
      const pane = /<pane\b[^>]*>/.exec(xml)?.[0]
      if (!pane || !/state="frozen(Split)?"/.test(pane)) continue
      const cols = Number(/xSplit="(\d+)"/.exec(pane)?.[1] ?? 0)
      const rows = Number(/ySplit="(\d+)"/.exec(pane)?.[1] ?? 0)
      if (rows > 0 || cols > 0) out[name] = { rows, cols }
    }
  } catch {
    // A malformed package just yields no freeze info; never throw here.
  }
  return out
}

type NumOp = 'gt' | 'lt' | 'ge' | 'le' | 'eq' | 'between'
const XLSX_OP_TO_NUM: Record<string, NumOp> = {
  greaterThan: 'gt',
  lessThan: 'lt',
  greaterThanOrEqual: 'ge',
  lessThanOrEqual: 'le',
  equal: 'eq',
  between: 'between'
}

// Data validations keyed by sheet name. SheetJS drops them, so read the
// <dataValidation> elements from the worksheet XML. Only rules we model are
// recovered; a range-based list source (not an inline quoted list) is skipped
// rather than guessed.
export async function parseXlsxValidations(data: Uint8Array): Promise<Record<string, SheetValidation[]>> {
  const out: Record<string, SheetValidation[]> = {}
  try {
    for (const [name, xml] of await worksheetXmlByName(data)) {
      const rules: SheetValidation[] = []
      let i = 0
      for (const dv of xml.match(/<dataValidation\b[\s\S]*?(?:\/>|<\/dataValidation>)/g) ?? []) {
        const sqref = /sqref="([^"]+)"/.exec(dv)?.[1]?.split(/\s+/)[0]
        if (!sqref) continue
        const type = /type="([^"]+)"/.exec(dv)?.[1] ?? ''
        const opAttr = /operator="([^"]+)"/.exec(dv)?.[1]
        const strict = /allowBlank="1"/.test(dv) ? false : true
        const decode = (s?: string): string | undefined =>
          s?.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
        const f1 = decode(/<formula1>([\s\S]*?)<\/formula1>/.exec(dv)?.[1])
        const f2 = decode(/<formula2>([\s\S]*?)<\/formula2>/.exec(dv)?.[1])
        let rule: SheetValidationRule | null = null
        if (type === 'list' && f1) {
          const m = /^"(.*)"$/.exec(f1) // inline quoted list only
          if (m) rule = { kind: 'list', values: m[1].split(',').map((s) => s.trim()).filter(Boolean) }
        } else if ((type === 'decimal' || type === 'whole') && f1 != null && Number.isFinite(Number(f1))) {
          // Excel omits operator="between" because it is the numeric default, so a
          // missing operator with two operands means a between-rule.
          const nop: NumOp = opAttr ? XLSX_OP_TO_NUM[opAttr] ?? 'gt' : f2 != null ? 'between' : 'gt'
          rule = { kind: 'number', op: nop, value: Number(f1), ...(nop === 'between' && f2 != null ? { value2: Number(f2) } : {}) }
        } else if (type === 'textLength' && (opAttr === 'greaterThan' || !opAttr)) {
          rule = { kind: 'textNotEmpty' }
        }
        if (rule) rules.push({ id: `imp-dv-${i++}`, range: sqref, rule, ...(strict ? { strict: true } : {}) })
      }
      if (rules.length) out[name] = rules
    }
  } catch {
    // Malformed package: no validations recovered, never throw.
  }
  return out
}

export async function importSheet(): Promise<SheetImportResult> {
  const win = focusedWindow()
  const res = await dialog.showOpenDialog(win!, {
    title: 'Import spreadsheet',
    properties: ['openFile'],
    filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }]
  })
  if (res.canceled || !res.filePaths[0]) return { ok: false }
  const path = res.filePaths[0]
  try {
    const buf = await readFile(path)
    // cellStyles: true so SheetJS parses column widths (!cols) and row heights
    // (!rows) out of the file; without it those structural dimensions are dropped.
    const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellNF: true, cellText: true, cellStyles: true })
    const sheets = wb.SheetNames.map((sn) => worksheetToTab(wb.Sheets[sn], sn))
    if (!sheets.length) return { ok: false, error: 'That workbook has no sheets.' }
    // Recover frozen panes, data validations and conditional formatting (SheetJS
    // drops all three) from the package XML.
    const bytes = new Uint8Array(buf)
    const freeze = await parseXlsxFreeze(bytes)
    const validations = await parseXlsxValidations(bytes)
    const condFormatting = await parseXlsxCondFormatting(bytes)
    for (const tab of sheets) {
      const f = freeze[tab.name]
      if (f) tab.freeze = f
      const v = validations[tab.name]
      if (v) tab.validations = v
      const c = condFormatting[tab.name]
      if (c) tab.condRules = c
    }
    return { ok: true, name: basename(path), body: { version: 2, sheets, activeSheet: 0 } }
  } catch (e) {
    return { ok: false, error: `Could not read that file: ${(e as Error).message}` }
  }
}

function tabToWorksheet(tab: SheetTab): XLSX.WorkSheet {
  const aoa: (string | number)[][] = tab.rows.map((row) =>
    row.map((cell) => {
      if (cell.startsWith('=')) return cell // becomes a formula below
      const n = Number(cell)
      return cell.trim() !== '' && Number.isFinite(n) ? n : cell
    })
  )
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // Re-encode formula cells with the {f} form so Excel keeps them live.
  for (let r = 0; r < tab.rows.length; r++) {
    for (let c = 0; c < tab.rows[r].length; c++) {
      const raw = tab.rows[r][c]
      if (raw.startsWith('=')) {
        const addr = XLSX.utils.encode_cell({ r, c })
        ws[addr] = { t: 'n', f: raw.slice(1) } as XLSX.CellObject
      }
    }
  }
  // Carry per-cell number formats so currency/percent/date render in Excel rather
  // than as bare numbers. (Fonts/fills/colours need a styled writer — exceljs — and
  // are a separate fidelity pass; this keeps numeric meaning intact today.)
  if (tab.formats) {
    for (const [key, fmt] of Object.entries(tab.formats)) {
      const z = toExcelNumFmt(fmt.numFmt)
      if (!z) continue
      const [r, c] = key.split(',').map(Number)
      const addr = XLSX.utils.encode_cell({ r, c })
      const existing = ws[addr] as XLSX.CellObject | undefined
      if (existing) existing.z = z
    }
  }
  // Column widths (px → approximate Excel character width).
  if (tab.colWidths && Object.keys(tab.colWidths).length > 0) {
    const maxCol = Math.max(...tab.rows.map((r) => r.length), 1)
    ws['!cols'] = Array.from({ length: maxCol }, (_, c) => {
      const px = tab.colWidths?.[c]
      return px ? { wch: Math.max(2, Math.round(px / 7)) } : {}
    })
  }
  return ws
}

export async function exportSheet(input: {
  body: SheetBodyV2
  format: 'xlsx' | 'csv'
  name: string
}): Promise<SheetExportResult> {
  const win = focusedWindow()
  const safe = (input.name || 'spreadsheet').replace(/[/\\?%*:|"<>]/g, '-')
  const res = await dialog.showSaveDialog(win!, {
    title: `Export as ${input.format.toUpperCase()}`,
    defaultPath: `${safe}.${input.format}`,
    filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }
  try {
    if (input.format === 'csv') {
      // CSV is single-sheet, computed/raw values only (no formats, no formulas).
      const ws = tabToWorksheet(input.body.sheets[input.body.activeSheet ?? 0])
      const csv = XLSX.utils.sheet_to_csv(ws)
      await writeFile(res.filePath, csv)
    } else {
      // xlsx export goes through exceljs so visual styles (fonts, fills, colours,
      // alignment) survive into real Excel, not just values + number formats.
      const out = await buildStyledXlsx(input.body)
      await writeFile(res.filePath, out)
    }
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: `Could not export: ${(e as Error).message}` }
  }
}
