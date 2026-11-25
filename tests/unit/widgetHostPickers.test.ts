// The widget host answers the Office editors' image pickers itself.
//
// On the desktop, Insert image (Write, Deck, Design) and Place (Draw) open an
// Electron dialog in the main process; the browser runtime serves neither, so
// in the host those buttons were dead. The picked image is stored IN the
// document's body (a data URL), so it travels with the file -- these can
// honestly work. Same shapes as the desktop (main/officeDocx.ts pickImage,
// main/drawImport.ts pickDrawImportFiles); PDF and Illustrator files are not
// offered to Place, because placing them needs the desktop's PDF renderer.
import { describe, it, expect } from 'vitest'
import { servePickers, ACCEPT } from '../../src/web/widgetHost/pickers'
import { MAX_PLACE_BYTES } from '../../src/shared/draw/import/imageInfo'

const file = (name: string, bytes: number[] | Uint8Array, type = ''): File => new File([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], name, { type })

function setup(picked: File[]) {
  const asked: Array<{ accept: string; multiple: boolean }> = []
  const api: Record<string, Record<string, unknown>> = { office: {}, draw: {} }
  servePickers(api, async (o) => { asked.push(o); return picked })
  return { api: api as unknown as { office: { pickImage: () => Promise<any> }; draw: { pickImportFiles: (i: { purpose: string }) => Promise<any> } }, asked }
}

describe('Insert image', () => {
  it('a picked image comes back as a data URL, as the desktop returns it', async () => {
    const { api, asked } = setup([file('logo.png', [137, 80, 78, 71], 'image/png')])
    expect(await api.office.pickImage()).toEqual({ ok: true, dataUrl: 'data:image/png;base64,iVBORw==' })
    expect(asked).toEqual([{ accept: ACCEPT.officeImage, multiple: false }])
  })

  it('the type comes from the name when the browser gives none, as on the desktop', async () => {
    expect(await setup([file('mark.svg', [60, 115])]).api.office.pickImage()).toEqual({ ok: true, dataUrl: 'data:image/svg+xml;base64,PHM=' })
    expect(await setup([file('a.JPG', [1])]).api.office.pickImage()).toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/) })
  })

  it('nothing picked, or not an image, is ok: false', async () => {
    expect(await setup([]).api.office.pickImage()).toEqual({ ok: false })
    expect(await setup([file('notes.txt', [1], 'text/plain')]).api.office.pickImage()).toEqual({ ok: false, error: 'notes.txt is not an image.' })
  })
})

describe('Place (Draw)', () => {
  it('images and SVG, several at once for Place, with their bytes', async () => {
    const { api, asked } = setup([file('a.png', [1, 2]), file('b.svg', [3])])
    const r = await api.draw.pickImportFiles({ purpose: 'place' })
    expect(r.ok).toBe(true)
    expect(r.files.map((f: { name: string; bytes: Uint8Array }) => [f.name, [...f.bytes]])).toEqual([['a.png', [1, 2]], ['b.svg', [3]]])
    expect(r.skipped).toEqual([])
    expect(asked[0]).toEqual({ accept: ACCEPT.place, multiple: true })
    expect(ACCEPT.place).not.toMatch(/pdf|\.ai/)
  })

  it('open and import take SVG only; replace takes one image', async () => {
    const s = setup([])
    await s.api.draw.pickImportFiles({ purpose: 'open' })
    await s.api.draw.pickImportFiles({ purpose: 'import' })
    await s.api.draw.pickImportFiles({ purpose: 'replace' })
    expect(s.asked).toEqual([{ accept: ACCEPT.svg, multiple: false }, { accept: ACCEPT.svg, multiple: false }, { accept: ACCEPT.image, multiple: false }])
  })

  it('a file over the size cap, or a PDF dropped in anyway, is skipped with the reason', async () => {
    const big = file('huge.png', new Uint8Array(MAX_PLACE_BYTES + 1))
    const r = await setup([big, file('doc.pdf', [1]), file('ok.png', [9])]).api.draw.pickImportFiles({ purpose: 'place' })
    expect(r.files.map((f: { name: string }) => f.name)).toEqual(['ok.png'])
    expect(r.skipped).toEqual([
      { name: 'huge.png', reason: `larger than ${Math.round(MAX_PLACE_BYTES / (1024 * 1024))} MB` },
      { name: 'doc.pdf', reason: 'PDF and Illustrator files can be placed in Plexii' }
    ])
  })

  it('nothing picked is ok: false with no files', async () => {
    expect(await setup([]).api.draw.pickImportFiles({ purpose: 'place' })).toEqual({ ok: false, files: [], skipped: [] })
  })
})
