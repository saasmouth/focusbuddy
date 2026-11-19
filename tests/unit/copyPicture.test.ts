// Where an Image work widget's ⌘C gets the picture's bytes (lib/copyPicture):
// never fetch() of a data: URL, which the app's content security policy refuses.
import { describe, it, expect } from 'vitest'
import { pictureBlob } from '../../src/renderer/src/lib/copyPicture'

describe('pictureBlob', () => {
  it('decodes a data: URL itself', async () => {
    const b = await pictureBlob('data:image/png;base64,iVBORw0KGgo=')
    expect(b.type).toBe('image/png')
    expect(new Uint8Array(await b.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })
  it('reads a stored file through Files, and says so when it is gone', async () => {
    const read = async (id: string) => (id === 'f1' ? { mimeType: 'image/jpeg', buffer: new Uint8Array([1, 2, 3]).buffer } : null)
    const b = await pictureBlob('fb-file://f1', read)
    expect([b.type, b.size]).toEqual(['image/jpeg', 3])
    await expect(pictureBlob('fb-file://gone', read)).rejects.toThrow(/no longer in Files/)
  })
  it('anything else is refused in words', async () => {
    await expect(pictureBlob('not a picture')).rejects.toThrow(/could not be read/)
  })
})
