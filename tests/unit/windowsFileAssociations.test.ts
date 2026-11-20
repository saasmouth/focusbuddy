// @vitest-environment node
// The Windows check of F3's file types (scripts/check-windows-file-associations.mjs),
// run here against a registry stood in for exactly as electron-builder's NSIS
// macros write it (APP_ASSOCIATE) and remove it (APP_UNASSOCIATE), so the checks
// themselves are proven before CI runs them on a real Windows machine.
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain .mjs script with no type declarations
import * as check from '../../scripts/check-windows-file-associations.mjs'

type Read = (key: string, value?: string) => string | null
const C = check as {
  expectedEntries: (exe: string) => Array<{ ext: string; progId: string; description: string; command: string }>
  checkInstalled: (read: Read, exe: string) => string[]
  checkRemoved: (read: Read) => string[]
  parseRegQuery: (out: string) => string | null
}

const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\PlexiiDesk\\PlexiiDesk.exe'
const CLASSES = 'HKCU\\Software\\Classes'

/** A registry: key → { '': default, name: data }. */
type Reg = Map<string, Map<string, string>>
const set = (reg: Reg, key: string, name: string, data: string): void => {
  if (!reg.has(key)) reg.set(key, new Map())
  reg.get(key)!.set(name, data)
}
const reader = (reg: Reg): Read => (key, value) => {
  const k = reg.get(key)
  if (!k) return null
  return k.get(value ?? '') ?? null
}
/** What APP_ASSOCIATE writes (node_modules/app-builder-lib/templates/nsis/include/FileAssociation.nsh). */
function installed(exe = EXE): Reg {
  const reg: Reg = new Map()
  for (const e of C.expectedEntries(exe)) {
    set(reg, `${CLASSES}\\.${e.ext}`, '', e.progId)
    set(reg, `${CLASSES}\\.${e.ext}\\OpenWithProgids`, e.progId, '')
    set(reg, `${CLASSES}\\${e.progId}`, '', e.description)
    set(reg, `${CLASSES}\\${e.progId}\\DefaultIcon`, '', `${exe},0`)
    set(reg, `${CLASSES}\\${e.progId}\\shell`, '', 'open')
    set(reg, `${CLASSES}\\${e.progId}\\shell\\open`, '', 'Open with PlexiiDesk')
    set(reg, `${CLASSES}\\${e.progId}\\shell\\open\\command`, '', `"${exe}" "%1"`)
  }
  return reg
}
/** What APP_UNASSOCIATE then removes: the OpenWithProgids value and the ProgID key (and below). .<ext>'s default stays. */
function uninstalled(reg: Reg): Reg {
  for (const e of C.expectedEntries(EXE)) {
    reg.get(`${CLASSES}\\.${e.ext}\\OpenWithProgids`)?.delete(e.progId)
    for (const k of [...reg.keys()]) if (k === `${CLASSES}\\${e.progId}` || k.startsWith(`${CLASSES}\\${e.progId}\\`)) reg.delete(k)
  }
  return reg
}

describe('the Windows registry check', () => {
  it('expects all 31 types, each opening the installed Plexii with the file', () => {
    const e = C.expectedEntries(EXE)
    expect(e).toHaveLength(31)
    expect(e.find((x) => x.ext === 'plexii-sheet')).toEqual({
      ext: 'plexii-sheet',
      progId: 'Plexii.document.sheet',
      description: 'Plexii Spreadsheet',
      command: `"${EXE}" "%1"`
    })
  })

  it('an installer that wrote every type passes', () => {
    expect(C.checkInstalled(reader(installed()), EXE)).toEqual([])
  })

  it('a type missing, opening another program, or with no command is named', () => {
    const reg = installed()
    reg.delete(`${CLASSES}\\.plexii-sheet`)
    reg.get(`${CLASSES}\\Plexii.widget.taskList\\shell\\open\\command`)!.set('', '"C:\\Windows\\notepad.exe" "%1"')
    reg.delete(`${CLASSES}\\Plexii.document.doc\\shell\\open\\command`)
    // In the table's order: work widgets, then documents.
    expect(C.checkInstalled(reader(reg), EXE)).toEqual([
      'Plexii.widget.taskList opens with "C:\\Windows\\notepad.exe" "%1", not "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\PlexiiDesk\\PlexiiDesk.exe" "%1"',
      'Plexii.document.doc opens with nothing, not "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\PlexiiDesk\\PlexiiDesk.exe" "%1"',
      '.plexii-sheet names nothing, not Plexii.document.sheet'
    ])
  })

  it('after the uninstall nothing is registered (the dangling .<ext> default the uninstaller leaves is not a handler)', () => {
    const reg = uninstalled(installed())
    expect(reg.get(`${CLASSES}\\.plexii-sheet`)!.get('')).toBe('Plexii.document.sheet')
    expect(C.checkRemoved(reader(reg))).toEqual([])
    expect(C.checkRemoved(reader(installed()))).toHaveLength(62)
  })

  it('reads reg.exe\'s own output', () => {
    expect(C.parseRegQuery('\r\nHKEY_CURRENT_USER\\Software\\Classes\\.plexii-sheet\r\n    (Default)    REG_SZ    Plexii.document.sheet\r\n\r\n')).toBe('Plexii.document.sheet')
    expect(C.parseRegQuery('\r\nHKEY_CURRENT_USER\\Software\\Classes\\.plexii-sheet\\OpenWithProgids\r\n    Plexii.document.sheet    REG_NONE    \r\n\r\n')).toBe('')
    expect(C.parseRegQuery('\r\nHKEY_CURRENT_USER\\Software\\Classes\\Plexii.document.sheet\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\P\\PlexiiDesk.exe" "%1"\r\n')).toBe('"C:\\P\\PlexiiDesk.exe" "%1"')
    expect(C.parseRegQuery('')).toBeNull()
  })
})
