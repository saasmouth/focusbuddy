// The browser-build "browser widget": an <iframe> of an address the desk names.
//
// On a public share page that address was chosen by whoever minted the link, so
// the frame is a stranger's page inside ours. Checked here, on a real mount:
//   - the page's own URL (which carries the share token) is never sent: the
//     referrer policy is origin-only;
//   - the frame is sandboxed so it can run like a normal site but cannot
//     navigate the share page away, pop dialogs over it, or push downloads;
//   - nothing but http(s) is framed or linked, never the share app itself, and
//     another page of the same site only as an opaque origin.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
// Where the share app is served from, as in production: under /share/ on the
// marketing site's origin.
vi.mock('../../src/renderer/src/lib/fileUrl', () => ({ webBase: () => '/share/' }))

import EmbeddedSiteWidget, {
  EMBED_REFERRER_POLICY,
  EMBED_SANDBOX,
  EMBED_SANDBOX_SAME_ORIGIN
} from '../../src/renderer/src/components/widgets/EmbeddedSiteWidget'
import type { Widget } from '../../src/shared/types'

const widget = (content: string): Widget => ({ id: 'w1', kind: 'webview', title: 'Site', content }) as unknown as Widget

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async (content: string): Promise<void> => {
  await act(async () => {
    root.render(<EmbeddedSiteWidget widget={widget(content)} />)
  })
}

describe('EmbeddedSiteWidget', () => {
  it('frames an ordinary site with an origin-only referrer and a sandbox that keeps it working', async () => {
    await mount('https://www.youtube.com/embed/dQw4w9WgXcQ')
    const frame = host.querySelector('iframe')!
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')

    // Origin only. Never the old 'no-referrer-when-downgrade', which sent the
    // full /share/s/<token> address to the framed site.
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin')
    expect(EMBED_REFERRER_POLICY).toBe('strict-origin')

    const tokens = (frame.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean).sort()
    expect(tokens).toEqual(
      ['allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-same-origin', 'allow-scripts'].sort()
    )
    expect(EMBED_SANDBOX.split(' ').sort()).toEqual(tokens)
    for (const denied of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-modals', 'allow-downloads']) {
      expect(tokens).not.toContain(denied)
    }

    // The way out still opens the site in a tab that cannot reach back.
    const open = host.querySelector('[data-testid="embedded-site-open"]')!
    expect(open.getAttribute('href')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')
    expect(open.getAttribute('rel')).toContain('noopener')
    expect(open.getAttribute('rel')).toContain('noreferrer')
  })

  it('reads a bare host as https, as the address field always has', async () => {
    await mount('example.com/pricing')
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/pricing')
  })

  it.each([
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://plexiidesk.com/x',
    'file:///etc/hosts',
    'https://user:secret@example.com/',
    '/share/fb-file/abc'
  ])('frames and links nothing for %s', async (content) => {
    await mount(content)
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('[data-testid="embedded-site-refused"]')?.textContent).toMatch(/cannot open/)
  })

  it.each(['/share/fb-file/abc', '/share/s/another-token', '/share/'])(
    'refuses the app itself (%s): neither framed nor linked',
    async (path) => {
      // Under the app's base the share site serves the desk's own files, with
      // bytes and types the link's author chose.
      await mount(`${window.location.origin}${path}`)
      expect(host.querySelector('iframe')).toBeNull()
      expect(host.querySelector('a')).toBeNull()
      expect(host.querySelector('[data-testid="embedded-site-refused"]')?.textContent).toMatch(/points back into this app/)
    }
  )

  it('frames another page of the same site, but as an opaque origin', async () => {
    await mount(`${window.location.origin}/pricing`)
    const frame = host.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(`${window.location.origin}/pricing`)
    const tokens = (frame.getAttribute('sandbox') ?? '').split(/\s+/)
    expect(tokens).not.toContain('allow-same-origin')
    expect(tokens).toContain('allow-scripts')
    expect(frame.getAttribute('sandbox')).toBe(EMBED_SANDBOX_SAME_ORIGIN)
  })

  it('says so when there is no address at all', async () => {
    await mount('')
    expect(host.textContent).toContain('No address set.')
  })
})
