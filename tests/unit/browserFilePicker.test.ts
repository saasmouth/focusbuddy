// Attaching a file in the browser.
//
// Reported as "choose file button doesn't do anything". It did nothing because
// the desktop serves `files:pickAndIngest` from a native dialog and the Worker
// cannot, so the call refused — and the click handler dropped the rejection, so
// a refusing channel and a cancelled dialog looked identical from the outside.
// Dropping a file worked; the button never could.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { pickAndIngest, pickFilesIntoFolder } from '../../src/web/api/filePicker'

/** The input the picker appends, once it has appended one. */
const liveInput = (): HTMLInputElement | null =>
  document.querySelector('input[type="file"]')

/** Hand the open picker a selection, as a browser would. */
function choose(files: File[]): void {
  const input = liveInput()
  if (!input) throw new Error('the picker opened no input')
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change'))
}

const ingestOk = () =>
  vi.fn(async (input: { originalName: string; mimeType: string; buffer: ArrayBuffer }) => ({
    id: `id-${input.originalName}`,
    originalName: input.originalName,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.byteLength
  })) as never

afterEach(() => {
  document.querySelectorAll('input[type="file"]').forEach((n) => n.remove())
})

describe('the browser file picker', () => {
  it('accepts any kind of file, exactly as the native dialog does', async () => {
    const ingest = ingestOk()
    const done = pickAndIngest(ingest)
    const input = liveInput()!
    // No `accept` filter: a .sketch, a .key, an unknown extension must all be
    // attachable. The desktop opens its dialog with no filters either.
    expect(input.getAttribute('accept')).toBeNull()
    expect(input.multiple).toBe(false)
    choose([new File(['x'], 'archive.sketch', { type: '' })])
    await done
    expect(ingest).toHaveBeenCalledOnce()
  })

  it('stores the bytes, the name and the type it was given', async () => {
    const ingest = ingestOk()
    const done = pickAndIngest(ingest)
    choose([new File(['hello world'], 'notes.txt', { type: 'text/plain' })])
    const file = await done
    const arg = (ingest as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0]
    expect(arg.originalName).toBe('notes.txt')
    expect(arg.mimeType).toBe('text/plain')
    expect(new TextDecoder().decode(arg.buffer as ArrayBuffer)).toBe('hello world')
    expect(file).not.toBeNull()
  })

  it('falls back to octet-stream when the browser offers no type', async () => {
    // The same fallback the drop path uses, so a file attached either way is
    // stored identically.
    const ingest = ingestOk()
    const done = pickAndIngest(ingest)
    choose([new File(['x'], 'mystery.xyz', { type: '' })])
    await done
    const arg = (ingest as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0]
    expect(arg.mimeType).toBe('application/octet-stream')
  })

  it('treats a cancelled picker as nothing attached, not as an error', async () => {
    const ingest = ingestOk()
    const done = pickAndIngest(ingest)
    liveInput()!.dispatchEvent(new Event('cancel'))
    await expect(done).resolves.toBeNull()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('cleans up the input it added, however it ended', async () => {
    const a = pickAndIngest(ingestOk())
    choose([new File(['x'], 'a.txt', { type: 'text/plain' })])
    await a
    expect(liveInput()).toBeNull()

    const b = pickAndIngest(ingestOk())
    liveInput()!.dispatchEvent(new Event('cancel'))
    await b
    expect(liveInput()).toBeNull()
  })

  it('takes several files into a folder, and one bad file loses only itself', async () => {
    const ingest = vi.fn(async (input: { originalName: string }) => {
      if (input.originalName === 'bad.bin') throw new Error('unreadable')
      return { id: `id-${input.originalName}`, originalName: input.originalName }
    }) as never
    const done = pickFilesIntoFolder(ingest, 'folder-1')
    expect(liveInput()!.multiple).toBe(true)
    choose([
      new File(['1'], 'one.txt', { type: 'text/plain' }),
      new File(['2'], 'bad.bin', { type: '' }),
      new File(['3'], 'two.txt', { type: 'text/plain' })
    ])
    const out = await done
    expect(out.map((f) => (f as { originalName: string }).originalName)).toEqual(['one.txt', 'two.txt'])
  })

  it('puts picked files in the folder it was given', async () => {
    const ingest = ingestOk()
    const done = pickFilesIntoFolder(ingest, 'folder-7')
    choose([new File(['x'], 'a.txt', { type: 'text/plain' })])
    await done
    const arg = (ingest as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0]
    expect(arg.parentId).toBe('folder-7')
  })

  // The helper working is worth nothing if window.api never reaches it. This is
  // the wiring the bug was actually in: the Worker does not serve these
  // channels, the page must, and nothing checked that anyone did.
  describe('is reachable from window.api', () => {
    it('the page provides the channels the Worker cannot', async () => {
      const { platformNamespaces } = await import('../../src/web/api/platform')
      const ns = platformNamespaces()
      expect(typeof ns.files?.pickAndIngest).toBe('function')
      expect(typeof ns.fileManager?.pickFiles).toBe('function')
    })

    it('and those overrides are load-bearing, not duplicates', async () => {
      // If the Worker ever does serve these, this override is dead code that
      // silently wins over it -- worth knowing either way.
      const { HANDLERS } = await import('../../src/web/worker/handlers')
      expect(HANDLERS['files:pickAndIngest']).toBeUndefined()
      expect(HANDLERS['fileManager:pickFiles']).toBeUndefined()
    })

    it('and they are real channels the renderer calls', async () => {
      const { INVOKE_CHANNELS } = await import('../../src/web/api/channelMap.generated')
      const map = INVOKE_CHANNELS as unknown as Record<string, string>
      expect(map['files.pickAndIngest']).toBe('files:pickAndIngest')
      expect(map['fileManager.pickFiles']).toBe('fileManager:pickFiles')
    })
  })
})
