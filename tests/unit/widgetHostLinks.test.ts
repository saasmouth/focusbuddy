// Links in the widget host open in the person's browser, through PlexiiLite.
//
// The host is a <webview> in PlexiiLite. A link that navigated it would replace
// the widget with a web page and lose any unsaved edit; window.open would ask
// for a window nobody handles; and window.api.files.openExternal (the map's
// "Open in OpenStreetMap") goes to a channel this runtime does not serve, so
// the button would be dead. All three become one message, open-link, for
// http(s) and mailto only; anything else opens nothing.
import { describe, it, expect, beforeEach } from 'vitest'
import { routeLinks } from '../../src/web/widgetHost/links'
import type { HostMessage } from '../../src/web/widgetHost/protocol'

let posted: HostMessage[]
let undo: () => void
beforeEach(() => {
  posted = []
  undo?.()
  document.body.innerHTML = ''
  ;(window as unknown as { api: Record<string, Record<string, unknown>> }).api = { files: { openExternal: () => Promise.reject(new Error('files:openExternal is not available')) } }
  undo = routeLinks((m) => void posted.push(m))
})

const urls = (): string[] => posted.map((m) => (m as { url?: string }).url ?? '')

describe('links in the widget host', () => {
  it('window.open of a web address becomes open-link, and opens no window', () => {
    expect(window.open('https://example.com/a?b=1', '_blank', 'noopener')).toBeNull()
    expect(posted).toEqual([{ type: 'plexii-widget-host:open-link', protocol: 1, url: 'https://example.com/a?b=1' }])
  })

  it('the api\'s openExternal (the map\'s Open in OpenStreetMap) works instead of being dead', async () => {
    await (window as unknown as { api: { files: { openExternal: (u: string) => Promise<void> } } }).api.files.openExternal('https://www.openstreetmap.org/#map=16/1/2')
    expect(urls()).toEqual(['https://www.openstreetmap.org/#map=16/1/2'])
  })

  it('a clicked link is held in place and handed over; a link within the page is left alone', () => {
    document.body.innerHTML = '<a id="out" href="https://plexiidesk.com/">out</a><a id="mail" href="mailto:a@b.co">mail</a><a id="in" href="#notes">in</a>'
    const click = (id: string): boolean => document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(click('out')).toBe(false)
    expect(click('mail')).toBe(false)
    expect(click('in')).toBe(true)
    expect(urls()).toEqual(['https://plexiidesk.com/', 'mailto:a@b.co'])
  })

  it('anything but http(s) and mailto opens nothing', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'plexii://open', 'data:text/html,hi', '']) window.open(u)
    expect(posted).toEqual([])
  })
})
