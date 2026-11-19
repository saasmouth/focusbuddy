// Files for Draw's paste specs: a real PNG and a real one-page PDF, built in
// code so no binary fixture is checked in. Also: the size a Mac app gives a
// pasted PNG (drawCopyOut, _drawCopyOutNative).
import { deflateSync } from 'zlib'

/** A real PNG of one colour. */
export function png(w: number, h: number): Buffer {
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (t: string, d: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x40)])))
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A one-page PDF with real text, 300 x 200 pt. */
export function pdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    ((s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`)('0 0 1 rg 20 20 260 60 re f BT /F1 28 Tf 30 120 Td (Hello PlexiiDraw) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/**
 * The size, in points, that NSImage (Pages, Keynote, Mail) gives this PNG:
 * its pixels at its pHYs density (72 dpi when it has none). Draw writes its
 * copy at 2x with 144 dpi so it pastes at the art's size.
 */
export function pngPointSize(png: Buffer): { w: number; h: number } {
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  let dpi = 72
  for (let off = 8; off + 12 <= png.length; ) {
    const len = png.readUInt32BE(off)
    if (png.subarray(off + 4, off + 8).toString('latin1') === 'pHYs' && png[off + 16] === 1) dpi = png.readUInt32BE(off + 8) * 0.0254
    off += 12 + len
  }
  return { w: Math.round((w * 72) / dpi), h: Math.round((h * 72) / dpi) }
}
