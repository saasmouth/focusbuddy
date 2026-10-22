import type { BuildContext, SnippetConversion } from '../snippetConvert'

export function toDesign(ctx: BuildContext): SnippetConversion {
  if (ctx.body.kind === 'design') return { ok: true, body: structuredClone(ctx.body), lossy: [] }
  return { ok: false, reason: 'This conversion is not available yet.' }
}
