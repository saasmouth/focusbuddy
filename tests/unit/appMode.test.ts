import { describe, it, expect } from 'vitest'
import { detectOfficeBuild, detectPreviewBuild } from '../../src/main/appMode'

// Regression guard for the bug where PlexiOffice quit on launch whenever PlexiDesk
// was open: the packaged bundle reports app.getName()="focusbuddy" for BOTH apps,
// so office detection must come from the env or the executable path, not the name.

describe('detectOfficeBuild', () => {
  it('detects the office build from the PLEXI_APP env (dev:office)', () => {
    expect(
      detectOfficeBuild({
        plexiAppEnv: 'office',
        execPath: '/Applications/agentic/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        appName: 'focusbuddy'
      })
    ).toBe(true)
  })

  it('detects the packaged office build from the macOS executable path', () => {
    // The crucial case: no env var, and app.getName() is the misleading
    // "focusbuddy" — detection must still succeed from the bundle path.
    expect(
      detectOfficeBuild({
        plexiAppEnv: undefined,
        execPath: '/Applications/PlexiOffice.app/Contents/MacOS/PlexiOffice',
        appName: 'focusbuddy'
      })
    ).toBe(true)
  })

  it('detects the packaged office build from the Windows executable path', () => {
    expect(
      detectOfficeBuild({
        plexiAppEnv: undefined,
        execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\PlexiOffice\\PlexiOffice.exe',
        appName: 'focusbuddy'
      })
    ).toBe(true)
  })

  it('detects the office build from the app name once setName has applied', () => {
    expect(
      detectOfficeBuild({ plexiAppEnv: undefined, execPath: '/anything/Electron', appName: 'PlexiOffice' })
    ).toBe(true)
  })

  it('does NOT flag the packaged PlexiDesk build as office', () => {
    expect(
      detectOfficeBuild({
        plexiAppEnv: undefined,
        execPath: '/Applications/PlexiDesk.app/Contents/MacOS/PlexiDesk',
        appName: 'focusbuddy'
      })
    ).toBe(false)
  })

  it('does NOT flag a plain dev PlexiDesk run as office', () => {
    expect(
      detectOfficeBuild({
        plexiAppEnv: undefined,
        execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        appName: 'focusbuddy'
      })
    ).toBe(false)
  })
})

describe('detectPreviewBuild', () => {
  // The preview build was renamed 3 -> 4 along with the product. Both
  // generations must keep matching, and that is not cosmetic: a preview install
  // that stops being recognised falls through to the PRODUCTION userData
  // directory and opens the real database — the precise accident this detector
  // exists to prevent. There was no test here before the rename.
  it.each([
    ['preview3', '/Applications/PlexiDesk 3 Preview.app/Contents/MacOS/PlexiDesk 3 Preview'],
    ['preview4', '/Applications/PlexiDesk 4 Preview.app/Contents/MacOS/PlexiDesk 4 Preview']
  ])('recognises the %s build by env and by path', (env, execPath) => {
    expect(
      detectPreviewBuild({ plexiAppEnv: env, execPath: '/x/Production.app', appName: 'PlexiDesk' })
    ).toBe(true)
    expect(
      detectPreviewBuild({ plexiAppEnv: undefined, execPath, appName: 'PlexiDesk' })
    ).toBe(true)
  })

  it('leaves a production build alone', () => {
    expect(
      detectPreviewBuild({
        plexiAppEnv: undefined,
        execPath: '/Applications/PlexiDesk.app/Contents/MacOS/PlexiDesk',
        appName: 'PlexiDesk'
      })
    ).toBe(false)
  })
})
