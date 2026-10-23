// WidgetPreview's Fallback (the minimap and focus-cluster thumbnails) printed a
// widget's stored content verbatim. For every kind whose content is JSON and
// has no preview of its own (voice, table, field, task list…) that is a raw
// blob on screen: voiceRecorder.spec saw '{"fileId":null,"transcript":"Buy
// milk…' beside the real widget. A preview shows the words, never the format.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import WidgetPreview from '../../src/renderer/src/components/WidgetPreview'
import type { Widget } from '../../src/shared/types'

function render(widget: Partial<Widget>): string {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<WidgetPreview widget={{ id: 'w', taskId: 't', title: '', x: 0, y: 0, width: 200, height: 120, ...widget } as Widget} />))
  const text = host.textContent ?? ''
  act(() => root.unmount())
  host.remove()
  return text
}

describe('WidgetPreview fallback', () => {
  it('shows a voice note’s transcript, not its JSON', () => {
    const text = render({ kind: 'voice', content: JSON.stringify({ fileId: null, transcript: 'Buy milk on the way home', mode: 'summary' }) })
    expect(text).toContain('Buy milk on the way home')
    expect(text).not.toMatch(/[{}"]|fileId/)
  })

  it('shows a table’s cell text, not its JSON', () => {
    const text = render({ kind: 'table', content: JSON.stringify({ columns: [{ id: 'c1', name: 'Name' }], rows: [{ id: 'r1', cells: { c1: 'Alice' } }] }) })
    expect(text).not.toMatch(/[{}"]/)
  })

  it('keeps plain text content as it is', () => {
    expect(render({ kind: 'timer', content: 'Pomodoro 25 min' })).toContain('Pomodoro 25 min')
  })
})
