// GUARD for the office right-click menus (SPEC §9.3, §9.6).
//
// 1. The two kit shapes every office app builds its menus from (object, empty
//    canvas) keep the contract: groups in order, single separators, Delete last
//    in the danger colour, the menu bar's labels and hints, disabled rows that
//    say why. expectMenuContract is the same check the non-office surfaces use.
// 2. No office file draws a right-click menu of its own: a `contextmenu`
//    handler in the office tree that opens a menu goes through the kit.

import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { canvasMenu, objectMenu } from '../../src/renderer/src/lib/menus/officeContextMenu'
import { MENU } from '../../src/shared/menus/lexicon'
import { expectMenuContract, groupsOf } from './_menuContract'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

const f = (): void => {}

describe('object shape', () => {
  const all = objectMenu({
    object: [{ label: 'Edit text', icon: 'edit', onClick: f }],
    cut: f,
    copy: f,
    paste: f,
    canPaste: true,
    duplicate: f,
    bringToFront: f,
    sendToBack: f,
    group: f,
    ungroup: f,
    saveAsSnippet: f,
    askAssist: f,
    more: [{ label: 'Copy style', onClick: f }],
    del: f
  })

  it('lays out all six groups in contract order', () => {
    expectMenuContract(all, {
      groups: [
        ['Edit text'],
        [MENU.cut.label, MENU.copy.label, MENU.paste.label, MENU.duplicate.label],
        [MENU.bringToFront.label, MENU.sendToBack.label, MENU.group.label, MENU.ungroup.label],
        [MENU.saveAsSnippet.label, MENU.askAssistAboutThis.label],
        [MENU.moreActions.label],
        [MENU.delete.label]
      ]
    })
  })

  it('uses the menu bar’s hints for the same actions', () => {
    const byLabel = Object.fromEntries(all.filter((i) => !i.separator).map((i) => [i.label, i.shortcut]))
    expect(byLabel[MENU.cut.label]).toBe('⌘X')
    expect(byLabel[MENU.duplicate.label]).toBe('⌘D')
    expect(byLabel[MENU.bringToFront.label]).toBe('⇧⌘]')
    expect(byLabel[MENU.delete.label]).toBe('⌫')
    expect(all[all.length - 1]!.danger).toBe(true)
  })

  it('leaves out an empty group and its separator', () => {
    const few = objectMenu({ copy: f, del: f })
    expect(groupsOf(few)).toEqual([[MENU.copy.label], [MENU.delete.label]])
    expectMenuContract(few)
  })

  it('a Paste with nothing to paste is disabled and says why', () => {
    const m = objectMenu({ paste: f, canPaste: false })
    expect(m[0]).toMatchObject({ label: MENU.paste.label, disabled: true, hint: 'Nothing to paste' })
    expectMenuContract(m)
  })
})

describe('empty-canvas shape', () => {
  it('Paste · Insert snippet… | create here | Select all | view', () => {
    const m = canvasMenu({
      paste: f,
      insertSnippet: f,
      create: [{ label: 'Add text here', onClick: f }],
      selectAll: f,
      view: [{ label: 'Fit page', onClick: f }]
    })
    expectMenuContract(m, { groups: [[MENU.paste.label, MENU.insertSnippet.label], ['Add text here'], [MENU.selectAll.label], ['Fit page']] })
  })
})

// Office files allowed to draw their own right-click menu, and why (SPEC §9.6).
const OWN_MENU_ALLOWED: Record<string, string> = {
  'documents/draw/render/CanvasContextMenu.tsx':
    'PlexiiDraw builds its menu from its command registry (owner d1); moving it onto the kit is raised with d1 (§9.7 E-16)'
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []
  })
}

describe('no bespoke right-click menus in the office apps', () => {
  const root = join(__dirname, '../../src/renderer/src/components')
  const office = [...files(join(root, 'documents')), ...files(join(root, 'office'))]

  it('every file that opens a menu on contextmenu uses the kit', () => {
    const offenders: string[] = []
    for (const p of office) {
      const rel = relative(root, p)
      if (OWN_MENU_ALLOWED[rel]) continue
      const src = readFileSync(p, 'utf8')
      // A file that handles contextmenu AND keeps menu state (setXMenu) but never
      // touches the kit draws a menu of its own. A file that only forwards the
      // event to a callback prop (SheetGrid → SheetEditor) does not.
      const opensMenu = /onContextMenu=/.test(src) && /\bset\w*Menu\(/.test(src)
      const kit = /CanvasContextMenu|officeContextMenu/.test(src)
      if (opensMenu && !kit) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('the allowlist names files that still exist', () => {
    for (const rel of Object.keys(OWN_MENU_ALLOWED)) expect(office.map((p) => relative(root, p))).toContain(rel)
  })
})

// Right-click and the registry cannot disagree (SPEC §9.9; the 2e seam): a row
// built from an OfficeCommand IS ctxRow(command) — same label, hint, off state
// and reason — and the office right-click menus pass their commands, not bare
// functions, for the shared rows.
describe('right-click rows come from the command registry', () => {
  it('a command in a group renders exactly as ctxRow renders it, off state and reason included', async () => {
    const { ctxRow } = await import('../../src/renderer/src/lib/menus/officeCommand')
    const cut = { id: 'x-cut', label: 'Cut', keys: ['mod', 'x'] as const, run: f, enabled: () => false, reason: () => 'Select something first' }
    const del = { id: 'x-del', label: 'Delete', keys: ['backspace'] as const, run: f }
    const rows = objectMenu({ cut, del }).filter((r) => !r.separator)
    expect(rows[0]).toMatchObject({ label: ctxRow(cut).label, shortcut: ctxRow(cut).shortcut, disabled: true, hint: 'Select something first' })
    expect(rows[1]).toMatchObject({ label: 'Delete', shortcut: '⌫', danger: true })
  })

  it.each([
    ['SlidesEditor.tsx', /objectMenu\(\{\s*cut: cmds\.cut/],
    ['DesignEditor.tsx', /objectMenu\(\{\s*cut: dcmds\.cut/],
    ['diagram/ContextMenu.tsx', /cut: c\.cut/],
    ['SheetEditor.tsx', /objectMenu\(\{\s*cut: commands\['sheet-cut'\]/]
  ])('%s builds its object menu from its commands', (file, pattern) => {
    const src = readFileSync(join(__dirname, '../../src/renderer/src/components/documents', file), 'utf8')
    expect(src).toMatch(pattern)
  })
})
