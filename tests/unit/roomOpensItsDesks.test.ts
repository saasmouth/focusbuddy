// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-10-08 — "rooms shouldn't be desks" ─────────────────────────────────
//
// Operator: "When someone clicks on a room it should show the desks in the
// room, not a desk." goRoom used to commit kind 'project-dashboard', a single
// desk-shaped canvas, so opening a container showed you one surface instead of
// its contents — and the room's actual desks were reachable only from the
// Rooms index.
//
// The trap this guards: there is no single room-opening component. Six places
// open a room, and four of them had grown their own call to goProject instead
// of going through goRoom, so fixing the store alone would have left most
// doors behaving the old way. These assertions are per-door for that reason.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const store = read('renderer/src/stores/view.ts')

describe('a room opens the desks it contains', () => {
  it('goRoom commits kind "desks" scoped by roomId', () => {
    expect(store).toContain("goRoom: (roomId) => commit({ kind: 'desks', roomId })")
    expect(store).not.toContain("goRoom: (roomId) => commit({ kind: 'project-dashboard'")
  })

  it('goProject still exists for plans, which have a real dashboard', () => {
    expect(store).toContain("goProject: (projectId) => commit({ kind: 'project-dashboard', projectId })")
  })

  it('the desks view is scoped by the roomId the route carries', () => {
    expect(store).toContain("| { kind: 'desks'; roomId?: string }")
    expect(read('renderer/src/components/MainPane.tsx')).toContain('<DesksView roomId={view.roomId} />')
  })
})

describe('every room door goes through goRoom, not goProject', () => {
  // Each door and the selector it must reach for. The Rooms index is the one
  // that calls goDesks(roomId) directly rather than goRoom — the same
  // destination, because goRoom IS that commit; it predates goRoom and reads
  // more plainly in a list that also offers "all desks".
  const doors: Array<[string, string, string]> = [
    ['renderer/src/components/views/RoomsView.tsx', 'the Rooms index', 's.goDesks'],
    ['renderer/src/components/dashboard/FoldersCard.tsx', "Home's folders card", 's.goRoom'],
    ['renderer/src/components/dashboard/WorkspaceHealthCard.tsx', 'the workspace health card', 's.goRoom'],
    ['renderer/src/components/pins/PinTray.tsx', 'a pinned room', 's.goRoom'],
    ['renderer/src/components/views/InboxView.tsx', 'accepting a shared room', 's.goRoom'],
    ['renderer/src/components/StageManagerStrip.tsx', 'back-to-room from a desk', 's.goRoom']
  ]

  for (const [file, what, selector] of doors) {
    it(`${what} opens a room with ${selector.slice(2)}`, () => {
      expect(read(file)).toContain(selector)
    })
  }

  it('the Rooms index sends only PLANS to the dashboard', () => {
    const s = read('renderer/src/components/views/RoomsView.tsx')
    // Plans keep goProject; everything else goes to the room's desks.
    expect(s).toContain('r.isPlan ? goProject(r.id) : goDesks(r.id)')
    expect(s).not.toContain('r.isPlan ? goRoom(r.id)')
  })

  it('no room/folder branch still calls goProject', () => {
    for (const [file] of doors) {
      const s = read(file)
      // A folder- or room-guarded branch must not reach goProject any more.
      const bad = [
        "if (node.kind === 'folder') goProject(",
        "if (res.rootKind === 'folder') {\n          goProject(",
        "item.kind === 'room') {\n      goProject("
      ]
      for (const b of bad) expect(s).not.toContain(b)
    }
  })
})
