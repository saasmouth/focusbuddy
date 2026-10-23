// @vitest-environment node
// Nothing reaches pdf.js or a native canvas except through pdfCanvasGlobals.ts.
//
// pdf-parse and pdf-to-png-converter bundle different pdf.js and
// @napi-rs/canvas builds that share pdf.js's globals (Path2D, DOMMatrix,
// ImageData, pdfjsWorker). The fix only holds if every caller goes through the
// one helper: Draw's renderer was fixed on its own first, and OCR, which runs
// right after pdf-parse on the same PDF, kept failing. So:
//
//   - the renderer libraries (pdf-to-png-converter, pdfjs-dist,
//     @napi-rs/canvas, canvas) may be loaded ONLY by src/main/pdfCanvasGlobals.ts,
//     which hands the renderer out inside withPdfRenderer;
//   - pdf-parse may be loaded only by a dynamic import inside a
//     withPdfTextLayer(...) call, in a module that imports the helper.
//
// Static and dynamic imports, require, require.resolve and createRequire(...)
// calls all count; comments do not.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '../..')
const HELPER = 'src/main/pdfCanvasGlobals.ts'
/** The browser variant swapped in for the helper (vite.web.config.ts); it loads nothing. */
const HELPER_WEB = 'src/web/worker/main/pdfCanvasGlobals.ts'

const RENDER_LIBS = ['pdf-to-png-converter', 'pdfjs-dist', '@napi-rs/canvas', 'canvas']
const TEXT_LIB = 'pdf-parse'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules') continue
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Blank out comments, keeping offsets, so a mention in prose is not an import. */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += n ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

export interface ModuleLoad {
  spec: string
  index: number
  dynamic: boolean
}

/** Every place a module is loaded by name: import/export from, import(), require(), <require>.resolve(), createRequire(x)(). */
export function moduleLoads(code: string, specs: string[]): ModuleLoad[] {
  const names = specs.map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')
  const re = new RegExp(
    String.raw`(\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\.resolve\s*\(\s*|\)\s*\(\s*)(['"\`])(` +
      names +
      String.raw`)(?:/[^'"\`]*)?\2`,
    'g'
  )
  const out: ModuleLoad[] = []
  for (const m of code.matchAll(re)) {
    const lead = m[1].replace(/\s+/g, '')
    out.push({ spec: m[3], index: m.index!, dynamic: lead !== 'from' && lead !== 'import' })
  }
  return out
}

/** Is code[index] inside the argument list of a call to `fn(`? */
export function insideCallTo(code: string, index: number, fn: string): boolean {
  const re = new RegExp(String.raw`\b${fn}\s*(?:<[^>()]*>)?\s*\(`, 'g')
  for (const m of code.matchAll(re)) {
    const open = m.index! + m[0].length - 1
    if (open > index) break
    let depth = 0
    let closed = false
    for (let i = open; i < index; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') {
        depth--
        if (depth === 0) {
          closed = true
          break
        }
      }
    }
    if (!closed && depth > 0) return true
  }
  return false
}

const IMPORTS_HELPER = /from\s*['"](?:\.\/|\.\.\/)+(?:main\/)?pdfCanvasGlobals['"]|from\s*['"]@main\/pdfCanvasGlobals['"]/

/** Every violation in one file's source, as readable lines. */
export function violations(file: string, src: string): string[] {
  if (file === HELPER || file === HELPER_WEB) return []
  const code = stripComments(src)
  const out: string[] = []
  for (const l of moduleLoads(code, RENDER_LIBS)) {
    out.push(`${file}: loads '${l.spec}' directly; render PDFs through withPdfRenderer (src/main/pdfCanvasGlobals.ts)`)
  }
  for (const l of moduleLoads(code, [TEXT_LIB])) {
    if (!l.dynamic) out.push(`${file}: imports '${TEXT_LIB}' statically; load it inside withPdfTextLayer(...)`)
    else if (!insideCallTo(code, l.index, 'withPdfTextLayer')) out.push(`${file}: loads '${TEXT_LIB}' outside withPdfTextLayer(...)`)
    else if (!IMPORTS_HELPER.test(code)) out.push(`${file}: uses withPdfTextLayer without importing it from pdfCanvasGlobals`)
  }
  return out
}

describe('pdf.js and native canvas go through pdfCanvasGlobals.ts', () => {
  const files = sourceFiles(join(ROOT, 'src')).map((p) => ({ file: relative(ROOT, p), src: readFileSync(p, 'utf8') }))

  it('no module loads a PDF renderer, pdf.js or a native canvas without the helper', () => {
    const found = files.flatMap(({ file, src }) => violations(file, src))
    expect(found, found.join('\n')).toEqual([])
  })

  it('the scan is not vacuous: it sees the helper’s own loads and the text extraction', () => {
    const helper = files.find((f) => f.file === HELPER)!
    expect(moduleLoads(stripComments(helper.src), RENDER_LIBS).map((l) => l.spec).sort()).toEqual(['@napi-rs/canvas', 'pdf-to-png-converter', 'pdf-to-png-converter'])
    const users = files.filter((f) => moduleLoads(stripComments(f.src), [TEXT_LIB]).length > 0).map((f) => f.file)
    expect(users).toEqual(['src/main/fileText.ts'])
    // And the two renderers use the helper.
    for (const f of ['src/main/drawImport.ts', 'src/main/ocr.ts']) {
      const src = files.find((x) => x.file === f)!.src
      expect(src, f).toMatch(/withPdfRenderer\(/)
      expect(src, f).toMatch(IMPORTS_HELPER)
    }
  })

  it('flags each way of going around the helper', () => {
    const v = (src: string): string[] => violations('src/main/x.ts', src)
    expect(v(`import { pdfToPng } from 'pdf-to-png-converter'`)).toHaveLength(1)
    expect(v(`const m = await import('pdf-to-png-converter')`)).toHaveLength(1)
    expect(v(`import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'`)).toHaveLength(1)
    expect(v(`const c = require('@napi-rs/canvas')`)).toHaveLength(1)
    expect(v(`const c = createRequire(entry)('@napi-rs/canvas')`)).toHaveLength(1)
    expect(v(`const p = require.resolve("pdfjs-dist")`)).toHaveLength(1)
    expect(v(`import { createCanvas } from 'canvas'`)).toHaveLength(1)
    expect(v(`import { PDFParse } from 'pdf-parse'`)).toHaveLength(1)
    expect(v(`const { PDFParse } = await import('pdf-parse')`)).toHaveLength(1)
    // pdf-parse loaded after the window closed is still outside it.
    expect(
      v(`import { withPdfTextLayer } from './pdfCanvasGlobals'\nawait withPdfTextLayer(async () => 1)\nconst { PDFParse } = await import('pdf-parse')`)
    ).toHaveLength(1)
  })

  it('passes the sanctioned shapes, and ignores prose and plain strings', () => {
    const v = (src: string): string[] => violations('src/main/x.ts', src)
    expect(
      v(`import { withPdfTextLayer } from './pdfCanvasGlobals'\nconst r = await withPdfTextLayer(async () => {\n  const { PDFParse } = await import('pdf-parse')\n  return new PDFParse({ data }).getText()\n})`)
    ).toEqual([])
    expect(v(`// pdf-to-png-converter and import('pdfjs-dist') in a comment\n/* require('@napi-rs/canvas') */`)).toEqual([])
    expect(v(`const mode = 'canvas'\nconst el = document.createElement('canvas')`)).toEqual([])
  })
})
