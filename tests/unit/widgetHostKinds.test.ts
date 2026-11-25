// The widget host loads each kind on its own (F2 item 4: renderWidget's one
// 4.6 MB chunk drew a sticky), and it must load the SAME component the desk
// draws, or the host becomes a fork of Plexii's widgets (d0's rule 1: reuse,
// don't fork). This fails the moment renderWidget maps a host kind to a
// different component than kinds.ts loads, or wraps it in something the host
// does not.
import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import type { Widget } from '../../src/shared/types'
import { HOST_DOCUMENT_TYPES, HOST_WIDGET_LOADERS, loaderFor } from '../../src/web/widgetHost/kinds'

const widget = (kind: string): Widget => ({ id: `w-${kind}`, taskId: 't', kind, title: '', content: '', x: 0, y: 0, width: 300, height: 200, zIndex: 1, color: null }) as unknown as Widget

describe('the widget host draws what the desk draws', () => {
  it('every host kind loads the component renderWidget renders for it, unwrapped', async () => {
    const { renderWidget } = await import('../../src/renderer/src/components/widgets/renderWidget')
    const kinds = [...Object.keys(HOST_WIDGET_LOADERS), ...HOST_DOCUMENT_TYPES]
    expect(kinds).toHaveLength(25)
    const mismatched: string[] = []
    for (const kind of kinds) {
      const desk = renderWidget(widget(kind)) as ReactElement<{ children: ReactElement }>
      const inner = desk.props.children
      const hosted = (await loaderFor(kind)!()).default
      if (inner.type !== hosted) mismatched.push(`${kind}: desk ${String((inner.type as { name?: string }).name ?? inner.type)}, host ${hosted.name}`)
    }
    expect(mismatched).toEqual([])
  }, 120_000)

  it('anything else has no loader, so it is never drawn half-working', () => {
    for (const kind of ['inbox', 'calendar', 'webview', 'voice-recorder', 'section', 'portal', 'nonsense']) expect(loaderFor(kind)).toBeNull()
  })
})
