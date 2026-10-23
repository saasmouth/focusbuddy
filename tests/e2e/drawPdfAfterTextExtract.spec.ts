// PlexiiDraw's PDF renderer must keep working after Files has read a PDF's text.
//
// pdf-parse (Files' text extraction) and pdf-to-png-converter (Draw's Place of
// a PDF, and a PDF dropped from Files) each bring their own @napi-rs/canvas,
// and pdf.js installs the first one's Path2D/DOMMatrix/ImageData as globals for
// the life of the process. Before the fix, once Files had extracted any PDF's
// text, every later Draw render failed with "Value is none of these types
// `String`, `Path`", so a placed or dropped PDF silently became nothing.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

function onePagePdf(): string {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>',
    '<< /Length 35 >>\nstream\n0.2 0.4 0.8 rg 20 20 160 60 re f\nendstream'
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

test('Draw renders a PDF page after Files has extracted a PDF’s text', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const r = await window.evaluate(async (pdf) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const f = await api.files.ingestBuffer({ buffer: new TextEncoder().encode(pdf).buffer, originalName: 'brief.pdf', mimeType: 'application/pdf', parentId: null })
    // Files reads its text first (pdf-parse), as the brain and search do.
    await api.files.extractText(f.id)
    const read = await api.files.read(f.id)
    const page = await api.draw.pdfPage({ bytes: Uint8Array.from(new Uint8Array(read!.buffer as ArrayBuffer)), page: 1 })
    // And again, to show the text reader still works after our render.
    const text = await api.files.extractText(f.id)
    return { ok: page.ok, error: page.error ?? null, w: page.w, h: page.h, textAfter: text !== undefined }
  }, onePagePdf())
  expect(r.error).toBeNull()
  expect(r).toMatchObject({ ok: true, w: 200, h: 100, textAfter: true })
})
