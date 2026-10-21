// What the two fixed local-AI cards show, decided from main's state alone.
//
//   - The one-time card (local-ai-intro). With a verified model it is the
//     "local AI is now built in" notice. Without one it OFFERS Local as an
//     opt-in download (size and a Download button) and says the current AI
//     source has not changed. It never appears while the bundled model is
//     still being checked (a fresh install's first seconds), nor on a computer
//     with too little memory to run any model (a download it could not use).
//   - The "needs a one-time download" banner (local-ai-missing). Only when a
//     feature really routes to the device and the model is not here, i.e. AI
//     that cannot answer. Never when AI is working on another engine.
//
// Both are dismissible; LocalAiPrompts renders them.

import { AI_FEATURE_COPY, type AiFeature, type LocalAiStatus } from '@shared/localAi'

export type AiModeName = 'auto' | 'credits' | 'byok' | 'local' | 'openai'

export interface IntroInfo {
  pending: boolean
  from: AiModeName | null
  mode: AiModeName
  contentKey: 'anthropic' | 'openai' | null
  model?: { state: 'ready' | 'checking' | 'absent' | 'unsupported'; tierId: string | null; bytes: number }
}

export type IntroView = 'none' | 'built-in' | 'offer'

/** Which one-time card to show, if any. */
export function introView(intro: IntroInfo | null): IntroView {
  if (!intro || !intro.pending) return 'none'
  // An older main that does not report the model: the card as it was.
  const state = intro.model?.state ?? 'ready'
  if (state === 'ready') return 'built-in'
  if (state === 'checking' || state === 'unsupported') return 'none'
  // No model here. Someone already on Local gets the "needs a download" banner
  // instead; everyone else is offered the download.
  if (intro.mode === 'local' || !intro.model?.tierId) return 'none'
  return 'offer'
}

export interface MissingBanner {
  tierId: string
  bytes: number
  /** Every language-model feature routes to the device (the source is Local). */
  all: boolean
  /** The features that route to the device and so cannot answer, as labels. */
  features: string[]
}

const EMBED_BYTES_FALLBACK = 146_146_432

/** The "needs a one-time download" banner, or null when AI is not left without an engine. */
export function missingBanner(st: LocalAiStatus | null): MissingBanner | null {
  if (!st) return null
  const tier = st.tiers.find((t) => t.id === st.activeTier)
  // No tier: too little memory, which a download cannot fix (Settings says so).
  if (!tier || tier.installed || !tier.offered) return null
  const local = (Object.keys(st.effectiveRoutes) as AiFeature[]).filter((f) => f !== 'media' && st.effectiveRoutes[f] === 'local')
  if (local.length === 0) return null
  return {
    tierId: tier.id,
    bytes: tier.sizeBytes + (st.embeddings.installed ? 0 : EMBED_BYTES_FALLBACK),
    all: st.provider === 'local',
    features: local.map((f) => AI_FEATURE_COPY[f].label)
  }
}

export const MODE_LABEL: Record<AiModeName, string> = {
  auto: 'Plexii AI credits',
  credits: 'Plexii AI credits',
  byok: 'your Anthropic key',
  openai: 'your OpenAI key',
  local: 'on-device AI'
}

/** The Local source card's second line in Settings › AI: true to what is on this computer. */
export function localSourceSub(m: { installed: boolean; bytes: number; offered: boolean } | null): string {
  if (!m || m.installed) return 'Included with PlexiiDesk; requests stay on this computer'
  if (!m.offered) return 'Needs more memory than this computer has'
  return `One-time download (${(m.bytes / 1e9).toFixed(1)} GB); requests stay on this computer`
}

/**
 * Why "Learn from my documents" (and other on-device jobs) learned nothing,
 * true for the bundled engine. Ollama is named only as the advanced option it
 * is, for a computer that cannot use the bundled model or has not downloaded it.
 */
export function noLocalModelNote(st: Pick<LocalAiStatus, 'tiers' | 'activeTier' | 'ramGB'> | null): string {
  const tier = st?.tiers.find((t) => t.id === st.activeTier) ?? null
  if (st && !tier) {
    return `Nothing was learned: this needs the on-device AI model, and this computer has ${st.ramGB} GB of memory, less than the model needs. (Advanced: an Ollama server running on this computer can do it instead; see Settings › AI › Local on this device.)`
  }
  if (tier && tier.installed) {
    return 'Nothing was learned: the on-device AI model could not run just now. Try again in a moment.'
  }
  const size = tier ? ` (a one-time ${gb(tier.sizeBytes)} download)` : ''
  return `Nothing was learned: this runs on the on-device AI model, which is not downloaded yet. Download it in Settings › AI › Local on this device${size}, then try again.`
}

export const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`
