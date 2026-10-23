import { BrowserWindow } from 'electron'

// Tell the renderer that widgets changed BEHIND its back: written straight to
// the database by the MCP server (an agent, Claude Desktop, any MCP client)
// rather than through the renderer's own widget store. A renderer-initiated
// write needs no notice (its store already holds the change, and reloading on
// every drag would flicker), so only the out-of-band writers call this.
//
// Without it, a widget an agent added to the desk you are looking at did not
// appear until you left the desk and came back.
//
// Coalesced: an agent that adds ten widgets in one turn causes one reload per
// desk, not ten.

export const WIDGETS_EXTERNAL_CHANGE = 'widgets:externalChange'

export interface WidgetChangeNotifier {
  notify(taskIds: Iterable<string | null | undefined>): void
  /** Send anything pending now (tests, shutdown). */
  flush(): void
}

export function createWidgetChangeNotifier(
  send: (taskIds: string[]) => void,
  delayMs = 40
): WidgetChangeNotifier {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending.size === 0) return
    const ids = [...pending]
    pending.clear()
    send(ids)
  }
  return {
    notify(taskIds) {
      for (const id of taskIds) if (id) pending.add(id)
      if (pending.size === 0 || timer) return
      timer = setTimeout(flush, delayMs)
    },
    flush
  }
}

const live = createWidgetChangeNotifier((taskIds) => {
  // Guarded like notifyDocumentChanged: never fail a widget write because there
  // is no Electron to notify.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(WIDGETS_EXTERNAL_CHANGE, { taskIds })
      } catch {
        // window may have closed mid-broadcast — ignore
      }
    }
  } catch {
    // no Electron here, or no windows yet: nothing to tell.
  }
})

/** The desks whose widgets an out-of-band writer just changed. */
export function notifyWidgetsChanged(taskIds: Iterable<string | null | undefined>): void {
  live.notify(taskIds)
}
