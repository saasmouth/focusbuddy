// The app's zoom keys (⌘+ / ⌘- / ⌘0 and View › Zoom) go to an editor that
// claimed them (PlexiiDraw's canvas) and back to the app's UI scale after.
import { describe, expect, it } from 'vitest'
import { claimZoomCommands, runZoomCommand, type ZoomDir } from '../../src/renderer/src/lib/zoomCommands'

describe('zoom commands', () => {
  it('step the app scale unless an editor has claimed them; giving them back restores that', () => {
    const app: ZoomDir[] = []
    const draw: ZoomDir[] = []
    runZoomCommand('in', (d) => app.push(d))
    const release = claimZoomCommands((d) => (draw.push(d), true))
    runZoomCommand('out', (d) => app.push(d))
    runZoomCommand('reset', (d) => app.push(d))
    release()
    runZoomCommand('in', (d) => app.push(d))
    expect(app).toEqual(['in', 'in'])
    expect(draw).toEqual(['out', 'reset'])
  })

  it('an older claim released late does not take the keys from a newer one', () => {
    const a = claimZoomCommands(() => true)
    const seen: ZoomDir[] = []
    const b = claimZoomCommands((d) => (seen.push(d), true))
    a()
    runZoomCommand('in', () => seen.push('reset'))
    b()
    expect(seen).toEqual(['in'])
  })
})
