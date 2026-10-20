// The on-device models Plexii offers, with the SHA-256 each download must
// match. This file ships inside the signed app, so the checksum a download is
// verified against cannot be swapped by whoever controls the download host —
// the host is trusted for availability, never for integrity.
//
// Every value here was read from the file itself (size, sha256) and from the
// upstream repository (license, source commit). The manifest the upload script
// publishes next to the files is
// resources/local-models.json; tests/unit/localModelCatalog.test.ts holds this
// table and that manifest equal.
//
// Choosing tiers is a measurement, not a guess: see tools/local-ai-eval/results.

import type { LocalModelTier } from './localAi'

export const LOCAL_MODEL_TIERS: readonly LocalModelTier[] = [
  {
    id: 'compact',
    name: 'Qwen3 4B Instruct',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    version: '1',
    sizeBytes: 2497281120,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/cdbee75f17c01a7cc42f958dc650907174af0554/LICENSE',
    sourceUrl: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/blob/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    contextSize: 16384,
    kvCache: 'q8_0',
    minRamGB: 8,
    recommendedRamGB: 8
  }
]

/** The embedding model for PlexiiBrain's semantic search on the device. */
export const LOCAL_EMBED_MODEL = {
  id: 'embed' as const,
  name: 'nomic-embed-text v1.5',
  file: 'nomic-embed-text-v1.5.Q8_0.gguf',
  version: '1',
  sizeBytes: 146146432,
  sha256: '3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7',
  license: 'Apache-2.0',
  licenseUrl: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5',
  sourceUrl: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/blob/0188c9bf409793f810680a5a431e7b899c46104c/nomic-embed-text-v1.5.Q8_0.gguf',
  label: 'nomic-embed-text-v1.5'
}

export function tierById(id: string | null | undefined): LocalModelTier | null {
  return LOCAL_MODEL_TIERS.find((t) => t.id === id) ?? null
}
