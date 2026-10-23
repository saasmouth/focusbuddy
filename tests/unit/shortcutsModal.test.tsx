// GUARD for Help ▸ Keyboard shortcuts, which is generated from the registry.
//
// PlexiiWrite and PlexiiCells each hand-wrote this list, and both listed the
// same eight rows. PlexiiCells' copy promised "Clear formatting ⌘\" — a key the
// grid did not bind. A hand-written list of keys goes stale silently, because
// nothing compares it to the keymap.
//
// Reading the registry means the dialog shows the keys the app really has, and
// these assertions hold it to that.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import { matchCommand } from '../../src/renderer/src/lib/menus/commandKeys'
import { writeCommandsFor } from './_writeCommands'
import { cellsCommandsFor } from './_cellsCommands'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import ShortcutsModal from '../../src/renderer/src/components/documents/editor/ShortcutsModal'

const stubEditor = (): Editor =>
  ({
    isActive: () => false,
    getAttributes: () => ({}),
    can: () => ({ undo: () => true, redo: () => true }),
    chain: () => ({}),
    getHTML: () => '',
    state: { selection: { empty: false } },
    storage: {}
  }) as unknown as Editor

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: { platform: 'darwin' }
  }) as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const show = async (commands: Parameters<typeof ShortcutsModal>[0]['commands']): Promise<void> => {
  await act(async () => {
    root.render(<ShortcutsModal commands={commands} onClose={() => {}} />)
  })
}

/** Each row as "Label ⌘X", from the rendered dialog. */
const rows = (): string[] =>
  [...host.querySelectorAll('[data-testid="shortcuts-list"] > div > div')].map((d) =>
    [...d.querySelectorAll('span')].map((s) => s.textContent ?? '').join(' ')
  )

describe('PlexiiWrite', () => {
  it('lists the keys it binds, with the hint the binding really is', async () => {
    await show(writeCommandsFor(stubEditor()))
    const list = rows()
    expect(list).toContain('Bold ⌘B')
    expect(list).toContain('Clear formatting ⌘\\')
    expect(list).toContain('Find… ⌘F')
    expect(list).toContain('Find and replace… ⇧⌘H')
    expect(list).toContain('Keyboard shortcuts ⌘/')
  })

  it('leaves out every command with no key', async () => {
    // Insert snippet…, Word count and Check accessibility have no binding, so
    // they must not appear in a list of bindings.
    await show(writeCommandsFor(stubEditor()))
    const labels = rows().map((r) => r.split(' ').slice(0, -1).join(' '))
    // Not vacuous: an empty dialog contains none of them either.
    expect(labels).toContain('Bold')
    for (const absent of ['Insert snippet…', 'Word count', 'Check accessibility', 'Highlight'])
      expect(labels).not.toContain(absent)
  })

  it('groups the rows, so a long list stays readable', async () => {
    await show(writeCommandsFor(stubEditor()))
    const headings = [...host.querySelectorAll('[data-testid="shortcuts-list"] > div > div.uppercase')].map(
      (d) => d.textContent
    )
    expect(headings).toContain('Edit')
    expect(headings).toContain('Format')
  })
})

describe('PlexiiCells', () => {
  it('lists Bold and Clear formatting, which it used to claim without binding', async () => {
    await show(cellsCommandsFor())
    const list = rows()
    expect(list).toContain('Bold ⌘B')
    expect(list).toContain('Italic ⌘I')
    expect(list).toContain('Underline ⌘U')
    expect(list).toContain('Clear formatting ⌘\\')
  })

  it('shows nothing it cannot deliver: every listed key really matches', async () => {
    // The dialog and the keymap read the same `keys`, so each row's hint can be
    // turned back into a press that finds the same command.
    const c = cellsCommandsFor()
    const bound = Object.values(c).filter((k) => k.keys)
    expect(bound.length).toBeGreaterThan(5)
    for (const k of bound) {
      const keys = k.keys!
      const press = {
        key: String(keys[keys.length - 1]),
        metaKey: keys.includes('mod'),
        shiftKey: keys.includes('shift'),
        altKey: keys.includes('alt'),
        ctrlKey: keys.includes('ctrl')
      }
      expect(matchCommand(bound, press, 'darwin')?.id, `${k.label} is reachable by its own hint`).toBe(k.id)
    }
  })
})

describe('an app with no bound keys', () => {
  it('says so, rather than showing a list of keys it does not have', async () => {
    await show({})
    expect(host.querySelector('[data-testid="shortcuts-none"]')?.textContent).toContain('no keyboard shortcuts')
    expect(host.querySelector('[data-testid="shortcuts-list"]')).toBeNull()
  })
})
