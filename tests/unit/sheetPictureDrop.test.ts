// A spreadsheet dropped from the Files panel into PlexiiDraw, over the REAL
// path: the document's own capture (documentSnippetBody, as the Files drop
// reader runs it) → formsOf with the real deps → shared/fileForms
// formsForTarget → PlexiiDraw's converted paste (convertForms, verb 'drop').
// Before the sheet picture form this was refused ("PlexiiDraw has no tables;
// drop it into PlexiiWrite or a page instead.").

import { describe, expect, it } from 'vitest'
import { convertForms, conversionNotice } from '../../src/shared/snippetConvert'
import { formsOf } from '../../src/shared/snippetForms'
import { formsForTarget, nativeKind } from '../../src/shared/fileForms'
import { documentSnippetBody } from '../../src/renderer/src/lib/documentSnippetBody'
import type { FileDragRef } from '../../src/shared/filesDragPayload'
import type { SnippetKind } from '../../src/shared/snippets'
import type { DrawImageNode } from '../../src/shared/draw/model'
import * as F from './snippetConvertFixtures'

const budget = {
  docType: 'sheet' as const,
  title: 'Budget',
  body: {
    version: 2,
    sheets: [
      {
        id: 't1',
        name: 'Sheet1',
        columns: ['A', 'B', 'C'],
        rows: [
          ['Item', 'Qty', 'Price'],
          ['Pens', '2', '3'],
          ['Pads', '4', '=B3*2']
        ],
        colWidths: { 0: 180 }
      }
    ]
  }
}

const ref: FileDragRef = { entryId: 'e-budget', kind: 'doc', name: 'Budget', docId: 'd-budget', docType: 'sheet' }

function dropInto(target: 'draw' | 'image', alt = false): ReturnType<typeof formsForTarget> {
  const r = documentSnippetBody(budget as never)
  expect(r.body?.kind).toBe('sheet')
  const docForms = formsOf(r.body!, F.DEPS)
  return formsForTarget(ref, { docForms }, { target, alt })
}

describe('a Cells document dropped from Files into PlexiiDraw', () => {
  it('lands as a picture of its table, not a refusal', () => {
    const t = dropInto('draw')
    expect(t.refused).toBeUndefined()
    const out = convertForms(t.forms, 'draw', F.DEPS, undefined, { verb: 'drop' })
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    if (!out.ok || out.body.kind !== 'draw') return
    expect(out.body.objects).toHaveLength(1)
    const node = out.body.objects[0] as DrawImageNode
    expect(node).toMatchObject({ type: 'image', alt: 'Picture from PlexiiCells' })
    const asset = (out.body.assets as Record<string, { src?: string; dataUrl?: string }>)[node.assetId]
    const src = String(asset?.src ?? asset?.dataUrl ?? JSON.stringify(asset))
    expect(src).toMatch(/^data:image\/svg\+xml;base64,/)
    const svg = Buffer.from(src.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8')
    // The formula's VALUE, not the formula; the column width from the sheet.
    expect(svg).toContain('>8<')
    expect(svg).not.toContain('=B3*2')
    expect(svg).toContain('width="180"')
    // The notice says it is a picture and where to edit it.
    const notice = conversionNotice((nativeKind(t.forms) as SnippetKind | null) ?? null, 'draw', out.lossy)
    expect(notice).toContain('It becomes a picture: edit it in PlexiiCells.')
    expect(notice).toContain('Formulas become their values.')
  })

  it('an image work widget takes the same picture with ⌥', () => {
    const t = dropInto('image', true)
    expect(t.forms.some((f) => f.kind === 'svg')).toBe(true)
  })
})
