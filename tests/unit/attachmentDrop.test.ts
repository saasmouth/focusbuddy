// Dropping a picture onto a table's attachment field (owner, 2026-11-04: "I
// need to be able to drag images from a browser into a table attachment field").
//
// What a drop carries depends on where the drag began, and reading the wrong
// part attaches the wrong thing. These pin which part wins:
//   - files (Finder, or the bytes a Chromium page hands over) win outright;
//   - else the <img src> in text/html, because when the picture sits inside a
//     link the URL list names the LINK (a page), not the picture;
//   - else text/uri-list, else a bare address in text/plain;
//   - and junk (prose, blob:, file:, our own drags) attaches nothing.
// And the rule the field depends on: a drop APPENDS to what is there.
import { describe, it, expect } from 'vitest'
import {
  appendAttachmentIds,
  attachDropNotice,
  dragMayCarryAttachment,
  extractAttachmentDrop,
  imageSrcsFromHtml,
  ingestAttachmentDrop,
  isAppInternalDrag,
  MAX_URLS_PER_DROP,
  parseUriList,
  pickDropEffect,
  type DropDataLike
} from '../../src/renderer/src/lib/attachmentDrop'

/** A drop's readable data, as a test stand-in for DataTransfer. */
function drop(data: Record<string, string>, files: File[] = []): DropDataLike {
  const types = [...(files.length ? ['Files'] : []), ...Object.keys(data)]
  return { types, files, getData: (t: string) => data[t] ?? '' }
}
const png = (name = 'shot.png'): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], name, { type: 'image/png' })

describe('what a drop attaches', () => {
  it('files win: a Finder drag (or the bytes a page handed over) attaches the files, not the URL beside them', () => {
    const p = extractAttachmentDrop(
      drop({ 'text/uri-list': 'https://example.com/a.png', 'text/html': '<img src="https://example.com/a.png">' }, [png()])
    )
    expect(p.files.map((f) => f.name)).toEqual(['shot.png'])
    expect(p.urls).toEqual([])
  })

  it('reads the picture out of dropped HTML (Chrome and the desk browser describe an image drag that way)', () => {
    const p = extractAttachmentDrop(drop({ 'text/html': '<meta charset="utf-8"><img src="https://cdn.example.com/cat.jpg" alt="A cat">' }))
    expect(p.urls).toEqual(['https://cdn.example.com/cat.jpg'])
  })

  it('prefers the <img> over the URL list: a picture inside a link puts the PAGE on the URL list', () => {
    const p = extractAttachmentDrop(
      drop({
        'text/uri-list': 'https://example.com/article/42',
        'text/html': '<a href="https://example.com/article/42"><img src="https://example.com/media/hero.webp"></a>'
      })
    )
    expect(p.urls).toEqual(['https://example.com/media/hero.webp'])
  })

  it('falls back to text/uri-list (Safari, a dragged address), skipping comment lines', () => {
    const p = extractAttachmentDrop(drop({ 'text/uri-list': '# from Safari\r\nhttps://example.com/b.gif\r\nhttps://example.com/c.png' }))
    expect(p.urls).toEqual(['https://example.com/b.gif', 'https://example.com/c.png'])
  })

  it('takes a data:image address in the HTML or the URL list', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    expect(extractAttachmentDrop(drop({ 'text/html': `<img src="${data}">` })).urls).toEqual([data])
    expect(extractAttachmentDrop(drop({ 'text/uri-list': data })).urls).toEqual([data])
  })

  it('takes a bare address on text/plain, but never prose that mentions one', () => {
    expect(extractAttachmentDrop(drop({ 'text/plain': 'https://example.com/x.png' })).urls).toEqual(['https://example.com/x.png'])
    expect(extractAttachmentDrop(drop({ 'text/plain': 'see https://example.com/x.png for details' })).urls).toEqual([])
  })

  it('junk attaches nothing: plain text, an empty drop', () => {
    for (const d of [drop({ 'text/plain': 'hello world' }), drop({}), drop({ 'text/html': '<p>just words</p>' })]) {
      const p = extractAttachmentDrop(d)
      expect(p.files).toEqual([])
      expect(p.urls).toEqual([])
    }
    expect(extractAttachmentDrop(null)).toEqual({ files: [], urls: [], refused: [] })
  })

  it('refuses addresses no one can fetch: a page-local blob:, a file:, our own fb-file:, a relative src, javascript:', () => {
    const p = extractAttachmentDrop(
      drop({
        'text/html':
          '<img src="blob:https://example.com/123"><img src="file:///Users/x/a.png"><img src="fb-file://abc"><img src="/relative.png"><img src="javascript:alert(1)">'
      })
    )
    expect(p.urls).toEqual([])
    expect(p.refused).toEqual(['blob:https://example.com/123', 'file:///Users/x/a.png', 'fb-file://abc', '/relative.png', 'javascript:alert(1)'])
    expect(p.refused.every((u) => !p.urls.includes(u))).toBe(true)
  })

  it('refuses a data: address that is not an image', () => {
    const p = extractAttachmentDrop(drop({ 'text/uri-list': 'data:text/html,<script>alert(1)</script>' }))
    expect(p.urls).toEqual([])
    expect(p.refused).toHaveLength(1)
  })

  it('lists each picture once, and at most MAX_URLS_PER_DROP of them', () => {
    const same = '<img src="https://e.com/a.png"><img src="https://e.com/a.png">'
    expect(extractAttachmentDrop(drop({ 'text/html': same })).urls).toEqual(['https://e.com/a.png'])
    const many = Array.from({ length: 25 }, (_, i) => `<img src="https://e.com/${i}.png">`).join('')
    expect(extractAttachmentDrop(drop({ 'text/html': many })).urls).toHaveLength(MAX_URLS_PER_DROP)
  })

  it('reads srcset when an <img> has no src, and decodes entities', () => {
    expect(imageSrcsFromHtml('<img srcset="https://e.com/a-1x.png 1x, https://e.com/a-2x.png 2x">')).toEqual(['https://e.com/a-1x.png'])
    expect(imageSrcsFromHtml('<img src="https://e.com/a.png?w=1&amp;h=2">')).toEqual(['https://e.com/a.png?w=1&h=2'])
  })

  it('parses RFC 2483 URL lists', () => {
    expect(parseUriList('#c\r\n\r\n https://a.example/x \nhttps://b.example/y')).toEqual(['https://a.example/x', 'https://b.example/y'])
    expect(parseUriList(null)).toEqual([])
  })
})

describe('which drags the field offers to take (dragover, where only types are readable)', () => {
  it('a browser image drag, a link, a Finder file', () => {
    expect(dragMayCarryAttachment(['text/uri-list', 'text/html'])).toBe(true)
    expect(dragMayCarryAttachment(['Files'])).toBe(true)
    expect(dragMayCarryAttachment(['text/html'])).toBe(true)
  })

  it('not plain text, and not the app’s own drags (a work widget, a Files row, a document, a Kanban card, a connected app)', () => {
    expect(dragMayCarryAttachment(['text/plain'])).toBe(false)
    expect(dragMayCarryAttachment([])).toBe(false)
    expect(dragMayCarryAttachment(null)).toBe(false)
    for (const own of [
      'application/x-fb-widget-kind',
      'application/x-plexii-files',
      'application/x-fb-document',
      'application/x-plexii-document',
      'application/x-plexii-widget-file',
      'application/fb-entry-id',
      'text/fb-row-id',
      'text/fb-task-link',
      'text/fb-connected-app'
    ]) {
      // A connected app also carries its URL on text/uri-list; it is still ours.
      expect(dragMayCarryAttachment([own, 'text/uri-list', 'text/plain']), own).toBe(false)
      expect(isAppInternalDrag([own])).toBe(true)
    }
  })

  it('shows copy where the source allows it', () => {
    expect(pickDropEffect('all')).toBe('copy')
    expect(pickDropEffect('copyLink')).toBe('copy')
    expect(pickDropEffect('uninitialized')).toBe('copy')
    expect(pickDropEffect('link')).toBe('link')
    expect(pickDropEffect('move')).toBe('move')
  })
})

describe('a drop appends to the field, never replaces it', () => {
  it('keeps what was there and adds the new ids after it', () => {
    expect(appendAttachmentIds(['f1', 'f2'], ['f3'])).toEqual(['f1', 'f2', 'f3'])
    expect(appendAttachmentIds(['f1'], ['f2', 'f3'])).toEqual(['f1', 'f2', 'f3'])
  })

  it('an empty or missing value starts the list', () => {
    expect(appendAttachmentIds([], ['f1'])).toEqual(['f1'])
    expect(appendAttachmentIds(undefined, ['f1'])).toEqual(['f1'])
    expect(appendAttachmentIds(null, ['f1'])).toEqual(['f1'])
  })

  it('never lists one file twice, and a malformed stored value does not crash it', () => {
    expect(appendAttachmentIds(['f1'], ['f1', 'f2'])).toEqual(['f1', 'f2'])
    expect(appendAttachmentIds('f1', ['f2'])).toEqual(['f2'])
    expect(appendAttachmentIds(['f1', 7, null, ''], ['f2'])).toEqual(['f1', 'f2'])
  })

  it('does not mutate the stored array', () => {
    const stored = ['f1']
    appendAttachmentIds(stored, ['f2'])
    expect(stored).toEqual(['f1'])
  })
})

describe('storing a drop', () => {
  it('stores files by their bytes and images by address, in order', async () => {
    const calls: string[] = []
    const out = await ingestAttachmentDrop(
      { files: [png('a.png')], urls: ['https://e.com/b.png'], refused: [] },
      {
        ingestBuffer: async (i) => (calls.push(`buf:${i.originalName}:${i.mimeType}:${i.buffer.byteLength}`), { id: 'id-a' }),
        ingestUrl: async (u) => (calls.push(`url:${u}`), { ok: true, file: { id: 'id-b' } })
      }
    )
    expect(calls).toEqual(['buf:a.png:image/png:8', 'url:https://e.com/b.png'])
    expect(out).toEqual({ ids: ['id-a', 'id-b'], failures: [] })
  })

  it('one image that cannot be fetched does not lose the others, and is named', async () => {
    const out = await ingestAttachmentDrop(
      { files: [], urls: ['https://ok.example/a.png', 'https://www.gone.example/b.png'], refused: [] },
      {
        ingestBuffer: async () => ({ id: 'x' }),
        ingestUrl: async (u) =>
          u.includes('gone') ? { ok: false, error: 'The image could not be fetched (404).' } : { ok: true, file: { id: 'id-ok' } }
      }
    )
    expect(out.ids).toEqual(['id-ok'])
    expect(out.failures).toEqual([{ what: 'gone.example', why: 'The image could not be fetched (404).' }])
  })

  it('a thrown ingest is a named failure, not an unhandled rejection', async () => {
    const out = await ingestAttachmentDrop(
      { files: [png('bad.png')], urls: [], refused: [] },
      { ingestBuffer: async () => { throw new Error('disk full') } }
    )
    expect(out).toEqual({ ids: [], failures: [{ what: 'bad.png', why: 'disk full' }] })
  })

  it('without a main process (the browser build), an address is a named failure', async () => {
    const out = await ingestAttachmentDrop({ files: [], urls: ['https://e.com/a.png'], refused: [] }, { ingestBuffer: async () => ({ id: 'x' }) })
    expect(out.ids).toEqual([])
    expect(out.failures[0]!.why).toMatch(/desktop app/)
    // ... and when the browser build's worker refuses the channel by name.
    const refused = await ingestAttachmentDrop(
      { files: [], urls: ['https://e.com/a.png'], refused: [] },
      { ingestBuffer: async () => ({ id: 'x' }), ingestUrl: async () => { throw new Error('files:ingestUrl is not available in the browser runtime yet') } }
    )
    expect(refused.failures[0]!.why).toBe('Pictures from links can only be stored in the desktop app.')
  })
})

describe('what the person is told', () => {
  it('nothing usable, a page-local picture, a non-web address: each says so', () => {
    expect(attachDropNotice({ files: [], urls: [], refused: [] }, null)).toMatch(/Nothing to attach/)
    expect(attachDropNotice({ files: [], urls: [], refused: ['blob:https://e.com/1'] }, null)).toMatch(/only exists inside the page/)
    expect(attachDropNotice({ files: [], urls: [], refused: ['file:///a.png'] }, null)).toMatch(/http, https or data:/)
  })

  it('a clean drop says nothing (the thumbnail is the answer)', () => {
    const p = { files: [], urls: ['https://e.com/a.png'], refused: [] }
    expect(attachDropNotice(p, null)).toBeNull()
    expect(attachDropNotice(p, { ids: ['id'], failures: [] })).toBeNull()
  })

  it('a failed fetch names where it came from and why', () => {
    const p = { files: [], urls: ['https://e.com/a.png'], refused: [] }
    expect(attachDropNotice(p, { ids: [], failures: [{ what: 'e.com', why: 'That address is a web page, not an image.' }] })).toBe(
      'Could not attach the image from e.com. That address is a web page, not an image.'
    )
  })

  it('a partial drop says how many landed and which did not', () => {
    const p = { files: [], urls: ['https://a.com/1.png', 'https://b.com/2.png'], refused: [] }
    expect(attachDropNotice(p, { ids: ['id'], failures: [{ what: 'b.com', why: 'The image could not be fetched (403).' }] })).toBe(
      'Attached 1 of 2. Could not attach b.com. The image could not be fetched (403).'
    )
  })
})
