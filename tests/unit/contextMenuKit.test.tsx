// The context-menu kit's §9.1 additions: danger, checked, hint, focus return.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import CanvasContextMenu from '../../src/renderer/src/components/CanvasContextMenu'

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
    act(() => root.unmount())
    expect(document.activeElement, 'focus returned to the opener').toBe(opener)
    host.remove()
    opener.remove()
  })
})
