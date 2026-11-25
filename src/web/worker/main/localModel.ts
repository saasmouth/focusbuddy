// The local-model client in the browser: there is none.
//
// On the desktop, src/main/ai/localModel.ts runs Plexii's background AI jobs
// (search vectors, document descriptions, memory sweeps) on a model on this
// computer: the bundled engine, or else an Ollama server, which it finds by
// asking http://localhost:11434/api/tags.
//
// A browser tab must not. The share page is a public page, and the Worker
// reached this module through the search index: a visitor who dragged a
// calculator onto the desk they were sent made a work widget file, saving a
// file embeds it for search, and with no key and Background AI tasks off the
// embedder asks for a local model. So the visitor's browser asked
// localhost:11434 (d0, 2026-11-20). That is a public page probing the
// visitor's own computer: nothing said so, and newer Chrome asks the visitor
// for permission to reach their local network, which would have been the
// first thing many of them saw.
//
// The browser build swaps the module for this one (MODULE_SWAPS in
// vite.web.config.ts), so the tab carries no local-model client at all. The
// browser has no on-device model either (./providerRouter.ts), so this is
// what the desktop answers with nothing installed and no Ollama: every caller
// already handles it, search keeps to keywords, and nothing is faked.
// tests/web/shareNetwork.spec.ts drags a calculator onto a shared desk and
// checks no request reaches port 11434, and that the built app has no Ollama
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

/** The desktop registers its bundled embedder here; a tab has none to register. */
export function setBundledEmbedder(_e: BundledEmbedder | null): void {}

// Signature check against the desktop module: if one of these drifts there,
// typecheck:webruntime fails here instead of the browser misbehaving quietly.
// Type-only, so nothing of the desktop module is bundled.
;({ localModelStatus, localChat, localEmbed, setBundledEmbedder }) satisfies Pick<
  typeof Desktop,
  'localModelStatus' | 'localChat' | 'localEmbed' | 'setBundledEmbedder'
>
