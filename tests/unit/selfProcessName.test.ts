import { describe, it, expect } from 'vitest'
import { appleScriptNameList, selfProcessNames } from '../../src/main/selfProcessName'

// The frontmost-app checks (activity log, SpeedDeck key targeting) must skip
// the app's own process. System Events reports it by executable name, which is
// productName — never app.name ("plexii") in a packaged build.

describe('selfProcessNames', () => {
  it('names the packaged executable, app.name and Electron', () => {
    expect(selfProcessNames('/Applications/PlexiiDesk.app/Contents/MacOS/PlexiiDesk', 'plexii')).toEqual([
      'PlexiiDesk',
      'plexii',
      'Electron'
    ])
  })

  it('follows the executable, not the bundle directory, after an in-place update', () => {
    // Squirrel keeps the old "PlexiDesk.app" directory; the executable is new.
    expect(selfProcessNames('/Applications/PlexiDesk.app/Contents/MacOS/PlexiiDesk', 'plexii')[0]).toBe('PlexiiDesk')
  })

  it('handles a versioned local install, dev, and Windows', () => {
    expect(selfProcessNames('/Applications/PlexiiDesk 4.3.33.app/Contents/MacOS/PlexiiDesk', 'plexii')[0]).toBe('PlexiiDesk')
    expect(selfProcessNames('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'plexii')).toEqual([
      'Electron',
      'plexii'
    ])
    expect(selfProcessNames('C:\\Programs\\PlexiDesk\\PlexiiDesk.exe', 'plexii')[0]).toBe('PlexiiDesk')
  })

  it('never lets a quote into the AppleScript it is embedded in', () => {
    expect(selfProcessNames('/x/My"App', 'a\\b')).toEqual(['Electron'])
    expect(appleScriptNameList(['PlexiiDesk', 'Electron'])).toBe('{"PlexiiDesk", "Electron"}')
  })
})
