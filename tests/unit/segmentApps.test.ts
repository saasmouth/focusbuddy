import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEGMENT_APPS, lookupApp, isHubApp, appMeta, type SegmentKind } from '../../src/renderer/src/lib/segmentApps'
import { trayKeyFor } from '../../src/renderer/src/lib/openTray'

const KINDS: SegmentKind[] = ['plexidesk', 'plexipeople', 'plexibrain', 'office']
const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

// The app open inside a segment is navigation, not local state.
//
// This bug has now been fixed three times — the Office comms apps, the document
// open inside Office, and the twenty-four apps across PlexiDesk, PlexiPeople and
// PlexiBrain. Each time the symptom was the same: nothing outside the component
// could tell what you had open, so the tray could not list it, Back did nothing,
// and a reload lost it. These exist so there is not a fourth time.
describe('segment apps reach the tray', () => {
  it('gives every non-hub app a tray identity', () => {
    for (const kind of KINDS) {
      for (const app of SEGMENT_APPS[kind]) {
        const key = trayKeyFor({ kind, app: app.key } as never)
        if (app.hub) continue
        expect(key, `${kind}:${app.key} should be listable`).toBe(`${kind}:${app.key}`)
      }
    }
  })

  it('keeps every segment hub OUT of the tray', () => {
    // The tray lists what you have open, not where you can go. Four tabs all
    // reading a variant of "Home" would make it a second navigation bar.
    for (const kind of KINDS) {
      expect(trayKeyFor({ kind } as never), `${kind} hub`).toBeNull()
      const hub = SEGMENT_APPS[kind].find((a) => a.hub)
      expect(hub, `${kind} should name its hub`).toBeTruthy()
      expect(trayKeyFor({ kind, app: hub!.key } as never)).toBeNull()
    }
  })

  it('can name and illustrate every app it lists', () => {
    // A tray tab rendering its raw key is what a second, drifting copy of this
    // list produced: office:home had no entry and showed "home".
    for (const kind of KINDS) {
      for (const app of SEGMENT_APPS[kind]) {
        const meta = lookupApp(kind, app.key)
        expect(meta, `${kind}:${app.key}`).toBeTruthy()
        expect(meta!.label.trim().length).toBeGreaterThan(0)
        expect(meta!.label).not.toBe(app.key)
        expect(meta!.icon.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('has no duplicate keys within a segment', () => {
    for (const kind of KINDS) {
      const keys = SEGMENT_APPS[kind].map((a) => a.key)
      expect(new Set(keys).size, `${kind} has a duplicate key`).toBe(keys.length)
    }
  })

  it('keeps tray labels distinguishable across segments', () => {
    // Every segment has a "home"; if they all said "Home" the tray would be
    // four identical tabs. Only the hubs may collide, and hubs are excluded.
    const listed = KINDS.flatMap((k) => SEGMENT_APPS[k].filter((a) => !a.hub).map((a) => a.label))
    expect(new Set(listed).size, `duplicate tray labels: ${listed.join(', ')}`).toBe(listed.length)
  })

  it('falls back honestly for a key it does not know', () => {
    // Views are persisted across releases; an app that has since been renamed
    // must degrade, not crash or invent.
    expect(lookupApp('plexibrain', 'retired-app')).toBeNull()
    expect(lookupApp('plexidesk', undefined)).toBeNull()
    expect(appMeta('plexidesk', 'desk' as never).label).toBe('My Desk')
    expect(isHubApp('plexidesk', undefined)).toBe(true)
    expect(isHubApp('plexibrain', 'retired-app')).toBe(false)
  })
})

// A source-level guard. The property that broke is invisible at runtime until
// someone notices a tab missing, so it is asserted where it is introduced.
describe('the shells navigate rather than remember', () => {
  it('SegmentShell derives the open app from the view, and navigates to change it', () => {
    const f = src('src/renderer/src/components/segment/SegmentShell.tsx')
    expect(f, 'the open app must not be local state again').not.toMatch(
      /useState<string \| null>\(initialApp/
    )
    expect(f).toMatch(/goPlexiDesk|goPlexiPeople|goPlexiBrain/)
  })

  it('PlexiOfficeShell does the same for its apps and its open document', () => {
    const f = src('src/renderer/src/components/office/PlexiOfficeShell.tsx')
    expect(f).not.toMatch(/const \[activeComms, setActiveComms\] = useState/)
    expect(f).not.toMatch(/const \[openDocId, setOpenDocId\] = useState/)
    expect(f).toMatch(/goOffice/)
  })

  it('every segment shell tells SegmentShell which segment it is', () => {
    // Without `kind` the shell cannot know which navigation action to call, and
    // would silently fall back to one of them.
    const f = src('src/renderer/src/components/segment/segments.tsx')
    for (const kind of ['plexidesk', 'plexipeople', 'plexibrain']) {
      expect(f, `${kind} shell must declare its kind`).toContain(`kind: '${kind}'`)
    }
  })

  it('the shells take their labels and icons from the registry, not a second copy', () => {
    const f = src('src/renderer/src/components/segment/segments.tsx')
    expect(f).toContain('appMeta(')
    // A literal label next to a key is the drift this replaced.
    expect(f).not.toMatch(/\{ key: '[^']+', label: '/)
  })
})
