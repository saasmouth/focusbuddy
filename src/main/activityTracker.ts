import { execFile } from 'child_process'
import { app, BrowserWindow, ipcMain } from 'electron'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { selfProcessNames } from './selfProcessName'

// Activity tracker — observes which apps the user switches between
// while PlexiDesk is open, plus the user's Stream Deck button presses.
// The AI macro suggestor reads this log to spot repetitive patterns
// and propose macros that would automate them.
//
// Privacy contract (surfaced in the renderer's opt-in UI):
//   - LOCAL ONLY. The log lives in the user's userData folder; nothing
//     leaves the device unless the user explicitly asks for AI analysis,
//     in which case ONLY a compact summary is sent to the user's
//     Anthropic key.
//   - Off by default. The tracker only polls when enabled === true,
//     persisted via the toggle below.
//   - We log: app NAME (e.g. "Google Chrome") and timestamp. We do NOT
//     log window titles, URLs, keystrokes, mouse position, clipboard
//     content, or anything else.
//   - The user can wipe the log at any time. There's an IPC for that.

const execFileAsync = promisify(execFile)
const isMac = process.platform === 'darwin'
const POLL_INTERVAL_MS = 10_000 // 10s — fine-grained enough to spot
                                // patterns, coarse enough to be cheap
const LOG_CAP = 5000            // rotate when the log gets this long
const LOG_TRIM_TO = 3000        // keep the most-recent N after rotate

interface ActivityState {
  enabled: boolean
  // App-switch events: each is { app, ts }.
  switches: Array<{ app: string; ts: number }>
  // Stream Deck button presses: { label, action_kind, ts }.
  presses: Array<{ label: string; kind: string; ts: number }>
}

const EMPTY: ActivityState = { enabled: false, switches: [], presses: [] }

function fileFor(): string {
  return join(app.getPath('userData'), 'activity-log.json')
}

function read(): ActivityState {
  const path = fileFor()
  if (!existsSync(path)) return { ...EMPTY }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ActivityState>
    return {
      enabled: !!parsed.enabled,
      switches: Array.isArray(parsed.switches) ? parsed.switches : [],
      presses: Array.isArray(parsed.presses) ? parsed.presses : []
    }
  } catch {
    return { ...EMPTY }
  }
}

function write(state: ActivityState): void {
  const path = fileFor()
  mkdirSync(dirname(path), { recursive: true })
  // Rotate if either array gets too big.
  if (state.switches.length > LOG_CAP) {
    state.switches = state.switches.slice(-LOG_TRIM_TO)
  }
  if (state.presses.length > LOG_CAP) {
    state.presses = state.presses.slice(-LOG_TRIM_TO)
  }
  writeFileSync(path, JSON.stringify(state), 'utf8')
}

let pollHandle: NodeJS.Timeout | null = null
let lastSeenApp: string | null = null

async function getFrontmostApp(): Promise<string | null> {
  if (!isMac) return null
  try {
    const ours = selfProcessNames(process.execPath, app.name)
    const script = `tell application "System Events" to return name of first process whose frontmost is true`
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: 1500
    })
    const name = stdout.trim()
    if (!name) return null
    if (ours.includes(name)) return null
    return name
  } catch {
    return null
  }
}

async function tick(): Promise<void> {
  const cur = await getFrontmostApp()
  if (!cur) return
  if (cur === lastSeenApp) return
  lastSeenApp = cur
  const state = read()
  if (!state.enabled) return
  state.switches.push({ app: cur, ts: Date.now() })
  write(state)
}

function startPolling(): void {
  stopPolling()
  pollHandle = setInterval(() => void tick(), POLL_INTERVAL_MS)
  pollHandle.unref()
}

function stopPolling(): void {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  lastSeenApp = null
}

// ─── Public IPC API ────────────────────────────────────────────────────

export function installActivityTracker(): void {
  // Register IPC handlers — the renderer drives enable/disable, reads
  // the log, records button presses, and wipes data.
  ipcMain.handle('activity:getState', () => {
    const state = read()
    return {
      enabled: state.enabled,
      switchCount: state.switches.length,
      pressCount: state.presses.length
    }
  })

  ipcMain.handle('activity:setEnabled', (_e, enabled: boolean) => {
    const state = read()
    state.enabled = !!enabled
    write(state)
    if (enabled) startPolling()
    else stopPolling()
    return { ok: true }
  })

  ipcMain.handle('activity:read', () => {
    const state = read()
    return {
      enabled: state.enabled,
      switches: state.switches,
      presses: state.presses
    }
  })

  ipcMain.handle(
    'activity:logPress',
    (_e, input: { label: string; kind: string }) => {
      const state = read()
      if (!state.enabled) return { ok: true }
      state.presses.push({
        label: input.label,
        kind: input.kind,
        ts: Date.now()
      })
      write(state)
      return { ok: true }
    }
  )

  ipcMain.handle('activity:wipe', () => {
    const state = read()
    write({ ...state, switches: [], presses: [] })
    return { ok: true }
  })

  // Auto-resume polling on app launch if the user previously enabled it.
  const initial = read()
  if (initial.enabled) startPolling()
  // Stop polling when no window is open (avoid background drain when
  // the user has explicitly closed all PlexiDesk windows on macOS).
  app.on('window-all-closed', () => stopPolling())
  app.on('browser-window-focus', () => {
    if (read().enabled && !pollHandle) startPolling()
  })
  // Keep BrowserWindow imported for the future "trigger an immediate
  // tick when a window opens" enhancement.
  void BrowserWindow
}
