// The tray of things you have open.
//
// Two properties carry the whole design, and both are easy to lose in a later
// edit: only a view that names a SUBJECT earns an entry (or the tray becomes a
// second navigation bar at the bottom of the screen), and closing an entry
// touches the subject not at all (or the close button is a trap).
import { describe, it, expect } from 'vitest'
import {
  trayKeyFor,
  openIn,
  closeIn,
  closeOthersIn,
  togglePinIn,
  orderTray,
  pruneTray,
  MAX_TRAY,
  type TrayEntry, documentIdOf } from '../../src/renderer/src/lib/openTray'
import type { View } from '../../src/renderer/src/stores/view'

const at = (n: number): number => 1_700_000_000_000 + n

describe('what earns a place', () => {
  it('keeps the things a person would say they had open', () => {
    expect(trayKeyFor({ kind: 'task', taskId: 't1' })).toBe('task:t1')
    expect(trayKeyFor({ kind: 'document', documentId: 'd1' })).toBe('document:d1')
    expect(trayKeyFor({ kind: 'livedoc', liveDocId: 'l1' })).toBe('livedoc:l1')
    expect(trayKeyFor({ kind: 'connected-app', appId: 'slack' })).toBe('app:slack')
    expect(trayKeyFor({ kind: 'messages' })).toBe('messages')
    expect(trayKeyFor({ kind: 'mail' })).toBe('mail')
  })

  it('refuses the places you merely go', () => {
    // A tray listing Home and Trash is a second nav bar at the bottom.
    for (const v of [
      { kind: 'home' },
      { kind: 'trash' },
      { kind: 'calendar' },
      { kind: 'attention' },
      { kind: 'rooms' },
      { kind: 'documents' },
      { kind: 'files' }
    ] as View[]) {
      expect(trayKeyFor(v), v.kind).toBeNull()
    }
  })

  it('tells a specific room from the room index', () => {
    expect(trayKeyFor({ kind: 'desks', roomId: 'r1' })).toBe('room:r1')
    expect(trayKeyFor({ kind: 'desks' })).toBeNull()
  })

  it('tells a knowledge entry from the knowledge index', () => {
    expect(trayKeyFor({ kind: 'knowledge', entryId: 'k1' })).toBe('knowledge:k1')
    expect(trayKeyFor({ kind: 'knowledge' })).toBeNull()
  })
})

describe('opening', () => {
  it('adds a thing once, however many times you visit it', () => {
    let list = openIn([], { kind: 'task', taskId: 't1' }, at(1))
    list = openIn(list, { kind: 'task', taskId: 't1' }, at(2))
    list = openIn(list, { kind: 'task', taskId: 't1' }, at(3))
    expect(list).toHaveLength(1)
    expect(list[0].at).toBe(at(3))
  })

  it('does not reorder the strip when you revisit', () => {
    // The tray is a set of POSITIONS. Re-sorting it under the cursor every time
    // somebody glances at a desk would make it unusable for muscle memory.
    let list = openIn([], { kind: 'task', taskId: 'a' }, at(1))
    list = openIn(list, { kind: 'document', documentId: 'b' }, at(2))
    list = openIn(list, { kind: 'task', taskId: 'a' }, at(3))
    expect(list.map((e) => e.key)).toEqual(['task:a', 'document:b'])
  })

  it('ignores a view that is a place', () => {
    expect(openIn([], { kind: 'home' }, at(1))).toEqual([])
  })

  it('keeps the newest view for an entry, so a deep link updates it', () => {
    const list = openIn(
      openIn([], { kind: 'mail' }, at(1)),
      { kind: 'mail', openUid: 42 },
      at(2)
    )
    expect(list).toHaveLength(1)
    expect(list[0].view).toEqual({ kind: 'mail', openUid: 42 })
  })
})

describe('eviction', () => {
  const fill = (n: number): TrayEntry[] => {
    let list: TrayEntry[] = []
    for (let i = 0; i < n; i++) list = openIn(list, { kind: 'task', taskId: `t${i}` }, at(i))
    return list
  }

  it('stops the tray becoming a list to read', () => {
    expect(fill(MAX_TRAY + 5).length).toBe(MAX_TRAY)
  })

  it('drops the least recently seen', () => {
    let list = fill(MAX_TRAY)
    list = openIn(list, { kind: 'task', taskId: 't0' }, at(999)) // t0 is now newest
    list = openIn(list, { kind: 'task', taskId: 'new' }, at(1000))
    expect(list.map((e) => e.key)).toContain('task:t0')
    expect(list.map((e) => e.key)).not.toContain('task:t1')
  })

  it('never evicts something pinned', () => {
    let list = fill(MAX_TRAY)
    list = togglePinIn(list, 'task:t0')
    for (let i = 0; i < 20; i++) {
      list = openIn(list, { kind: 'task', taskId: `x${i}` }, at(2000 + i))
    }
    expect(list.map((e) => e.key)).toContain('task:t0')
  })

  it('lets the tray exceed the cap rather than drop a pin the user asked for', () => {
    let list = fill(MAX_TRAY)
    for (const key of list.map((e) => e.key)) list = togglePinIn(list, key)
    expect(list.every((e) => e.pinned)).toBe(true)
    list = openIn(list, { kind: 'task', taskId: 'extra' }, at(3000))
    expect(list.length).toBe(MAX_TRAY + 1)
  })
})

describe('closing', () => {
  it('removes the entry', () => {
    const list = openIn([], { kind: 'task', taskId: 't1' }, at(1))
    expect(closeIn(list, 'task:t1')).toEqual([])
  })

  it('is a no-op for a key that is not there', () => {
    const list = openIn([], { kind: 'task', taskId: 't1' }, at(1))
    expect(closeIn(list, 'task:nope')).toEqual(list)
  })

  it('closes the others but keeps pins', () => {
    let list = openIn([], { kind: 'task', taskId: 'a' }, at(1))
    list = openIn(list, { kind: 'task', taskId: 'b' }, at(2))
    list = openIn(list, { kind: 'task', taskId: 'c' }, at(3))
    list = togglePinIn(list, 'task:c')
    expect(closeOthersIn(list, 'task:a').map((e) => e.key).sort()).toEqual(['task:a', 'task:c'])
  })
})

describe('ordering', () => {
  it('puts pinned first and otherwise leaves the order alone', () => {
    let list = openIn([], { kind: 'task', taskId: 'a' }, at(1))
    list = openIn(list, { kind: 'task', taskId: 'b' }, at(2))
    list = openIn(list, { kind: 'task', taskId: 'c' }, at(3))
    list = togglePinIn(list, 'task:c')
    expect(orderTray(list).map((e) => e.key)).toEqual(['task:c', 'task:a', 'task:b'])
  })
})

describe('pruning', () => {
  const list = [
    { key: 'task:gone', view: { kind: 'task', taskId: 'gone' } as View, at: at(1) },
    { key: 'task:here', view: { kind: 'task', taskId: 'here' } as View, at: at(2) },
    { key: 'mail', view: { kind: 'mail' } as View, at: at(3) }
  ]

  it('drops an entry whose subject is gone', () => {
    const out = pruneTray(list, (e) => (e.key === 'task:gone' ? false : true))
    expect(out.map((e) => e.key)).toEqual(['task:here', 'mail'])
  })

  it('KEEPS anything the resolver has no opinion about', () => {
    // "I do not know" must never read as "it is gone", or a store that has not
    // finished loading would quietly empty the tray on startup.
    expect(pruneTray(list, () => undefined)).toEqual(list)
  })

  it('keeps everything when nothing is gone', () => {
    expect(pruneTray(list, () => true)).toEqual(list)
  })
})

describe('office apps in the tray', () => {
  it('keeps an Office app you have open', () => {
    expect(trayKeyFor({ kind: 'office', app: 'browser' })).toBe('office:browser')
    expect(trayKeyFor({ kind: 'office', app: 'chat' })).toBe('office:chat')
  })

  it('treats the Office hub itself as a place, not a thing', () => {
    expect(trayKeyFor({ kind: 'office' })).toBeNull()
  })

  it('keeps each app separate, so Chat and the Browser are two tabs', () => {
    let list = openIn([], { kind: 'office', app: 'chat' }, at(1))
    list = openIn(list, { kind: 'office', app: 'browser' }, at(2))
    expect(list.map((e) => e.key)).toEqual(['office:chat', 'office:browser'])
  })
})

// A document open inside the Office shell.
//
// This is the case the tray originally missed. Office rendered documents from
// local React state, so the document you had just created existed only inside
// one component: the tray could not list it and the history arrows could not
// return to it. The fix made it navigation, and these pin that down.
describe('a document open inside Office', () => {
  it('earns a tray entry', () => {
    expect(trayKeyFor({ kind: 'office', doc: 'd1' })).toBe('document:d1')
  })

  it('is the SAME entry as the standalone document route', () => {
    // One document, one tab, whichever way you got to it. Two keys here would
    // put the same file in the tray twice.
    expect(trayKeyFor({ kind: 'office', doc: 'd1' })).toBe(
      trayKeyFor({ kind: 'document', documentId: 'd1' })
    )
  })

  it('outranks the app it is open in', () => {
    // The subject is the document, not "PlexiOffice".
    expect(trayKeyFor({ kind: 'office', app: 'docs', doc: 'd1' })).toBe('document:d1')
  })

  it('leaves the bare Office app entry alone', () => {
    expect(trayKeyFor({ kind: 'office', app: 'browser' })).toBe('office:browser')
  })

  it('still treats the Office hub as a place', () => {
    expect(trayKeyFor({ kind: 'office' })).toBeNull()
  })
})

describe('documentIdOf', () => {
  it('finds the document on both routes', () => {
    expect(documentIdOf({ kind: 'document', documentId: 'd1' })).toBe('d1')
    expect(documentIdOf({ kind: 'office', doc: 'd1' })).toBe('d1')
  })

  it('is null for a view with no document', () => {
    // Anything that drags from a tab asks this first, so a wrong answer here
    // makes a desk tab draggable.
    expect(documentIdOf({ kind: 'office', app: 'mail' })).toBeNull()
    expect(documentIdOf({ kind: 'office' })).toBeNull()
    expect(documentIdOf({ kind: 'task', taskId: 't1' })).toBeNull()
    expect(documentIdOf({ kind: 'suite' })).toBeNull()
  })
})

// One screen, one tab — however you got there.
//
// Several screens are reachable both as a top-level view and as an app inside a
// segment, and the two render differently on purpose: Mail beside your desk
// sidebar, or Mail inside the Office shell. Arriving from a desk keeping your
// desk context is a feature. The tray treating them as two SUBJECTS was not: it
// listed two tabs both saying "Mail" for the same inbox.
describe('screens reachable two ways get one tray entry', () => {
  it('gives Office Mail and the standalone Mail one identity', () => {
    expect(trayKeyFor({ kind: 'office', app: 'mail' })).toBe(trayKeyFor({ kind: 'mail' }))
  })

  it('does not list "My Desk" as a second tab for the desk you are on', () => {
    // plexidesk:desk is a route to whichever desk is ACTIVE, not a subject —
    // that desk is already in the tray under its own name.
    expect(trayKeyFor({ kind: 'plexidesk', app: 'desk' })).toBeNull()
  })

  it('leaves the other segment apps with their own identity', () => {
    // Only genuine duplicates collapse. Plans and Files are not reachable as
    // traying top-level views, so they keep their own tabs.
    expect(trayKeyFor({ kind: 'plexidesk', app: 'plans' })).toBe('plexidesk:plans')
    expect(trayKeyFor({ kind: 'plexidesk', app: 'files' })).toBe('plexidesk:files')
    expect(trayKeyFor({ kind: 'office', app: 'chat' })).toBe('office:chat')
  })

  it('keeps Office Chat and the Chat screen separate — they are different views', () => {
    // office:chat renders MessagesView; view.messages renders FlowView. Same
    // word, different screens, so collapsing them would hide one.
    expect(trayKeyFor({ kind: 'office', app: 'chat' })).not.toBe(trayKeyFor({ kind: 'messages' }))
  })
})
