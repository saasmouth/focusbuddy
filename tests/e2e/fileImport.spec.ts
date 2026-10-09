import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// File-import E2E.
//
// Covers the four import paths exposed through window.api.fileImport:
//   .txt  → text draft (targetKind=note by default)
//   .md   → text draft (targetKind=markdown by default)
//   .csv  → table draft with inferred columns + rows
//   .json → table draft for array-of-objects, page draft for everything else
//
// We can't drive the native open-file dialog inside Playwright, so the
// tests call fileImport.run({path}) directly — the path picker is
// thin glue around the IPC and is exercised by the boot path.

let launched: LaunchedApp | null = null
let scratch: string | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true })
    scratch = null
  }
})

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-import-e2e-'))
  scratch = dir
  return dir
}

test('.txt imports as a note-flavoured text draft', async () => {
  const dir = makeScratch()
  const path = join(dir, 'simple.txt')
  writeFileSync(path, 'Hello world.\n\nSecond paragraph.\n', 'utf-8')

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const draft = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p, preferredTextKind: 'note' })
  , path)

  expect((draft as { kind: string }).kind).toBe('text')
  if ((draft as { kind: string }).kind !== 'text') return // narrow for TS
  const d = draft as { kind: 'text'; title: string; targetKind: string; content: string }
  expect(d.targetKind).toBe('note')
  expect(d.title).toBe('simple')
  expect(d.content).toContain('Hello world.')
})

test('.md imports as a markdown text draft (defaults to markdown kind)', async () => {
  const dir = makeScratch()
  const path = join(dir, 'notes.md')
  writeFileSync(path, '# Heading\n\n- One\n- Two\n', 'utf-8')

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const draft = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p, preferredTextKind: 'markdown' })
  , path)
  expect((draft as { kind: string }).kind).toBe('text')
  const d = draft as { kind: 'text'; targetKind: string; title: string; content: string }
  expect(d.targetKind).toBe('markdown')
  expect(d.title).toBe('notes')
  expect(d.content).toContain('# Heading')
})

test('.txt → page converts plain text into a Tiptap doc JSON', async () => {
  const dir = makeScratch()
  const path = join(dir, 'doc.txt')
  writeFileSync(path, 'Para one.\n\nPara two.\n', 'utf-8')

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const draft = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p, preferredTextKind: 'page' })
  , path)
  const d = draft as { kind: 'text'; targetKind: string; content: string }
  expect(d.targetKind).toBe('page')
  // Tiptap doc JSON — parseable + has two paragraph nodes for the two
  // blank-line-separated blocks.
  const doc = JSON.parse(d.content) as { type: string; content: Array<{ type: string }> }
  expect(doc.type).toBe('doc')
  expect(doc.content.filter((c) => c.type === 'paragraph').length).toBeGreaterThanOrEqual(2)
})

test('.csv imports as a table draft with header columns + parsed rows', async () => {
  const dir = makeScratch()
  const path = join(dir, 'budget.csv')
  writeFileSync(
    path,
    'Item,Amount,Paid\nGroceries,80,yes\n"Rent, May",1200,no\nUtilities,210,yes\n',
    'utf-8'
  )

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const draft = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p })
  , path)
  const d = draft as {
    kind: 'table'
    title: string
    schema: { columns: Array<{ label: string; type: string }> }
    rows: Array<Record<string, string>>
  }
  expect(d.kind).toBe('table')
  expect(d.title).toBe('budget')
  expect(d.schema.columns.map((c) => c.label)).toEqual(['Item', 'Amount', 'Paid'])
  // Type inference: Amount = number, Paid = checkbox.
  const amount = d.schema.columns.find((c) => c.label === 'Amount')
  const paid = d.schema.columns.find((c) => c.label === 'Paid')
  expect(amount?.type).toBe('number')
  expect(paid?.type).toBe('checkbox')
  // Quoted cell with comma round-trips.
  expect(d.rows[1].Item).toBe('Rent, May')
  expect(d.rows[1].Amount).toBe('1200')
})

test('.json array-of-objects imports as a table draft', async () => {
  const dir = makeScratch()
  const path = join(dir, 'people.json')
  writeFileSync(
    path,
    JSON.stringify([
      { name: 'Ada', age: 36, active: true },
      { name: 'Grace', age: 85, active: false },
      { name: 'Hedy', age: 86, role: 'inventor' }
    ]),
    'utf-8'
  )

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const draft = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p })
  , path)
  const d = draft as {
    kind: 'table'
    schema: { columns: Array<{ label: string; type: string }> }
    rows: Array<Record<string, string>>
  }
  expect(d.kind).toBe('table')
  // Union of keys, in insertion order — name, age, active, role.
  expect(d.schema.columns.map((c) => c.label)).toEqual(['name', 'age', 'active', 'role'])
  // age column = number, active = checkbox (per sample).
  expect(d.schema.columns.find((c) => c.label === 'age')?.type).toBe('number')
  expect(d.schema.columns.find((c) => c.label === 'active')?.type).toBe('checkbox')
  // Missing key fills as empty.
  expect(d.rows[1].role).toBe('')
})

test('.json non-array imports as a page-from-json draft', async () => {
  const dir = makeScratch()
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({ port: 8080, host: 'localhost' }, null, 2), 'utf-8')

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const draft = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p })
  , path)
  const d = draft as { kind: 'page-from-json'; title: string; content: string }
  expect(d.kind).toBe('page-from-json')
  expect(d.title).toBe('config')
  const doc = JSON.parse(d.content) as {
    type: string
    content: Array<{ type: string; content?: Array<{ text?: string }> }>
  }
  expect(doc.type).toBe('doc')
  expect(doc.content.some((c) => c.type === 'codeBlock')).toBe(true)
})

test('.docx returns a friendly not-yet-supported error', async () => {
  const dir = makeScratch()
  const path = join(dir, 'doc.docx')
  // Write any bytes — the import path bails on extension before reading.
  writeFileSync(path, 'placeholder', 'utf-8')

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p })
  , path)
  const r = result as { ok: false; error: string; reason: string }
  expect(r.ok).toBe(false)
  expect(r.reason).toBe('docx_not_supported')
})

test('Unsupported extension returns a friendly error', async () => {
  const dir = makeScratch()
  const path = join(dir, 'image.png')
  writeFileSync(path, 'PNG…', 'utf-8')

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate((p) =>
    window.api.fileImport.run({ path: p })
  , path)
  const r = result as { ok: false; error: string; reason: string }
  expect(r.ok).toBe(false)
  expect(r.reason).toBe('unsupported')
})
