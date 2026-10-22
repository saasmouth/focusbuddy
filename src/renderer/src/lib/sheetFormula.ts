// The spreadsheet formula engine.
//
// It evaluates A1-style references, ranges, arithmetic, comparisons, string
// concatenation, and a broad function library, to a real value of type number,
// string or boolean. The guiding rule is honesty: what it can compute it
// computes for real, and anything it cannot (a malformed formula, an unknown
// function, a reference cycle, a non-finite result) surfaces a visible #ERR
// rather than a plausible-looking number. A cell is a formula when it starts
// with "=".
//
// Coercion note: a referenced cell that holds non-numeric text counts as 0 in
// arithmetic, matching common spreadsheet behaviour (and the engine's original
// contract). Aggregate functions (SUM, AVERAGE, COUNT, ...) instead ignore
// non-numeric cells, so an average is over the numbers only.

export interface Grid {
  columns: string[]
  rows: string[][]
}

export type CellValue = number | string | boolean

// Excel-style typed errors. A formula surfaces the specific error a user expects
// (#DIV/0!, #N/A, #VALUE!, #NAME?, #NUM!) instead of a generic marker, while
// keeping the honesty rule: an error is a real, visible error, never a fake value.
// Any other thrown Error still falls back to the generic #ERR.
export type FormulaErrorCode = '#DIV/0!' | '#N/A' | '#VALUE!' | '#NAME?' | '#NUM!' | '#REF!' | '#ERR'
export class FormulaError extends Error {
  code: FormulaErrorCode
  constructor(code: FormulaErrorCode) {
    super(code)
    this.code = code
  }
}

// ── Cross-sheet workbook context ────────────────────────────────────────────
// A formula may reference another tab: =Sheet2!A1 or =SUM('My Tab'!A1:A9). The
// evaluator resolves the named tab's grid from this context, which is set for the
// duration of one top-level evaluation. Sheet names match case-insensitively.
export interface Workbook {
  byName: Map<string, Grid>
}
let WB: Workbook | null = null

// Named ranges: a workbook-level map from a name (lower-cased) to an A1 reference
// string such as "A1", "A1:B10" or "Sheet2!A1:C3". Set for the duration of one
// top-level evaluation, like WB. Null means no names are defined, in which case
// the parser behaves exactly as before (a bare name that isn't a cell ref errors).
let NAMES: Map<string, string> | null = null

// LET/LAMBDA scope. A binding is either a value or a lambda (a reusable function
// with parameter names and a body AST). A stack of frames supports nesting and
// shadowing; a bare identifier that is neither a cell ref nor a named range (a
// 'name' node) resolves against these frames. LET/lambda calls push a frame and
// pop it in a finally, so the stack is balanced even on error.
type LambdaDef = { params: string[]; body: Node }
type Binding = { v: CellValue } | { lambda: LambdaDef }
const SCOPE: Array<Map<string, Binding>> = []
function lookupBinding(name: string): Binding | undefined {
  const key = name.toLowerCase()
  for (let i = SCOPE.length - 1; i >= 0; i--) {
    const f = SCOPE[i]
    if (f.has(key)) return f.get(key)
  }
  return undefined
}

// Extract a lambda definition from an inline LAMBDA(...) call node or a name bound
// to a lambda. Returns null when the node is not a lambda (so the caller treats it
// as an ordinary value).
function resolveLambda(n: Node | undefined): LambdaDef | null {
  if (!n) return null
  if (n.k === 'call' && n.name === 'LAMBDA') {
    const params: string[] = []
    for (let i = 0; i < n.args.length - 1; i++) {
      const p = n.args[i]
      if (p.k !== 'name') return null
      params.push(p.name.toLowerCase())
    }
    return { params, body: n.args[n.args.length - 1] ?? { k: 'num', v: 0 } }
  }
  if (n.k === 'name') {
    const b = lookupBinding(n.name)
    if (b && 'lambda' in b) return b.lambda
  }
  return null
}

// Call a lambda with scalar argument values, binding params in a fresh frame.
function applyLambda(def: LambdaDef, vals: CellValue[], grid: Grid, seen: Set<string>): CellValue {
  const frame = new Map<string, Binding>()
  def.params.forEach((p, i) => frame.set(p, { v: vals[i] ?? '' }))
  SCOPE.push(frame)
  try {
    return evalNode(def.body, grid, seen)
  } finally {
    SCOPE.pop()
  }
}

// Bind a LET's name/value pairs into a pushed frame, run `evalBody` on the final
// calculation node, then pop. Shared by the scalar (evalCall) and array
// (evalArrayCall) LET paths so both bind identically.
function withLetScope<T>(args: Node[], grid: Grid, seen: Set<string>, evalBody: (body: Node) => T): T {
  if (args.length < 3 || args.length % 2 === 0) throw new FormulaError('#VALUE!')
  const frame = new Map<string, Binding>()
  SCOPE.push(frame)
  try {
    for (let i = 0; i < args.length - 1; i += 2) {
      const nameNode = args[i]
      if (nameNode.k !== 'name') throw new FormulaError('#NAME?')
      const valNode = args[i + 1]
      const lam = resolveLambda(valNode)
      frame.set(nameNode.name.toLowerCase(), lam ? { lambda: lam } : { v: evalNode(valNode, grid, seen) })
    }
    return evalBody(args[args.length - 1])
  } finally {
    SCOPE.pop()
  }
}

// Build the names map the evaluator consults, from the sheet body's definitions.
export function makeNames(defs: Array<{ name: string; ref: string }> | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const d of defs ?? []) {
    const name = d.name.trim()
    if (name) m.set(name.toLowerCase(), d.ref.trim())
  }
  return m
}

// The grid a ref/range should read from: its own sheet's grid when it carries a
// sheet qualifier we can resolve, otherwise the formula's own (default) grid.
function pickGrid(def: Grid, sheet?: string): Grid {
  if (sheet && WB) {
    const g = WB.byName.get(sheet.toLowerCase())
    if (g) return g
  }
  return def
}

// Stable per-grid id so the cycle-detection key is sheet-aware (A1 on two
// different tabs must not be treated as the same cell).
let gridSeq = 0
const gridIds = new WeakMap<Grid, number>()
function gridId(grid: Grid): number {
  let id = gridIds.get(grid)
  if (id === undefined) {
    id = ++gridSeq
    gridIds.set(grid, id)
  }
  return id
}

// Build a Workbook from named tabs (the renderer passes its sheet list).
export function makeWorkbook(
  sheets: Array<{ name: string; columns: string[]; rows: string[][] }>
): Workbook {
  const byName = new Map<string, Grid>()
  for (const s of sheets) byName.set(s.name.toLowerCase(), { columns: s.columns, rows: s.rows })
  return { byName }
}

// The functions the engine supports, with a short signature hint. Drives the
// in-cell "type =" formula menu so users get quick, discoverable access.
export const SHEET_FUNCTIONS: Array<{ name: string; hint: string }> = [
  { name: 'SUM', hint: 'SUM(range) — add numbers' },
  { name: 'AVERAGE', hint: 'AVERAGE(range) — mean of numbers' },
  { name: 'MIN', hint: 'MIN(range) — smallest number' },
  { name: 'MAX', hint: 'MAX(range) — largest number' },
  { name: 'COUNT', hint: 'COUNT(range) — count of numbers' },
  { name: 'COUNTA', hint: 'COUNTA(range) — count of non-empty cells' },
  { name: 'PRODUCT', hint: 'PRODUCT(range) — multiply numbers' },
  { name: 'COUNTIF', hint: 'COUNTIF(range, criteria)' },
  { name: 'SUMIF', hint: 'SUMIF(range, criteria, [sumRange])' },
  { name: 'AVERAGEIF', hint: 'AVERAGEIF(range, criteria, [avgRange])' },
  { name: 'IF', hint: 'IF(test, ifTrue, ifFalse)' },
  { name: 'AND', hint: 'AND(a, b, …) — all true' },
  { name: 'OR', hint: 'OR(a, b, …) — any true' },
  { name: 'NOT', hint: 'NOT(x)' },
  { name: 'IFERROR', hint: 'IFERROR(value, fallback)' },
  { name: 'ROUND', hint: 'ROUND(number, decimals)' },
  { name: 'ROUNDUP', hint: 'ROUNDUP(number, decimals)' },
  { name: 'ROUNDDOWN', hint: 'ROUNDDOWN(number, decimals)' },
  { name: 'ABS', hint: 'ABS(number)' },
  { name: 'SQRT', hint: 'SQRT(number)' },
  { name: 'POWER', hint: 'POWER(base, exponent)' },
  { name: 'MOD', hint: 'MOD(number, divisor)' },
  { name: 'CONCAT', hint: 'CONCAT(a, b, …) — join text' },
  { name: 'LEN', hint: 'LEN(text)' },
  { name: 'LEFT', hint: 'LEFT(text, n)' },
  { name: 'RIGHT', hint: 'RIGHT(text, n)' },
  { name: 'MID', hint: 'MID(text, start, length)' },
  { name: 'UPPER', hint: 'UPPER(text)' },
  { name: 'LOWER', hint: 'LOWER(text)' },
  { name: 'TRIM', hint: 'TRIM(text)' },
  { name: 'VLOOKUP', hint: 'VLOOKUP(key, table, colIndex, [FALSE]) — look up a row' },
  { name: 'HLOOKUP', hint: 'HLOOKUP(key, table, rowIndex, [FALSE]) — look up a column' },
  { name: 'INDEX', hint: 'INDEX(range, row, [col]) — value at a position' },
  { name: 'MATCH', hint: 'MATCH(key, range, [type]) — position of a value' },
  { name: 'XLOOKUP', hint: 'XLOOKUP(key, lookupRange, returnRange, [ifMissing], [mode]) — modern lookup' },
  { name: 'XMATCH', hint: 'XMATCH(key, range, [mode]) — position, exact or nearest' },
  { name: 'INDIRECT', hint: 'INDIRECT(refText) — a reference held as text, e.g. "A1"' },
  { name: 'SEQUENCE', hint: 'SEQUENCE(rows, [cols], [start], [step]) — spills a grid of numbers' },
  { name: 'TRANSPOSE', hint: 'TRANSPOSE(range) — flips rows and columns (spills)' },
  { name: 'UNIQUE', hint: 'UNIQUE(range) — distinct rows (spills)' },
  { name: 'SORT', hint: 'SORT(range, [column], [ascending]) — sorted rows (spills)' },
  { name: 'FILTER', hint: 'FILTER(range, conditionColumn) — rows where the condition is true (spills)' },
  { name: 'VSTACK', hint: 'VSTACK(a, b, …) — stack ranges/arrays vertically (spills)' },
  { name: 'HSTACK', hint: 'HSTACK(a, b, …) — stack ranges/arrays horizontally (spills)' },
  { name: 'TOROW', hint: 'TOROW(range) — flatten to a single row (spills)' },
  { name: 'TOCOL', hint: 'TOCOL(range) — flatten to a single column (spills)' },
  { name: 'TAKE', hint: 'TAKE(array, rows, [cols]) — first/last rows/cols (spills)' },
  { name: 'DROP', hint: 'DROP(array, rows, [cols]) — drop rows/cols (spills)' },
  { name: 'TEXTSPLIT', hint: 'TEXTSPLIT(text, colDelim, [rowDelim]) — split text into cells (spills)' },
  { name: 'LET', hint: 'LET(name, value, …, calculation) — name reusable values in a formula' },
  { name: 'LAMBDA', hint: 'LAMBDA(param, …, calculation) — a reusable function (use with LET, MAP, REDUCE)' },
  { name: 'MAP', hint: 'MAP(array, …, LAMBDA(x, …)) — apply a lambda to every cell (spills)' },
  { name: 'REDUCE', hint: 'REDUCE(init, array, LAMBDA(acc, v, …)) — fold an array to one value' },
  { name: 'SCAN', hint: 'SCAN(init, array, LAMBDA(acc, v, …)) — running totals (spills)' },
  { name: 'MAKEARRAY', hint: 'MAKEARRAY(rows, cols, LAMBDA(r, c, …)) — build a block (spills)' },
  { name: 'IFS', hint: 'IFS(cond1, val1, cond2, val2, …) — first true wins' },
  { name: 'SWITCH', hint: 'SWITCH(value, case1, result1, …, [default])' },
  { name: 'REGEXMATCH', hint: 'REGEXMATCH(text, pattern) — TRUE if the pattern matches' },
  { name: 'REGEXEXTRACT', hint: 'REGEXEXTRACT(text, pattern) — first match (or group 1)' },
  { name: 'REGEXREPLACE', hint: 'REGEXREPLACE(text, pattern, replacement) — replace all matches' },
  { name: 'LARGE', hint: 'LARGE(range, k) — kth largest value' },
  { name: 'SMALL', hint: 'SMALL(range, k) — kth smallest value' },
  { name: 'COUNTUNIQUE', hint: 'COUNTUNIQUE(range) — count of distinct non-empty values' },
  { name: 'SUMSQ', hint: 'SUMSQ(range) — sum of squares' },
  { name: 'SIGN', hint: 'SIGN(number) — -1, 0 or 1' },
  { name: 'EXP', hint: 'EXP(number) — e to the power' },
  { name: 'LN', hint: 'LN(number) — natural log' },
  { name: 'LOG', hint: 'LOG(number, [base]) — log, base 10 by default' },
  { name: 'LOG10', hint: 'LOG10(number) — base-10 log' },
  { name: 'CHAR', hint: 'CHAR(code) — character for a code point' },
  { name: 'CODE', hint: 'CODE(text) — code point of the first character' },
  { name: 'CLEAN', hint: 'CLEAN(text) — remove non-printable characters' },
  { name: 'DATE', hint: 'DATE(year, month, day) — build a date' },
  { name: 'DAYS', hint: 'DAYS(end, start) — days between two dates' },
  { name: 'EDATE', hint: 'EDATE(date, months) — shift by whole months' },
  { name: 'EOMONTH', hint: 'EOMONTH(date, months) — last day of the shifted month' },
  { name: 'DATEDIF', hint: 'DATEDIF(start, end, "D"|"M"|"Y") — difference in units' },
  { name: 'SUMIFS', hint: 'SUMIFS(sumRange, range1, crit1, …)' },
  { name: 'COUNTIFS', hint: 'COUNTIFS(range1, crit1, …)' },
  { name: 'AVERAGEIFS', hint: 'AVERAGEIFS(avgRange, range1, crit1, …)' },
  { name: 'SUMPRODUCT', hint: 'SUMPRODUCT(rangeA, rangeB, …)' },
  { name: 'MEDIAN', hint: 'MEDIAN(range) — middle value' },
  { name: 'STDEV', hint: 'STDEV(range) — sample standard deviation' },
  { name: 'VAR', hint: 'VAR(range) — sample variance' },
  { name: 'COUNTBLANK', hint: 'COUNTBLANK(range) — count of empty cells' },
  { name: 'INT', hint: 'INT(number) — round down to integer' },
  { name: 'TRUNC', hint: 'TRUNC(number, [decimals]) — drop decimals' },
  { name: 'CEILING', hint: 'CEILING(number, [significance])' },
  { name: 'FLOOR', hint: 'FLOOR(number, [significance])' },
  { name: 'FIND', hint: 'FIND(needle, text, [start]) — case-sensitive position' },
  { name: 'SEARCH', hint: 'SEARCH(needle, text, [start]) — case-insensitive position' },
  { name: 'SUBSTITUTE', hint: 'SUBSTITUTE(text, old, new, [nth])' },
  { name: 'REPLACE', hint: 'REPLACE(text, start, length, new)' },
  { name: 'TEXTJOIN', hint: 'TEXTJOIN(delim, ignoreEmpty, …)' },
  { name: 'PROPER', hint: 'PROPER(text) — Title Case' },
  { name: 'VALUE', hint: 'VALUE(text) — text to number' },
  { name: 'YEAR', hint: 'YEAR(date)' },
  { name: 'MONTH', hint: 'MONTH(date)' },
  { name: 'DAY', hint: 'DAY(date)' },
  { name: 'WEEKDAY', hint: 'WEEKDAY(date) — 1=Sunday' },
  { name: 'TODAY', hint: 'TODAY() — current date' },
  { name: 'NOW', hint: 'NOW() — current date and time' },
  { name: 'SPARKLINE', hint: 'SPARKLINE(range, ["line"|"bar"]) — a mini chart inside the cell' },
  { name: 'TEXT', hint: 'TEXT(value, format) — format a number/date as text, e.g. "0.00", "0%", "yyyy-mm-dd"' },
  { name: 'ISBLANK', hint: 'ISBLANK(value) — TRUE if the cell is empty' },
  { name: 'ISNUMBER', hint: 'ISNUMBER(value) — TRUE if it is a number' },
  { name: 'ISTEXT', hint: 'ISTEXT(value) — TRUE if it is text' },
  { name: 'ISLOGICAL', hint: 'ISLOGICAL(value) — TRUE if it is TRUE/FALSE' },
  { name: 'ISERROR', hint: 'ISERROR(value) — TRUE if the value is any error' },
  { name: 'ISNA', hint: 'ISNA(value) — TRUE only if the value is #N/A' },
  { name: 'NA', hint: 'NA() — the #N/A error value' },
  { name: 'ISEVEN', hint: 'ISEVEN(number)' },
  { name: 'ISODD', hint: 'ISODD(number)' },
  { name: 'ROW', hint: 'ROW(ref) — the row number of a reference' },
  { name: 'COLUMN', hint: 'COLUMN(ref) — the column number of a reference' },
  { name: 'ROWS', hint: 'ROWS(range) — number of rows in a range' },
  { name: 'COLUMNS', hint: 'COLUMNS(range) — number of columns in a range' },
  { name: 'CHOOSE', hint: 'CHOOSE(index, a, b, …) — pick the index-th value' },
  { name: 'MROUND', hint: 'MROUND(number, multiple) — round to the nearest multiple' },
  { name: 'RANK', hint: 'RANK(value, range, [ascending]) — position of a value' },
  { name: 'HOUR', hint: 'HOUR(datetime)' },
  { name: 'MINUTE', hint: 'MINUTE(datetime)' },
  { name: 'SECOND', hint: 'SECOND(datetime)' },
  { name: 'PMT', hint: 'PMT(rate, nper, pv, [fv], [type]) — loan payment per period' },
  { name: 'FV', hint: 'FV(rate, nper, pmt, [pv], [type]) — future value' },
  { name: 'PV', hint: 'PV(rate, nper, pmt, [fv], [type]) — present value' },
  { name: 'NPV', hint: 'NPV(rate, value1, value2, …) — net present value' }
]

// ── References ────────────────────────────────────────────────────────────────

function colToIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function refToCoord(
  ref: string
): { r: number; c: number; absR: boolean; absC: boolean } | null {
  // Optional $ before the column letters and/or the row number (e.g. $A$1, A$1).
  const m = ref.toUpperCase().match(/^(\$?)([A-Z]+)(\$?)(\d+)$/)
  if (!m) return null
  const absC = m[1] === '$'
  const c = colToIndex(m[2])
  const absR = m[3] === '$'
  const r = parseInt(m[4], 10) - 1
  if (r < 0 || c < 0) return null
  return { r, c, absR, absC }
}

// Render a column index back to letters (A, B, …, AA). Local copy so the engine
// stays self-contained (sheetBody.colLabel is the renderer-facing twin).
function indexToCol(c: number): string {
  let s = ''
  let n = c
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

// Render a single A1 reference with its absolute markers preserved.
function refToA1(r: number, c: number, absR: boolean, absC: boolean): string {
  return `${absC ? '$' : ''}${indexToCol(c)}${absR ? '$' : ''}${r + 1}`
}

function cellRaw(grid: Grid, r: number, c: number): string {
  return grid.rows[r]?.[c] ?? ''
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string; sheet?: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' }
  | { t: 'colon' }
  | { t: 'err'; v: FormulaErrorCode }

// An error code written INTO a formula, e.g. =#REF!*2. Both rewriters emit this
// when a reference is broken — pasted off the grid, or its row deleted — so the
// code has to survive a round trip through parse and serialize, or the formula
// becomes unparseable and the cell shows the generic #ERR instead of naming the
// problem. Ordered longest-first so #NUM! cannot shadow a longer code.
const ERROR_LITERAL = /^#(?:DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|REF!|ERR)/

function tokenize(s: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '#') {
      const err = s.slice(i).match(ERROR_LITERAL)
      if (err) {
        toks.push({ t: 'err', v: err[0] as FormulaErrorCode })
        i += err[0].length
        continue
      }
    }
    if (ch === '"') {
      let str = ''
      i++
      while (i < s.length && s[i] !== '"') {
        str += s[i]
        i++
      }
      if (s[i] !== '"') throw new Error('unterminated string')
      i++
      toks.push({ t: 'str', v: str })
      continue
    }
    // Sheet-qualified reference: Sheet1!A1 or 'My Sheet'!A1. The qualifier binds
    // to the cell ref that follows; for a range (Sheet1!A1:B2) the colon + second
    // ref are tokenized normally and the parser carries the sheet onto the range.
    const sheetMatch = s
      .slice(i)
      .match(/^(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*))!(\$?[A-Za-z]+\$?\d+)/)
    if (sheetMatch) {
      toks.push({ t: 'ident', v: sheetMatch[3], sheet: sheetMatch[1] ?? sheetMatch[2] })
      i += sheetMatch[0].length
      continue
    }
    const numMatch = s.slice(i).match(/^\d+(\.\d+)?/)
    if (numMatch) {
      toks.push({ t: 'num', v: parseFloat(numMatch[0]) })
      i += numMatch[0].length
      continue
    }
    // Identifiers double as function names AND cell references. Allow optional
    // `$` markers so absolute references ($A$1, A$1, $A1) tokenize as one ident;
    // function names never carry `$`, so this is unambiguous.
    const idMatch = s.slice(i).match(/^\$?[A-Za-z]+\$?\d*/)
    if (idMatch) {
      toks.push({ t: 'ident', v: idMatch[0] })
      i += idMatch[0].length
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') {
      toks.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('+-*/^&=<>'.includes(ch)) {
      toks.push({ t: 'op', v: ch })
      i++
      continue
    }
    if (ch === '(') { toks.push({ t: 'lp' }); i++; continue }
    if (ch === ')') { toks.push({ t: 'rp' }); i++; continue }
    if (ch === ',') { toks.push({ t: 'comma' }); i++; continue }
    if (ch === ':') { toks.push({ t: 'colon' }); i++; continue }
    throw new Error(`unexpected char ${ch}`)
  }
  return toks
}

// ── AST ───────────────────────────────────────────────────────────────────────

// `absR`/`absC` mark a `$`-anchored row/column (e.g. $A$1). The evaluator ignores
// them; only the reference-rewriter (autofill / copy) and the serializer read
// them, so an absolute ref stays put while a relative one shifts by the fill
// offset, exactly like Excel and Sheets.
type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; code: FormulaErrorCode }
  | { k: 'ref'; r: number; c: number; absR?: boolean; absC?: boolean; sheet?: string }
  | {
      k: 'range'
      r1: number
      c1: number
      r2: number
      c2: number
      absR1?: boolean
      absC1?: boolean
      absR2?: boolean
      absC2?: boolean
      sheet?: string
    }
  | { k: 'unary'; op: string; x: Node }
  | { k: 'binary'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] }
  // A bare identifier that is neither a cell reference nor a defined named range.
  // It resolves at eval time against LET's scope stack; unresolved is a #NAME?.
  | { k: 'name'; name: string }

// Resolve a named range's A1 reference string into an AST node, handling an
// optional sheet qualifier and a single cell or a range. Returns null if it does
// not parse, so a malformed name definition simply fails to resolve.
function refToNode(refStr: string): Node | null {
  let body = refStr.trim()
  let sheet: string | undefined
  const bang = body.indexOf('!')
  if (bang >= 0) {
    let q = body.slice(0, bang).trim()
    if (q.startsWith("'") && q.endsWith("'")) q = q.slice(1, -1)
    sheet = q
    body = body.slice(bang + 1).trim()
  }
  const colon = body.indexOf(':')
  if (colon >= 0) {
    const a = refToCoord(body.slice(0, colon).trim())
    const b = refToCoord(body.slice(colon + 1).trim())
    if (!a || !b) return null
    return {
      k: 'range',
      r1: Math.min(a.r, b.r),
      c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r),
      c2: Math.max(a.c, b.c),
      ...(sheet ? { sheet } : {})
    }
  }
  const a = refToCoord(body)
  if (!a) return null
  return { k: 'ref', r: a.r, c: a.c, absR: a.absR, absC: a.absC, ...(sheet ? { sheet } : {}) }
}

function parse(src: string): Node {
  const toks = tokenize(src)
  let p = 0
  const peek = (): Tok | undefined => toks[p]
  const next = (): Tok => toks[p++]

  function parseExpr(): Node {
    return parseComparison()
  }
  function parseComparison(): Node {
    let a = parseConcat()
    while (peek()?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes((peek() as { v: string }).v)) {
      const op = (next() as { v: string }).v
      a = { k: 'binary', op, a, b: parseConcat() }
    }
    return a
  }
  function parseConcat(): Node {
    let a = parseAdd()
    while (peek()?.t === 'op' && (peek() as { v: string }).v === '&') {
      next()
      a = { k: 'binary', op: '&', a, b: parseAdd() }
    }
    return a
  }
  function parseAdd(): Node {
    let a = parseMul()
    while (peek()?.t === 'op' && ['+', '-'].includes((peek() as { v: string }).v)) {
      const op = (next() as { v: string }).v
      a = { k: 'binary', op, a, b: parseMul() }
    }
    return a
  }
  function parseMul(): Node {
    let a = parsePow()
    while (peek()?.t === 'op' && ['*', '/'].includes((peek() as { v: string }).v)) {
      const op = (next() as { v: string }).v
      a = { k: 'binary', op, a, b: parsePow() }
    }
    return a
  }
  function parsePow(): Node {
    const a = parseUnary()
    if (peek()?.t === 'op' && (peek() as { v: string }).v === '^') {
      next()
      return { k: 'binary', op: '^', a, b: parsePow() } // right-assoc
    }
    return a
  }
  function parseUnary(): Node {
    if (peek()?.t === 'op' && ['+', '-'].includes((peek() as { v: string }).v)) {
      const op = (next() as { v: string }).v
      return { k: 'unary', op, x: parseUnary() }
    }
    return parsePrimary()
  }
  function parsePrimary(): Node {
    const tok = peek()
    if (!tok) throw new Error('unexpected end')
    if (tok.t === 'num') { next(); return { k: 'num', v: tok.v } }
    if (tok.t === 'str') { next(); return { k: 'str', v: tok.v } }
    if (tok.t === 'err') { next(); return { k: 'err', code: tok.v } }
    if (tok.t === 'lp') {
      next()
      const e = parseExpr()
      if (peek()?.t !== 'rp') throw new Error('missing )')
      next()
      return e
    }
    if (tok.t === 'ident') {
      next()
      const name = tok.v
      if (peek()?.t === 'lp') {
        next()
        const args: Node[] = []
        if (peek()?.t !== 'rp') {
          args.push(parseArg())
          while (peek()?.t === 'comma') {
            next()
            args.push(parseArg())
          }
        }
        if (peek()?.t !== 'rp') throw new Error('missing ) in call')
        next()
        return { k: 'call', name: name.toUpperCase(), args }
      }
      const upper = name.toUpperCase()
      if (upper === 'TRUE') return { k: 'bool', v: true }
      if (upper === 'FALSE') return { k: 'bool', v: false }
      const coord = refToCoord(name)
      if (coord) {
        return {
          k: 'ref',
          r: coord.r,
          c: coord.c,
          absR: coord.absR,
          absC: coord.absC,
          ...(tok.sheet ? { sheet: tok.sheet } : {})
        }
      }
      // Not a cell reference — try a defined named range, which resolves to the
      // ref or range it points at. Cell-ref syntax always wins, so a name can
      // never shadow A1 (and Sheets forbids naming a range like a cell anyway).
      if (NAMES) {
        const ref = NAMES.get(name.toLowerCase())
        const node = ref ? refToNode(ref) : null
        if (node) return node
      }
      // Not a cell ref or a named range: defer to eval, where it resolves against
      // a LET scope (or surfaces #NAME? if unbound). This is what lets LET name
      // its locals without a parse-time declaration.
      return { k: 'name', name }
    }
    throw new Error('parse error')
  }
  // An argument may be a range (ref:ref). Otherwise a normal expression.
  function parseArg(): Node {
    const start = p
    const tok = peek()
    if (tok?.t === 'ident' && toks[p + 1]?.t === 'colon') {
      const a = refToCoord(tok.v)
      const endTok = toks[p + 2]
      if (a && endTok?.t === 'ident') {
        const b = refToCoord(endTok.v)
        if (b) {
          p += 3
          // Normalize each axis independently, keeping each endpoint's $-flag
          // attached to whichever side it lands on after min/max.
          const rowFirst = a.r <= b.r
          const colFirst = a.c <= b.c
          return {
            k: 'range',
            r1: Math.min(a.r, b.r),
            c1: Math.min(a.c, b.c),
            r2: Math.max(a.r, b.r),
            c2: Math.max(a.c, b.c),
            absR1: rowFirst ? a.absR : b.absR,
            absC1: colFirst ? a.absC : b.absC,
            absR2: rowFirst ? b.absR : a.absR,
            absC2: colFirst ? b.absC : a.absC,
            // The sheet qualifier (if any) rides on the first ref and covers the
            // whole range, e.g. Sheet2!A1:B10.
            ...(tok.sheet ? { sheet: tok.sheet } : {})
          }
        }
      }
      p = start
    }
    return parseExpr()
  }

  const node = parseExpr()
  if (p !== toks.length) throw new Error('trailing tokens')
  return node
}

// ── Serialization & reference rewriting (autofill / copy) ──────────────────────

const PREC: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5
}

// Turn an AST back into a formula string. Precedence-aware so it adds parentheses
// only where they're needed to preserve meaning (and round-trips through parse).
// Render a sheet qualifier for serialization: bare when it is a simple name,
// single-quoted when it contains spaces or punctuation (e.g. 'Q1 Plan'!A1).
function sheetPrefix(sheet?: string): string {
  if (!sheet) return ''
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? `${sheet}!` : `'${sheet}'!`
}

function nodeToString(node: Node): string {
  switch (node.k) {
    case 'err':
      return node.code
    case 'num':
      return String(node.v)
    case 'str':
      return `"${node.v.replace(/"/g, '""')}"`
    case 'bool':
      return node.v ? 'TRUE' : 'FALSE'
    case 'ref':
      return sheetPrefix(node.sheet) + refToA1(node.r, node.c, !!node.absR, !!node.absC)
    case 'range':
      return (
        sheetPrefix(node.sheet) +
        refToA1(node.r1, node.c1, !!node.absR1, !!node.absC1) +
        ':' +
        refToA1(node.r2, node.c2, !!node.absR2, !!node.absC2)
      )
    case 'unary': {
      const inner = nodeToString(node.x)
      return `${node.op}${node.x.k === 'binary' ? `(${inner})` : inner}`
    }
    case 'binary': {
      const p = PREC[node.op] ?? 0
      const rightAssoc = node.op === '^'
      const wrap = (child: Node, isRight: boolean): string => {
        const s = nodeToString(child)
        if (child.k !== 'binary') return s
        const cp = PREC[child.op] ?? 0
        // Lower-precedence children always need parens. Equal precedence needs
        // parens on the associativity-breaking side (right side for left-assoc
        // ops, left side for the right-assoc ^).
        const needs = cp < p || (cp === p && (rightAssoc ? !isRight : isRight))
        return needs ? `(${s})` : s
      }
      return `${wrap(node.a, false)}${node.op}${wrap(node.b, true)}`
    }
    case 'call':
      return `${node.name}(${node.args.map(nodeToString).join(', ')})`
    case 'name':
      return node.name
  }
}

// A broken reference is carried through the AST as a sentinel string node and
// swapped for a bare #REF! after serialization, because the AST has no dedicated
// error node. Shared by both rewriters so a reference broken by a paste and one
// broken by a deleted row produce the identical formula text.
// NUL-delimited because a NUL cannot occur in user-entered formula text,
// whereas a plain word could: ="A REF B" would otherwise be mangled.
const BROKEN_REF = '\u0000REF\u0000'
const unwrapBrokenRefs = (serialized: string): string =>
  serialized.split(`"${BROKEN_REF}"`).join('#REF!')

// Shift every RELATIVE reference in a formula by (dRow, dCol); absolute ($) parts
// stay pinned. Used when a formula is dragged with the fill handle or pasted to a
// new origin, so =B2 dragged one row down becomes =B3, exactly like Excel/Sheets.
// `formula` may include the leading '='. Unparseable input is returned unchanged.
//
// A reference pushed off the top or left edge becomes #REF!, not A1. It used to
// clamp at 0, which produced a formula that looked right and computed something
// else: =C4*2 pasted four rows up became =A1*2, silently multiplying the wrong
// cell. Excel shows #REF! for the same move, and a visible error beats a
// plausible wrong answer. Only the broken reference is replaced, so the rest of
// the formula still reads as written (=C4*2 becomes =#REF!*2), which is also
// what Excel does and tells the user which part to repair.
export function rewriteFormulaRefs(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula
  const hadEquals = formula.startsWith('=')
  const src = hadEquals ? formula.slice(1) : formula
  if (src.trim() === '') return formula
  let ast: Node
  try {
    ast = parse(src)
  } catch {
    return formula
  }
  // Null marks a coordinate that fell off the grid; the reference carrying it is
  // swapped for the sentinel node and serialized to #REF!, the same mechanism
  // remapFormulaRefs uses for a reference whose row or column was deleted.
  const shift = (coord: number, abs: boolean | undefined, delta: number): number | null => {
    if (abs) return coord
    const next = coord + delta
    return next < 0 ? null : next
  }
  const broken = (): Node => ({ k: 'str', v: BROKEN_REF })
  const rewrite = (n: Node): Node => {
    switch (n.k) {
      case 'ref': {
        const r = shift(n.r, n.absR, dRow)
        const c = shift(n.c, n.absC, dCol)
        if (r === null || c === null) return broken()
        return { ...n, r, c }
      }
      case 'range': {
        const r1 = shift(n.r1, n.absR1, dRow)
        const c1 = shift(n.c1, n.absC1, dCol)
        const r2 = shift(n.r2, n.absR2, dRow)
        const c2 = shift(n.c2, n.absC2, dCol)
        // Any endpoint off the grid breaks the whole range: unlike a structural
        // delete, nothing here survived to shrink the range toward.
        if (r1 === null || c1 === null || r2 === null || c2 === null) return broken()
        return { ...n, r1, c1, r2, c2 }
      }
      case 'unary':
        return { ...n, x: rewrite(n.x) }
      case 'binary':
        return { ...n, a: rewrite(n.a), b: rewrite(n.b) }
      case 'call':
        return { ...n, args: n.args.map(rewrite) }
      default:
        return n
    }
  }
  return (hadEquals ? '=' : '') + unwrapBrokenRefs(nodeToString(rewrite(ast)))
}

// Remap references through row/column INDEX maps, for structural edits: inserting,
// deleting, or moving rows/columns. Unlike rewriteFormulaRefs (a uniform relative
// shift), this repoints each coordinate through an arbitrary old->new index map,
// so a mid-sheet insert/delete or a drag-reorder keeps formulas pointing at the
// same data. A map returns the new index, or null when that row/column was
// removed, in which case the reference becomes #REF! rather than being silently
// repointed. Both absolute and relative references remap, because a structural
// edit moves the referenced data itself. References that carry a sheet qualifier
// (=Sheet2!A1) point at another tab and are left untouched. Unparseable input is
// returned unchanged.
export function remapFormulaRefs(
  formula: string,
  mapRow: (r: number) => number | null,
  mapCol: (c: number) => number | null
): string {
  const hadEquals = formula.startsWith('=')
  const src = hadEquals ? formula.slice(1) : formula
  if (src.trim() === '') return formula
  let ast: Node
  try {
    ast = parse(src)
  } catch {
    return formula
  }
  const broken = (): Node => ({ k: 'str', v: BROKEN_REF })
  const remap = (n: Node): Node => {
    switch (n.k) {
      case 'ref': {
        if (n.sheet) return n // cross-sheet ref points elsewhere; leave it
        const nr = mapRow(n.r)
        const nc = mapCol(n.c)
        if (nr === null || nc === null) return broken()
        return { ...n, r: nr, c: nc }
      }
      case 'range': {
        if (n.sheet) return n
        // Map an endpoint; if that exact line was deleted, walk inward toward the
        // other endpoint to the nearest surviving line so the range shrinks to its
        // survivors (deleting the top of A1:A3 leaves A1:A2, not A2:A2). Returns
        // null only when every line between the two endpoints is gone.
        const edge = (start: number, other: number, map: (i: number) => number | null): number | null => {
          const first = map(start)
          if (first !== null) return first
          const step = start <= other ? 1 : -1
          for (let i = start + step; step > 0 ? i <= other : i >= other; i += step) {
            const m = map(i)
            if (m !== null) return m
          }
          return null
        }
        const r1 = edge(n.r1, n.r2, mapRow)
        const r2 = edge(n.r2, n.r1, mapRow)
        const c1 = edge(n.c1, n.c2, mapCol)
        const c2 = edge(n.c2, n.c1, mapCol)
        if (r1 === null || r2 === null || c1 === null || c2 === null) return broken()
        return { ...n, r1, r2, c1, c2 }
      }
      case 'unary':
        return { ...n, x: remap(n.x) }
      case 'binary':
        return { ...n, a: remap(n.a), b: remap(n.b) }
      case 'call':
        return { ...n, args: n.args.map(remap) }
      default:
        return n
    }
  }
  const out = unwrapBrokenRefs(nodeToString(remap(ast)))
  return (hadEquals ? '=' : '') + out
}

// ── Evaluation ────────────────────────────────────────────────────────────────

function toNum(v: CellValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v.trim() === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function toStr(v: CellValue): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6)
  return v
}
function toBool(v: CellValue): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const t = v.trim().toLowerCase()
  if (t === 'true') return true
  if (t === 'false' || t === '') return false
  return true
}
// Parse a date cell for the date functions: an epoch-ms integer or any string
// Date can read (ISO dates parse as UTC). null when it is not a date.
function parseDate(s: string): Date | null {
  const t = s.trim()
  if (t === '') return null
  const d = /^\d+$/.test(t) ? new Date(Number(t)) : new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}

// The evaluated value of a cell (following a formula), or its raw text/number.
function cellValue(grid: Grid, r: number, c: number, seen: Set<string>): CellValue {
  const key = `${gridId(grid)}:${r},${c}`
  if (seen.has(key)) throw new Error('cycle')
  const raw = cellRaw(grid, r, c).trim()
  if (raw.startsWith('=')) {
    const nextSeen = new Set(seen)
    nextSeen.add(key)
    return evalNode(parse(raw.slice(1)), grid, nextSeen)
  }
  if (raw === '') return ''
  const n = Number(raw)
  return raw !== '' && Number.isFinite(n) ? n : raw
}

// The numeric value of a cell, or null if it is not a number (for aggregates).
function cellNumeric(grid: Grid, r: number, c: number, seen: Set<string>): number | null {
  const v = cellValue(grid, r, c, seen)
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function rangeCoords(node: Extract<Node, { k: 'range' }>): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = []
  for (let r = node.r1; r <= node.r2; r++) for (let c = node.c1; c <= node.c2; c++) out.push({ r, c })
  return out
}

function compare(op: string, a: CellValue, b: CellValue): boolean {
  const bothNum = typeof a === 'number' && typeof b === 'number'
  let cmp: number
  if (bothNum) cmp = (a as number) - (b as number)
  else cmp = String(toStr(a)).localeCompare(String(toStr(b)))
  switch (op) {
    case '=':
      return cmp === 0
    case '<>':
      return cmp !== 0
    case '<':
      return cmp < 0
    case '>':
      return cmp > 0
    case '<=':
      return cmp <= 0
    case '>=':
      return cmp >= 0
    default:
      throw new Error(`bad comparison ${op}`)
  }
}

// Match a cell value against a COUNTIF/SUMIF criterion such as ">10" or "x".
function matchCriteria(value: CellValue, criterion: CellValue): boolean {
  const cr = typeof criterion === 'string' ? criterion : toStr(criterion)
  const m = cr.match(/^(<=|>=|<>|<|>|=)(.*)$/)
  if (m) {
    const op = m[1]
    const rhsRaw = m[2].trim()
    const rhs: CellValue = rhsRaw !== '' && Number.isFinite(Number(rhsRaw)) ? Number(rhsRaw) : rhsRaw
    return compare(op === '=' ? '=' : op, value, rhs)
  }
  // Bare value: equality.
  const rhs: CellValue = cr !== '' && Number.isFinite(Number(cr)) ? Number(cr) : cr
  return compare('=', value, rhs)
}

function evalNode(node: Node, grid: Grid, seen: Set<string>): CellValue {
  switch (node.k) {
    case 'err':
      // An error written into the formula evaluates to itself, so =#REF!*2
      // shows #REF! rather than the generic #ERR an unparseable formula gives.
      // It propagates like any other error: anything built on it is also in
      // error, which is what Excel does.
      throw new FormulaError(node.code)
    case 'num':
      return node.v
    case 'str':
      return node.v
    case 'bool':
      return node.v
    case 'ref':
      return cellValue(pickGrid(grid, node.sheet), node.r, node.c, seen)
    case 'range':
      throw new Error('range not allowed here')
    case 'unary': {
      const x = toNum(evalNode(node.x, grid, seen))
      return node.op === '-' ? -x : x
    }
    case 'binary': {
      if (node.op === '&') return toStr(evalNode(node.a, grid, seen)) + toStr(evalNode(node.b, grid, seen))
      if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
        return compare(node.op, evalNode(node.a, grid, seen), evalNode(node.b, grid, seen))
      }
      const a = toNum(evalNode(node.a, grid, seen))
      const b = toNum(evalNode(node.b, grid, seen))
      let r: number
      switch (node.op) {
        case '+': r = a + b; break
        case '-': r = a - b; break
        case '*': r = a * b; break
        case '/': if (b === 0) throw new FormulaError('#DIV/0!'); r = a / b; break
        case '^': r = Math.pow(a, b); break
        default: throw new Error(`bad op ${node.op}`)
      }
      if (!Number.isFinite(r)) throw new Error('not finite')
      return r
    }
    case 'call':
      return evalCall(node, grid, seen)
    case 'name': {
      const b = lookupBinding(node.name)
      if (!b) throw new FormulaError('#NAME?')
      if ('lambda' in b) throw new FormulaError('#VALUE!') // a lambda is not a scalar
      return b.v
    }
  }
}

// Collect the numeric values implied by an argument list (ranges expand to their
// numeric cells; scalars coerce to numbers).
function collectNumbers(args: Node[], grid: Grid, seen: Set<string>): number[] {
  const out: number[] = []
  for (const arg of args) {
    if (arg.k === 'range') {
      const g = pickGrid(grid, arg.sheet)
      for (const { r, c } of rangeCoords(arg)) {
        const n = cellNumeric(g, r, c, seen)
        if (n !== null) out.push(n)
      }
    } else {
      out.push(toNum(evalNode(arg, grid, seen)))
    }
  }
  return out
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A pragmatic TEXT() formatter covering the common number and date patterns
// (fixed decimals, %, thousands, $, and a few explicit date layouts). It is not a
// full Excel format-code engine; unknown patterns fall back to the plain value.
function textFormat(v: CellValue, fmt: string): string {
  const f = fmt.trim()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const dateForms: Record<string, (d: Date) => string> = {
    'yyyy-mm-dd': (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    'mm/dd/yyyy': (d) => `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()}`,
    'dd/mm/yyyy': (d) => `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    'd mmm yyyy': (d) => `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  }
  const dform = dateForms[f.toLowerCase()]
  if (dform) {
    const d = parseDate(typeof v === 'number' ? String(v) : String(v))
    if (d) return dform(d)
  }
  if (!/[0#]/.test(f)) return toStr(v) // not a numeric pattern
  const num = toNum(v)
  const percent = f.includes('%')
  const n = percent ? num * 100 : num
  const dot = f.indexOf('.')
  const decimals = dot >= 0 ? (f.slice(dot).match(/0/g) || []).length : 0
  let s = Math.abs(n).toFixed(decimals)
  if (f.includes(',')) {
    const [intp, frac] = s.split('.')
    s = intp.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '')
  }
  if (f.includes('$')) s = '$' + s
  if (n < 0) s = '-' + s
  if (percent) s += '%'
  return s
}

function evalCall(node: Extract<Node, { k: 'call' }>, grid: Grid, seen: Set<string>): CellValue {
  const name = node.name
  const args = node.args
  const arg = (i: number): CellValue => evalNode(args[i], grid, seen)
  // The grid a range argument reads from — its own sheet's grid when qualified
  // (e.g. SUM(Sheet2!A1:A9)), otherwise this formula's grid.
  const gridOf = (n: Node | undefined): Grid =>
    pickGrid(grid, n && (n.k === 'range' || n.k === 'ref') ? n.sheet : undefined)

  // Calling a LET/lambda-bound name, e.g. LET(f, LAMBDA(x, x*2), f(A1)). The name
  // parses as a call; if it resolves to a lambda in scope, apply it to the args.
  const bound = lookupBinding(name.toLowerCase())
  if (bound && 'lambda' in bound) {
    return applyLambda(bound.lambda, args.map((a) => evalNode(a, grid, seen)), grid, seen)
  }

  switch (name) {
    // LET(name1, value1, [name2, value2, ...], calculation). Binds each name to
    // its value (evaluated with the prior names already in scope), then returns
    // the final calculation. A value that is a LAMBDA(...) binds a callable
    // function. Names that look like a cell reference are rejected by the parser.
    case 'LET':
      return withLetScope(args, grid, seen, (body) => evalNode(body, grid, seen))
    // REDUCE(init, array, LAMBDA(acc, value, result)) folds a lambda over an
    // array to a single value.
    case 'REDUCE': {
      const def = resolveLambda(args[2])
      if (!def) throw new FormulaError('#VALUE!')
      let acc = evalNode(args[0], grid, seen)
      for (const v of flattenMatrix(nodeToMatrix(args[1], grid, seen))) acc = applyLambda(def, [acc, v], grid, seen)
      return acc
    }
    // Aggregates
    case 'SUM':
      return collectNumbers(args, grid, seen).reduce((a, b) => a + b, 0)
    case 'AVERAGE':
    case 'AVG': {
      const ns = collectNumbers(args, grid, seen)
      if (!ns.length) throw new Error('AVERAGE of nothing')
      return ns.reduce((a, b) => a + b, 0) / ns.length
    }
    case 'MIN': {
      const ns = collectNumbers(args, grid, seen)
      return ns.length ? Math.min(...ns) : 0
    }
    case 'MAX': {
      const ns = collectNumbers(args, grid, seen)
      return ns.length ? Math.max(...ns) : 0
    }
    case 'PRODUCT':
      return collectNumbers(args, grid, seen).reduce((a, b) => a * b, 1)
    case 'COUNT': {
      let n = 0
      for (const a of args) {
        if (a.k === 'range') {
          const g = gridOf(a)
          for (const { r, c } of rangeCoords(a)) if (cellNumeric(g, r, c, seen) !== null) n++
        } else if (typeof evalNode(a, grid, seen) === 'number') n++
      }
      return n
    }
    case 'COUNTA': {
      let n = 0
      for (const a of args) {
        if (a.k === 'range') {
          const g = gridOf(a)
          for (const { r, c } of rangeCoords(a)) if (cellRaw(g, r, c).trim() !== '') n++
        } else {
          const v = evalNode(a, grid, seen)
          if (!(typeof v === 'string' && v === '')) n++
        }
      }
      return n
    }
    case 'COUNTIF': {
      if (args[0]?.k !== 'range') throw new Error('COUNTIF needs a range')
      const crit = arg(1)
      const g = gridOf(args[0])
      let n = 0
      for (const { r, c } of rangeCoords(args[0])) if (matchCriteria(cellValue(g, r, c, seen), crit)) n++
      return n
    }
    case 'SUMIF':
    case 'AVERAGEIF': {
      if (args[0]?.k !== 'range') throw new Error(`${name} needs a range`)
      const crit = arg(1)
      const sumRange = args[2]?.k === 'range' ? args[2] : args[0]
      const critGrid = gridOf(args[0])
      const sumGrid = gridOf(sumRange)
      const cells = rangeCoords(args[0])
      const sumCells = rangeCoords(sumRange)
      let sum = 0
      let count = 0
      for (let i = 0; i < cells.length; i++) {
        if (matchCriteria(cellValue(critGrid, cells[i].r, cells[i].c, seen), crit)) {
          const sc = sumCells[i] ?? cells[i]
          const n = cellNumeric(sumGrid, sc.r, sc.c, seen)
          if (n !== null) { sum += n; count++ }
        }
      }
      if (name === 'AVERAGEIF') {
        if (!count) throw new Error('AVERAGEIF of nothing')
        return sum / count
      }
      return sum
    }
    // Logical
    case 'IF':
      return toBool(arg(0)) ? arg(1) : args.length > 2 ? arg(2) : false
    case 'AND':
      return args.every((_, i) => toBool(arg(i)))
    case 'OR':
      return args.some((_, i) => toBool(arg(i)))
    case 'NOT':
      return !toBool(arg(0))
    case 'IFERROR':
      try {
        return arg(0)
      } catch {
        return arg(1)
      }
    // Math
    case 'ROUND': {
      const d = args.length > 1 ? toNum(arg(1)) : 0
      const f = Math.pow(10, d)
      return Math.round(toNum(arg(0)) * f) / f
    }
    case 'ROUNDUP': {
      const d = args.length > 1 ? toNum(arg(1)) : 0
      const f = Math.pow(10, d)
      return Math.ceil(Math.abs(toNum(arg(0))) * f) / f * Math.sign(toNum(arg(0)) || 1)
    }
    case 'ROUNDDOWN': {
      const d = args.length > 1 ? toNum(arg(1)) : 0
      const f = Math.pow(10, d)
      return Math.floor(Math.abs(toNum(arg(0))) * f) / f * Math.sign(toNum(arg(0)) || 1)
    }
    case 'ABS':
      return Math.abs(toNum(arg(0)))
    case 'SQRT': {
      const x = toNum(arg(0))
      if (x < 0) throw new FormulaError('#NUM!')
      return Math.sqrt(x)
    }
    case 'POWER':
      return Math.pow(toNum(arg(0)), toNum(arg(1)))
    case 'MOD': {
      const b = toNum(arg(1))
      if (b === 0) throw new FormulaError('#DIV/0!')
      return toNum(arg(0)) % b
    }
    // Text
    case 'CONCAT':
    case 'CONCATENATE': {
      let out = ''
      for (const a of args) {
        if (a.k === 'range') {
          const g = gridOf(a)
          for (const { r, c } of rangeCoords(a)) out += toStr(cellValue(g, r, c, seen))
        } else out += toStr(evalNode(a, grid, seen))
      }
      return out
    }
    case 'LEN':
      return toStr(arg(0)).length
    case 'LEFT':
      return toStr(arg(0)).slice(0, args.length > 1 ? toNum(arg(1)) : 1)
    case 'RIGHT': {
      const n = args.length > 1 ? toNum(arg(1)) : 1
      const s = toStr(arg(0))
      return n <= 0 ? '' : s.slice(Math.max(0, s.length - n))
    }
    case 'MID': {
      const start = Math.max(1, toNum(arg(1)))
      return toStr(arg(0)).slice(start - 1, start - 1 + toNum(arg(2)))
    }
    case 'UPPER':
      return toStr(arg(0)).toUpperCase()
    case 'LOWER':
      return toStr(arg(0)).toLowerCase()
    case 'TRIM':
      return toStr(arg(0)).trim()
    case 'FIND':
    case 'SEARCH': {
      const needle = toStr(arg(0))
      const hay = toStr(arg(1))
      const start = args.length > 2 ? Math.max(1, toNum(arg(2))) : 1
      const idx =
        name === 'SEARCH'
          ? hay.toLowerCase().indexOf(needle.toLowerCase(), start - 1)
          : hay.indexOf(needle, start - 1)
      if (idx < 0) throw new FormulaError('#VALUE!')
      return idx + 1
    }
    case 'SUBSTITUTE': {
      const s = toStr(arg(0))
      const oldT = toStr(arg(1))
      const newT = toStr(arg(2))
      if (oldT === '') return s
      if (args.length > 3) {
        const nth = toNum(arg(3))
        let count = 0
        let i = 0
        let out = ''
        while (i < s.length) {
          if (s.startsWith(oldT, i)) {
            count++
            if (count === nth) return out + newT + s.slice(i + oldT.length)
            out += oldT
            i += oldT.length
          } else {
            out += s[i]
            i++
          }
        }
        return out
      }
      return s.split(oldT).join(newT)
    }
    case 'REPLACE': {
      const s = toStr(arg(0))
      const start = Math.max(1, toNum(arg(1)))
      const len = toNum(arg(2))
      return s.slice(0, start - 1) + toStr(arg(3)) + s.slice(start - 1 + len)
    }
    case 'REPT':
      return toStr(arg(0)).repeat(Math.max(0, toNum(arg(1))))
    case 'PROPER':
      return toStr(arg(0))
        .toLowerCase()
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
    case 'EXACT':
      return toStr(arg(0)) === toStr(arg(1))
    case 'VALUE': {
      const n = Number(toStr(arg(0)).replace(/[\s,$%]/g, ''))
      if (!Number.isFinite(n)) throw new FormulaError('#VALUE!')
      return n
    }
    case 'TEXTJOIN': {
      const delim = toStr(arg(0))
      const ignoreEmpty = toBool(arg(1))
      const parts: string[] = []
      for (let i = 2; i < args.length; i++) {
        const a = args[i]
        if (a.k === 'range') {
          const g = gridOf(a)
          for (const { r, c } of rangeCoords(a)) {
            const v = toStr(cellValue(g, r, c, seen))
            if (!ignoreEmpty || v !== '') parts.push(v)
          }
        } else {
          const v = toStr(evalNode(a, grid, seen))
          if (!ignoreEmpty || v !== '') parts.push(v)
        }
      }
      return parts.join(delim)
    }
    // Statistical
    case 'MEDIAN': {
      const ns = collectNumbers(args, grid, seen).sort((a, b) => a - b)
      if (!ns.length) throw new Error('MEDIAN of nothing')
      const mid = Math.floor(ns.length / 2)
      return ns.length % 2 ? ns[mid] : (ns[mid - 1] + ns[mid]) / 2
    }
    case 'STDEV':
    case 'STDEVP':
    case 'VAR':
    case 'VARP': {
      const ns = collectNumbers(args, grid, seen)
      const pop = name.endsWith('P')
      if (ns.length < (pop ? 1 : 2)) throw new Error(`${name} needs more numbers`)
      const mean = ns.reduce((a, b) => a + b, 0) / ns.length
      const ss = ns.reduce((a, b) => a + (b - mean) ** 2, 0)
      const variance = ss / (pop ? ns.length : ns.length - 1)
      return name.startsWith('VAR') ? variance : Math.sqrt(variance)
    }
    case 'COUNTBLANK': {
      let n = 0
      for (const a of args) {
        if (a.k === 'range') {
          const g = gridOf(a)
          for (const { r, c } of rangeCoords(a)) if (cellRaw(g, r, c).trim() === '') n++
        } else {
          const v = evalNode(a, grid, seen)
          if (typeof v === 'string' && v.trim() === '') n++
        }
      }
      return n
    }
    // Multi-criteria
    case 'SUMIFS':
    case 'AVERAGEIFS':
    case 'COUNTIFS': {
      const isCount = name === 'COUNTIFS'
      const sumRange = isCount ? null : args[0]?.k === 'range' ? args[0] : null
      if (!isCount && !sumRange) throw new Error(`${name} needs a sum range`)
      const pairStart = isCount ? 0 : 1
      const pairs: Array<{ range: Extract<Node, { k: 'range' }>; crit: CellValue }> = []
      for (let i = pairStart; i + 1 < args.length; i += 2) {
        const rangeNode = args[i]
        if (rangeNode.k !== 'range') throw new Error(`${name}: criteria range expected`)
        pairs.push({ range: rangeNode, crit: evalNode(args[i + 1], grid, seen) })
      }
      if (!pairs.length) throw new Error(`${name} needs a range/criteria pair`)
      const coordsList = pairs.map((p) => rangeCoords(p.range))
      const pairGrids = pairs.map((p) => gridOf(p.range))
      const len = coordsList[0].length
      const sumCells = sumRange ? rangeCoords(sumRange) : null
      const sumGrid = sumRange ? gridOf(sumRange) : grid
      let sum = 0
      let count = 0
      for (let i = 0; i < len; i++) {
        const ok = pairs.every((p, pi) =>
          matchCriteria(cellValue(pairGrids[pi], coordsList[pi][i].r, coordsList[pi][i].c, seen), p.crit)
        )
        if (!ok) continue
        count++
        if (sumCells) {
          const sc = sumCells[i]
          const v = cellNumeric(sumGrid, sc.r, sc.c, seen)
          if (v !== null) sum += v
        }
      }
      if (isCount) return count
      if (name === 'AVERAGEIFS') {
        if (!count) throw new Error('AVERAGEIFS of nothing')
        return sum / count
      }
      return sum
    }
    case 'SUMPRODUCT': {
      const ranges = args.filter((a) => a.k === 'range') as Array<Extract<Node, { k: 'range' }>>
      if (!ranges.length) throw new Error('SUMPRODUCT needs ranges')
      const coordsList = ranges.map(rangeCoords)
      const rangeGrids = ranges.map((rg) => gridOf(rg))
      const len = coordsList[0].length
      let total = 0
      for (let i = 0; i < len; i++) {
        let prod = 1
        for (let ri = 0; ri < ranges.length; ri++) {
          const { r, c } = coordsList[ri][i]
          prod *= cellNumeric(rangeGrids[ri], r, c, seen) ?? 0
        }
        total += prod
      }
      return total
    }
    // Math (extra)
    case 'INT':
      return Math.floor(toNum(arg(0)))
    case 'TRUNC': {
      const d = args.length > 1 ? toNum(arg(1)) : 0
      const f = Math.pow(10, d)
      return Math.trunc(toNum(arg(0)) * f) / f
    }
    case 'CEILING': {
      const sig = args.length > 1 ? toNum(arg(1)) : 1
      return sig === 0 ? 0 : Math.ceil(toNum(arg(0)) / sig) * sig
    }
    case 'FLOOR': {
      const sig = args.length > 1 ? toNum(arg(1)) : 1
      return sig === 0 ? 0 : Math.floor(toNum(arg(0)) / sig) * sig
    }
    case 'SIGN':
      return Math.sign(toNum(arg(0)))
    case 'EXP':
      return Math.exp(toNum(arg(0)))
    case 'LN': {
      const x = toNum(arg(0))
      if (x <= 0) throw new FormulaError('#NUM!')
      return Math.log(x)
    }
    case 'LOG10': {
      const x = toNum(arg(0))
      if (x <= 0) throw new FormulaError('#NUM!')
      return Math.log10(x)
    }
    case 'LOG': {
      const x = toNum(arg(0))
      const base = args.length > 1 ? toNum(arg(1)) : 10
      if (x <= 0) throw new FormulaError('#NUM!')
      return Math.log(x) / Math.log(base)
    }
    // Date
    case 'YEAR':
    case 'MONTH':
    case 'DAY':
    case 'WEEKDAY': {
      const d = parseDate(toStr(arg(0)))
      if (!d) throw new Error(`${name}: bad date`)
      if (name === 'YEAR') return d.getUTCFullYear()
      if (name === 'MONTH') return d.getUTCMonth() + 1
      if (name === 'DAY') return d.getUTCDate()
      return d.getUTCDay() + 1 // WEEKDAY: Sunday = 1
    }
    case 'TODAY': {
      const d = new Date()
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    }
    case 'NOW':
      return new Date().toISOString()
    // Lookup
    case 'MATCH': {
      const key = arg(0)
      if (args[1]?.k !== 'range') throw new Error('MATCH needs a range')
      const g = gridOf(args[1])
      const coords = rangeCoords(args[1])
      const type = args.length > 2 ? toNum(arg(2)) : 1
      if (type === 0) {
        for (let i = 0; i < coords.length; i++)
          if (compare('=', cellValue(g, coords[i].r, coords[i].c, seen), key)) return i + 1
        throw new FormulaError('#N/A')
      }
      let best = -1
      for (let i = 0; i < coords.length; i++) {
        const v = cellValue(g, coords[i].r, coords[i].c, seen)
        if (type === 1 ? compare('<=', v, key) : compare('>=', v, key)) best = i
      }
      if (best < 0) throw new FormulaError('#N/A')
      return best + 1
    }
    case 'INDEX': {
      if (args[0]?.k !== 'range') throw new Error('INDEX needs a range')
      const rg = args[0]
      const g = gridOf(rg)
      const rows = rg.r2 - rg.r1 + 1
      const cols = rg.c2 - rg.c1 + 1
      const a1 = toNum(arg(1))
      let rr: number
      let cc: number
      if (args.length <= 2 && rows === 1) {
        rr = rg.r1
        cc = rg.c1 + (a1 - 1)
      } else if (args.length <= 2 && cols === 1) {
        rr = rg.r1 + (a1 - 1)
        cc = rg.c1
      } else {
        rr = rg.r1 + (a1 - 1)
        cc = rg.c1 + ((args.length > 2 ? toNum(arg(2)) : 1) - 1)
      }
      if (rr < rg.r1 || rr > rg.r2 || cc < rg.c1 || cc > rg.c2) throw new FormulaError('#REF!')
      return cellValue(g, rr, cc, seen)
    }
    case 'VLOOKUP':
    case 'HLOOKUP': {
      const key = arg(0)
      if (args[1]?.k !== 'range') throw new Error(`${name} needs a table range`)
      const rg = args[1]
      const g = gridOf(rg)
      const idx = toNum(arg(2))
      const exact = args.length > 3 ? !toBool(arg(3)) : true
      const horizontal = name === 'HLOOKUP'
      if (idx < 1) throw new FormulaError('#VALUE!')
      const lineVal = (i: number): CellValue =>
        horizontal ? cellValue(g, rg.r1, i, seen) : cellValue(g, i, rg.c1, seen)
      const resultVal = (i: number): CellValue =>
        horizontal ? cellValue(g, rg.r1 + idx - 1, i, seen) : cellValue(g, i, rg.c1 + idx - 1, seen)
      const lo = horizontal ? rg.c1 : rg.r1
      const hi = horizontal ? rg.c2 : rg.r2
      const lim = horizontal ? rg.r1 + idx - 1 : rg.c1 + idx - 1
      if (lim > (horizontal ? rg.r2 : rg.c2)) throw new FormulaError('#REF!')
      for (let i = lo; i <= hi; i++) if (compare('=', lineVal(i), key)) return resultVal(i)
      if (!exact) {
        let best = -1
        for (let i = lo; i <= hi; i++) if (compare('<=', lineVal(i), key)) best = i
        if (best >= 0) return resultVal(best)
      }
      throw new FormulaError('#N/A')
    }
    // ── Lookup (modern) ─────────────────────────────────────────────────────
    case 'XLOOKUP': {
      const key = arg(0)
      if (args[1]?.k !== 'range' || args[2]?.k !== 'range') throw new Error('XLOOKUP needs a lookup range and a return range')
      const lg = gridOf(args[1])
      const rgGrid = gridOf(args[2])
      const lcoords = rangeCoords(args[1])
      const rcoords = rangeCoords(args[2])
      const mode = args.length > 4 ? toNum(arg(4)) : 0
      const lvals = lcoords.map(({ r, c }) => cellValue(lg, r, c, seen))
      let found = lvals.findIndex((v) => compare('=', v, key))
      if (found < 0 && mode !== 0) found = nearestIndex(lvals, key, mode === 1 ? 'up' : 'down')
      if (found < 0) {
        if (args.length > 3) return arg(3)
        throw new FormulaError('#N/A')
      }
      const rc = rcoords[found]
      if (!rc) throw new FormulaError('#VALUE!')
      return cellValue(rgGrid, rc.r, rc.c, seen)
    }
    case 'XMATCH': {
      const key = arg(0)
      if (args[1]?.k !== 'range') throw new Error('XMATCH needs a range')
      const g = gridOf(args[1])
      const coords = rangeCoords(args[1])
      const mode = args.length > 2 ? toNum(arg(2)) : 0
      const vals = coords.map(({ r, c }) => cellValue(g, r, c, seen))
      let found = vals.findIndex((v) => compare('=', v, key))
      if (found < 0 && mode !== 0) found = nearestIndex(vals, key, mode === 1 ? 'up' : 'down')
      if (found < 0) throw new FormulaError('#N/A')
      return found + 1
    }
    // ── Logical (multi-branch) ──────────────────────────────────────────────
    case 'IFS': {
      for (let i = 0; i + 1 < args.length; i += 2) if (toBool(arg(i))) return arg(i + 1)
      throw new FormulaError('#N/A')
    }
    case 'SWITCH': {
      const subject = arg(0)
      let i = 1
      for (; i + 1 < args.length; i += 2) if (compare('=', subject, arg(i))) return arg(i + 1)
      if (i < args.length) return arg(i) // trailing default
      throw new FormulaError('#N/A')
    }
    case 'INDIRECT':
      // Resolve a reference held as text, e.g. INDIRECT("A1") or INDIRECT("S2!B3").
      // Reusing the parser keeps A1 / sheet-qualified semantics identical to a
      // literal reference. A range string yields #ERR (no spill), which is honest.
      return evalNode(parse(toStr(arg(0)).trim()), grid, seen)
    // ── Regex (text) ────────────────────────────────────────────────────────
    case 'REGEXMATCH': {
      const re = compileRegex(toStr(arg(1)))
      return re.test(toStr(arg(0)))
    }
    case 'REGEXEXTRACT': {
      const re = compileRegex(toStr(arg(1)))
      const m = toStr(arg(0)).match(re)
      if (!m) throw new Error('REGEXEXTRACT: no match')
      return m[1] ?? m[0]
    }
    case 'REGEXREPLACE': {
      const re = compileRegex(toStr(arg(1)), 'g')
      return toStr(arg(0)).replace(re, toStr(arg(2)))
    }
    case 'CHAR':
      return String.fromCharCode(Math.trunc(toNum(arg(0))))
    case 'CODE': {
      const s = toStr(arg(0))
      if (!s) throw new Error('CODE of empty text')
      return s.charCodeAt(0)
    }
    case 'CLEAN':
      // Strip non-printable control characters.
      // eslint-disable-next-line no-control-regex
      return toStr(arg(0)).replace(/[\x00-\x1F\x7F]/g, '')
    // ── Stats / math ────────────────────────────────────────────────────────
    case 'LARGE':
    case 'SMALL': {
      const ns = collectNumbers([args[0]], grid, seen).slice().sort((a, b) => (name === 'LARGE' ? b - a : a - b))
      const k = Math.trunc(toNum(arg(1)))
      if (k < 1 || k > ns.length) throw new FormulaError('#NUM!')
      return ns[k - 1]
    }
    case 'COUNTUNIQUE': {
      const set = new Set<string>()
      for (const a of args) {
        if (a.k === 'range') {
          const g = gridOf(a)
          for (const { r, c } of rangeCoords(a)) {
            const raw = cellRaw(g, r, c).trim()
            if (raw !== '') set.add(raw)
          }
        } else {
          const v = toStr(evalNode(a, grid, seen))
          if (v.trim() !== '') set.add(v)
        }
      }
      return set.size
    }
    case 'SUMSQ':
      return collectNumbers(args, grid, seen).reduce((a, b) => a + b * b, 0)
    // ── Dates ───────────────────────────────────────────────────────────────
    case 'DATE': {
      const dt = new Date(Date.UTC(toNum(arg(0)), toNum(arg(1)) - 1, toNum(arg(2))))
      if (Number.isNaN(dt.getTime())) throw new Error('DATE: invalid')
      return isoDate(dt)
    }
    case 'DAYS': {
      const e = parseDate(toStr(arg(0)))
      const s = parseDate(toStr(arg(1)))
      if (!e || !s) throw new Error('DAYS: bad date')
      return Math.round((e.getTime() - s.getTime()) / 86400000)
    }
    case 'EDATE': {
      const d = parseDate(toStr(arg(0)))
      if (!d) throw new Error('EDATE: bad date')
      return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + toNum(arg(1)), d.getUTCDate())))
    }
    case 'EOMONTH': {
      const d = parseDate(toStr(arg(0)))
      if (!d) throw new Error('EOMONTH: bad date')
      return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + toNum(arg(1)) + 1, 0)))
    }
    case 'DATEDIF': {
      const s = parseDate(toStr(arg(0)))
      const e = parseDate(toStr(arg(1)))
      if (!s || !e) throw new Error('DATEDIF: bad date')
      const unit = toStr(arg(2)).toUpperCase()
      if (unit === 'D') return Math.round((e.getTime() - s.getTime()) / 86400000)
      if (unit === 'Y') {
        let y = e.getUTCFullYear() - s.getUTCFullYear()
        if (e.getUTCMonth() < s.getUTCMonth() || (e.getUTCMonth() === s.getUTCMonth() && e.getUTCDate() < s.getUTCDate())) y--
        return y
      }
      if (unit === 'M') {
        let m = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth())
        if (e.getUTCDate() < s.getUTCDate()) m--
        return m
      }
      throw new Error('DATEDIF: unit must be D, M or Y')
    }
    // ── Sparkline ─────────────────────────────────────────────────────────────
    // In the grid a SPARKLINE cell is drawn as a chart (see sparklineForCell). In
    // any text context (CSV export, a formula that references this cell) it
    // resolves to its real values joined by spaces, never a fabricated number.
    case 'SPARKLINE': {
      const last = args[args.length - 1]
      let valueArgs = args
      if (last && last.k !== 'range') {
        const t = toStr(evalNode(last, grid, seen)).trim().toLowerCase()
        if (t === 'bar' || t === 'line') valueArgs = args.slice(0, -1)
      }
      return sparklineValues(valueArgs, grid, seen).map(fmtCell).join(' ')
    }
    // ── Text formatting ───────────────────────────────────────────────────────
    case 'TEXT':
      return textFormat(arg(0), toStr(arg(1)))
    // ── IS* predicates ────────────────────────────────────────────────────────
    case 'ISBLANK': {
      const a = args[0]
      if (a?.k === 'ref') return cellRaw(gridOf(a), a.r, a.c).trim() === ''
      try {
        return evalNode(a, grid, seen) === ''
      } catch {
        return false
      }
    }
    case 'ISNUMBER':
      try {
        return typeof evalNode(args[0], grid, seen) === 'number'
      } catch {
        return false
      }
    case 'ISTEXT': {
      try {
        const v = evalNode(args[0], grid, seen)
        return typeof v === 'string' && v !== ''
      } catch {
        return false
      }
    }
    case 'ISLOGICAL':
      try {
        return typeof evalNode(args[0], grid, seen) === 'boolean'
      } catch {
        return false
      }
    case 'ISERROR':
      try {
        evalNode(args[0], grid, seen)
        return false
      } catch {
        return true
      }
    case 'ISNA':
      try {
        evalNode(args[0], grid, seen)
        return false
      } catch (e) {
        return e instanceof FormulaError && e.code === '#N/A'
      }
    case 'NA':
      throw new FormulaError('#N/A')
    case 'ISEVEN':
      return Math.trunc(toNum(arg(0))) % 2 === 0
    case 'ISODD':
      return Math.abs(Math.trunc(toNum(arg(0))) % 2) === 1
    // ── Reference shape ───────────────────────────────────────────────────────
    case 'ROW': {
      const a = args[0]
      if (a?.k === 'ref') return a.r + 1
      if (a?.k === 'range') return a.r1 + 1
      throw new Error('ROW needs a cell reference')
    }
    case 'COLUMN': {
      const a = args[0]
      if (a?.k === 'ref') return a.c + 1
      if (a?.k === 'range') return a.c1 + 1
      throw new Error('COLUMN needs a cell reference')
    }
    case 'ROWS': {
      const a = args[0]
      if (a?.k === 'range') return Math.abs(a.r2 - a.r1) + 1
      if (a?.k === 'ref') return 1
      throw new Error('ROWS needs a range')
    }
    case 'COLUMNS': {
      const a = args[0]
      if (a?.k === 'range') return Math.abs(a.c2 - a.c1) + 1
      if (a?.k === 'ref') return 1
      throw new Error('COLUMNS needs a range')
    }
    case 'CHOOSE': {
      const i = Math.trunc(toNum(arg(0)))
      const chosen = args[i] // 1-based: args[0] is the index, args[1] the first choice
      if (!chosen) throw new FormulaError('#VALUE!')
      return evalNode(chosen, grid, seen)
    }
    // ── Math ──────────────────────────────────────────────────────────────────
    case 'MROUND': {
      const n = toNum(arg(0))
      const m = toNum(arg(1))
      return m === 0 ? 0 : Math.round(n / m) * m
    }
    case 'RANK': {
      const v = toNum(arg(0))
      if (args[1]?.k !== 'range') throw new Error('RANK needs a range')
      const g = gridOf(args[1])
      const nums: number[] = []
      for (const { r, c } of rangeCoords(args[1])) {
        const n = cellNumeric(g, r, c, seen)
        if (n !== null) nums.push(n)
      }
      const asc = args.length > 2 ? toNum(arg(2)) !== 0 : false
      const sorted = [...nums].sort((a, b) => (asc ? a - b : b - a))
      const idx = sorted.indexOf(v)
      if (idx < 0) throw new Error('RANK: value not in range')
      return idx + 1
    }
    // ── Time parts (dates are epoch-ms / ISO; extracted in UTC to match YEAR) ──
    case 'HOUR':
    case 'MINUTE':
    case 'SECOND': {
      const d = parseDate(toStr(arg(0)))
      if (!d) throw new Error(`${name}: bad date/time`)
      if (name === 'HOUR') return d.getUTCHours()
      if (name === 'MINUTE') return d.getUTCMinutes()
      return d.getUTCSeconds()
    }
    // ── Financial ─────────────────────────────────────────────────────────────
    case 'PMT': {
      const rate = toNum(arg(0))
      const nper = toNum(arg(1))
      const pv = toNum(arg(2))
      const fv = args.length > 3 ? toNum(arg(3)) : 0
      const type = args.length > 4 ? toNum(arg(4)) : 0
      if (rate === 0) return -(pv + fv) / nper
      const pow = Math.pow(1 + rate, nper)
      return (-(pv * pow + fv) * rate) / ((pow - 1) * (1 + rate * type))
    }
    case 'FV': {
      const rate = toNum(arg(0))
      const nper = toNum(arg(1))
      const pmt = toNum(arg(2))
      const pv = args.length > 3 ? toNum(arg(3)) : 0
      const type = args.length > 4 ? toNum(arg(4)) : 0
      if (rate === 0) return -(pv + pmt * nper)
      const pow = Math.pow(1 + rate, nper)
      return -(pv * pow + pmt * (1 + rate * type) * ((pow - 1) / rate))
    }
    case 'PV': {
      const rate = toNum(arg(0))
      const nper = toNum(arg(1))
      const pmt = toNum(arg(2))
      const fv = args.length > 3 ? toNum(arg(3)) : 0
      const type = args.length > 4 ? toNum(arg(4)) : 0
      if (rate === 0) return -(fv + pmt * nper)
      const pow = Math.pow(1 + rate, nper)
      return -(fv + pmt * (1 + rate * type) * ((pow - 1) / rate)) / pow
    }
    case 'NPV': {
      const rate = toNum(arg(0))
      const vals = collectNumbers(args.slice(1), grid, seen)
      let npv = 0
      vals.forEach((v, i) => (npv += v / Math.pow(1 + rate, i + 1)))
      return npv
    }
    default:
      throw new FormulaError('#NAME?')
  }
}

// Format a date as the engine's canonical YYYY-MM-DD string (matching TODAY).
function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

// Compile a user regex, surfacing a clean error rather than throwing a raw
// SyntaxError that would read as an engine crash.
function compileRegex(pattern: string, flags = ''): RegExp {
  try {
    return new RegExp(pattern, flags)
  } catch {
    throw new Error('bad regular expression')
  }
}

// Nearest match for XLOOKUP/XMATCH approximate modes: the largest value <= key
// ('down') or the smallest value >= key ('up'). Returns -1 when none qualify.
function nearestIndex(vals: CellValue[], key: CellValue, dir: 'up' | 'down'): number {
  let best = -1
  let bestVal: CellValue | null = null
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (dir === 'down' && compare('<=', v, key)) {
      if (bestVal === null || compare('>=', v, bestVal)) {
        best = i
        bestVal = v
      }
    } else if (dir === 'up' && compare('>=', v, key)) {
      if (bestVal === null || compare('<=', v, bestVal)) {
        best = i
        bestVal = v
      }
    }
  }
  return best
}

// Evaluate a formula string (without the leading '=') against the grid. Exposed
// for unit testing the engine directly. Pass a Workbook to resolve cross-sheet
// references (Sheet2!A1).
export function evaluateFormula(
  grid: Grid,
  formula: string,
  seedKey = '__seed__',
  wb?: Workbook,
  names?: Map<string, string>
): CellValue {
  WB = wb ?? null
  NAMES = names ?? null
  try {
    return evalNode(parse(formula), grid, new Set([`${gridId(grid)}:${seedKey}`]))
  } finally {
    WB = null
    NAMES = null
  }
}

// True if a formula string parses (syntax only — it may still reference empty
// cells). The AI formula assistant uses this as an honesty gate so a formula the
// engine cannot even parse is never offered for insertion.
export function isParseableFormula(formula: string, names?: Map<string, string>): boolean {
  const src = formula.startsWith('=') ? formula.slice(1) : formula
  if (src.trim() === '') return false
  NAMES = names ?? null
  try {
    parse(src)
    return true
  } catch {
    return false
  } finally {
    NAMES = null
  }
}

// The value to DISPLAY for a cell: raw text, the evaluated formula, or #ERR.
// Never a silent wrong number.
export function displayCell(
  grid: Grid,
  r: number,
  c: number,
  wb?: Workbook,
  spill?: Map<string, string>,
  names?: Map<string, string>
): string {
  // A spill map (built once per grid by buildSpillMap) overrides both the anchor
  // of an array formula and the empty cells it spills into, so an array formula
  // renders as a real block instead of #ERR on the anchor and blanks beside it.
  if (spill) {
    const s = spill.get(`${r},${c}`)
    if (s !== undefined) return s
  }
  const raw = cellRaw(grid, r, c)
  if (!raw.startsWith('=')) return raw
  WB = wb ?? null
  NAMES = names ?? null
  try {
    const v = evalNode(parse(raw.slice(1)), grid, new Set([`${gridId(grid)}:${r},${c}`]))
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '#NUM!'
      return String(Math.round(v * 1e6) / 1e6)
    }
    return v
  } catch (e) {
    return e instanceof FormulaError ? e.code : '#ERR'
  } finally {
    WB = null
    NAMES = null
  }
}

// ── Sparklines ───────────────────────────────────────────────────────────────
// =SPARKLINE(range) draws a tiny line chart of the range's numeric values inside
// the cell; =SPARKLINE(range,"bar") draws bars. The cell still holds the formula;
// the grid asks sparklineForCell whether to render a chart instead of text. Only a
// top-level SPARKLINE call qualifies, so a cell like =SUM(...) is untouched. The
// values are the real referenced cells — an empty or all-non-numeric range yields
// an empty values array, which the grid renders as a faint placeholder rather than
// inventing a line.

export interface SparklineValue {
  values: number[]
  type: 'line' | 'bar'
}

// Pull the numeric values a SPARKLINE call references, in order. A range expands
// to its cells (row by row); a non-numeric or empty cell is skipped, matching the
// aggregate-function contract. A bare scalar argument coerces to a number.
function sparklineValues(args: Node[], grid: Grid, seen: Set<string>): number[] {
  const out: number[] = []
  for (const arg of args) {
    if (arg.k === 'range') {
      const g = pickGrid(grid, arg.sheet)
      for (const { r, c } of rangeCoords(arg)) {
        const n = cellNumeric(g, r, c, seen)
        if (n !== null) out.push(n)
      }
    } else {
      const v = evalNode(arg, grid, seen)
      const n = typeof v === 'number' ? v : Number(toStr(v))
      if (Number.isFinite(n)) out.push(n)
    }
  }
  return out
}

// If the cell at (r,c) is a top-level =SPARKLINE(...) formula, return its values +
// type for the grid to draw; otherwise null. Parse/eval failures resolve to null
// so the grid falls back to its normal text path (which shows #ERR).
export function sparklineForCell(
  grid: Grid,
  r: number,
  c: number,
  wb?: Workbook,
  names?: Map<string, string>
): SparklineValue | null {
  const raw = cellRaw(grid, r, c).trim()
  if (!raw.startsWith('=')) return null
  WB = wb ?? null
  NAMES = names ?? null
  try {
    const node = parse(raw.slice(1))
    if (node.k !== 'call' || node.name !== 'SPARKLINE') return null
    const seen = new Set([`${gridId(grid)}:${r},${c}`])
    const last = node.args[node.args.length - 1]
    // A trailing string argument selects the variant; default is a line.
    let type: 'line' | 'bar' = 'line'
    let valueArgs = node.args
    if (last && last.k !== 'range') {
      const t = toStr(evalNode(last, grid, seen)).trim().toLowerCase()
      if (t === 'bar' || t === 'line') {
        type = t
        valueArgs = node.args.slice(0, -1)
      }
    }
    return { values: sparklineValues(valueArgs, grid, seen), type }
  } catch {
    return null
  } finally {
    WB = null
    NAMES = null
  }
}

// ── Array formulas + spill ──────────────────────────────────────────────────
// A few functions return a 2D block rather than one scalar: SEQUENCE, TRANSPOSE,
// UNIQUE, SORT and FILTER. The anchor cell holds the formula and shows the
// top-left value; the rest spill into the cells below and right when those are
// empty, exactly like modern Excel and Google Sheets. If a spill target already
// holds content the anchor shows #SPILL! and nothing spills.

type Matrix = CellValue[][]

export const SPILL_FUNCTIONS = new Set([
  'LET',
  'MAP',
  'SCAN',
  'MAKEARRAY',
  'SEQUENCE',
  'TRANSPOSE',
  'UNIQUE',
  'SORT',
  'FILTER',
  'VSTACK',
  'HSTACK',
  'TOROW',
  'TOCOL',
  'TAKE',
  'DROP',
  'TEXTSPLIT'
])

function readRange(grid: Grid, node: Extract<Node, { k: 'range' }>, seen: Set<string>): Matrix {
  const g = pickGrid(grid, node.sheet)
  const out: Matrix = []
  for (let r = node.r1; r <= node.r2; r++) {
    const row: CellValue[] = []
    for (let c = node.c1; c <= node.c2; c++) row.push(cellValue(g, r, c, seen))
    out.push(row)
  }
  return out
}

function fmtCell(v: CellValue): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '#ERR'
  return v
}

// Coerce any node to a matrix — a range reads its cells, a nested array call
// yields its block (so array functions compose, e.g. SORT(VSTACK(...))), and a
// scalar becomes a 1x1. Module-level so both evalArrayCall and the scalar array
// helpers (REDUCE) read data the same way.
function nodeToMatrix(n: Node | undefined, grid: Grid, seen: Set<string>): Matrix {
  if (!n) return []
  if (n.k === 'range') return readRange(grid, n, seen)
  if (n.k === 'call') {
    const m = evalArrayCall(n, grid, seen)
    if (m) return m
  }
  return [[evalNode(n, grid, seen)]]
}
function flattenMatrix(m: Matrix): CellValue[] {
  const out: CellValue[] = []
  for (const row of m) for (const v of row) out.push(v)
  return out
}

// Evaluate an array-function call to a matrix, or null if it isn't one (or its
// arguments are the wrong shape, in which case the scalar path reports the error).
function evalArrayCall(node: Extract<Node, { k: 'call' }>, grid: Grid, seen: Set<string>): Matrix | null {
  const args = node.args
  const toMatrix = (n: Node | undefined): Matrix => nodeToMatrix(n, grid, seen)
  switch (node.name) {
    // LET in the array path so its calculation can be an array (e.g. a MAP), and
    // so a LET-bound lambda is in scope when that MAP runs.
    case 'LET':
      return withLetScope(args, grid, seen, (body) => nodeToMatrix(body, grid, seen))
    // MAP(array1, [array2, ...], LAMBDA(a, [b], ...)) applies the lambda to each
    // cell (zipping multiple arrays), preserving the first array's shape.
    case 'MAP': {
      const def = resolveLambda(args[args.length - 1])
      if (!def) return null
      const arrays = args.slice(0, -1).map((a) => toMatrix(a))
      const base = arrays[0] ?? []
      return base.map((row, r) => row.map((_, c) => applyLambda(def, arrays.map((m) => m[r]?.[c] ?? ''), grid, seen)))
    }
    // SCAN(init, array, LAMBDA(acc, value, result)) returns the running totals,
    // preserving the array's shape.
    case 'SCAN': {
      const def = resolveLambda(args[2])
      if (!def) return null
      let acc = evalNode(args[0], grid, seen)
      return toMatrix(args[1]).map((row) =>
        row.map((v) => {
          acc = applyLambda(def, [acc, v], grid, seen)
          return acc
        })
      )
    }
    // MAKEARRAY(rows, cols, LAMBDA(r, c, ...)) builds a block from a lambda of the
    // 1-based row/column index.
    case 'MAKEARRAY': {
      const rows = Math.max(0, Math.trunc(toNum(evalNode(args[0], grid, seen))))
      const cols = Math.max(0, Math.trunc(toNum(evalNode(args[1], grid, seen))))
      const def = resolveLambda(args[2])
      if (!def) return null
      const out: Matrix = []
      for (let r = 0; r < rows; r++) {
        const row: CellValue[] = []
        for (let c = 0; c < cols; c++) row.push(applyLambda(def, [r + 1, c + 1], grid, seen))
        out.push(row)
      }
      return out
    }
    case 'SEQUENCE': {
      const rows = Math.max(0, Math.trunc(toNum(evalNode(args[0], grid, seen))))
      const cols = args.length > 1 ? Math.max(1, Math.trunc(toNum(evalNode(args[1], grid, seen)))) : 1
      const start = args.length > 2 ? toNum(evalNode(args[2], grid, seen)) : 1
      const step = args.length > 3 ? toNum(evalNode(args[3], grid, seen)) : 1
      const out: Matrix = []
      let v = start
      for (let r = 0; r < rows; r++) {
        const row: CellValue[] = []
        for (let c = 0; c < cols; c++) {
          row.push(v)
          v += step
        }
        out.push(row)
      }
      return out
    }
    case 'TRANSPOSE': {
      const m = toMatrix(args[0])
      const rows = m.length
      const cols = m[0]?.length ?? 0
      const out: Matrix = []
      for (let c = 0; c < cols; c++) {
        const row: CellValue[] = []
        for (let r = 0; r < rows; r++) row.push(m[r][c])
        out.push(row)
      }
      return out
    }
    case 'UNIQUE': {
      const seenRows = new Set<string>()
      const out: Matrix = []
      for (const row of toMatrix(args[0])) {
        const key = row.map(fmtCell).join(' ')
        if (!seenRows.has(key)) {
          seenRows.add(key)
          out.push(row)
        }
      }
      return out
    }
    case 'SORT': {
      const m = toMatrix(args[0]).map((row) => row.slice())
      const col = (args.length > 1 ? Math.max(1, Math.trunc(toNum(evalNode(args[1], grid, seen)))) : 1) - 1
      const asc = args.length > 2 ? toBool(evalNode(args[2], grid, seen)) : true
      m.sort((a, b) => {
        const av = a[col] ?? ''
        const bv = b[col] ?? ''
        const r = compare('<', av, bv) ? -1 : compare('>', av, bv) ? 1 : 0
        return asc ? r : -r
      })
      return m
    }
    case 'FILTER': {
      const m = toMatrix(args[0])
      const cm = toMatrix(args[1])
      const out: Matrix = []
      for (let i = 0; i < m.length; i++) {
        const c = cm[i]?.[0]
        if (c !== undefined && toBool(c)) out.push(m[i])
      }
      return out
    }
    case 'VSTACK': {
      const parts = args.map(toMatrix)
      const width = Math.max(0, ...parts.map((m) => Math.max(0, ...m.map((r) => r.length))))
      const out: Matrix = []
      for (const m of parts)
        for (const row of m) {
          const rr = row.slice()
          while (rr.length < width) rr.push('')
          out.push(rr)
        }
      return out
    }
    case 'HSTACK': {
      const parts = args.map(toMatrix)
      const height = Math.max(0, ...parts.map((m) => m.length))
      const out: Matrix = Array.from({ length: height }, () => [] as CellValue[])
      for (const m of parts) {
        const w = Math.max(0, ...m.map((r) => r.length))
        for (let i = 0; i < height; i++) {
          const src = m[i] ?? []
          for (let j = 0; j < w; j++) out[i].push(src[j] ?? '')
        }
      }
      return out
    }
    case 'TOROW': {
      const flat: CellValue[] = []
      for (const row of toMatrix(args[0])) for (const v of row) flat.push(v)
      return [flat]
    }
    case 'TOCOL': {
      const out: Matrix = []
      for (const row of toMatrix(args[0])) for (const v of row) out.push([v])
      return out
    }
    case 'TAKE': {
      const m = toMatrix(args[0])
      const nr = Math.trunc(toNum(evalNode(args[1], grid, seen)))
      let rows = nr >= 0 ? m.slice(0, nr) : m.slice(Math.max(0, m.length + nr))
      if (args.length > 2) {
        const nc = Math.trunc(toNum(evalNode(args[2], grid, seen)))
        rows = rows.map((r) => (nc >= 0 ? r.slice(0, nc) : r.slice(Math.max(0, r.length + nc))))
      }
      return rows
    }
    case 'DROP': {
      const m = toMatrix(args[0])
      const nr = Math.trunc(toNum(evalNode(args[1], grid, seen)))
      let rows = nr >= 0 ? m.slice(nr) : m.slice(0, Math.max(0, m.length + nr))
      if (args.length > 2) {
        const nc = Math.trunc(toNum(evalNode(args[2], grid, seen)))
        rows = rows.map((r) => (nc >= 0 ? r.slice(nc) : r.slice(0, Math.max(0, r.length + nc))))
      }
      return rows
    }
    case 'TEXTSPLIT': {
      const text = toStr(evalNode(args[0], grid, seen))
      const colDelim = (args.length > 1 ? toStr(evalNode(args[1], grid, seen)) : ',') || ','
      const rowDelim = args.length > 2 ? toStr(evalNode(args[2], grid, seen)) : ''
      const lines = rowDelim ? text.split(rowDelim) : [text]
      return lines.map((line) => line.split(colDelim))
    }
    default:
      return null
  }
}

// Evaluate a formula (without '=') to a matrix: an array function yields its
// block, anything else a 1x1 of its scalar value.
function evalMatrix(grid: Grid, formula: string, seen: Set<string>): Matrix {
  const node = parse(formula)
  if (node.k === 'call') {
    const m = evalArrayCall(node, grid, seen)
    if (m) return m
  }
  return [[evalNode(node, grid, seen)]]
}

// Build the display value for every cell that an array formula owns: the anchor
// and the cells it spills into. Keyed "r,c". An anchor whose spill is blocked by
// existing content resolves to '#SPILL!' and writes no targets. Cells not touched
// by any spill are absent, so displayCell falls back to its normal evaluation.
export function buildSpillMap(
  grid: Grid,
  wb?: Workbook,
  names?: Map<string, string>
): Map<string, string> {
  WB = wb ?? null
  NAMES = names ?? null
  const map = new Map<string, string>()
  const occupied = (r: number, c: number): boolean => cellRaw(grid, r, c).trim() !== ''
  try {
    for (let r = 0; r < grid.rows.length; r++) {
      const row = grid.rows[r] ?? []
      for (let c = 0; c < row.length; c++) {
        const raw = (row[c] ?? '').trim()
        if (!raw.startsWith('=')) continue
        let node: Node
        try {
          node = parse(raw.slice(1))
        } catch {
          continue
        }
        if (node.k !== 'call' || !SPILL_FUNCTIONS.has(node.name)) continue
        let m: Matrix
        try {
          m = evalMatrix(grid, raw.slice(1), new Set([`${gridId(grid)}:${r},${c}`]))
        } catch {
          continue
        }
        // A 1x1 result doesn't spill — leave it to the normal scalar render.
        if (m.length <= 1 && (m[0]?.length ?? 0) <= 1) continue
        let blocked = false
        for (let i = 0; i < m.length && !blocked; i++) {
          for (let j = 0; j < m[i].length && !blocked; j++) {
            if (i === 0 && j === 0) continue
            if (occupied(r + i, c + j)) blocked = true
          }
        }
        if (blocked) {
          map.set(`${r},${c}`, '#SPILL!')
          continue
        }
        for (let i = 0; i < m.length; i++) {
          for (let j = 0; j < m[i].length; j++) map.set(`${r + i},${c + j}`, fmtCell(m[i][j]))
        }
      }
    }
  } finally {
    WB = null
    NAMES = null
  }
  return map
}
