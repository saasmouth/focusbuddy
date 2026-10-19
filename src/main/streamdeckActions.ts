import { exec, execFile } from 'child_process'
import { app, BrowserWindow, dialog, shell, systemPreferences } from 'electron'
import { openExternalSafe } from './safeOpenExternal'
import { appleScriptNameList, selfProcessNames } from './selfProcessName'
import { promisify } from 'util'
import type {
  KeyComboAction,
  MediaKeyAction,
  Modifier,
  MultiStepAction,
  OpenAppAction,
  OpenUrlAction,
  RunShellAction,
  SetVolumeAction,
  SingleStepAction,
  StreamDeckAction,
  TypeTextAction
} from '@shared/streamdeck'

// Stream Deck action executor — runs in main, called from the renderer
// via the streamdeck:execute IPC. Returns { ok, error? } so the renderer
// can surface failures on the button (red flash + tooltip).
//
// Platform: macOS-first. AppleScript (osascript) handles keyboard
// shortcuts, media keys, volume, and text typing without any extra
// native modules. Windows + Linux paths are stubs we'd fill in later
// with nircmd / xdotool respectively — for now they fail gracefully.
//
// Security note: run-shell is gated in the MAIN process at execution time.
// A security audit found that the previously-claimed renderer "one-time
// confirm" did not exist, and that a shared/imported SpeedDeck widget could
// carry a run-shell command that ran on a single click with no prompt (a
// remotely-deliverable one-click RCE). The gate below shows a native,
// cancel-by-default confirmation displaying the exact command before every
// execution, so no execution can happen without a deliberate human decision.
// Delivery is also cut off upstream: shares/imports strip run-shell actions
// and the AI applier refuses to mint them.

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const isMac = process.platform === 'darwin'

export interface ExecuteResult {
  ok: boolean
  error?: string
  // Set when the failure is fixable by enabling Accessibility for
  // PlexiDesk. The renderer surfaces a one-click "Open System Settings"
  // affordance instead of a generic error.
  needsAccessibility?: boolean
}

// ─── Focus handoff ─────────────────────────────────────────────────────
//
// THE central UX fix for the Stream Deck: when the user clicks a button
// in PlexiDesk, PlexiDesk itself becomes the frontmost app. If we then
// fire ⌘C the copy goes to PlexiDesk (which has nothing meaningful
// selected). For the Stream Deck to work as a real macro pad, we have
// to hand focus BACK to whatever app the user was in before clicking.
//
// Strategy:
//   1. We track the previously-frontmost macOS process by listening to
//      Electron's `browser-window-blur` / `browser-window-focus` and
//      using NSWorkspace via osascript. The cached app name is the
//      target for the next keystroke.
//   2. Before any keystroke / media-key action, we activate the cached
//      target app, wait a beat for it to focus, then send the keys.
//   3. After actions that move the user's attention (Cmd+Shift+4
//      screenshot, key combos, type-text) we leave the user where they
//      ended up — we DON'T re-activate PlexiDesk.

// Cached process name of the app frontmost just before PlexiDesk
// stole focus. Updated on every browser-window-focus.
let previousFrontmostApp: string | null = null

function getOurProcessNames(): string[] {
  // The macOS process names PlexiiDesk may present as: the executable's own
  // name (productName, "PlexiiDesk"), app.name ("plexii") and "Electron" in
  // dev. app.name alone never matched a packaged build — see selfProcessName.ts.
  return selfProcessNames(process.execPath, app.name)
}

async function getFrontmostNonSelf(): Promise<string | null> {
  if (!isMac) return null
  try {
    const ours = appleScriptNameList(getOurProcessNames())
    // List visible processes ordered by recently-active. The first
    // process that isn't us is what the user was last working in.
    const script = `tell application "System Events"
      set procs to (every process whose visible is true)
      set targetName to ""
      repeat with p in procs
        set n to name of p
        if n is not in ${ours} then
          set targetName to n
          exit repeat
        end if
      end repeat
      return targetName
    end tell`
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: 2000
    })
    const name = stdout.trim()
    return name ? name : null
  } catch {
    return null
  }
}

// Install focus tracker. Called once from main on app ready. Whenever
// PlexiDesk is about to gain focus, we capture what was frontmost
// (so the next keystroke action knows where to send keys).
export function installFocusTracker(): void {
  if (!isMac) return
  // Refresh the cache on every focus event — covers both "user
  // alt-tabbed to us" and "user just clicked our window".
  const refresh = async (): Promise<void> => {
    const target = await getFrontmostNonSelf()
    if (target) previousFrontmostApp = target
  }
  app.on('browser-window-focus', () => void refresh())
  // Also snapshot on a slow timer so the cache stays fresh even if the
  // user is alt-tabbing rapidly outside PlexiDesk.
  setInterval(() => {
    if (BrowserWindow.getFocusedWindow() === null) void refresh()
  }, 1500).unref()
  // Seed once on startup so the first keystroke action has a target
  // even if the user hasn't touched anything yet.
  void refresh()
}

// Switch the frontmost app to whatever was active before us, then wait
// the requested settle time. Used as the prefix for every keystroke
// action so the keys land in the right window.
async function focusPreviousApp(settleMs = 120): Promise<void> {
  if (!isMac) return
  // Get a fresh read in case the cache is stale. Prefer the live read
  // when available — covers cases where the user opened a new app
  // since our last refresh.
  const target = (await getFrontmostNonSelf()) ?? previousFrontmostApp
  if (!target) return
  try {
    await execFileAsync('osascript', [
      '-e',
      `tell application "${target.replace(/"/g, '\\"')}" to activate`
    ])
  } catch {
    // Some apps don't respond to AppleScript `activate` (background
    // services, system processes). Fall back to System Events.
    try {
      await execFileAsync('osascript', [
        '-e',
        `tell application "System Events" to set frontmost of (first process whose name is "${target.replace(/"/g, '\\"')}") to true`
      ])
    } catch {
      // Give up — the keystroke will probably go to whatever's
      // frontmost now, which is at least better than landing on us.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs))
}

// Surface "this needs Accessibility permission" as a structured error
// the renderer can render specially. macOS silently no-ops synthetic
// keystrokes when the calling app isn't in System Settings → Privacy
// → Accessibility, so a friendly "open Settings" prompt is essential.
function checkAccessibility(): boolean {
  if (!isMac) return true
  try {
    // Electron's systemPreferences exposes the live AX trust check.
    // Passing `false` means "don't prompt yet" — we want to prompt
    // only if the user explicitly opted in to the action.
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return true
  }
}

function accessibilityPromptError(): ExecuteResult {
  return {
    ok: false,
    error:
      'PlexiiDesk needs Accessibility permission to send keystrokes. ' +
      'Open System Settings → Privacy & Security → Accessibility and toggle PlexiiDesk on.',
    needsAccessibility: true
  }
}

// ─── AppleScript helpers ────────────────────────────────────────────────

// Run an AppleScript snippet via osascript -e. Returns stdout (rarely
// useful for our actions) and surfaces any error.
async function runAppleScript(script: string): Promise<void> {
  if (!isMac) throw new Error('This action requires macOS (AppleScript).')
  // Use -e (single string) — safer than piping to stdin because we can
  // pass argument as a discrete argv item, no shell interpolation.
  await execFileAsync('osascript', ['-e', script], { timeout: 5000 })
}

// AppleScript "using" clause from our modifier list.
function modifiersClause(mods: Modifier[]): string {
  const map: Record<Modifier, string> = {
    cmd: 'command down',
    shift: 'shift down',
    option: 'option down',
    control: 'control down',
    fn: 'function down'
  }
  if (mods.length === 0) return ''
  const parts = mods.map((m) => map[m]).filter(Boolean)
  return ` using {${parts.join(', ')}}`
}

// Map our friendly key names to AppleScript "key code" numbers when
// they're special, or return null if the key is a regular character
// (in which case we use `keystroke "x"` instead of `key code N`).
function specialKeyCode(key: string): number | null {
  const lower = key.toLowerCase()
  const map: Record<string, number> = {
    enter: 36,
    return: 36,
    tab: 48,
    space: 49,
    delete: 51,
    backspace: 51,
    escape: 53,
    'arrow-left': 123,
    'arrow-right': 124,
    'arrow-down': 125,
    'arrow-up': 126,
    home: 115,
    end: 119,
    'page-up': 116,
    'page-down': 121,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111
  }
  return map[lower] ?? null
}

// Escape a string for safe embedding inside AppleScript double quotes.
// AppleScript escape: " → \" and \ → \\
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ─── Action implementations ─────────────────────────────────────────────

async function openApp(action: OpenAppAction): Promise<void> {
  const target = action.target.trim()
  if (!target) throw new Error('Open-app target is empty.')
  if (isMac) {
    // `open -a` handles both .app paths and app names. Quiet (-g) keeps
    // PlexiDesk in the foreground; user can remove that flag in their
    // macro if they want the app to come to front.
    await execFileAsync('open', ['-a', target])
    return
  }
  // Windows / Linux — best-effort spawn. shell.openPath handles documents
  // and registered URI schemes.
  await shell.openPath(target)
}

async function openUrl(action: OpenUrlAction): Promise<void> {
  if (!action.url) throw new Error('URL is empty.')
  // The URL comes from the button's saved configuration, so it is user data
  // rather than a constant: route it through the scheme check instead of handing
  // an arbitrary string to the OS.
  const opened = await openExternalSafe(action.url)
  if (!opened) throw new Error('Only http and https links can be opened.')
}

async function keyCombo(action: KeyComboAction): Promise<void> {
  if (!action.key) throw new Error('Key is empty.')
  // Critical: hand focus back to the previous app FIRST, otherwise the
  // keystroke goes to PlexiDesk and your ⌘C / ⌘V / ⌘⇧4 all no-op.
  await focusPreviousApp()
  const code = specialKeyCode(action.key)
  const using = modifiersClause(action.modifiers)
  let script: string
  if (code !== null) {
    script = `tell application "System Events" to key code ${code}${using}`
  } else {
    const ch = action.key.length === 1 ? action.key : action.key.slice(0, 1)
    script = `tell application "System Events" to keystroke "${escapeAppleScript(ch)}"${using}`
  }
  await runAppleScript(script)
}

async function typeText(action: TypeTextAction): Promise<void> {
  if (!action.text) return
  // Hand focus back so the typing lands in the user's previous window,
  // not PlexiDesk itself.
  await focusPreviousApp()
  // Split on newlines so each line becomes its own keystroke; AppleScript
  // handles newlines inside a string but interpretation varies by app.
  // For most apps, a literal "return" keypress between lines is what
  // the user actually wants.
  const lines = action.text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      await runAppleScript(
        `tell application "System Events" to keystroke "${escapeAppleScript(lines[i])}"`
      )
    }
    if (i < lines.length - 1) {
      await runAppleScript('tell application "System Events" to key code 36') // Return
    }
  }
}

async function mediaKey(action: MediaKeyAction): Promise<void> {
  if (!isMac) throw new Error('Media keys are macOS-only in v1.')
  // macOS media-key injection is finicky — the cleanest approach is to
  // target the apps the user is likely to be playing media in. We try
  // each in order; only running apps get the message. Spotify + Apple
  // Music cover ~95% of desktop music; Chrome's web-player handling is
  // out of scope.
  let script = ''
  switch (action.key) {
    case 'play-pause':
      script = `
        tell application "System Events"
          if (exists process "Spotify") then tell application "Spotify" to playpause
          if (exists process "Music") then tell application "Music" to playpause
        end tell
      `
      break
    case 'next':
      script = `
        tell application "System Events"
          if (exists process "Spotify") then tell application "Spotify" to next track
          if (exists process "Music") then tell application "Music" to next track
        end tell
      `
      break
    case 'previous':
      script = `
        tell application "System Events"
          if (exists process "Spotify") then tell application "Spotify" to previous track
          if (exists process "Music") then tell application "Music" to previous track
        end tell
      `
      break
    case 'volume-up':
      // Bumps system volume by 5 increments (out of 100).
      script = `set volume output volume ((output volume of (get volume settings)) + 5)`
      break
    case 'volume-down':
      script = `set volume output volume ((output volume of (get volume settings)) - 5)`
      break
    case 'mute':
      script = `set volume output muted not (output muted of (get volume settings))`
      break
  }
  await runAppleScript(script)
}

async function setVolume(action: SetVolumeAction): Promise<void> {
  if (!isMac) throw new Error('Volume control is macOS-only in v1.')
  const level = Math.max(0, Math.min(100, Math.round(action.level)))
  await runAppleScript(`set volume output volume ${level}`)
}

async function runShell(action: RunShellAction): Promise<void> {
  if (!action.command.trim()) throw new Error('Shell command is empty.')
  // Execution-time gate: a native, cancel-by-default dialog showing the exact
  // command. This is the one control that holds no matter how the action was
  // created (hand-authored, shared, imported, AI-proposed), so a single click
  // can never silently run a shell command.
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Run command'],
    defaultId: 0,
    cancelId: 0,
    title: 'Run a shell command?',
    message: 'This SpeedDeck button wants to run a shell command on your computer.',
    detail: `${action.command}\n\nOnly continue if you created this button yourself and trust this command.`,
    noLink: true
  }
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  if (response !== 1) throw new Error('Shell command cancelled by the user.')
  await execAsync(action.command, {
    timeout: action.timeoutMs ?? 10_000,
    // Cap output to prevent runaway logs; we don't surface stdout/stderr
    // to the user anyway (the button just fires-and-forgets).
    maxBuffer: 256 * 1024
  })
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Public entry ──────────────────────────────────────────────────────

async function executeSingle(action: SingleStepAction): Promise<void> {
  switch (action.type) {
    case 'open-app':
      return openApp(action)
    case 'open-url':
      return openUrl(action)
    case 'key-combo':
      return keyCombo(action)
    case 'type-text':
      return typeText(action)
    case 'media-key':
      return mediaKey(action)
    case 'set-volume':
      return setVolume(action)
    case 'run-shell':
      return runShell(action)
    case 'delay':
      return delay(action.ms)
  }
}

// Which action types require macOS Accessibility permission. Used to
// pre-flight the user with a clear prompt instead of letting the
// AppleScript silently no-op.
function needsAccessibility(action: SingleStepAction): boolean {
  switch (action.type) {
    case 'key-combo':
    case 'type-text':
    case 'media-key': // play/pause via System Events branch
      return true
    default:
      return false
  }
}

export async function executeAction(action: StreamDeckAction): Promise<ExecuteResult> {
  // Pre-flight accessibility check on macOS for actions that need it.
  // We do this BEFORE running anything so the user gets a clean error
  // instead of an action that partially completed.
  if (isMac) {
    const allSteps: SingleStepAction[] =
      action.type === 'multi-step'
        ? (action as MultiStepAction).steps
        : [action as SingleStepAction]
    if (allSteps.some(needsAccessibility) && !checkAccessibility()) {
      return accessibilityPromptError()
    }
  }
  try {
    if (action.type === 'multi-step') {
      for (const step of (action as MultiStepAction).steps) {
        await executeSingle(step)
      }
    } else {
      await executeSingle(action as SingleStepAction)
    }
    return { ok: true }
  } catch (err) {
    const message = (err as Error).message || 'Unknown error.'
    // AppleScript "(-1719)" is the assistive-access-denied code.
    // Convert to a friendly response.
    if (/-1719|assistive access|System Events got an error/i.test(message)) {
      return accessibilityPromptError()
    }
    return { ok: false, error: message }
  }
}

// Open the macOS Privacy & Security → Accessibility pane.
//
// History of pain: macOS keeps changing the URL scheme and pane IDs
// across releases. On Sequoia (15) the old URL can route to the new
// Passwords app (which prompts for the system password and shows your
// saved credentials) instead of the Privacy & Security pane. That's
// exactly what the user was hitting.
//
// We now try four strategies in order, returning the moment one
// succeeds. The renderer ALSO shows manual navigation instructions
// next to the button so if every strategy fails the user still has a
// clear path forward.
export interface OpenSettingsResult {
  ok: boolean
  strategy:
    | 'forced-systempreferences-bundle'
    | 'modern-script'
    | 'legacy-script'
    | 'fallback-app'
    | 'failed'
}

export async function openAccessibilitySettings(): Promise<OpenSettingsResult> {
  if (!isMac) return { ok: false, strategy: 'failed' }

  // Strategy 1: open the URL scheme via `open -b com.apple.systempreferences`.
  // The `-b` flag FORCES the URL to be handled by System Preferences /
  // Settings rather than whichever app currently claims the URL scheme
  // (some password managers will register `x-apple.systempreferences:`
  // and intercept it). Tried with both modern and legacy pane IDs.
  const urls = [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility'
  ]
  for (const url of urls) {
    try {
      await execFileAsync(
        'open',
        ['-b', 'com.apple.systempreferences', url],
        { timeout: 3000 }
      )
      return { ok: true, strategy: 'forced-systempreferences-bundle' }
    } catch {
      // try next URL
    }
  }

  // Strategy 2: AppleScript via System Settings (modern, macOS 13+).
  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "System Settings"
  activate
  reveal anchor "Privacy_Accessibility" of pane id "com.apple.settings.PrivacySecurity.extension"
end tell`
      ],
      { timeout: 4000 }
    )
    return { ok: true, strategy: 'modern-script' }
  } catch {
    // continue
  }

  // Strategy 3: AppleScript via System Preferences (legacy, macOS 12-).
  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "System Preferences"
  activate
  reveal anchor "Privacy_Accessibility" of pane id "com.apple.preference.security"
end tell`
      ],
      { timeout: 4000 }
    )
    return { ok: true, strategy: 'legacy-script' }
  } catch {
    // continue
  }

  // Strategy 4 (fallback): open System Settings or System Preferences
  // by name; the user navigates manually from there.
  try {
    await execFileAsync('open', ['-a', 'System Settings'], { timeout: 3000 })
    return { ok: true, strategy: 'fallback-app' }
  } catch {
    try {
      await execFileAsync('open', ['-a', 'System Preferences'], { timeout: 3000 })
      return { ok: true, strategy: 'fallback-app' }
    } catch {
      // give up
    }
  }
  return { ok: false, strategy: 'failed' }
}

// Just open System Settings (or System Preferences on older macOS) by
// app name. NO URL processing — bulletproof.
//
// Used as the primary action button when the URL-scheme deep-link is
// unreliable on the user's macOS (password managers register the URL
// scheme and intercept it; some Sequoia versions changed pane IDs).
// The user then navigates manually using the in-modal instructions.
export async function openSettingsAppPlain(): Promise<boolean> {
  if (!isMac) return false
  try {
    await execFileAsync('open', ['-a', 'System Settings'], { timeout: 3000 })
    return true
  } catch {
    try {
      await execFileAsync('open', ['-a', 'System Preferences'], { timeout: 3000 })
      return true
    } catch {
      return false
    }
  }
}

// Reveal the PlexiDesk.app bundle in Finder so the user can drag-drop
// it into the Accessibility list. In dev mode this reveals Electron.app
// (because that's the actual binary running). In packaged release,
// reveals PlexiDesk.app. Either way, the user can drag the revealed
// item into the Accessibility list as a foolproof way to add the app.
export async function revealAppBundleInFinder(): Promise<{
  ok: boolean
  bundleName: string | null
}> {
  if (!isMac) return { ok: false, bundleName: null }
  const exePath = app.getPath('exe')
  const match = exePath.match(/^(.+\.app)\/Contents\/MacOS\//)
  if (!match) {
    try {
      await execFileAsync('open', ['/Applications'], { timeout: 3000 })
      return { ok: true, bundleName: null }
    } catch {
      return { ok: false, bundleName: null }
    }
  }
  const bundle = match[1]
  const bundleName = bundle.split('/').pop() ?? null
  try {
    await execFileAsync('open', ['-R', bundle], { timeout: 3000 })
    return { ok: true, bundleName }
  } catch {
    return { ok: false, bundleName }
  }
}
