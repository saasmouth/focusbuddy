import type { BuildContext, SnippetConversion } from '../snippetConvert'
import { REASON, ok, pick, refusal } from './common'

/**
 * Into PlexiiCells: rows of values. A document gives its first table (or one
 * line per row), text widgets their lines or pipe table. The block has no
 * origin, so Cells writes it literally, as an external paste. Pictures are
 * refused: a sheet holds values.
 */
export function toSheet(ctx: BuildContext): SnippetConversion {
  const { body, forms } = ctx
  if (body?.kind === 'sheet') return ok(structuredClone(body), [])
  if (body?.kind === 'slide' || body?.kind === 'design' || body?.kind === 'diagram' || body?.kind === 'draw') {
    return { ok: false, reason: REASON.cellsNoPictures }
  }
  if (body?.kind === 'widget' && body.widgetKind === 'image') return { ok: false, reason: REASON.cellsNoPictures }
  const f = pick(forms, ['rows'], body)
  // A paste of a picture alone (no source body to name): the same reason a
  // picture snippet gets, rather than a generic one.
  if (!f && !body && forms.some((x) => x.kind === 'svg' || x.kind === 'image')) return { ok: false, reason: REASON.cellsNoPictures }
  if (!f || f.kind !== 'rows' || !f.value.rows.length) return refusal(body, 'sheet')
  return ok({ kind: 'sheet', rows: structuredClone(f.value.rows) }, f.lossy)
}
