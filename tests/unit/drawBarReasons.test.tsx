// The top bar and the menu say the same thing (SPEC §9.5, §9.9). Every bar
// button bound to a Draw command takes its off tooltip from that command's
// gated reason (commands/gate.ts) -- a button has no reason of its own -- so
// the bar can never say something different from the menu item. And the Path
// tab merges paths the one way Draw has: Object › Compound Path › Make (⌘8).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

// Each command-bound button, tagged with the command it runs, so the test can
// ask that command for its reason. The real button renders inside.
vi.mock('../../src/renderer/src/components/documents/draw/bar/controls', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/components/documents/draw/bar/controls')>()
  return {
    ...real,
    CmdButton: (p: Parameters<typeof real.CmdButton>[0]) => (
      <span data-cmd={p.id}>
        <real.CmdButton {...p} />
      </span>
    ),
    CmdToggle: (p: Parameters<typeof real.CmdToggle>[0]) => (
      <span data-cmd={p.id}>
        <real.CmdToggle {...p} />
      </span>
    )
  }
})

import { drawBarTabs, barTabById } from '../../src/renderer/src/components/documents/draw/bar/registry'
import { commandById } from '../../src/renderer/src/components/documents/draw/commands/registry'
import { setKeyPlatform } from '../../src/renderer/src/components/documents/draw/commands/keys'
import type { DrawNode } from '../../src/shared/draw/model'
import { blank, harness, rect, type Harness } from './drawTools/harness'

vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { api: { platform: 'darwin' } }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  setKeyPlatform('mac')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('a bar button bound to a command says what the menu says when it is off', () => {
  it.each([
    ['a blank drawing', () => harness(blank())],
    ['a read-only drawing', () => harness(blank(), { readOnly: true })],
    [
      'a drawing with a locked layer, its shapes selected',
      () => {
        const h = harness(blank([rect('a', 10, 10, 50, 50), rect('b', 100, 10, 50, 50)]))
        h.ed.ctx.select(['a', 'b'])
        h.run('layer.patch', { id: h.doc().layers[0].id, patch: { locked: true } })
        return h
      }
    ]
  ])('in %s, on every tab', (_state, make) => {
    const h = make()
    const checked: string[] = []
    const wrong: string[] = []
    for (const tab of drawBarTabs()) {
      const C = tab.component
      // Every tab, shown or not in this context: its buttons must be right whenever it is.
      act(() => root.render(<C ctx={h.ed.ctx} />))
      for (const el of host.querySelectorAll<HTMLElement>('[data-cmd]')) {
        const id = el.dataset.cmd!
        const button = el.querySelector('button')!
        if (!button.disabled) continue
        const why = commandById(id)!.disabledReason?.(h.ed.ctx) ?? null
        const tip = button.getAttribute('aria-label') ?? ''
        const shown = tip.includes(' — ') ? tip.slice(tip.indexOf(' — ') + 3) : null
        checked.push(id)
        if (shown !== why) wrong.push(`${tab.id} ${button.dataset.testid ?? id}: bar "${shown}" vs command "${why}"`)
      }
      act(() => root.render(<></>))
    }
    expect(wrong).toEqual([])
    // Not vacuous: plenty of buttons are off in each of these states.
    expect(checked.length).toBeGreaterThan(20)
  })
})

describe('the Path tab merges paths the way ⌘8 does', () => {
  // Two overlapping rectangles: as a compound path, the front one cuts a hole.
  const two = (): Harness => {
    const h = harness(blank([rect('a', 0, 0, 100, 100), rect('b', 25, 25, 50, 50)]))
    h.ed.ctx.select(['a', 'b'])
    return h
  }
  const shape = (h: Harness): unknown =>
    h.objects().map((o: DrawNode) => {
      const { id: _id, ...rest } = o as DrawNode & { id: string }
      void _id
      return rest
    })

  it('every Path-tab button that merges the selected paths into one makes exactly what ⌘8 makes', () => {
    const viaKey = two()
    viaKey.key('8', { meta: true, code: 'Digit8' })
    expect(viaKey.objects()).toHaveLength(1)
    const want = shape(viaKey)

    // Merge (draw-path-merge) and Compound Path › Make (draw-compound-make):
    // whichever of them the tab has.
    const probe = two()
    act(() => root.render(<>{(() => { const C = barTabById('path')!.component; return <C ctx={probe.ed.ctx} /> })()}</>))
    const merging = ['draw-path-merge', 'draw-compound-make'].filter((t) => host.querySelector(`[data-testid="${t}"]`))
    act(() => root.render(<></>))
    expect(merging).toContain('draw-compound-make')

    for (const testid of merging) {
      const h = two()
      const C = barTabById('path')!.component
      act(() => root.render(<C ctx={h.ed.ctx} />))
      act(() => (host.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement).click())
      act(() => root.render(<></>))
      expect(shape(h), testid).toEqual(want)
    }
  })

  it('"Join into one path" is gone from Object › Path and from the registry', () => {
    expect(commandById('object.join')).toBeUndefined()
  })
})
