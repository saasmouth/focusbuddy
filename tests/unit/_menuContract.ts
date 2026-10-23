// Shared assertions for the right-click menu contract (SPEC §9.3–§9.5).
//
// Every non-office surface's guard test (tests/unit/contextMenuContract.*.test.ts)
// builds its menu the way the app does and hands the CtxMenuItem[] to
// expectMenuContract. One helper, so a surface cannot pass by testing a looser
// rule than its neighbours.

import { expect } from 'vitest'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import { MENU } from '../../src/shared/menus/lexicon'

/** Labels that §9.4 retired, each mapped to the label that replaced it. */
export const RETIRED_LABELS: Record<string, string> = {
  'Move to trash': MENU.moveToTrash.label,
  'Delete selection': MENU.delete.label,
  'Duplicate selection': MENU.duplicate.label,
  'Copy text': MENU.copy.label,
  'Copy URL': MENU.copyLink.label,
  'Copy link address': MENU.copyLink.label,
  'Saved snippet': MENU.insertSnippet.label
}

// Words that keep their capital inside a sentence-case label (§9.4).
const PROPER = /^(Plexii\w*|Focus|Trash|PDF|SVG|PNG|CSV|URL|AI|Markdown|Google|Drive|Slack|Gmail|Outlook|Notion|GitHub|Figma|Excel|Word|I|Mermaid|Room|Desk)$/

/** A label as it reads, without the submenu arrow some renderers append. */
const clean = (l: string): string => l.replace(/\s*▸$/, '').trim()

export interface ContractOptions {
  /** Expected groups in order, each a list of labels; separators between groups are asserted. */
  groups?: string[][]
  /** Labels allowed to break sentence case (e.g. a user-named desk shown in a row). */
  allowCase?: string[]
}

/** Assert one menu level (and every submenu) against §9.3–§9.5. */
export function expectMenuContract(items: CtxMenuItem[], opts: ContractOptions = {}, path = 'menu'): void {
  const rows = items.filter((i) => !i.separator)
  expect(rows.length, `${path}: a menu with no items should not open`).toBeGreaterThan(0)

  // No leading, trailing or doubled separators.
  expect(items[0]?.separator, `${path}: starts with a separator`).not.toBe(true)
  expect(items[items.length - 1]?.separator, `${path}: ends with a separator`).not.toBe(true)
  items.forEach((it, i) => {
    if (it.separator) expect(items[i + 1]?.separator, `${path}: two separators in a row at ${i}`).not.toBe(true)
  })

  // Destructive rows last, behind their own separator (§9.3 group 6).
  const firstDanger = items.findIndex((i) => i.danger)
  if (firstDanger >= 0) {
    expect(items[firstDanger - 1]?.separator, `${path}: destructive group is not behind a separator`).toBe(true)
    const after = items.slice(firstDanger).filter((i) => !i.separator)
    expect(after.every((i) => i.danger), `${path}: a non-destructive row follows a destructive one`).toBe(true)
  }

  for (const it of rows) {
    const label = clean(it.label ?? '')
    expect(label, `${path}: an item has no label`).not.toBe('')
    // "…" never "..." (§9.4).
    expect(label.includes('...'), `${path}: "${label}" uses "..." not "…"`).toBe(false)
    // Retired labels (§9.4).
    expect(RETIRED_LABELS[label], `${path}: "${label}" is retired; use "${RETIRED_LABELS[label]}"`).toBeUndefined()
    // Sentence case: words after the first are lower case unless proper nouns (§9.4).
    if (!opts.allowCase?.includes(label)) {
      const words = label.replace(/[…“”"()]/g, '').split(/\s+/).slice(1)
      for (const w of words) {
        if (/^[A-Z][a-z]/.test(w) && !PROPER.test(w.replace(/[,.:;!?]$/, ''))) {
          expect.fail(`${path}: "${label}" is not sentence case ("${w}")`)
        }
      }
    }
    // A disabled item says why (§9.5).
    if (it.disabled) expect(it.hint, `${path}: "${label}" is disabled without a hint`).toBeTruthy()
    // Shortcut hints come from shortcuts.ts: on macOS, Apple order ⌃⌥⇧⌘ and never "⌘⇧" (§9.4).
    if (it.shortcut) {
      const mods = it.shortcut.match(/[⌃⌥⇧⌘]/g) ?? []
      const order = '⌃⌥⇧⌘'
      const sorted = [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      expect(mods.join(''), `${path}: "${label}" hint "${it.shortcut}" is not in ⌃⌥⇧⌘ order`).toBe(sorted.join(''))
      expect(/Cmd|Command/.test(it.shortcut), `${path}: "${label}" hint "${it.shortcut}" spells out the modifier`).toBe(false)
    }
    // A shared action carries its shared hint when it shows one.
    const shared = Object.values(MENU).find((m) => m.label === label) as { label: string; keys?: readonly string[] } | undefined
    if (shared && it.shortcut && !shared.keys) expect.fail(`${path}: "${label}" shows a hint but its shared action has no bound key`)
    if (it.children?.length) expectMenuContract(it.children, { allowCase: opts.allowCase }, `${path} › ${label}`)
  }

  if (opts.groups) expect(groupsOf(items), `${path}: groups`).toEqual(opts.groups)
}

/** The menu as groups of labels, split at separators. */
export function groupsOf(items: CtxMenuItem[]): string[][] {
  const out: string[][] = [[]]
  for (const it of items) {
    if (it.separator) out.push([])
    else out[out.length - 1]!.push(clean(it.label ?? ''))
  }
  return out.filter((g) => g.length)
}
