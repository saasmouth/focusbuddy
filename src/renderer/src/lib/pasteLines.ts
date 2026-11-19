// A paste of several lines into a list's "add" box: one item per line, as Things,
// Todoist and Apple Reminders do. Owner, 2026-11-19 ("check for similar issues
// with all other widgets"): five pasted lines used to make ONE task, its title
// the lines run together.
//
// Each line loses the list marks it was written with (- * • 1. 1) a. [ ] [x]
// ☐ ☑ ✓ ✔), and a line marked done ([x], ☑, ✓, ✔) comes in done. Tabs (a
// spreadsheet column) read as spaces. Blank lines are skipped. A single line is
// not a list: null, and the field takes it as typing would.

export interface PastedItem {
  title: string
  done: boolean
}

const DONE_MARK = /^(?:\[[xX✓✔]\]|☑|✓|✔)\s*/
const OPEN_MARK = /^(?:\[\s?\]|☐)\s*/
const BULLET = /^(?:[-*•‣◦▪–]|\d{1,3}[.)]|[a-zA-Z][.)])(?:\s+|$)/

export function pastedListItems(text: string): PastedItem[] | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.filter((l) => l.trim()).length < 2) return null
  const out: PastedItem[] = []
  for (const raw of lines) {
    let line = raw.replace(/\t+/g, ' ').trim()
    if (!line) continue
    line = line.replace(BULLET, '')
    let done = false
    if (DONE_MARK.test(line)) {
      done = true
      line = line.replace(DONE_MARK, '')
    } else {
      line = line.replace(OPEN_MARK, '')
    }
    line = line.trim()
    if (line) out.push({ title: line, done })
  }
  return out.length >= 2 ? out : null
}
