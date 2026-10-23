// What PlexiiWrite's Home tab and empty page SHOW (rails-tabs-41 shots,
// Write-home.png):
//   - the Styles button's face read "Styles — apply and customise paragraph
//     styles", wrapped over two lines: its whole label, description and all;
//   - the font size of an empty document read "—", as if it had none;
//   - an empty document drew no prompt: the placeholder rule never reached
//     Write's surface.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import type { Editor } from '@tiptap/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BarButton, BarDialogButton, BarMenu, BarToggle, barText, ContextBar } from '../../src/renderer/src/components/office/shell'
import { WRITE_TABS, type WCtx } from '../../src/renderer/src/components/documents/editor/writeRibbon'
import { writeCommandsFor } from './_writeCommands'
import { caretFontSize } from '../../src/renderer/src/components/documents/editor/fontSize'
import { DOC_SURFACE_CLASS } from '../../src/renderer/src/components/documents/editor/surface'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  localStorage.clear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const noop = (): void => {}
const anyFn = <T,>(over: Record<string, unknown> = {}): T => new Proxy(over, { get: (t, k) => (k in t ? t[k as string] : noop) }) as T

/** A Write editor on screen: an empty paragraph whose text is `px` big, caret in it, no size mark. */
function editorAt(px: number | null): Editor {
  const dom = document.createElement('div')
  const p = document.createElement('p')
  if (px !== null) p.style.fontSize = `${px}px`
  dom.appendChild(p)
  document.body.appendChild(dom)
  return {
    isActive: () => false,
    getAttributes: () => ({}),
    can: () => ({ undo: () => false, redo: () => false }),
    isDestroyed: false,
    view: { dom, domAtPos: () => ({ node: p, offset: 0 }) },
    state: { selection: { from: 1 } }
  } as unknown as Editor
}

/** The words on a control's face: its text without icon glyph names (Material ligatures). */
function faceText(el: Element): string {
  const c = el.cloneNode(true) as Element
  c.querySelectorAll('.material-symbols-outlined, svg').forEach((n) => n.remove())
  return (c.textContent ?? '').trim()
}

// Write's ribbon renders its command registry (writeCommands, SPEC §9.9): the real one on this editor.
const writeCtx = (editor: Editor): WCtx =>
  anyFn<WCtx>({ editor, readOnly: false, pageView: false, styleLabel: 'Normal', sidePane: null, isPanelOpen: () => false, hasTracked: false, commands: writeCommandsFor(editor) })

function mountHome(editor: Editor): void {
  act(() => root.render(<ContextBar testid="doc-toolbar" tabs={WRITE_TABS} ctx={writeCtx(editor)} activeTab="home" onTabChange={noop} menuBar={null} />))
}

describe('Write Home tab, as it reads', () => {
  it('the Styles button says "Styles"; its description stays in the tooltip and accessible name', () => {
    mountHome(editorAt(15))
    const btn = host.querySelector('[data-testid="doc-styles-btn"]') as HTMLElement
    expect(faceText(btn)).toBe('Styles')
    expect(faceText(btn)).not.toContain('—')
    expect(btn.getAttribute('aria-label')).toBe('Styles — apply and customise paragraph styles')
  })

  it('an empty document’s font size shows the size its text is, not "—"', () => {
    mountHome(editorAt(15))
    const size = host.querySelector('[data-bar-semantic="font-size"]') as HTMLInputElement
    expect(size.value).toBe('15')
  })

  it('a size the text cannot be measured for still shows blank, never an invented number', () => {
    const e = editorAt(15)
    ;(e.view.dom as HTMLElement).remove() // not on screen
    mountHome(e)
    expect((host.querySelector('[data-bar-semantic="font-size"]') as HTMLInputElement).value).toBe('')
  })
})

describe('bar faces show the name, not the description', () => {
  it('barText', () => {
    expect(barText('Styles — apply and customise paragraph styles')).toBe('Styles')
    expect(barText('Bold')).toBe('Bold')
    expect(barText('Layouts and themes…')).toBe('Layouts and themes…')
  })

  it('every primitive that shows a label shows only the name', () => {
    act(() =>
      root.render(
        <>
          <BarButton icon="code" label="Macros — automate the sheet with a script" showLabel onClick={noop} testid="b" />
          <BarToggle icon="edit_note" label="Suggesting — track every change" showLabel pressed={false} onChange={noop} testid="t" />
          <BarDialogButton icon="tune" label="Margins — set the page edges" onOpen={noop} testid="d" />
          <BarMenu icon="tune" label="Spacing — line and paragraph" items={[]} testid="m" />
        </>
      )
    )
    const face = (id: string): string => faceText(host.querySelector(`[data-testid="${id}"]`)!)
    expect(face('b')).toBe('Macros')
    expect(face('t')).toBe('Suggesting')
    expect(face('d')).toBe('Margins…')
    expect(face('m')).toBe('Spacing')
    expect(host.querySelector('[data-testid="d"]')!.getAttribute('aria-label')).toBe('Margins — set the page edges')
  })
})

describe('caretFontSize', () => {
  it('reads the size at the caret, rounded to whole pixels', () => {
    expect(caretFontSize(editorAt(15))).toBe(15)
    expect(caretFontSize(editorAt(30.4))).toBe(30)
  })
  it('is undefined with no editor or one not on screen', () => {
    expect(caretFontSize(null)).toBeUndefined()
    const e = editorAt(15)
    ;(e.view.dom as HTMLElement).remove()
    expect(caretFontSize(e)).toBeUndefined()
  })
})

describe('Write’s empty document has a prompt', () => {
  it('globals.css draws the placeholder on the class Write’s surface carries', () => {
    const css = postcss.parse(readFileSync(join(__dirname, '../../src/renderer/src/styles/globals.css'), 'utf8'))
    const rules: string[] = []
    css.walkRules((r) => {
      const content = r.nodes.find((n) => n.type === 'decl' && n.prop === 'content') as { value: string } | undefined
      if (content?.value === 'attr(data-placeholder)') rules.push(...r.selectors)
    })
    expect(rules.some((s) => s.includes(`.${DOC_SURFACE_CLASS}`) && s.includes('.is-editor-empty') && s.endsWith('::before'))).toBe(true)
  })
})
