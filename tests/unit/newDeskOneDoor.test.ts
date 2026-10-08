// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-10-08 — "New desk" meant two different things ─────────────────────
//
// Operator: "new desk there launches the wizard builder, but new desk
// elsewhere does not. Align the functionality so it works the same anywhere a
// new desk is created."
//
// The sidebar opened the set-up dialog. The Desks index, the Home create chip
// and the suite launcher each called nodes.create() directly with the literal
// title 'New desk' and navigated there, so three of the four doors handed you
// an untitled desk filed nowhere. They all go through requestNewDesk now.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')

const DOORS: Array<[string, string]> = [
  ['renderer/src/components/views/DesksView.tsx', 'the Desks index'],
  ['renderer/src/components/suite/PlexiSuiteHome.tsx', 'the suite launcher'],
  ['renderer/src/components/views/homeWidgets.tsx', "Home's create chip"],
  ['renderer/src/components/DeskGallery.tsx', 'the desk gallery']
]

describe('every new-desk door opens the same set-up dialog', () => {
  for (const [file, what] of DOORS) {
    it(`${what} calls requestNewDesk`, () => {
      const s = read(file)
      expect(s).toContain('requestNewDesk')
      expect(s).toMatch(/from '(\.\.\/)+lib\/newDesk'/)
    })
  }

  it('the sidebar button still opens the dialog directly — it owns it', () => {
    const s = read('renderer/src/components/Sidebar.tsx')
    expect(s).toContain("function requestCreateDesk(): void {\n    setDialog({ mode: 'create', parentId: null, kind: 'task' })")
  })

  it('the Desks index pre-files into the room being viewed', () => {
    expect(read('renderer/src/components/views/DesksView.tsx')).toContain(
      'requestNewDesk(roomId ?? null)'
    )
  })
})

describe('the door can tell whether a dialog exists', () => {
  const helper = read('renderer/src/lib/newDesk.ts')

  it('the event is cancelable and the result is reported', () => {
    expect(helper).toContain('cancelable: true')
    expect(helper).toContain('return ev.defaultPrevented')
  })

  it('the sidebar claims the event so callers can detect it', () => {
    expect(read('renderer/src/components/Sidebar.tsx')).toContain('if (e.cancelable) e.preventDefault()')
  })

  it('each caller still has a direct-create fallback, so no door is ever dead', () => {
    // A surface with no sidebar mounted would otherwise get a button that does
    // nothing at all — worse than the direct create this replaced.
    for (const [file] of DOORS.filter(([f]) => !f.endsWith('DeskGallery.tsx'))) {
      const s = read(file)
      expect(s).toMatch(/if \(requestNewDesk\([^)]*\)\) return/)
      expect(s).toContain("kind: 'task', title: 'New desk'")
    }
  })
})
