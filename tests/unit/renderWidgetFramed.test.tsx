// Every widget on a desk sits in a WidgetFrame: its position, title bar, drag,
// resize, and the data-widget-id every canvas gesture finds it by. Widget
// components wrap themselves; four never did (chat-thread, mail-thread,
// image-gen, meeting-record), so on a desk they rendered unpositioned and could
// not be moved or removed. renderWidget now frames those (BODY_ONLY_KINDS) and
// unknown kinds. This pins both halves: no renderWidget case may render a
// component that is neither self-framed nor listed, and the listed kinds really
// come out framed.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

const WIDGETS = 'src/renderer/src/components/widgets'
const src = readFileSync(join(process.cwd(), WIDGETS, 'renderWidget.tsx'), 'utf8')

describe('renderWidget frames every kind it renders', () => {
  it('each case renders a self-framed component, or is listed as body-only', async () => {
    const { BODY_ONLY_KINDS } = await import('../../src/renderer/src/components/widgets/renderWidget')
    const inner = src.slice(src.indexOf('function renderWidgetInner'))
    const imports = new Map<string, string>()
    for (const m of src.matchAll(/^import (\w+) from '\.\/(\w+)'/gm)) imports.set(m[1]!, m[2]!)
    const unframed: string[] = []
    // Each run of `case 'a': case 'b':` up to the component it returns.
    for (const m of inner.matchAll(/((?:\s*case '[^']+':)+)(?:\s*\/\/[^\n]*)*\s*return <(\w+)/g)) {
      const kinds = [...m[1]!.matchAll(/case '([^']+)'/g)].map((k) => k[1]!)
      const comp = m[2]!
      const file = imports.get(comp)
      if (!file) continue // defined in renderWidget.tsx or imported from elsewhere (checked below)
      const path = join(process.cwd(), WIDGETS, `${file}.tsx`)
      const framed = existsSync(path) && readFileSync(path, 'utf8').includes('WidgetFrame')
      for (const k of kinds) if (!framed && !BODY_ONLY_KINDS.has(k)) unframed.push(`${k} -> ${comp}`)
    }
    expect(unframed, 'renderWidget cases whose component has no WidgetFrame and is not in BODY_ONLY_KINDS').toEqual([])
  })

  it('the guard can see the four body-only components (it is not vacuous)', () => {
    for (const comp of ['ChatThreadWidget', 'MailThreadWidget', 'ImageGenWidget', 'MeetingRecordWidget']) {
      expect(src).toContain(`return <${comp} widget={w} />`)
      const body = readFileSync(join(process.cwd(), WIDGETS, `${comp}.tsx`), 'utf8')
      expect(body.includes('WidgetFrame'), `${comp} renders its body only`).toBe(false)
    }
  })
})

describe('a body-only kind comes out of renderWidget framed', () => {
  it('a chat-thread widget mounts inside a WidgetFrame carrying its data-widget-id', async () => {
    ;(window as unknown as { api: unknown }).api = new Proxy(
      {},
      { get: () => new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) }) }
    )
    const { renderWidget } = await import('../../src/renderer/src/components/widgets/renderWidget')
    const w = {
      id: 'chat-w1', taskId: 't1', kind: 'chat-thread', title: 'Chat', content: '',
      x: 200, y: 160, width: 320, height: 300, zIndex: 1, color: null, status: null, pinned: false,
      pinnedScreenX: null, pinnedScreenY: null, parentSectionId: null, layout: null, sourceAppId: null,
      mode: null, pinnedZone: null, createdAt: 1, updatedAt: 1, archived: false
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<>{renderWidget(w as never)}</>))
    const frame = host.querySelector('[data-widget-id="chat-w1"]')
    expect(frame, 'framed: data-widget-id present').not.toBeNull()
    expect(frame!.getAttribute('data-widget-kind')).toBe('chat-thread')
    // and the body still renders inside it (signed out: the honest notice)
    expect(frame!.textContent).toContain('Sign in to use chat on this desk.')
    act(() => root.unmount())
    host.remove()
  })
})
