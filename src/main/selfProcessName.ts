// The names macOS can report for THIS app's own process, so code that asks
// "which app is frontmost?" can skip itself.
//
// The obvious answer, app.name, is wrong for a packaged build: it comes from
// package.json `name` ("plexii", pinned because it also names the keychain
// item), while System Events reports the process by its bundle name — the
// executable electron-builder names after productName. The two have never
// matched, so the activity log recorded the app's own process and the
// SpeedDeck's "send keys to the previous app" could pick the app itself.
//
// The executable's own basename is the reliable source. It follows productName
// on a fresh install AND after an in-place auto-update, where the bundle keeps
// its old directory name ("PlexiDesk.app") but the executable inside is the
// new one. In dev it is "Electron", which is listed anyway.

/** Every name this app's process may go by, de-duplicated, safe to embed in AppleScript. */
export function selfProcessNames(execPath: string, appName: string): string[] {
  const exe = execPath.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? ''
  const names = [exe, appName, 'Electron']
  return [...new Set(names.filter((n) => n && !/["\\]/.test(n)))]
}

/** An AppleScript list literal of those names: {"PlexiiDesk", "plexii", "Electron"}. */
export function appleScriptNameList(names: string[]): string {
  return `{${names.map((n) => `"${n}"`).join(', ')}}`
}
