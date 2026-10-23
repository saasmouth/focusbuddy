// The context-menu kit's §9.1 additions: danger, checked, hint, focus return.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import CanvasContextMenu from '../../src/renderer/src/components/CanvasContextMenu'
import { focusNewWidget, PRIMARY_INPUT_ATTR } from '../../src/renderer/src/lib/focusNewWidget'

describe('CanvasContextMenu additions', () => {
  it('renders danger, checked and a disabled item’s reason, and returns focus on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() =>
      root.render(
        <CanvasContextMenu
          x={10}
          y={10}
          onClose={() => {}}
          items={[
            { label: 'Grid', checked: true, onClick: () => {} },
            { label: 'Paste', disabled: true, hint: 'Nothing to paste' },
            { separator: true },
            { label: 'Move to Trash', danger: true, onClick: () => {}, testid: 'trash' }
          ]}
        />
      )
    )
    const grid = document.querySelector('[role="menuitemcheckbox"]') as HTMLElement
    expect(grid?.getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('Nothing to paste')
    expect((document.querySelector('[data-testid="trash"]') as HTMLElement).className).toMatch(/text-red-/)
    expect(document.activeElement).not.toBe(opener) // the menu took focus
    // Opaque, not glass (fb-menu-solid): the computed alpha is checked in the
    // built app by officeMenus.spec in light, dark and atelier.
    expect((document.querySelector('[data-canvas-ctx-menu]') as HTMLElement).classList.contains('fb-menu-solid')).toBe(true)
    act(() => root.unmount())
    expect(document.activeElement, 'focus returned to the opener').toBe(opener)
    host.remove()
    opener.remove()
  })
})

// NWT-2 (newWidgetTyping.spec): "Add to this desk" from a side-menu tile's
// right-click menu places a Tasks work widget, which hands the keyboard to its
// Add a task box (focusNewWidget). The menu's focus return (§9.1) gave focus
// back to the tile as the menu closed, and focusNewWidget only takes focus
// from the body, so the typed task went nowhere. Focus the menu put back is not
// a choice the person made: a row whose action moves focus on purpose wins.
describe('focus return vs a row that moves focus', () => {
  it('a just-placed work widget still takes the keyboard after the menu returns focus', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<CanvasContextMenu x={10} y={10} onClose={() => {}} items={[{ label: 'Add to this desk', onClick: () => {} }]} />))
    act(() => root.unmount())
    expect(document.activeElement, 'the menu returned focus').toBe(opener)

    // The placed widget mounts after the menu closed (its IPC create is async).
    const frame = document.createElement('div')
    frame.setAttribute('data-widget-id', 'w-new')
    const input = document.createElement('input')
    input.setAttribute(PRIMARY_INPUT_ATTR, '')
    frame.appendChild(input)
    document.body.appendChild(frame)
    focusNewWidget('w-new')
    await new Promise((r) => setTimeout(r, 100))
    expect(document.activeElement, 'the new widget took the keyboard').toBe(input)

    frame.remove()
    host.remove()
    opener.remove()
  })

  it('but once the person points again, the returned focus is theirs and is never taken', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<CanvasContextMenu x={10} y={10} onClose={() => {}} items={[{ label: 'Add to this desk', onClick: () => {} }]} />))
    act(() => root.unmount())
    // They click the same control again: focus does not move, but it is a choice now.
    opener.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    const frame = document.createElement('div')
    frame.setAttribute('data-widget-id', 'w-new-2')
    const input = document.createElement('input')
    input.setAttribute(PRIMARY_INPUT_ATTR, '')
    frame.appendChild(input)
    document.body.appendChild(frame)
    focusNewWidget('w-new-2')
    await new Promise((r) => setTimeout(r, 100))
    expect(document.activeElement).toBe(opener)

    frame.remove()
    host.remove()
    opener.remove()
  })
})
