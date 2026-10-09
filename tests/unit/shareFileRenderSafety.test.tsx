// A desk's files, rendered on a page whose files came from someone else.
//
// On the public share page every file -- its bytes, its recorded type and the
// extension its stored blob is named with -- is in a bundle the link's author
// wrote. The browser's file Service Worker serves /fb-file/<id> from the share
// site's own origin and types the response from the blob's NAME. Anything that
// loads those bytes as a DOCUMENT (an <iframe>, a navigation) therefore runs an
// .html or .svg "file" as a page of the share site. Images, video and audio are
// not documents and are unaffected.
//
// Covered here:
//   - the File widget frames a PDF only when type and extension agree;
//   - in the browser, the PDF frame shows the bytes re-wrapped as
//     application/pdf, so they cannot render as anything else;
//   - a field's attachment link downloads rather than navigates.
//   - the heading-style CSS a document carries cannot break out of its rule;
//   - slide AI output is reduced to text without touching the live document.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({
  default: ({ children }: { children: unknown }) => <div>{children as never}</div>
}))
vi.mock('../../src/renderer/src/components/contextMenu/UnifiedConnectedMenu', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/stores/files', () => ({ useFilesStore: () => vi.fn() }))
vi.mock('../../src/renderer/src/stores/widgets', () => ({ useWidgetStore: () => vi.fn() }))
vi.mock('../../src/renderer/src/stores/tables', () => ({ useTablesStore: () => vi.fn() }))
vi.mock('../../src/renderer/src/stores/view', () => ({ useViewStore: () => vi.fn() }))
vi.mock('../../src/renderer/src/components/DocPickerModal', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/lib/docMetaCache', () => ({ useDocMetas: () => ({}), primeDocMeta: vi.fn() }))

import { PdfFrame } from '../../src/renderer/src/components/widgets/FileWidget'
import { AttachmentChip } from '../../src/renderer/src/components/fields/FieldEditor'
import { fileKindFromMime, fileRenderKind } from '../../src/shared/fields'
import { headingCss, parseDocBody } from '../../src/renderer/src/components/documents/editor/headingStyles'
import { htmlToText } from '../../src/renderer/src/components/documents/slides/useSlideAi'

type G = { __PLEXII_WEB__?: boolean; api?: unknown }

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
  delete (globalThis as G).__PLEXII_WEB__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fileRenderKind — what the File widget may frame', () => {
  it('frames a PDF only when its type and its extension both say PDF', () => {
    expect(fileRenderKind('application/pdf', '.pdf')).toBe('pdf')
    expect(fileRenderKind('application/pdf', 'PDF')).toBe('pdf')
    // Either half disagreeing is the disguise: the browser types by extension,
    // the desktop by recorded type, and one of them would serve a page.
    expect(fileRenderKind('application/pdf', '.html')).toBe('generic')
    expect(fileRenderKind('application/pdf', '.svg')).toBe('image') // an <img>, which never runs script
    expect(fileRenderKind('text/html', '.pdf')).toBe('generic')
    expect(fileRenderKind('application/octet-stream', '.pdf')).toBe('generic')
    // ...while fileKindFromMime, used for icons and labels, is unchanged.
    expect(fileKindFromMime('application/pdf', '.html')).toBe('pdf')
  })

  it('leaves every non-PDF kind exactly as fileKindFromMime has it', () => {
    for (const [m, e] of [['image/png', '.png'], ['video/mp4', '.mp4'], ['audio/mpeg', '.mp3'], ['text/plain', '.txt'], ['text/html', '.html']]) {
      expect(fileRenderKind(m, e)).toBe(fileKindFromMime(m, e))
    }
  })
})

describe('PdfFrame', () => {
  it('in the browser, frames the bytes re-typed as application/pdf, never the worker URL', async () => {
    ;(globalThis as G).__PLEXII_WEB__ = true
    // The worker answers with whatever the blob's name implied -- here, a page.
    const fetchMock = vi.fn(async () => new Response('<script>window.__pdfPwned=1</script>', { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      blobs.push(b as Blob)
      return 'blob:http://localhost/pdf-1'
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    await act(async () => root.render(<PdfFrame url="/share/fb-file/abc" title="Deck.pdf" />))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(fetchMock).toHaveBeenCalledWith('/share/fb-file/abc')
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('application/pdf')
    const frame = host.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('blob:http://localhost/pdf-1#toolbar=1&navpanes=1&view=FitH')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')

    act(() => root.unmount())
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/pdf-1')
    root = createRoot(host)
  })

  it('in the browser, says so when the bytes are not here, and frames nothing', async () => {
    ;(globalThis as G).__PLEXII_WEB__ = true
    vi.stubGlobal('fetch', vi.fn(async () => new Response('No such file', { status: 404 })))
    await act(async () => root.render(<PdfFrame url="/share/fb-file/gone" title="x.pdf" />))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('could not be loaded')
  })

  it('on the desktop, frames the fb-file:// URL directly (the protocol sends the recorded type)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => root.render(<PdfFrame url="fb-file://abc" title="Deck.pdf" />))
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('fb-file://abc#toolbar=1&navpanes=1&view=FitH')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('AttachmentChip', () => {
  it('links the file as a download, so its bytes are saved, never shown as a page', async () => {
    ;(globalThis as G).api = { files: { get: vi.fn(async () => ({ originalName: 'brief.html' })) } }
    await act(async () => root.render(<AttachmentChip fileId="abc" onRemove={() => {}} />))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const a = host.querySelector('a')!
    expect(a.hasAttribute('download')).toBe(true)
    expect(a.getAttribute('download')).toBe('brief.html')
    expect(a.getAttribute('rel')).toContain('noreferrer')
    delete (globalThis as G).api
  })
})

describe('heading styles — CSS a document carries into a <style> element', () => {
  const hostile = {
    doc: { type: 'doc', content: [] },
    headingStyles: {
      1: { color: 'red}body{background:url(https://tracker.example/p.gif)}h1{color:red', fontSize: '20px;}*{display:none', bold: 'yes', italic: true },
      2: { color: '#6d5dfc', fontSize: 28, bold: true },
      7: { color: '#000' },
      x: { color: '#000' }
    }
  }

  it('parseDocBody keeps real values field by field and drops the rest', () => {
    const { headingStyles } = parseDocBody(hostile)
    expect(headingStyles).toEqual({ 1: { italic: true }, 2: { color: '#6d5dfc', fontSize: 28, bold: true } })
  })

  it('headingCss emits one rule per level and nothing from a hostile value, even unparsed', () => {
    const css = headingCss('doc-hs-r1', hostile.headingStyles as never)
    expect(css).not.toContain('tracker.example')
    expect(css).not.toContain('display:none')
    // Two braces per emitted rule and no more: nothing broke out of a block.
    const rules = css.trim().split('\n')
    expect(rules).toHaveLength(2)
    for (const r of rules) {
      expect((r.match(/\{/g) ?? []).length).toBe(1)
      expect((r.match(/\}/g) ?? []).length).toBe(1)
    }
    expect(css).toContain('h2 *{font-size:28px !important;color:#6d5dfc !important;font-weight:700 !important}')
  })
})

describe('slide AI output reduced to text', () => {
  it('parses in an inert document, keeps the words and the paragraph breaks', () => {
    const create = vi.spyOn(document, 'createElement')
    const out = htmlToText('<p>First <b>bold</b></p><img src="x" onerror="window.__slidePwned=1"><p>Second</p>')
    expect(out).toBe('First bold\nSecond')
    // Not one element was created in the live document (which is what made the
    // old innerHTML-on-a-div start loading the <img> and fire its handler).
    expect(create).not.toHaveBeenCalled()
    expect((window as unknown as { __slidePwned?: number }).__slidePwned).toBeUndefined()
  })
})
