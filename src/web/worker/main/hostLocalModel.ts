// The local-model client in the widget host: there is none.
//
// On the desktop, src/main/ai/localModel.ts runs Plexii's background AI jobs
// (search vectors, document descriptions, memory sweeps) on a model on this
// computer: the bundled engine, or else an Ollama server, which it finds by
// asking http://localhost:11434/api/tags. The share app's Worker keeps that
// module as it is.
//
// The widget host must not. It runs inside PlexiiLite, which shows no AI, and
// the host reached this module through the search index: opening a file saves
// it into the page's database, a save embeds the document for search, and with
// no key and Background AI tasks off the embedder asks for a local model. So
// every page that showed a calculator, a chart or a task list asked
// localhost:11434 (1a, 2026-11-20). Nothing left the computer, but it was AI
// machinery working inside PlexiiLite, and on a computer running Ollama it
// would have been answered.
//
// The host build swaps the module for this one (vite.widgethost.config.ts,
// HOST_MODULE_SWAPS), so the host carries no local-model client at all. Every
// caller already handles "no local model": search keeps to keywords, and the
// background jobs report that nothing is available. Nothing is faked.
// tests/widget-host/network.spec.ts opens each kind's example file and checks
// that no request reaches port 11434, and that the built host has no Ollama
// address in it.
import type * as Desktop from '../../../main/ai/localModel'
import type { BundledEmbedder, LocalModelStatus } from '../../../main/ai/localModel'

/** Nothing is available, and there is nowhere to ask. */
export async function localModelStatus(): Promise<LocalModelStatus> {
  return { available: false, baseUrl: 'none', chatModel: null, embedModel: null }
}

/** No model, so no answer: the callers' honest null. */
export async function localChat(_input: Parameters<typeof Desktop.localChat>[0]): Promise<string | null> {
  return null
}

/** No embedder, so no vectors: the callers keep to keyword search. */
export async function localEmbed(
  _texts: string[],
  _kind?: 'document' | 'query'
): Promise<{ model: string; vectors: number[][] } | null> {
  return null
}

/** The desktop registers its bundled embedder here; the host has none to register. */
export function setBundledEmbedder(_e: BundledEmbedder | null): void {}

// Signature check against the desktop module: if one of these drifts there,
// typecheck:webruntime fails here instead of the host misbehaving quietly.
// Type-only, so nothing of the desktop module is bundled.
;({ localModelStatus, localChat, localEmbed, setBundledEmbedder }) satisfies Pick<
  typeof Desktop,
  'localModelStatus' | 'localChat' | 'localEmbed' | 'setBundledEmbedder'
>
