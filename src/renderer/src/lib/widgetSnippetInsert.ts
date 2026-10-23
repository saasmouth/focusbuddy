// The renderer's half of putting any content into a work widget or onto a
// desk: the pure acceptors (shared/snippetWidgets.ts) decide WHAT lands; this
// module does the side effects (store a picture, write rows into an fb_table,
// create a widget) and reads the clipboard for ⌘V.
//
// One path for both: a saved snippet is read as formsOf(body), a paste as
// readClipboardForms(), and both go through the same acceptor, so an insert and
// a paste of the same thing land identically.

import { useEffect, useId, useRef } from 'react'
import { formsOf, type Form } from '@shared/snippetForms'
import { rowsToGfm } from '@shared/snippetForms/rows'
import { looksLikeHeader } from '@shared/snippetForms/rows'
import { FILE_PROBES, probeBodies, probeFileForms, type FileProbe } from '@shared/snippetConvert/accepts'
import { parseTsv } from '@shared/gridClipboard'
import { defaultConfig, type FieldDefinition, type TableSchema } from '@shared/fields'
import {
  SNIPPET_KINDS,
  type Snippet,
  type SnippetBody,
  type SnippetInsertResult,
  type SnippetKind,
  type SnippetTarget
} from '@shared/snippets'
import {
  acceptForImage,
  acceptForMarkdown,
  acceptForPage,
  acceptForTable,
  acceptForTextWidget,
  lossyLine,
  pasteForms,
  planDesk,
  type AcceptContext,
  type DeskPlan,
  type WidgetTargetKind
} from '@shared/snippetWidgets'
import type { Widget, WidgetKind } from '@shared/types'
import { snippetConvertDeps } from './snippetConvertDeps'
import { readClipboardForms, type FormsRead } from './clipboardForms'
import { pictureSrc, storeMarkdownPictures, storeNodePictures } from './widgetPictures'
import { freshColumnId, planRowsIntoTable, schemaWithPlan } from './widgetSnippetTable'
import { announceConverted } from './convertedNotice'
import { registerSnippetTarget } from '../stores/snippets'
import { useNoticeStore } from '../stores/notice'
import { useTablesStore } from '../stores/tables'
import { useWidgetStore } from '../stores/widgets'
import { useActionHistory } from '../stores/actionHistory'

// ── Forms ────────────────────────────────────────────────────────────────────

/** A snippet body's forms, with the renderer's real conversion deps. */
export function bodyForms(body: SnippetBody): Form[] {
  return formsOf(body, snippetConvertDeps())
}

/** Whatever any acceptor returns. */
type Accepted = { ok: true; lossy: string[] } | { ok: false; reason: string }

/** Run the acceptor for a widget kind. */
export function acceptFor(kind: WidgetTargetKind, forms: Form[], ctx: AcceptContext): ReturnType<typeof acceptForPage> | ReturnType<typeof acceptForMarkdown> | ReturnType<typeof acceptForTable> | ReturnType<typeof acceptForImage> | ReturnType<typeof acceptForTextWidget> {
  switch (kind) {
    case 'sticky':
    case 'note':
      return acceptForTextWidget(kind, forms, ctx)
    case 'page':
      return acceptForPage(forms, ctx)
    case 'markdown':
      return acceptForMarkdown(forms, ctx)
    case 'table':
      return acceptForTable(forms, ctx)
    case 'image':
      return acceptForImage(forms, ctx)
  }
}

const acceptsCache = new Map<WidgetTargetKind, SnippetKind[]>()

/**
 * The kinds a work widget offers in its snippet library, DERIVED by running its
 * acceptor over the same representative bodies the office hosts are derived
 * from (shared/snippetConvert/accepts.ts), so the offer cannot drift from what
 * really lands.
 *
 * Stickies and notes also list the picture kinds, by the owner's decision:
 * inserting a drawing there is REFUSED with where it can go ("Stickies hold
 * text. Insert it on the desk to add it as an image."), which only happens if
 * the drawing can be picked. Hiding it would leave the person wondering why.
 */
export function widgetAccepts(kind: WidgetTargetKind): SnippetKind[] {
  const hit = acceptsCache.get(kind)
  if (hit) return hit
  const deps = snippetConvertDeps()
  const out = SNIPPET_KINDS.filter((k) => {
    if ((kind === 'sticky' || kind === 'note') && (k === 'slide' || k === 'design' || k === 'diagram' || k === 'draw')) return true
    return probeBodies(k).some((b) => acceptFor(kind, formsOf(b, deps), { body: b, verb: 'insert' }).ok)
  })
  acceptsCache.set(kind, out)
  return out
}

/**
 * The kinds of FILE a work widget takes from a Files drop, derived the same
 * way: its acceptor run over the representative file forms
 * (shared/snippetConvert/accepts.ts probeFileForms), read exactly as a drop is
 * (readDropForms, verb 'drop'). For the drop handler's highlight and hint.
 */
export function widgetFileAccepts(kind: WidgetTargetKind): FileProbe[] {
  return FILE_PROBES.filter((probe) => {
    const read = readDropForms({ forms: probeFileForms(probe), source: null })
    return acceptFor(kind, read.forms, read.ctx).ok
  })
}

/** The result a target returns: took it, with the lossy line as its notice. */
export function tookIt(lossy: string[]): SnippetInsertResult {
  const notice = lossyLine(lossy)
  return notice ? { ok: true, notice } : true
}

// ── Clipboard ────────────────────────────────────────────────────────────────

/** A File as a data: URL. */
function fileDataUrl(f: File): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const r = new FileReader()
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
      r.readAsDataURL(f)
    } catch {
      resolve(null)
    }
  })
}

/** What a paste event's own data holds, captured synchronously (the event is gone after an await). */
export interface PasteSnapshot {
  text: string
  html: string
  images: File[]
}

export function snapshotPaste(dt: DataTransfer | null | undefined): PasteSnapshot {
  if (!dt) return { text: '', html: '', images: [] }
  const get = (t: string): string => {
    try {
      return dt.getData(t) ?? ''
    } catch {
      return ''
    }
  }
  const images = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'))
  return { text: get('text/plain'), html: get('text/html'), images }
}

/**
 * The same snapshot for a paste that has no event (a "Paste" menu item): the
 * system clipboard's text, read through the async Clipboard API. The forms
 * themselves come from readClipboardForms, which reads every flavour in main.
 */
export async function snapshotFromSystem(): Promise<PasteSnapshot> {
  const text = await navigator.clipboard?.readText?.().catch(() => '')
  return { text: text ?? '', html: '', images: [] }
}

/** The snapshot as a DataTransfer again, for readClipboardForms' browser fallback (the event's own is dead after an await). */
function snapshotTransfer(snap: PasteSnapshot): DataTransfer | null {
  try {
    const dt = new DataTransfer()
    if (snap.text) dt.setData('text/plain', snap.text)
    if (snap.html) dt.setData('text/html', snap.html)
    return dt
  } catch {
    return null
  }
}

/** Plain text as forms: the text, and rows when it is tab-separated (a Cells range). */
export function textForms(text: string): Form[] {
  const forms: Form[] = [{ kind: 'text', value: text, lossy: [] }]
  if (text.includes('\t')) {
    const rows = parseTsv(text)
    if (rows.length) forms.push({ kind: 'rows', value: { rows, header: looksLikeHeader(rows) }, lossy: [] })
  }
  return forms
}

/** A paste read for the acceptors: forms best first, and the source body when one of our apps made the copy. */
export interface PasteRead {
  forms: Form[]
  ctx: AcceptContext
  /** The reader refused the clipboard (an unknown Draw version): shown verbatim, nothing inserted. */
  refused?: string
}

/**
 * The clipboard as forms, best first, for a paste. readClipboardForms() is the
 * one reader (lib/clipboardForms.ts): a copy from one of our apps comes back as
 * that app's own body's forms, so `ctx.body` is that body and the paste lands
 * exactly as inserting a saved snippet of the same selection would. Only when
 * it finds nothing at all are the paste event's own picture files and text
 * used, which is the same data seen through the DOM rather than a guess.
 */
export async function readPasteForms(snap: PasteSnapshot): Promise<PasteRead> {
  let read: Awaited<ReturnType<typeof readClipboardForms>> = { forms: [], source: null }
  try {
    read = await readClipboardForms(snapshotTransfer(snap))
  } catch {
    read = { forms: [], source: null }
  }
  if (read.refused) return { forms: [], ctx: { verb: 'paste' }, refused: read.refused }
  let forms = read.forms
  if (!forms.length) {
    forms = []
    if (snap.images.length) {
      const src = await fileDataUrl(snap.images[0])
      if (src) forms.push({ kind: 'image', value: { src }, lossy: [] })
    }
    if (snap.text) forms.push(...textForms(snap.text))
  }
  const native = forms.find((f) => f.kind === 'native')
  const body = native && native.kind === 'native' ? native.value : undefined
  return body ? { forms, ctx: { body, verb: 'paste' } } : { forms: pasteForms(forms), ctx: { verb: 'paste' } }
}

/** Why a drop with no forms at all lands nothing. */
export const NOTHING_DROPPED = 'Nothing that was dropped can go in this work widget.'

/**
 * A drop read for the acceptors (a file from the Files panel, already read as
 * forms by its drop reader): the same shape as a paste, with the verb 'drop'
 * so a refusal says "Drop". Synchronous: the reading was done by the caller.
 */
export function readDropForms(read: FormsRead): PasteRead {
  if (read.refused) return { forms: [], ctx: { verb: 'drop' }, refused: read.refused }
  const native = read.forms.find((f) => f.kind === 'native')
  const body = native && native.kind === 'native' ? native.value : undefined
  return body ? { forms: read.forms, ctx: { body, verb: 'drop' } } : { forms: pasteForms(read.forms), ctx: { verb: 'drop' } }
}

/** Is this text a grid of two or more tab-separated columns? */
export function isTsvGrid(text: string): boolean {
  if (!text.includes('\t')) return false
  return parseTsv(text).some((r) => r.length >= 2)
}

/** Say what a paste did, or why it did not. */
export function announcePaste(res: Accepted | SnippetInsertResult): void {
  if (res === true || res === false) return
  if ('ok' in res && res.ok === false) {
    useNoticeStore.getState().show({ text: (res as { reason: string }).reason, icon: 'info' })
    return
  }
  if ('notice' in res) announceConverted((res as { notice?: string }).notice)
  else if ('lossy' in res) announceConverted(lossyLine((res as { lossy: string[] }).lossy))
}

// ── Widget targets ───────────────────────────────────────────────────────────

const KIND_NAME: Record<WidgetTargetKind, string> = {
  sticky: 'sticky',
  note: 'note',
  page: 'page',
  markdown: 'markdown work widget',
  table: 'table',
  image: 'image work widget'
}

/** The registry id for a mounted work widget. Instance-scoped: the same widget mounted twice is two places. */
export function widgetSnippetTargetId(widgetId: string, instance: string): string {
  return `widget:${widgetId}:${instance}`
}

/**
 * Register a mounted work widget as a place snippets can go. Duplicate only:
 * a converted insert is a copy, and a widget has no node that could resolve a
 * reference on render. No `host`: a work widget is not a SnippetHostKind (it
 * would claim to render kinds natively), which ec confirmed.
 *
 * `insert` is read through a ref updated every render, so the registry always
 * calls this render's function (the Cells pattern) while re-registering only
 * when what the TARGET says about itself changes. Returns the target id, for
 * the widget's "Insert snippet…" menu item.
 */
export function useWidgetSnippetTarget(
  widget: Pick<Widget, 'id' | 'title'>,
  kind: WidgetTargetKind,
  insert: (snippet: Snippet) => Promise<SnippetInsertResult> | SnippetInsertResult,
  enabled = true
): string {
  const instance = useId()
  const id = widgetSnippetTargetId(widget.id, instance)
  const ref = useRef(insert)
  ref.current = insert
  const title = widget.title?.trim() ?? ''
  useEffect(() => {
    if (!enabled) return
    const target: SnippetTarget = {
      id,
      label: title ? `“${title}” ${KIND_NAME[kind]}` : `This ${KIND_NAME[kind]}`,
      accepts: widgetAccepts(kind),
      supports: ['duplicate'],
      insert: (snippet, link) => (link === 'duplicate' ? ref.current(snippet) : { ok: false, reason: 'Work widgets take a copy of a snippet, not a live one.' })
    }
    return registerSnippetTarget(target)
  }, [id, kind, title, enabled])
  return id
}

// ── Into a widget's content ──────────────────────────────────────────────────

/** Text spliced into existing text at a caret, on its own lines. */
export function spliceText(current: string, insert: string, at: { start: number; end: number } | null): { text: string; caret: number } {
  const start = at ? Math.max(0, Math.min(at.start, current.length)) : current.length
  const end = at ? Math.max(start, Math.min(at.end, current.length)) : current.length
  const before = current.slice(0, start)
  const after = current.slice(end)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n' : ''
  const text = `${before}${lead}${insert}${trail}${after}`
  return { text, caret: before.length + lead.length + insert.length }
}

/** Page nodes with their data: pictures stored. */
export async function pageNodesReady(nodes: unknown[]): Promise<unknown[]> {
  return (await storeNodePictures(nodes)).nodes
}

/** Markdown with its data: pictures stored, or the refusal when one could not be. */
export async function markdownReady(markdown: string): Promise<{ ok: true; markdown: string } | { ok: false; reason: string }> {
  const r = await storeMarkdownPictures(markdown)
  if (r.failed) return { ok: false, reason: 'The picture could not be stored, so a markdown work widget cannot show it.' }
  return { ok: true, markdown: r.markdown }
}

/**
 * Append rows to a table work widget's fb_table: matched to columns by
 * heading (or by position without one), new columns added where needed,
 * every cell coerced to its column's type. One undo step.
 */
export async function appendRowsToTable(tableId: string, rows: string[][], header: boolean): Promise<{ ok: true; added: number } | { ok: false; reason: string }> {
  const store = useTablesStore.getState()
  const table = store.tables[tableId] ?? (await store.ensureTableLoaded(tableId))
  if (!table) return { ok: false, reason: 'This table work widget has no table yet. Try again in a moment.' }
  const plan = planRowsIntoTable(table.schema, rows, header, () => freshColumnId())
  if (!plan.ops.length) return { ok: false, reason: 'There are no rows in this to add.' }
  const schema = schemaWithPlan(table.schema, plan, (t) => defaultConfig(t))
  useActionHistory.getState().beginBatch()
  try {
    if (schema !== table.schema) await store.setSchema(table.id, schema)
    for (const op of plan.ops) if (op.op === 'insert') await store.addRow(table.id, op.cells)
  } finally {
    useActionHistory.getState().endBatch(`Add ${plan.ops.length} row${plan.ops.length === 1 ? '' : 's'}`)
  }
  return { ok: true, added: plan.ops.length }
}

/** A picture stored for an image work widget, as its content (fb-file://… or a link). */
export async function imageWidgetContent(picture: Parameters<typeof pictureSrc>[0]): Promise<string | null> {
  const r = await pictureSrc(picture)
  return r?.src ?? null
}

// ── Onto a desk ──────────────────────────────────────────────────────────────

export interface DeskPlacement {
  taskId: string
  /** Where the new widget's top-left goes, given its size; omitted lets the desk decide. */
  at?: (width: number, height: number) => { x: number; y: number }
  /** The new widget's title (a snippet's name). */
  title?: string
}

function placeAt(where: DeskPlacement, w: number, h: number): { x?: number; y?: number } {
  if (!where.at) return {}
  const p = where.at(w, h)
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

/** A fresh table, its schema made from the rows, the rows written in. Null when it could not be created. */
async function createTableFor(taskId: string, title: string, rows: string[][], header: boolean): Promise<string | null> {
  const store = useTablesStore.getState()
  const empty: TableSchema = { columns: [] }
  const plan = planRowsIntoTable(empty, rows, header, () => freshColumnId())
  const schema = schemaWithPlan(empty, plan, (t) => defaultConfig(t))
  if (!schema.columns.length) return null
  try {
    const table = await store.createTable({ taskId, title: title || 'Table', schema: { columns: schema.columns as FieldDefinition[] } })
    for (const op of plan.ops) if (op.op === 'insert') await store.addRow(table.id, op.cells)
    return table.id
  } catch {
    return null
  }
}

export const TABLE_FALLBACK_NOTE = 'It was placed as a markdown table because a table work widget could not be created.'

/**
 * Carry out a desk plan: create the widget it names. A grid becomes a REAL
 * table work widget with its own fb_table; if that cannot be created it lands
 * as a markdown table and the notice says which.
 */
export async function placeDeskPlan(plan: Exclude<DeskPlan, { ok: false }>, where: DeskPlacement): Promise<{ ok: true; widget: Widget; lossy: string[] } | { ok: false; reason: string }> {
  const create = useWidgetStore.getState().createOptional
  const base = { taskId: where.taskId, width: plan.width, height: plan.height, color: null, ...placeAt(where, plan.width, plan.height) }
  const lossy = [...plan.lossy]
  let kind: WidgetKind
  let content: string
  let title = where.title ?? ''
  switch (plan.widget) {
    case 'table': {
      const tableId = await createTableFor(where.taskId, title, plan.rows, plan.header)
      if (tableId) {
        kind = 'table'
        content = tableId
      } else {
        kind = 'markdown'
        content = rowsToGfm(plan.rows)
        lossy.push(TABLE_FALLBACK_NOTE)
      }
      break
    }
    case 'page': {
      kind = 'page'
      content = JSON.stringify({ type: 'doc', content: await pageNodesReady(plan.nodes) })
      break
    }
    case 'markdown': {
      const ready = await markdownReady(plan.markdown)
      if (!ready.ok) return ready
      kind = 'markdown'
      content = ready.markdown
      break
    }
    case 'image': {
      const src = await imageWidgetContent(plan.picture)
      if (!src) return { ok: false, reason: 'The picture could not be stored on this desk.' }
      kind = 'image'
      content = src
      if (!title) title = 'svg' in plan.picture ? `Picture from ${plan.picture.svg.app}` : plan.picture.alt ?? ''
      break
    }
    case 'sticky':
      kind = 'sticky'
      content = plan.text
      break
  }
  const widget = await create({ ...base, kind, content, ...(title ? { title } : {}) })
  if (!widget) return { ok: false, reason: 'This desk is no longer open.' }
  return { ok: true, widget, lossy }
}

/** Plan and place content on a desk. */
export async function placeOnDesk(forms: Form[], ctx: AcceptContext, where: DeskPlacement): Promise<{ ok: true; widget: Widget; lossy: string[] } | { ok: false; reason: string }> {
  const plan = planDesk(forms, ctx)
  if (!plan.ok) return plan
  return placeDeskPlan(plan, where)
}
