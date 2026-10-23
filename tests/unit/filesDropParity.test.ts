// PARITY: the same content dropped from Files, pasted, and inserted as a saved
// snippet lands as the SAME body in every app (Files plan §7 Phase 3).
//
//   dropped   a document from Files with ⌥ where the target holds links (copy,
//             not the link), plainly elsewhere: formsForTarget over the forms
//             the reader makes (formsOf the document's snippet body), then the
//             app's converted paste (convertForms, verb 'drop') or the work
//             widget's dropForms (acceptFor through readDropForms);
//   pasted    the same body copied from its app: the clipboard reader's forms
//             for our apps are formsOf(body), through the same paste;
//   inserted  the same body as a saved snippet (convertSnippetBody, or the
//             widget's insert through bodyForms).
//
// The verb changes only the wording of a refusal, never what lands, so the
// bodies (and pictures, rows, text) must be deep-equal.

import { describe, expect, it } from 'vitest'
import { convertForms, convertSnippetBody } from '../../src/shared/snippetConvert'
import { formsOf } from '../../src/shared/snippetForms'
import type { SnippetBody, SnippetKind } from '../../src/shared/snippets'
import type { WidgetTargetKind } from '../../src/shared/snippetWidgets'
import { acceptFor, bodyForms, readDropForms } from '../../src/renderer/src/lib/widgetSnippetInsert'
import { LINK_HOLDERS, formsForTarget, nativeKind, type ContentTarget } from '../../src/shared/fileForms'
import type { FileDragRef } from '../../src/shared/filesDragPayload'
import * as F from './snippetConvertFixtures'

const BODIES: Array<{ name: string; docType: FileDragRef['docType']; body: SnippetBody }> = [
  { name: 'Write document', docType: 'doc', body: F.doc() },
  { name: 'Cells sheet', docType: 'sheet', body: F.sheet() },
  { name: 'Deck slide', docType: 'slides', body: F.slide() },
  { name: 'Design page', docType: 'design', body: F.design() },
  { name: 'Diagram', docType: 'map', body: F.diagram() },
  { name: 'Drawing', docType: 'draw', body: F.draw() },
  { name: 'Sticky work widget file', docType: 'widget', body: F.STICKY }
]

const OFFICE: SnippetKind[] = ['doc', 'sheet', 'slide', 'design', 'diagram', 'draw']
const WIDGETS: WidgetTargetKind[] = ['page', 'markdown', 'sticky', 'note', 'table', 'image']

function dropped(ref: FileDragRef, body: SnippetBody, target: ContentTarget) {
  const content = { docForms: formsOf(body, F.DEPS) }
  // Content, not the link: ⌥ where the target holds links.
  return formsForTarget(ref, content, { target, alt: LINK_HOLDERS.has(target) || target === 'image' })
}

describe('drop = paste = insert, office apps', () => {
  for (const b of BODIES) {
    const ref: FileDragRef = { entryId: `e-${b.docType}`, kind: 'doc', name: b.name, docId: `d-${b.docType}`, docType: b.docType }
    for (const to of OFFICE) {
      it(`${b.name} → ${to}`, () => {
        const inserted = convertSnippetBody(b.body, to, F.DEPS, { verb: 'insert' })
        const pasted = convertForms(formsOf(b.body, F.DEPS), to, F.DEPS, undefined, { verb: 'paste' })
        const d = dropped(ref, b.body, to)
        expect(d.refused).toBeUndefined()
        const drop = convertForms(d.forms, to, F.DEPS, undefined, { verb: 'drop' })
        expect(drop.ok).toBe(inserted.ok)
        expect(pasted.ok).toBe(inserted.ok)
        if (inserted.ok && drop.ok && pasted.ok) {
          expect(drop.body).toEqual(inserted.body)
          expect(pasted.body).toEqual(inserted.body)
          expect(drop.lossy).toEqual(inserted.lossy)
        }
      })
    }
  }
})

describe('drop = paste = insert, work widgets', () => {
  for (const b of BODIES) {
    const ref: FileDragRef = { entryId: `e-${b.docType}`, kind: 'doc', name: b.name, docId: `d-${b.docType}`, docType: b.docType }
    for (const to of WIDGETS) {
      it(`${b.name} → ${to}`, () => {
        const inserted = acceptFor(to, bodyForms(b.body), { body: b.body, verb: 'insert' }) as { ok: boolean }
        const pastedRead = readDropForms({ forms: formsOf(b.body, F.DEPS), source: null, kind: b.body.kind, verb: 'paste' })
        const pasted = acceptFor(to, pastedRead.forms, { ...pastedRead.ctx, verb: 'paste' }) as { ok: boolean }
        const d = dropped(ref, b.body, to)
        expect(d.refused).toBeUndefined()
        const r = readDropForms({ forms: d.forms, source: null, kind: (nativeKind(d.forms) as SnippetKind | null) ?? null, verb: 'drop' })
        const drop = acceptFor(to, r.forms, r.ctx) as { ok: boolean }
        // Sticky and note copy the WORDS of a document (fileForms TEXT_ONLY):
        // their insert of the whole body may refuse a picture kind the drop
        // turns into text, so only the cells that land both ways are compared.
        if (to === 'sticky' || to === 'note') {
          if (inserted.ok && drop.ok) expect(strip(drop)).toEqual(strip(inserted))
          return
        }
        expect(drop.ok).toBe(inserted.ok)
        expect(pasted.ok).toBe(inserted.ok)
        if (inserted.ok) {
          expect(strip(drop)).toEqual(strip(inserted))
          expect(strip(pasted)).toEqual(strip(inserted))
        }
      })
    }
  }
})

/** What landed, without the lossy wording (the verb words it). */
function strip(r: { ok: boolean }): unknown {
  const { lossy: _lossy, ...rest } = r as { lossy?: unknown }
  void _lossy
  return rest
}
