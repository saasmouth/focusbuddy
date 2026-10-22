import type { BuildContext, SnippetConversion } from '../snippetConvert'

export function toDoc(ctx: BuildContext): SnippetConversion {
  if (ctx.body.kind === 'doc') return { ok: true, body: structuredClone(ctx.body), lossy: [] }
  return { ok: false, reason: 'This conversion is not available yet.' }
}
