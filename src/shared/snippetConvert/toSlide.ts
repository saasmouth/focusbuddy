import type { BuildContext, SnippetConversion } from '../snippetConvert'

export function toSlide(ctx: BuildContext): SnippetConversion {
  if (ctx.body.kind === 'slide') return { ok: true, body: structuredClone(ctx.body), lossy: [] }
  return { ok: false, reason: 'This conversion is not available yet.' }
}
