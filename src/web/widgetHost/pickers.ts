// The Office editors' image pickers, answered by the widget host itself.
//
// On the desktop, Insert image (Write, Deck, Design) and Place (Draw) open an
// Electron dialog in the main process (main/officeDocx.ts pickImage,
// main/drawImport.ts pickDrawImportFiles). The browser runtime serves
// neither, so in the host those buttons were dead. The picked image is stored
// IN the document's body as a data URL, so it travels with the file and these
// can honestly work: a file input stands in for the dialog, with the same
// types, cap and result shapes. PDF and Illustrator files are not offered to
// Place: placing them needs the desktop's PDF renderer (draw:pdfPage).
import { MAX_PLACE_BYTES } from '@shared/draw/import/imageInfo'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']
const OFFICE_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
const VECTOR_EXT = ['svg', 'svgz']
const PDF_EXT = ['pdf', 'ai']
const accept = (exts: string[]): string => exts.map((e) => `.${e}`).join(',')

export const ACCEPT = {
  officeImage: accept(OFFICE_IMAGE_EXT),
  place: accept([...IMAGE_EXT, ...VECTOR_EXT]),
  svg: accept(VECTOR_EXT),
  image: accept(IMAGE_EXT)
} as const

export type PickFiles = (opts: { accept: string; multiple: boolean }) => Promise<File[]>

const extOf = (name: string): string => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

/** The desktop's mime for a picked image: svg+xml, jpeg for .jpg, else image/<ext>. */
function imageMime(f: File): string | null {
  if (f.type.startsWith('image/')) return f.type
  const ext = extOf(f.name)
  if (!OFFICE_IMAGE_EXT.includes(ext)) return null
  return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** A hidden file input, clicked within the person's click so the browser allows it. */
export const inputPicker: PickFiles = ({ accept: acc, multiple }) =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = acc
    input.multiple = multiple
    input.style.display = 'none'
    const done = (files: File[]): void => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true })
    input.addEventListener('cancel', () => done([]), { once: true })
    document.body.appendChild(input)
    input.click()
  })

export function servePickers(api: Record<string, Record<string, unknown>>, pick: PickFiles = inputPicker): void {
  api.office = {
    ...(api.office ?? {}),
    pickImage: async () => {
      const [f] = await pick({ accept: ACCEPT.officeImage, multiple: false })
      if (!f) return { ok: false }
      const mime = imageMime(f)
      if (!mime) return { ok: false, error: `${f.name} is not an image.` }
      return { ok: true, dataUrl: `data:${mime};base64,${base64(new Uint8Array(await f.arrayBuffer()))}` }
    }
  }
  api.draw = {
    ...(api.draw ?? {}),
    pickImportFiles: async (input?: { purpose?: string }) => {
      const purpose = ['place', 'open', 'import', 'replace'].includes(input?.purpose ?? '') ? input!.purpose! : 'place'
      const acc = purpose === 'open' || purpose === 'import' ? ACCEPT.svg : purpose === 'replace' ? ACCEPT.image : ACCEPT.place
      const picked = await pick({ accept: acc, multiple: purpose === 'place' })
      const files: Array<{ name: string; bytes: Uint8Array }> = []
      const skipped: Array<{ name: string; reason: string }> = []
      for (const f of picked.slice(0, 64)) {
        if (PDF_EXT.includes(extOf(f.name))) {
          skipped.push({ name: f.name, reason: 'PDF and Illustrator files can be placed in Plexii' })
          continue
        }
        if (f.size > MAX_PLACE_BYTES) {
          skipped.push({ name: f.name, reason: `larger than ${Math.round(MAX_PLACE_BYTES / (1024 * 1024))} MB` })
          continue
        }
        files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
      }
      return { ok: files.length > 0, files, skipped }
    }
  }
}
