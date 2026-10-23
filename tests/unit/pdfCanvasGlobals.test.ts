// @vitest-environment node
// pdfCanvasGlobals.ts: the one door to pdf.js's shared globals.
//
// pdf-parse (Files' text extraction) and pdf-to-png-converter (Draw's PDF page
// renderer, OCR) bundle different pdf.js and @napi-rs/canvas builds that share
// Path2D, DOMMatrix, ImageData and pdfjsWorker. These pin the helper's
// contract: the renderer's globals are in place inside the window, exactly
// the previous ones come back after (also on a throw), overlapping renders
// share one window instead of restoring each other's globals mid-render, and
// text extraction never runs inside a render's window.
//
// The first block runs the REAL libraries, in a process where pdf-parse loaded
// first, the order Files produces in the app: a render without the helper
// fails with the error users saw, and through the helper it succeeds.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import {
  withPdfCanvasGlobals,
  withPdfTextLayer,
  withPdfRenderer,
  rendererCanvasBuild,
  pdfGlobalsWindow,
  PDF_CANVAS_GLOBALS
} from '../../src/main/pdfCanvasGlobals'

const g = globalThis as Record<string, unknown>

async function textPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 200]).drawText('Quarterly report alpha bravo charlie', { x: 20, y: 100, size: 18, font })
  return doc.save()
}

/** A page with a vector mark on it: pdf.js draws the rectangle with Path2D. */
async function vectorPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 100]).drawRectangle({ x: 20, y: 20, width: 160, height: 60, color: rgb(0.2, 0.4, 0.8) })
  return doc.save()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('the real clash: pdf-parse first, then a render', () => {
  beforeAll(() => {
    for (const k of [...PDF_CANVAS_GLOBALS, 'pdfjsWorker']) delete g[k]
  })

  it('pdf-parse loads first and claims the globals with its own canvas build', async () => {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: await textPdf() })
    try {
      expect((await parser.getText()).text).toContain('Quarterly report alpha bravo')
    } finally {
      await parser.destroy()
    }
    const renderers = rendererCanvasBuild()
    expect(renderers, 'the renderer’s own @napi-rs/canvas build must resolve').toBeTruthy()
    expect(typeof g.Path2D).toBe('function')
    expect(g.Path2D, 'pdf-parse’s Path2D is a different class from the renderer’s').not.toBe(renderers!.Path2D)
  })

  it('a render that bypasses the helper fails with the error users saw (the fixture really exercises the bug)', async () => {
    const req = createRequire(import.meta.url)
    const { pdfToPng } = req('pdf-to-png-converter') as { pdfToPng: (d: Uint8Array, o: Record<string, unknown>) => Promise<unknown> }
    const prevWorker = g.pdfjsWorker
    delete g.pdfjsWorker
    try {
      await expect(pdfToPng(await vectorPdf(), { viewportScale: 1, returnPageContent: true, verbosityLevel: 0 })).rejects.toThrow(
        /none of these types/
      )
    } finally {
      if (prevWorker !== undefined) g.pdfjsWorker = prevWorker
    }
  })

  it('the same render through withPdfRenderer succeeds, and pdf-parse still reads text after it', async () => {
    const before = PDF_CANVAS_GLOBALS.map((k) => g[k])
    const bytes = await vectorPdf()
    const pages = await withPdfRenderer((pdfToPng) =>
      pdfToPng(bytes, { viewportScale: 1, returnPageContent: true, verbosityLevel: 0 })
    )
    expect(pages).toHaveLength(1)
    expect(pages[0].content?.byteLength ?? 0).toBeGreaterThan(100)
    expect(pages[0].width).toBe(200)
    expect(PDF_CANVAS_GLOBALS.map((k) => g[k]), 'pdf-parse’s globals are back').toEqual(before)

    const text = await withPdfTextLayer(async () => {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: await textPdf() })
      try {
        return (await parser.getText()).text
      } finally {
        await parser.destroy()
      }
    })
    expect(text).toContain('Quarterly report alpha bravo')
  })
})

describe('withPdfCanvasGlobals: install and restore', () => {
  const SENTINEL = { Path2D: class Theirs {}, DOMMatrix: class TheirMatrix {}, ImageData: class TheirImageData {}, pdfjsWorker: { WorkerMessageHandler: 'theirs' } }

  function plant(): void {
    for (const [k, v] of Object.entries(SENTINEL)) g[k] = v
  }
  afterEach(() => {
    expect(pdfGlobalsWindow(), 'every test leaves the window closed').toEqual({ kind: null, count: 0, waiting: 0 })
  })

  it('installs the renderer build’s Path2D, DOMMatrix and ImageData and clears pdfjsWorker inside, restores them after', async () => {
    plant()
    const build = rendererCanvasBuild()!
    const seen = await withPdfCanvasGlobals(async () => ({
      Path2D: g.Path2D,
      DOMMatrix: g.DOMMatrix,
      ImageData: g.ImageData,
      worker: 'pdfjsWorker' in g
    }))
    expect(seen).toEqual({ Path2D: build.Path2D, DOMMatrix: build.DOMMatrix, ImageData: build.ImageData, worker: false })
    for (const [k, v] of Object.entries(SENTINEL)) expect(g[k], k).toBe(v)
  })

  it('restores on a throw', async () => {
    plant()
    await expect(
      withPdfCanvasGlobals(async () => {
        throw new Error('render blew up')
      })
    ).rejects.toThrow('render blew up')
    for (const [k, v] of Object.entries(SENTINEL)) expect(g[k], k).toBe(v)
  })

  it('globals that were absent are absent again after', async () => {
    for (const k of [...PDF_CANVAS_GLOBALS, 'pdfjsWorker']) delete g[k]
    await withPdfCanvasGlobals(async () => {
      expect(typeof g.Path2D).toBe('function')
    })
    for (const k of [...PDF_CANVAS_GLOBALS, 'pdfjsWorker']) expect(k in g, k).toBe(false)
  })
})

describe('concurrency', () => {
  const THEIRS = class Theirs {}
  afterEach(() => {
    expect(pdfGlobalsWindow()).toEqual({ kind: null, count: 0, waiting: 0 })
  })

  it('overlapping renders share one window: the first to finish does not restore under the second', async () => {
    g.Path2D = THEIRS
    const build = rendererCanvasBuild()!
    const firstDone = deferred()
    const secondMayFinish = deferred()
    let seenBySecondAfterFirst: unknown = null

    const a = withPdfCanvasGlobals(async () => {
      await tick()
      return 'a'
    }).then((v) => {
      firstDone.resolve()
      return v
    })
    const b = withPdfCanvasGlobals(async () => {
      await firstDone.promise
      // The first render has finished and released; this one is still drawing.
      seenBySecondAfterFirst = g.Path2D
      await secondMayFinish.promise
      return 'b'
    })
    await firstDone.promise
    await tick()
    expect(pdfGlobalsWindow()).toEqual({ kind: 'render', count: 1, waiting: 0 })
    secondMayFinish.resolve()
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(seenBySecondAfterFirst, 'still the renderer’s Path2D mid-render').toBe(build.Path2D)
    expect(g.Path2D, 'restored once the last render ends').toBe(THEIRS)
  })

  it('a render nested in a render joins the window instead of deadlocking', async () => {
    g.Path2D = THEIRS
    const out = await withPdfCanvasGlobals(() => withPdfCanvasGlobals(async () => 'inner'))
    expect(out).toBe('inner')
    expect(g.Path2D).toBe(THEIRS)
  })

  it('text extraction waits for a render to finish, and sees the previous globals', async () => {
    g.Path2D = THEIRS
    const log: string[] = []
    const renderMayFinish = deferred()
    const render = withPdfCanvasGlobals(async () => {
      log.push('render:start')
      await renderMayFinish.promise
      log.push('render:end')
    })
    let textSaw: unknown = null
    const text = withPdfTextLayer(async () => {
      log.push('text:start')
      textSaw = g.Path2D
    })
    await tick()
    expect(log, 'text has not started while the render holds the window').toEqual(['render:start'])
    expect(pdfGlobalsWindow()).toEqual({ kind: 'render', count: 1, waiting: 1 })
    renderMayFinish.resolve()
    await Promise.all([render, text])
    expect(log).toEqual(['render:start', 'render:end', 'text:start'])
    expect(textSaw).toBe(THEIRS)
  })

  it('a render waits for text extraction; waiters of one kind are released together', async () => {
    g.Path2D = THEIRS
    const build = rendererCanvasBuild()!
    const log: string[] = []
    const textMayFinish = deferred()
    const t1 = withPdfTextLayer(async () => {
      log.push('t1')
      await textMayFinish.promise
      log.push('t1:end')
    })
    const r1 = withPdfCanvasGlobals(async () => {
      log.push(`r1:${g.Path2D === build.Path2D}`)
      await tick()
    })
    const r2 = withPdfCanvasGlobals(async () => {
      log.push(`r2:${g.Path2D === build.Path2D}`)
      await tick()
    })
    await tick()
    expect(pdfGlobalsWindow()).toEqual({ kind: 'text', count: 1, waiting: 2 })
    textMayFinish.resolve()
    await Promise.all([t1, r1, r2])
    expect(log).toEqual(['t1', 't1:end', 'r1:true', 'r2:true'])
    expect(g.Path2D).toBe(THEIRS)
  })
})
