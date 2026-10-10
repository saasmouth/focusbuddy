// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  validateWidgetRef,
  isRefKind,
  REF_OBJECT_KIND,
  type RefCandidate
} from '../../src/shared/widgetRefs'

// A task-link holds a desk id. A portal holds the desk it watches. A drive
// widget holds a folder id, a file widget a file id, a table widget an
// fb_tables id. One id, nothing else — the chart's problem in miniature, and
// with the same quiet failures:
//
//   invented id    → the widget renders empty, reading as "nothing here"
//                    rather than "wrong target"
//   wrong kind     → a folder where a file is meant renders empty too
//
// Nothing throws in either case, so the expert is handed the real objects and
// its answer is checked before it is written.

const desks: RefCandidate[] = [
  { id: 'n-launch', title: 'Q3 launch', objectKind: 'desk' },
  { id: 'n-hiring', title: 'Hiring', objectKind: 'desk' }
]

describe('a reference to something real is accepted', () => {
  it('accepts a desk for a task-link', () => {
    expect(validateWidgetRef('task-link', 'n-launch', desks)).toEqual({ ok: true })
  })

  it('accepts a desk for a portal, which watches one', () => {
    expect(validateWidgetRef('portal', 'n-hiring', desks)).toEqual({ ok: true })
  })

  it('tolerates surrounding whitespace, since models add it', () => {
    expect(validateWidgetRef('task-link', '  n-launch  ', desks).ok).toBe(true)
  })
})

describe('invented and mismatched ids are refused by name', () => {
  it('refuses an id that is in no candidate list', () => {
    const r = validateWidgetRef('task-link', 'n-made-up', desks)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('n-made-up')
  })

  it('refuses the right id of the WRONG kind of object', () => {
    // A folder accepted where a file is meant renders an empty widget — the
    // same quiet failure, so it is refused twice over.
    const mixed: RefCandidate[] = [{ id: 'f-1', title: 'Contracts', objectKind: 'folder' }]
    const r = validateWidgetRef('file', 'f-1', mixed)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('Contracts is a folder')
    expect(r.ok === false && r.reason).toContain('points at a file')
  })

  it('refuses an empty or missing id rather than writing nothing', () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
      expect(validateWidgetRef('task-link', bad, desks).ok, String(bad)).toBe(false)
    }
  })

  it('refuses everything when the workspace has no candidates', () => {
    // Nothing can be referenced that nobody can see, so an empty universe is
    // a refusal and not a free pass.
    expect(validateWidgetRef('task-link', 'n-launch', []).ok).toBe(false)
  })

  it('refuses a widget kind that holds no reference at all', () => {
    const r = validateWidgetRef('sticky', 'n-launch', desks)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('does not hold a reference')
  })
})

describe('the kinds that hold references are declared, not guessed', () => {
  it('covers the five reference widgets and nothing else', () => {
    expect(Object.keys(REF_OBJECT_KIND).sort()).toEqual([
      'drive',
      'file',
      'portal',
      'table',
      'task-link'
    ])
  })

  it('each names what kind of object it points at', () => {
    expect(REF_OBJECT_KIND['task-link']).toBe('desk')
    expect(REF_OBJECT_KIND.portal).toBe('desk')
    expect(REF_OBJECT_KIND.table).toBe('table')
    expect(REF_OBJECT_KIND.drive).toBe('folder')
    expect(REF_OBJECT_KIND.file).toBe('file')
  })

  it('isRefKind agrees with the table', () => {
    expect(isRefKind('portal')).toBe(true)
    expect(isRefKind('sticky')).toBe(false)
  })
})
