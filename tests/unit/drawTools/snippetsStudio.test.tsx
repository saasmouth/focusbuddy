// The mounted studio is the snippet target: it registers when it mounts and
// withdraws when it unmounts, so the library never offers a closed drawing.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar', () => ({
  default: () => <div data-testid="menubar-stub" />
}))
vi.mock('../../../src/renderer/src/lib/googleFonts', () => ({
  loadGoogleFont: vi.fn(),
  familyLabel: (v: string | undefined) => v ?? 'Default',
  fontFamilyValue: (v: string) => v,
  GOOGLE_FONTS: []
}))
vi.mock('../../../src/renderer/src/components/documents/draw/raster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/src/components/documents/draw/raster')>()),
  loadIntoCanvas: vi.fn(async () => {})
}))

import DrawStudio from '../../../src/renderer/src/components/documents/DrawStudio'
import { resetShellPrefs } from '../../../src/renderer/src/components/documents/draw/editor/shellPrefs'
import { useSnippetsStore } from '../../../src/renderer/src/stores/snippets'
import { linkModesFor } from '../../../src/shared/snippets'
import { blank, rect } from './harness'

beforeEach(() => resetShellPrefs())
afterEach(() => resetShellPrefs())

const drawTargets = () => Object.values(useSnippetsStore.getState().targets).filter((t) => t.id.startsWith('draw:'))

describe('the studio as a snippet target', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => host.remove())

  it('registers on mount (Duplicate only, labelled with the title) and withdraws on unmount', async () => {
    ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
    expect(drawTargets()).toHaveLength(0)
    const root = createRoot(host)
    await act(async () => root.render(<DrawStudio content={blank([rect('a', 10, 10, 40, 40)])} title="Poster" onChange={() => {}} />))
    const [t] = drawTargets()
    expect(drawTargets()).toHaveLength(1)
    expect(t.label).toBe('“Poster”')
    expect(linkModesFor(t, 'draw')).toEqual(['duplicate'])

    // A second open drawing is a second destination.
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const root2 = createRoot(host2)
    await act(async () => root2.render(<DrawStudio content={blank([])} title="Flyer" onChange={() => {}} />))
    expect(drawTargets()).toHaveLength(2)

    await act(async () => root2.unmount())
    host2.remove()
    expect(drawTargets().map((x) => x.label)).toEqual(['“Poster”'])
    await act(async () => root.unmount())
    expect(drawTargets()).toHaveLength(0)
  })
})
