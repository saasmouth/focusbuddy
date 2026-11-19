// Shared, pure TSV clipboard helpers used by BOTH the spreadsheet and the typed
// table so the two surfaces parse and serialize copied ranges identically. TSV
// (tab between columns, newline between rows) is exactly how Excel and Google
// Sheets put a copied range on the system clipboard, so this round-trips with
// them too.

// Parse clipboard TSV into a matrix. Tabs split columns, newlines split rows.
// A trailing newline is ignored so a copied block doesn't gain a blank row.
export function parseTsv(text: string): string[][] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => line.split('\t'))
}

// Serialize a matrix of raw cell strings to TSV for the clipboard.
export function toTsv(matrix: string[][]): string {
  return matrix.map((row) => row.join('\t')).join('\n')
}

// True when a pasted block is a single cell — the case Excel/Sheets fill across
// the whole target selection rather than writing once.
export function isSingleCell(matrix: string[][]): boolean {
  return matrix.length === 1 && matrix[0].length === 1
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A matrix of cell text as an HTML table: what Write, Mail, Word and Google
 * Docs keep as rows and columns when a range is pasted (Sheets and Excel read
 * the TSV beside it). The text is what the cells SHOW, escaped.
 */
export function toHtmlTable(matrix: string[][]): string {
  const body = matrix.map((row) => `<tr>${row.map((t) => `<td>${escapeHtml(t)}</td>`).join('')}</tr>`).join('')
  return `<meta charset="utf-8"><table><tbody>${body}</tbody></table>`
}
