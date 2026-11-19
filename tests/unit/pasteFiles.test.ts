// @vitest-environment node
// Files copied in Finder (or Explorer) and pasted: main reads them and sends
// them to the page (src/main/pasteFiles.ts). The Electron clipboard is a stand-in.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const board: { items: Array<{ types: string[]; getType: (t: string) => Promise<Blob> }> } = { items: [] }
const appWindows = new Set<unknown>()
vi.mock('electron', () => ({
  clipboard: { read: async () => board.items },
  BrowserWindow: { fromWebContents: (wc: unknown) => (appWindows.has(wc) ? {} : null) },
  ClipboardItem: class {},
  nativeImage: {},
  dialog: {}
}))

const { dropFilesPaths, pastedFilesPayload, pasteInto, PASTE_FILES_CHANNEL } = await import('../../src/main/pasteFiles')

function item(entries: Record<string, string | Buffer>): { types: string[]; getType: (t: string) => Promise<Blob> } {
  return {
    types: Object.keys(entries),
    getType: async (t) => new Blob([typeof entries[t] === 'string' ? (entries[t] as string) : new Uint8Array(entries[t] as Buffer)])
  }
}

function fakeContents(type: 'window' | 'webview'): { wc: never; sent: Array<[string, unknown]>; pasted: number } {
  const rec = { sent: [] as Array<[string, unknown]>, pasted: 0 }
  const wc = {
    isDestroyed: () => false,
    getType: () => type,
    send: (ch: string, payload: unknown) => rec.sent.push([ch, payload]),
    paste: () => {
      rec.pasted++
    }
  }
  if (type === 'window') appWindows.add(wc)
  return { wc: wc as never, ...rec, get sent() { return rec.sent }, get pasted() { return rec.pasted } }
}

const deps = {
  read: async (paths: string[]) => ({
    ok: true,
    files: paths.filter((p) => !p.endsWith('/big.mov')).map((p) => ({ name: p.split('/').pop()!, bytes: new Uint8Array([1, 2, 3]) })),
    skipped: paths.filter((p) => p.endsWith('/big.mov')).map((p) => ({ name: p.split('/').pop()!, reason: 'larger than 40 MB' }))
  }),
  mimeOf: (ext: string) => ({ '.pdf': 'application/pdf', '.png': 'image/png' })[ext] ?? 'application/octet-stream'
}

beforeEach(() => {
  board.items = []
  appWindows.clear()
})

describe('pasting files copied in Finder', () => {
  it('a Finder copy (file URLs on the pasteboard) goes to the app window as the files, not as a paste of their names', async () => {
    board.items = [item({ 'text/uri-list': 'file:///Users/me/Report%20Q3.pdf\r\nfile:///Users/me/shot.png', 'text/plain': 'Report Q3.pdf\rshot.png' })]
    const c = fakeContents('window')
    await pasteInto(c.wc, deps)
    expect(c.pasted).toBe(0)
    expect(c.sent).toHaveLength(1)
    const [channel, payload] = c.sent[0] as [string, { files: Array<{ name: string; mimeType: string; bytes: Uint8Array }>; skipped: unknown[] }]
    expect(channel).toBe(PASTE_FILES_CHANNEL)
    expect(payload.files.map((f) => [f.name, f.mimeType])).toEqual([
      ['Report Q3.pdf', 'application/pdf'],
      ['shot.png', 'image/png']
    ])
    expect(payload.skipped).toEqual([])
  })

  it('a file too large to read is named with why, not dropped', async () => {
    board.items = [item({ 'text/uri-list': 'file:///Users/me/notes.txt\nfile:///Users/me/big.mov' })]
    const c = fakeContents('window')
    await pasteInto(c.wc, deps)
    const payload = c.sent[0][1] as { files: Array<{ name: string }>; skipped: Array<{ name: string; reason: string }> }
    expect(payload.files.map((f) => f.name)).toEqual(['notes.txt'])
    expect(payload.skipped).toEqual([{ name: 'big.mov', reason: 'larger than 40 MB' }])
  })

  it('no copied files: the ordinary paste runs', async () => {
    board.items = [item({ 'text/plain': 'hello' })]
    const c = fakeContents('window')
    await pasteInto(c.wc, deps)
    expect(c.sent).toHaveLength(0)
    expect(c.pasted).toBe(1)
  })

  it('a web page in a browser work widget always gets the ordinary paste', async () => {
    board.items = [item({ 'text/uri-list': 'file:///Users/me/shot.png' })]
    const c = fakeContents('webview')
    await pasteInto(c.wc, deps)
    expect(c.sent).toHaveLength(0)
    expect(c.pasted).toBe(1)
  })

  it('more than 64 files: the rest are named as not pasted', async () => {
    const paths = Array.from({ length: 66 }, (_, i) => `/tmp/f${i}.txt`)
    const p = await pastedFilesPayload(paths, { ...deps, read: async (ps) => deps.read(ps.slice(0, 64)) })
    expect(p.files).toHaveLength(64)
    expect(p.skipped).toEqual([
      { name: 'f64.txt', reason: 'more than 64 files were copied' },
      { name: 'f65.txt', reason: 'more than 64 files were copied' }
    ])
  })

  it('Windows Explorer: every path in a DROPFILES block (CF_HDROP)', async () => {
    const list = 'C:\\Users\\me\\a.pdf\0C:\\Users\\me\\b.png\0\0'
    const head = Buffer.alloc(20)
    head.writeUInt32LE(20, 0) // the list follows the header
    head.writeUInt32LE(1, 16) // UTF-16
    const block = Buffer.concat([head, Buffer.from(list, 'utf16le')])
    expect(dropFilesPaths(block)).toEqual(['C:\\Users\\me\\a.pdf', 'C:\\Users\\me\\b.png'])
    expect(dropFilesPaths(Buffer.alloc(4))).toEqual([])
    board.items = [item({ 'electron application/osclipboard;format="CF_HDROP"': block })]
    const c = fakeContents('window')
    await pasteInto(c.wc, { ...deps, read: async (ps) => ({ ok: true, files: ps.map((p) => ({ name: p.split('\\').pop()!, bytes: new Uint8Array([1]) })), skipped: [] }) })
    expect((c.sent[0][1] as { files: Array<{ name: string }> }).files.map((f) => f.name)).toEqual(['a.pdf', 'b.png'])
  })
})
