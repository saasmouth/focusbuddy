// Turn the user's @-mentions into real text (Phase 4.2).
//
// This is the piece that makes mentions genuinely better than click-to-pin. The
// renderer's gatherCanvasAttachments reads only widgets on the desk you are
// LOOKING AT, from the renderer's own store — which is why the pin can only
// ever reference what is in front of you. This resolver runs in main with DB
// access, so "@" reaches a widget on another desk, a document, a room, a file
// or a PlexiBrain entry.
//
// The honesty contract, inherited from chatAttachments' pinned-reference rule
// and made explicit here: a reference that produces no readable text resolves
// to `text: null` with a stated reason. Nothing downstream may claim it. There
// is no path in this module by which an unresolvable reference can produce
// text — the only `text` values come from real rows.

import type { ChatMentionRef, ChatMentionResolved } from '@shared/types'
import { getDocument } from '../db/documents'
import { getNode, listNodes } from '../db/nodes'
import { getWidget, listWidgetsByTask } from '../db/widgets'
import { getFile } from '../db/files'
import { getKnowledge } from '../db/knowledge'
import { getTable, listRows } from '../db/tables'
import { DOC_TEXT_CAP, extractDocText } from '../workspaceRank'
import { widgetToText, type WidgetTextResolvers, type ResolvedTable } from '@shared/widgetText'
import { getDirectoryPerson, personDisplayName } from '../peopleDirectory'
import { readFileSync } from 'node:fs'

// Per-reference cap. Matches chatAttachments' PER so one reference cannot eat
// the whole prompt; the total budget is applied by the renderer of this data.
const PER_MENTION = 8000
// How many of a desk's widgets are read when a whole desk is referenced. A desk
// is a container, so it is summarised from its parts rather than force-fed.
const DESK_WIDGET_LIMIT = 12
const DESK_PER_WIDGET = 1200
// Files whose bytes are genuinely text. Anything else is described by its
// metadata and explicitly says its contents were not read.
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'log', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'sql'
])
const FILE_READ_LIMIT = 200_000

export interface ResolvedMention {
  ref: ChatMentionRef
  // Human label for the prompt block, e.g. "document", "desk", "widget".
  kindLabel: string
  // Real extracted text, or null when the reference produced nothing readable.
  text: string | null
  // URL / filename / owning desk — the provenance line, when there is one.
  source: string | null
  // Why `text` is null. Null when it isn't.
  reason: string | null
  // The PER_MENTION cap already cut this reference short. Carried out of the
  // resolver because the cut happens HERE — the prompt renderer would otherwise
  // see an 8 000-char string, find it well within its own budget, and report no
  // truncation for a document that lost two thirds of itself. A cap nobody
  // reports is a silent cap.
  truncated: boolean
  // Length before this module's cap, so the notice can state what was lost.
  // NULL means "longer than what is shown, exact length unknown" — which is the
  // truth when an upstream extractor (extractDocText's DOC_TEXT_CAP) already cut
  // the body before it reached here. Stating a made-up total would be worse than
  // stating none.
  fullLength: number | null
}

function label(kind: ChatMentionRef['kind']): string {
  switch (kind) {
    case 'document':
      return 'document'
    case 'desk':
      return 'desk'
    case 'room':
      return 'room'
    case 'widget':
      return 'widget'
    case 'file':
      return 'file'
    case 'knowledge':
      return 'PlexiBrain entry'
    case 'person':
      return 'person'
  }
}

// The shared widget extractor's async sources, resolved synchronously from the
// DB. Same extractor the renderer uses, so a widget reads identically whether
// it was pinned from the canvas or mentioned from another desk.
function widgetResolvers(): WidgetTextResolvers {
  return {
    table: (tableId: string): ResolvedTable | null => {
      const tbl = getTable(tableId)
      if (!tbl) return null
      return {
        title: tbl.title,
        columns: tbl.schema.columns.map((c) => ({ id: c.id, label: c.label, type: c.type })),
        rows: listRows(tableId).map((r) => r.cells)
      }
    },
    docText: (docId: string): string | null => {
      const d = getDocument(docId)
      return d ? extractDocText(d.docType, d.body) : null
    },
    // A live browser/PDF page is rendered content the MAIN process cannot see —
    // only the renderer that hosts the webview can. A mentioned browser widget
    // therefore resolves from its stored content (its URL), never from an
    // invented page body.
    liveText: () => null
  }
}

// Webview-family widgets render their content in the canvas that hosts them;
// the main process only ever has the ADDRESS. Saying "resolved" over a bare
// URL was the most deceptive path in the stack (defect #6): the chip looked
// healthy while the model received ~45 characters and answered as if it had
// read the page.
const WEB_WIDGET_KINDS = new Set(['webview', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email'])
// The office-doc kinds whose text comes through extractDocText and can land
// exactly on its cap — the honest "longer than shown, total unknown" case.
const DOC_WIDGET_KINDS = new Set(['doc', 'sheet', 'slides', 'map', 'design', 'draw'])

function resolveWidget(id: string): {
  text: string | null
  source: string | null
  reason: string | null
  upstreamTruncated?: boolean
} {
  const w = getWidget(id)
  if (!w) return { text: null, source: null, reason: 'this widget no longer exists' }
  // The live-page boundary, stated exactly the way unreadable files state it
  // (#6): the address is real information and rides; the not-read fact is
  // said in the prompt so the model can say it to the user.
  if (WEB_WIDGET_KINDS.has(w.kind)) {
    const url = (w.content ?? '').trim()
    const meta = `${w.title || w.kind}${url ? ` (${url})` : ''}`
    return {
      text:
        `${meta}\n[This widget's live page was not read — only its address is known from here. ` +
        'Its rendered content rides automatically when the desk it lives on is open in front of the user.]',
      source: url || null,
      reason: null
    }
  }
  const r = widgetToText(w, widgetResolvers())
  const text = (r.text ?? '').trim()
  // The extractor returns parenthesised placeholders like "(empty document)"
  // for widgets it could reach but that hold nothing — the same rule
  // gatherCanvasAttachments applies before attaching anything.
  if (!text || /^\(.*\)$/.test(text)) {
    return { text: null, source: null, reason: 'this widget has no readable content' }
  }
  const owner = getNode(w.taskId)
  return {
    text,
    source: r.source ?? (owner ? `on desk "${owner.title || 'Untitled'}"` : null),
    reason: null,
    // extractDocText caps office bodies at DOC_TEXT_CAP; landing on the cap
    // means the document continued past it and the true total is unknowable
    // here (#11 — quoting the cap as the denominator stated a false number).
    upstreamTruncated: DOC_WIDGET_KINDS.has(w.kind) && text.length >= DOC_TEXT_CAP
  }
}

function resolveDesk(id: string): {
  text: string | null
  source: string | null
  reason: string | null
  upstreamTruncated?: boolean
} {
  const n = getNode(id)
  if (!n || n.kind !== 'task') return { text: null, source: null, reason: 'this desk no longer exists' }
  const parts: string[] = []
  const head = `${n.title || 'Untitled desk'}${n.description ? `\n${n.description}` : ''}`.trim()
  if (head) parts.push(head)
  const resolvers = widgetResolvers()
  const widgets = listWidgetsByTask(id)
  let used = 0
  let skipped = 0
  let widgetCut = false
  for (const w of widgets) {
    // Past the limit, widgets are counted but never extracted — the count is
    // what makes the cap honest (#9: a 40-widget desk reported success having
    // read 12, and no notice machinery could see the cut).
    if (used >= DESK_WIDGET_LIMIT) {
      skipped++
      continue
    }
    const r = widgetToText(w, resolvers)
    const t = (r.text ?? '').trim()
    if (!t || /^\(.*\)$/.test(t)) continue
    if (t.length > DESK_PER_WIDGET) widgetCut = true
    parts.push(`• ${w.title || w.kind}: ${t.slice(0, DESK_PER_WIDGET)}`)
    used++
  }
  if (parts.length === 0 && skipped === 0) {
    return { text: null, source: null, reason: 'this desk is empty' }
  }
  if (skipped > 0) {
    parts.push(
      `[${skipped} more widget${skipped === 1 ? '' : 's'} on this desk ${skipped === 1 ? 'was' : 'were'} not read — mention one directly to read it in full.]`
    )
  }
  return {
    text: parts.join('\n'),
    source:
      skipped > 0
        ? `read ${used} of ${used + skipped} widgets`
        : `${used} widget${used === 1 ? '' : 's'} read`,
    reason: null,
    // Either cut — widgets left unread, or a widget shortened to its slice —
    // must surface through the truncation notice, with no invented total.
    upstreamTruncated: skipped > 0 || widgetCut
  }
}

function resolveRoom(id: string): { text: string | null; source: string | null; reason: string | null } {
  const n = getNode(id)
  if (!n || n.kind !== 'folder') return { text: null, source: null, reason: 'this room no longer exists' }
  const children = listNodes().filter((c) => c.parentId === id && !c.archived)
  const parts: string[] = []
  const head = `${n.title || 'Untitled room'}${n.description ? `\n${n.description}` : ''}`.trim()
  if (head) parts.push(head)
  if (children.length > 0) {
    parts.push(
      `Contains: ${children.map((c) => `${c.title || 'Untitled'} (${c.kind === 'task' ? 'desk' : 'room'})`).join(', ')}`
    )
  }
  if (parts.length === 0) return { text: null, source: null, reason: 'this room is empty' }
  return { text: parts.join('\n'), source: `${children.length} item${children.length === 1 ? '' : 's'}`, reason: null }
}

function resolveFile(id: string): { text: string | null; source: string | null; reason: string | null } {
  const f = getFile(id)
  if (!f) return { text: null, source: null, reason: 'this file no longer exists' }
  const ext = (f.ext || '').replace(/^\./, '').toLowerCase()
  const meta = `${f.originalName} (${f.mimeType || ext || 'unknown type'}, ${Math.round(f.sizeBytes / 1024)} KB)`
  if (!TEXT_EXTS.has(ext)) {
    // Honest about the boundary: the assistant knows this file exists and what
    // it is, and has NOT read it. Better than silently pretending either way.
    return {
      text: `${meta}\n[This file's contents were not read — only text files are readable here.]`,
      source: f.originalName,
      reason: null
    }
  }
  try {
    const body = readFileSync(f.storedPath, 'utf8').slice(0, FILE_READ_LIMIT).trim()
    if (!body) return { text: null, source: null, reason: 'this file is empty' }
    return { text: `${meta}\n${body}`, source: f.originalName, reason: null }
  } catch {
    return { text: null, source: null, reason: 'this file could not be read from disk' }
  }
}

function resolveOne(ref: ChatMentionRef): ResolvedMention {
  const kindLabel = label(ref.kind)
  const wrap = (r: {
    text: string | null
    source: string | null
    reason: string | null
    // The text was ALREADY cut before this module saw it, so its length is a
    // floor, not a total.
    upstreamTruncated?: boolean
  }): ResolvedMention => {
    const full = r.text ?? ''
    const cut = full.slice(0, PER_MENTION)
    const upstream = r.upstreamTruncated === true
    return {
      ref,
      kindLabel,
      text: r.text ? cut : null,
      source: r.source,
      reason: r.reason,
      truncated: cut.length < full.length || upstream,
      fullLength: upstream ? null : full.length
    }
  }
  try {
    switch (ref.kind) {
      case 'document': {
        const d = getDocument(ref.id)
        if (!d) return wrap({ text: null, source: null, reason: 'this document no longer exists' })
        const text = extractDocText(d.docType, d.body).trim()
        if (!text) return wrap({ text: null, source: null, reason: 'this document is empty' })
        return wrap({
          text: `${d.title || 'Untitled'}\n${text}`,
          source: d.docType,
          reason: null,
          // extractDocText caps every body at DOC_TEXT_CAP. Landing exactly on
          // the cap means the document continued past it, and how far is not
          // knowable from here.
          upstreamTruncated: text.length >= DOC_TEXT_CAP
        })
      }
      case 'desk':
        return wrap(resolveDesk(ref.id))
      case 'room':
        return wrap(resolveRoom(ref.id))
      case 'widget':
        return wrap(resolveWidget(ref.id))
      case 'file':
        return wrap(resolveFile(ref.id))
      case 'knowledge': {
        const k = getKnowledge(ref.id)
        if (!k) return wrap({ text: null, source: null, reason: 'this PlexiBrain entry no longer exists' })
        const text = `${k.title}\n${k.tags.join(' ')}\n${k.body}`.trim()
        if (!text) return wrap({ text: null, source: null, reason: 'this PlexiBrain entry is empty' })
        return wrap({ text, source: k.pinned ? 'pinned entry' : null, reason: null })
      }
      case 'person': {
        // Context only, never a notification (plan D1). There is no path from
        // the assistant to a person's inbox, and this branch does not pretend
        // otherwise — it describes who they are and says so plainly.
        const person = getDirectoryPerson(ref.id)
        if (!person) {
          // Signed out, or this org's members were never loaded. Refusing is the
          // honest answer: the alternative is a name the app never fetched.
          return wrap({
            text: null,
            source: null,
            reason: 'this person is not in the workspace directory you have loaded'
          })
        }
        const name = personDisplayName(person)
        const lines = [
          `${name} (@${person.handle})`,
          `Role in this workspace: ${person.role}.`,
          'This is who they are, for context. You have no way to message or ' +
            'notify them from here — do not claim you have contacted them.'
        ]
        return wrap({ text: lines.join('\n'), source: `@${person.handle}`, reason: null })
      }
    }
  } catch {
    // A resolver throwing must never take the chat down with it — the reference
    // simply did not resolve, and says so.
    return wrap({ text: null, source: null, reason: 'this reference could not be read' })
  }
}

// Resolve every reference. Order is preserved: the user's first @ is the first
// thing the model reads.
export function resolveMentions(refs: readonly ChatMentionRef[] | undefined): ResolvedMention[] {
  if (!refs || refs.length === 0) return []
  return refs.map(resolveOne)
}

// The desks a reference set points at — a widget's owning desk, a desk itself.
// Used to narrow the retrieval pool that CAN be narrowed (tasks / tables /
// canvas notes). Documents and PlexiBrain entries have no desk affiliation in
// the data model at all, so they are not — and cannot honestly be — scoped.
export function mentionedDeskIds(refs: readonly ChatMentionRef[] | undefined): string[] {
  if (!refs || refs.length === 0) return []
  const out = new Set<string>()
  for (const r of refs) {
    if (r.kind === 'desk') out.add(r.id)
    else if (r.kind === 'widget' && r.taskId) out.add(r.taskId)
  }
  return [...out]
}

// What the renderer is told each reference produced. Derived from the SAME
// objects the prompt was built from (see chatMentions.renderMentions), so the
// report and the prompt cannot disagree about what rode.
export function reportResolutions(
  resolved: readonly ResolvedMention[],
  // Character counts that genuinely reached the prompt, keyed "<kind>:<id>".
  admitted: ReadonlyMap<string, { chars: number; truncated: boolean }>
): ChatMentionResolved[] {
  return resolved.map((r) => {
    const got = admitted.get(`${r.ref.kind}:${r.ref.id}`)
    return {
      kind: r.ref.kind,
      id: r.ref.id,
      title: r.ref.title,
      resolved: got !== undefined,
      chars: got?.chars ?? 0,
      truncated: got?.truncated ?? false,
      // Evicted is not deleted (#7): a reference that RESOLVED but lost the
      // shared budget to earlier references must say so — the old fallback
      // string rendered identically to a dead reference.
      reason:
        got !== undefined
          ? null
          : (r.reason ??
            (r.text
              ? 'left out to fit the size budget — it still exists; remove other references to include it'
              : 'this reference produced no readable content'))
    }
  })
}

// Exported for tests: the per-reference cap the resolver applies.
export const MENTION_TEXT_CAP = PER_MENTION

// Kind labels are part of the prompt's wording; exported so the prompt renderer
// and the tests agree on them.
export const mentionKindLabel = label
