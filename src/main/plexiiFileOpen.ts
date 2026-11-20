// Double-click a .plexii-* file in Finder or Explorer and Plexii opens it (F3,
// 2026-11-20; docs/widget-files.md, "Opening a file from Finder or Explorer").
//
// The operating system hands Plexii a file three ways, and every one ends here:
//   - macOS: an open-file event, whether the file launched the app, the app was
//     already running, or the file was dropped on the Dock icon;
//   - Windows: the path in argv when the file launches the app;
//   - Windows: the argv of a second instance, when Plexii is already running
//     (the single-instance lock is authProtocol.ts's).
//
// The file is READ at once, because a Mail attachment or a download can be moved
// or gone a moment later, and kept with its text until the window takes it
// (components/PlexiiFileOpenEffects.tsx). The window brings it in once someone
// is signed in, as a copy, by the same import as Files › Import
// (widgetFiles:import), and puts it on the desk on screen. Plexii never writes
// to the file.
import { app, BrowserWindow } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { isImportablePlexiiFileName, type OpenedPlexiiFile } from '@shared/plexiiFileTypes'

/** Larger than any Plexii file: a file over this is refused, not read into memory. */
export const OPENED_FILE_MAX_BYTES = 64 * 1024 * 1024

let queue: OpenedPlexiiFile[] = []
let seq = 0
// Files are read one after another, so they are kept in the order they were opened.
let reading: Promise<unknown> = Promise.resolve()
// Files handed over together (several chosen in Finder, one argv) are told to the
// window once, when the last is read: one batch, one notice.
let unread = 0
let ensureWindow: (() => void) | null = null

/** The file's name, from a macOS or a Windows path. */
const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** The .plexii-* files in a launch's arguments: never the program (argv[0]) or a flag. */
export function plexiiFilePathsFromArgv(argv: readonly string[]): string[] {
  return argv.slice(1).filter((a) => typeof a === 'string' && a !== '' && !a.startsWith('-') && isImportablePlexiiFileName(nameOf(a)))
}

async function readOpened(path: string): Promise<OpenedPlexiiFile> {
  const base = { id: `opened-${Date.now()}-${++seq}`, name: nameOf(path), at: Date.now() }
  try {
    const s = await stat(path)
    if (s.isDirectory()) return { ...base, error: 'It is a folder, not a file.' }
    if (s.size > OPENED_FILE_MAX_BYTES) return { ...base, error: 'It is larger than 64 MB, more than a Plexii file can be.' }
    return { ...base, text: await readFile(path, 'utf8') }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { ...base, error: 'It isn’t there any more.' }
    if (code === 'EACCES' || code === 'EPERM') return { ...base, error: 'Plexii wasn’t allowed to read it.' }
    return { ...base, error: 'It could not be read.' }
  }
}

/** Tell every window there is something to take, and bring the window forward. */
function tellWindows(): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) {
    // macOS keeps Plexii running with no window: open one to take it. Before the
    // app is ready (a file that launched it), the first window takes it anyway.
    if (app.isReady()) ensureWindow?.()
    return
  }
  for (const win of wins) {
    try {
      win.webContents.send('plexiiFiles:opened', queue.length)
    } catch {
      /* still loading: it takes what is waiting when it is ready */
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

/** A file the OS handed over: read it and keep it for the window. Anything that isn't a Plexii file is left alone. */
export function receivePlexiiFile(path: string): Promise<void> {
  if (!isImportablePlexiiFileName(nameOf(path))) return Promise.resolve()
  unread++
  const next = reading.then(async () => {
    try {
      queue.push(await readOpened(path))
    } finally {
      unread--
    }
    if (unread === 0) tellWindows()
  })
  reading = next.catch(() => undefined)
  return next
}

/** The window takes every file waiting (each one once). */
export function takeOpenedPlexiiFiles(): OpenedPlexiiFile[] {
  const taken = queue
  queue = []
  return taken
}

/** Settles once every file handed over so far has been read. */
export function whenOpenedFilesRead(): Promise<void> {
  return reading.then(() => undefined)
}

/**
 * Listen for files from the OS. Call before the app is ready: macOS sends the
 * file that launched the app as an open-file event before ready. `ensureWindow`
 * opens a window when a file arrives and none is open.
 */
export function registerPlexiiFileOpen(opts: { ensureWindow?: () => void } = {}): void {
  ensureWindow = opts.ensureWindow ?? null
  app.on('open-file', (event, path) => {
    if (!isImportablePlexiiFileName(nameOf(path))) return
    event.preventDefault()
    void receivePlexiiFile(path)
  })
  app.on('second-instance', (_event, argv) => {
    for (const p of plexiiFilePathsFromArgv(argv)) void receivePlexiiFile(p)
  })
  // A copy that lost the single-instance lock is quitting; the running one gets
  // its argv through second-instance, so this one takes nothing.
  if (!app.hasSingleInstanceLock()) return
  for (const p of plexiiFilePathsFromArgv(process.argv)) void receivePlexiiFile(p)
}

/** Tests: forget everything waiting. */
export function resetPlexiiFileOpenForTests(): void {
  queue = []
  seq = 0
  reading = Promise.resolve()
  unread = 0
  ensureWindow = null
}
