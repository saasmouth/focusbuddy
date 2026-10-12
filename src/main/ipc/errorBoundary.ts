import { ipcMain } from 'electron'
import { checkArgs, violationMessage } from './contracts'
import { IPC_ARG_CONTRACTS } from './ipcContracts.generated'

// One error boundary for every ipcMain.handle channel.
//
// Electron serialises a rejected handler's name, message AND stack back to the
// renderer. That means a handler which lets a raw error escape hands the
// renderer main-process implementation detail: better-sqlite3's "Too few
// parameter values were provided", a filesystem errno, and absolute paths that
// disclose the username and install layout. An audit of a booted build found
// 150 channels answering malformed input with a raw database error and 218
// sending a main-process stack trace.
//
// The contract deliberately does NOT change: a failing handler still rejects, so
// every existing `.catch()` in the renderer keeps working. What changes is what
// travels with the rejection:
//
//   - a domain message the app wrote on purpose ("Work items are not enabled.")
//     is passed through untouched, because the renderer shows it to the user;
//   - a message carrying internal detail is replaced with a generic one and the
//     real error is logged in main, so nothing is lost for debugging;
//   - the stack is replaced in both cases, since a stack is only ever
//     main-process file paths and the renderer has no use for it.
//
// This is installed by intercepting ipcMain.handle once, before any handler is
// registered. Electron exposes no hook for this, and the alternative — editing
// ~500 call sites — is a far larger change to review and an easy one to forget
// at the next handler.

/** Message shapes that mean the error is describing the app's insides. */
const INTERNAL_DETAIL = [
  // Absolute paths: disclose the username and where the app is installed.
  /\/(Users|home|Applications|private|var)\//,
  // better-sqlite3 / SQLite speaking directly to the renderer.
  /SQLITE_|no such (table|column)|syntax error near|(UNIQUE|NOT NULL|FOREIGN KEY|CHECK) constraint failed|Too few parameter values|datatype mismatch|database is locked|attempt to write a readonly database/i,
  // Raw filesystem errnos.
  /\b(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EMFILE|ENOSPC)\b/,
  // Node internals leaking through.
  /node:internal\//
]

function carriesInternalDetail(message: string): boolean {
  return INTERNAL_DETAIL.some((re) => re.test(message))
}

/** Only the app's top-level renderer may invoke privileged channels. */
export function isTrustedIpcSenderUrl(url: string, devRendererUrl = process.env.ELECTRON_RENDERER_URL): boolean {
  if (!url) return false
  try {
    const sender = new URL(url)
    if (devRendererUrl) {
      const dev = new URL(devRendererUrl)
      if (sender.origin === dev.origin) return true
    }
    return sender.protocol === 'file:' && sender.pathname.endsWith('/out/renderer/index.html')
  } catch {
    return false
  }
}

/**
 * Build the error that actually crosses to the renderer. Never returns the
 * original: even when the message is safe, the stack is not.
 */
export function sanitiseIpcError(channel: string, err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err))
  const leaks = carriesInternalDetail(original.message)

  if (leaks) {
    // Keep the real thing where only we can read it.
    console.error(`[ipc] ${channel} failed:`, original)
  }

  const safe = new Error(
    leaks
      ? `The "${channel}" operation failed. See the application log for details.`
      : original.message
  )
  // A stack is main-process file paths and nothing else the renderer can use.
  safe.stack = `${safe.name}: ${safe.message}`
  return safe
}

let installed = false

/**
 * Wrap every subsequently registered invoke handler. Call once, as early in the
 * main process as possible — any handler registered before this runs is not
 * covered.
 */
export function installIpcErrorBoundary(): void {
  if (installed) return
  installed = true

  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void => {
    const contract = IPC_ARG_CONTRACTS[channel]
    original(channel, async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url ?? event.sender.getURL()
      if (!isTrustedIpcSenderUrl(senderUrl)) {
        const e = new Error('This operation is not available from the current page.')
        e.stack = `${e.name}: ${e.message}`
        throw e
      }
      // Refuse structurally impossible calls BEFORE the handler body runs.
      //
      // Sanitising the error was only half the fix: it stopped a raw database
      // error reaching the caller, but the handler had already acted on garbage
      // by then. Measured on a booted build, 151 of 429 handlers could be driven
      // into SQLite or the filesystem with an undefined id and only failed at the
      // bind. Checking first means the mutation never starts.
      if (contract) {
        const bad = checkArgs(contract, args)
        if (bad) {
          const e = new Error(violationMessage(channel, bad))
          // Same treatment as any other rejection: no stack across the boundary.
          e.stack = `${e.name}: ${e.message}`
          throw e
        }
      }
      try {
        return await listener(event, ...args)
      } catch (err) {
        throw sanitiseIpcError(channel, err)
      }
    })
  }) as typeof ipcMain.handle
}
