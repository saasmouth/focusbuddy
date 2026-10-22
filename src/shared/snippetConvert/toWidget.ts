import type { BuildContext, SnippetConversion } from '../snippetConvert'

export function toWidget(ctx: BuildContext): SnippetConversion {
  if (ctx.body.kind === 'widget') return { ok: true, body: structuredClone(ctx.body), lossy: [] }
  return { ok: false, reason: 'This conversion is not available yet.' }
}
