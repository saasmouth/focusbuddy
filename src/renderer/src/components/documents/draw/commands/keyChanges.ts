// What moved when PlexiiDraw switched to Illustrator's default keys: the list
// the one-time notice shows. A unit test diffs the keymap from before the
// switch against today's, so this list is exactly the keys that changed --
// nothing missing and nothing extra.

import { formatKey, type KeyPlatform } from './keys'

export interface KeyChange {
  /** What the key belongs to, as people see it. */
  what: string
  kind: 'tool' | 'command'
  id: string
  /** The key before (keymap form). */
  from: string
  /** The key now, or null when it has none by default. */
  to: string | null
  /** One short line; `{key}` placeholders are written for the platform. */
  note?: string
}

export const KEY_CHANGES: KeyChange[] = [
  {
    what: 'Rectangle',
    kind: 'tool',
    id: 'rect',
    from: 'r',
    to: 'm',
    note: 'R is Rotate in Illustrator'
  },
  { what: 'Ellipse', kind: 'tool', id: 'ellipse', from: 'o', to: 'l', note: 'O is Reflect' },
  { what: 'Line', kind: 'tool', id: 'line', from: 'l', to: '\\' },
  {
    what: 'Eraser',
    kind: 'tool',
    id: 'eraser',
    from: 'e',
    to: 'shift+e',
    note: 'E is Free Transform'
  },
  {
    what: 'Paint bucket',
    kind: 'tool',
    id: 'bucket',
    from: 'g',
    to: 'k',
    note: 'G is the Gradient tool'
  },
  {
    what: 'Rounded rectangle',
    kind: 'tool',
    id: 'roundRect',
    from: 'd',
    to: null,
    note: 'pick it in the toolbox'
  },
  {
    what: 'Polygon',
    kind: 'tool',
    id: 'polygon',
    from: 'u',
    to: null,
    note: 'pick it in the toolbox'
  },
  {
    what: 'Star',
    kind: 'tool',
    id: 'star',
    from: 's',
    to: null,
    note: 'pick it in the toolbox; S is Scale'
  },
  {
    what: 'Duplicate',
    kind: 'command',
    id: 'edit.duplicate',
    from: 'mod+d',
    to: null,
    note: 'Edit › Duplicate; {mod+d} is now Transform again'
  },
  {
    what: 'Redo',
    kind: 'command',
    id: 'edit.redo',
    from: 'mod+y',
    to: null,
    note: '{mod+shift+z} still redoes; {mod+y} is Outline view in Illustrator'
  }
]

/** A change's note with its `{key}` placeholders written for the platform. */
export function changeNote(c: KeyChange, p?: KeyPlatform): string | undefined {
  return c.note?.replace(/\{([^}]+)\}/g, (_, k: string) => formatKey(k, p))
}

/** Where the notice's dismissal is kept: localStorage, which Electron keeps per profile. */
export const NOTICE_STORAGE_KEY = 'fb.draw.illustratorKeysNotice.v1'

export function noticeDismissed(): boolean {
  try {
    return localStorage.getItem(NOTICE_STORAGE_KEY) === 'dismissed'
  } catch {
    // No storage (a locked-down profile): showing it every time beats never.
    return false
  }
}

export function dismissNotice(): void {
  try {
    localStorage.setItem(NOTICE_STORAGE_KEY, 'dismissed')
  } catch {
    // Nothing to do: it will show again next time, which is honest.
  }
}
