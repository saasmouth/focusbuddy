// @vitest-environment node
// Double-clicking a .plexii-* file (F3, 2026-11-20), the main-process end
// (main/plexiiFileOpen.ts): every way the OS hands Plexii a file -- macOS
// open-file, a Windows launch's argv, a second instance's argv -- reads the file
// AT ONCE and keeps its text until the window takes it. The files here are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type Listener = (...args: unknown[]) => void
const h = vi.hoisted(() => ({
  listeners: {} as Record<string, Listener[]>,
  ready: true,
  lock: true,
  windows: [] as Array<{ sent: Array<[string, unknown]>; focused: number; restored: number; minimized: boolean }>
}))
vi.mock('electron', () => ({
  app: {
    on: (ev: string, fn: Listener) => {
      ;(h.listeners[ev] ??= []).push(fn)
    },
    isReady: () => h.ready,
    hasSingleInstanceLock: () => h.lock
  },
  BrowserWindow: {
    getAllWindows: () =>
      h.windows.map((w) => ({
        isDestroyed: () => false,
        isMinimized: () => w.minimized,
        restore: () => {
          w.restored++
        },
        focus: () => {
          w.focused++
        },
        webContents: { send: (ch: string, payload: unknown) => w.sent.push([ch, payload]) }
      }))
  }
}))

import {
  OPENED_FILE_MAX_BYTES,
  plexiiFilePathsFromArgv,
  receivePlexiiFile,
  registerPlexiiFileOpen,
  resetPlexiiFileOpenForTests,
  takeOpenedPlexiiFiles,
  whenOpenedFilesRead
} from '../../src/main/plexiiFileOpen'

let dir = ''
const SHEET = JSON.stringify({ type: 'plexii.document.sheet', version: 1, title: 'Budget', docType: 'sheet', body: { columns: [], rows: [] } })
const write = (name: string, text: string): string => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plexii-open-file-')))
  h.listeners = {}
  h.ready = true
  h.lock = true
  h.windows = [{ sent: [], focused: 0, restored: 0, minimized: true }]
  resetPlexiiFileOpenForTests()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('which launch arguments are Plexii files', () => {
  it('only .plexii-* paths Plexii imports; never the program, a flag or another file', () => {
    expect(
      plexiiFilePathsFromArgv([
        'C:\\Program Files\\PlexiiDesk\\PlexiiDesk.exe',
        '--allow-file-access-from-files',
        'C:\\Users\\robin\\Downloads\\Budget.plexii-sheet',
        '/Users/robin/Desktop/List.plexii-tasks',
        '/Users/robin/Desktop/notes.txt',
        '/Users/robin/Desktop/cal.plexii-calendar', // an embed tool: never imported
        '--flag=/x/Budget.plexii-sheet'
      ])
    ).toEqual(['C:\\Users\\robin\\Downloads\\Budget.plexii-sheet', '/Users/robin/Desktop/List.plexii-tasks'])
  })
  it('the program itself is never taken for a file, even when it is the only argument', () => {
    expect(plexiiFilePathsFromArgv(['/x/Weird.plexii-doc'])).toEqual([])
  })
})

describe('a file the OS hands over', () => {
  it('is read at once and kept, with its name and text, until the window takes it', async () => {
    const p = write('Budget.plexii-sheet', SHEET)
    await receivePlexiiFile(p)
    rmSync(p) // a Mail attachment can be gone a moment later: Plexii already has it
    const [item, ...rest] = takeOpenedPlexiiFiles()
    expect(rest).toEqual([])
    expect(item).toMatchObject({ name: 'Budget.plexii-sheet', text: SHEET })
    expect(takeOpenedPlexiiFiles()).toEqual([])
  })

  it('tells every window, and brings the window forward', async () => {
    await receivePlexiiFile(write('Budget.plexii-sheet', SHEET))
    expect(h.windows[0]!.sent).toEqual([['plexiiFiles:opened', 1]])
    expect(h.windows[0]!.restored).toBe(1)
    expect(h.windows[0]!.focused).toBe(1)
  })

  it('files handed over together are told to the window once, when the last is read: one batch', async () => {
    registerPlexiiFileOpen()
    h.listeners['second-instance']![0]!({}, ['PlexiiDesk.exe', write('A.plexii-doc', SHEET), write('B.plexii-sticky', '{}'), write('C.plexii-tasks', '{}')], dir)
    await whenOpenedFilesRead()
    expect(h.windows[0]!.sent).toEqual([['plexiiFiles:opened', 3]])
  })

  it('one that cannot be read is kept as what went wrong, in plain words', async () => {
    await receivePlexiiFile(join(dir, 'Gone.plexii-doc'))
    const big = write('Huge.plexii-doc', '')
    writeFileSync(big, Buffer.alloc(OPENED_FILE_MAX_BYTES + 1))
    mkdirSync(join(dir, 'Folder.plexii-doc'))
    await receivePlexiiFile(big)
    await receivePlexiiFile(join(dir, 'Folder.plexii-doc'))
    const locked = write('Locked.plexii-doc', SHEET)
    chmodSync(locked, 0o000)
    await receivePlexiiFile(locked)
    chmodSync(locked, 0o600)
    const items = takeOpenedPlexiiFiles()
    expect(items.map((i) => [i.name, 'error' in i ? i.error : 'read'])).toEqual([
      ['Gone.plexii-doc', 'It isn’t there any more.'],
      ['Huge.plexii-doc', 'It is larger than 64 MB, more than a Plexii file can be.'],
      ['Folder.plexii-doc', 'It is a folder, not a file.'],
      // Root reads anything: then it simply was read.
      ['Locked.plexii-doc', process.getuid?.() === 0 ? 'read' : 'Plexii wasn’t allowed to read it.']
    ])
  })

  it('a file that is not a .plexii-* file Plexii imports is not taken at all', async () => {
    await receivePlexiiFile(write('notes.txt', 'hello'))
    await receivePlexiiFile(write('cal.plexii-calendar', '{}'))
    expect(takeOpenedPlexiiFiles()).toEqual([])
    expect(h.windows[0]!.sent).toEqual([])
  })
})

describe('every way the OS hands one over', () => {
  it('macOS open-file: claimed (preventDefault) only for a Plexii file, read, and kept in the order opened', async () => {
    registerPlexiiFileOpen()
    const a = write('A.plexii-doc', SHEET)
    const b = write('B.plexii-sticky', '{}')
    const prevented: string[] = []
    const open = (p: string): void => h.listeners['open-file']![0]!({ preventDefault: () => prevented.push(p) }, p)
    open(a)
    open(join(dir, 'other.pdf'))
    open(b)
    await whenOpenedFilesRead()
    expect(prevented).toEqual([a, b])
    expect(takeOpenedPlexiiFiles().map((i) => i.name)).toEqual(['A.plexii-doc', 'B.plexii-sticky'])
  })

  it('Windows: a launch with files in argv, and a second instance with files in its argv', async () => {
    const a = write('A.plexii-doc', SHEET)
    const b = write('B.plexii-sticky', '{}')
    const argv = process.argv
    process.argv = ['PlexiiDesk.exe', a]
    try {
      registerPlexiiFileOpen()
    } finally {
      process.argv = argv
    }
    h.listeners['second-instance']![0]!({}, ['PlexiiDesk.exe', '--original-process-start-time=1', b], dir)
    await whenOpenedFilesRead()
    expect(takeOpenedPlexiiFiles().map((i) => i.name)).toEqual(['A.plexii-doc', 'B.plexii-sticky'])
  })

  it('an instance that is quitting for the running one takes nothing from argv', async () => {
    h.lock = false
    const argv = process.argv
    process.argv = ['PlexiiDesk.exe', write('A.plexii-doc', SHEET)]
    try {
      registerPlexiiFileOpen()
    } finally {
      process.argv = argv
    }
    await whenOpenedFilesRead()
    expect(takeOpenedPlexiiFiles()).toEqual([])
  })

  it('with no window open (macOS keeps running without one), a window is opened for it', async () => {
    h.windows = []
    const ensureWindow = vi.fn()
    registerPlexiiFileOpen({ ensureWindow })
    h.listeners['open-file']![0]!({ preventDefault: () => {} }, write('A.plexii-doc', SHEET))
    await whenOpenedFilesRead()
    expect(ensureWindow).toHaveBeenCalledTimes(1)
    expect(takeOpenedPlexiiFiles()).toHaveLength(1)
  })

  it('before the app is ready (a file that launched it), no window is forced: the first one takes it', async () => {
    h.windows = []
    h.ready = false
    const ensureWindow = vi.fn()
    registerPlexiiFileOpen({ ensureWindow })
    h.listeners['open-file']![0]!({ preventDefault: () => {} }, write('A.plexii-doc', SHEET))
    await whenOpenedFilesRead()
    expect(ensureWindow).not.toHaveBeenCalled()
    expect(takeOpenedPlexiiFiles()).toHaveLength(1)
  })
})
