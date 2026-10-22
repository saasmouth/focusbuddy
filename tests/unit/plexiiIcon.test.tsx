// <PlexiiIcon>: the right file for the screen, no layout shift, an accessible
// name only when asked for one, and the existing glyph whenever there is no
// asset or the file fails — never a blank.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name, className }: { name: string; className?: string }) => <i data-icon={name} className={className} />
}))

import PlexiiIcon, { PlexiiTileIcon, plexiiIconUrl } from '../../src/renderer/src/components/PlexiiIcon'
import { PLEXII_ICON_ASSETS } from '../../src/renderer/src/lib/plexiiIconAssets.generated'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (el: JSX.Element): void => act(() => root.render(el))

describe('PlexiiIcon', () => {
  it('draws an app tile as an <img> with a width-described srcset and fixed box', () => {
    render(<PlexiiIcon kind="app" id="docs" size={20} />)
    const img = host.querySelector('img')!
    const asset = PLEXII_ICON_ASSETS['apps/plexiiwrite']
    expect(img).toBeTruthy()
    expect(img.getAttribute('srcset')).toBe(`${asset.src[32]} 32w, ${asset.src[64]} 64w, ${asset.src[128]} 128w`)
    expect(img.getAttribute('sizes')).toBe('20px')
    expect(img.getAttribute('width')).toBe('20')
    expect(img.getAttribute('height')).toBe('20')
    // 20px at 2x needs 40 device px: the 64px file.
    expect(img.getAttribute('src')).toBe(asset.src[64])
    expect(img.getAttribute('data-plexii-icon')).toBe('app:docs')
  })

  it('is decorative without a label and named with one', () => {
    render(<PlexiiIcon kind="app" id="mail" />)
    let img = host.querySelector('img')!
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    render(<PlexiiIcon kind="app" id="mail" label="Mail" />)
    img = host.querySelector('img')!
    expect(img.getAttribute('alt')).toBe('Mail')
    expect(img.hasAttribute('aria-hidden')).toBe(false)
  })

  it('rounds connected-app logos with a CSS mask, not a baked file', () => {
    render(<PlexiiIcon kind="connected" id="slack" size={22} />)
    const img = host.querySelector('img')!
    expect(img.getAttribute('data-plexii-style')).toBe('logo')
    expect(img.style.borderRadius).toBe('var(--plexii-logo-radius)')
  })

  it('draws a glyph as a mask filled with the per-theme token', () => {
    render(<PlexiiIcon kind="tool" id="search" size={18} label="Search" />)
    const span = host.querySelector('[data-plexii-icon="tool:search"]') as HTMLElement
    expect(span.tagName).toBe('SPAN')
    expect(span.getAttribute('role')).toBe('img')
    expect(span.getAttribute('aria-label')).toBe('Search')
    expect(span.getAttribute('data-plexii-style')).toBe('glyph')
    expect(span.style.backgroundColor).toBe('var(--plexii-glyph)')
    expect(span.style.width).toBe('18px')
    expect(span.getAttribute('data-plexii-src')).toBe(PLEXII_ICON_ASSETS['tools/search'].src[64])
  })

  it('keeps the declared glyph for an entity with no asset', () => {
    render(<PlexiiIcon kind="widget" id="task-link" fallbackClassName="text-sky-500" />)
    expect(host.querySelector('img')).toBeNull()
    const i = host.querySelector('i')!
    expect(i.getAttribute('data-icon')).toBe('link')
    expect(i.className).toContain('text-sky-500')
  })

  it('falls back to the glyph when the file fails to load', () => {
    render(<PlexiiIcon kind="app" id="vault" fallback="lock" />)
    const img = host.querySelector('img')!
    act(() => {
      img.dispatchEvent(new Event('error'))
    })
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('i')!.getAttribute('data-icon')).toBe('lock')
  })

  it('hands out the URL a size and DPR needs, never upscaling past the source', () => {
    expect(plexiiIconUrl('app', 'calendar', 16, 1)).toBe(PLEXII_ICON_ASSETS['apps/calendar'].src[32])
    expect(plexiiIconUrl('app', 'calendar', 48, 2)).toBe(PLEXII_ICON_ASSETS['apps/calendar'].src[128])
    // The Google Doc mark only exists up to 64px.
    expect(plexiiIconUrl('widget', 'gdoc', 48, 2)).toBe(PLEXII_ICON_ASSETS['widgets/google-doc'].src[64])
    expect(plexiiIconUrl('widget', 'task-link')).toBeNull()
  })

  it('PlexiiTileIcon wears an asset bare and keeps the tinted chip otherwise', () => {
    render(<PlexiiTileIcon kind="app" id="files" fallback="folder" tone="text-sky-500" />)
    expect(host.querySelector('img')).toBeTruthy()
    expect(host.querySelector('.rounded-xl')).toBeNull()
    render(<PlexiiTileIcon kind="widget" id="minimap" fallback="map" tone="text-sky-500" />)
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.rounded-xl.text-sky-500 i')!.getAttribute('data-icon')).toBe('map')
  })
})
