// Local AI — the shared vocabulary for the on-device model: which features
// exist, how each AI purpose maps onto one, what the measured local quality of
// each is, and the catalog of downloadable model tiers.
//
// Shared because main enforces it and the renderer explains it. Everything
// here that describes QUALITY comes from tools/local-ai-eval (the harness runs
// the app's real prompts and parsers against the local model and the cloud
// reference); the numbers are copied from its results file, not estimated, and
// localAiGates.test.ts pins them to that file so the two cannot drift.

import type { AIPurpose } from './types'

/** Where AI requests are served. Persisted as the settings `aiMode`. */
export type AiProviderChoice = 'local' | 'byok' | 'credits' | 'openai'

/** User-facing groups of AI features, each routable on its own. */
export type AiFeature =
  | 'assistant'
  | 'build'
  | 'office'
  | 'writing'
  | 'summaries'
  | 'background'
  | 'agents'
  | 'media'

export const AI_FEATURES: readonly AiFeature[] = [
  'assistant',
  'build',
  'office',
  'writing',
  'summaries',
  'background',
  'agents',
  'media'
] as const

/**
 * Display copy per feature. Names follow the 4.3.34 lexicon: the assistant is
 * PlexiiAssist, the knowledge view is PlexiiBrain, desk items are work widgets.
 */
export const AI_FEATURE_COPY: Record<AiFeature, { label: string; covers: string }> = {
  assistant: {
    label: 'PlexiiAssist and PlexiiBrain answers',
    covers: 'Questions about your desks and documents, proposed work widgets and tasks, command bar'
  },
  build: {
    label: 'Build with AI',
    covers: 'Setting up a desk with work widgets, smart stacks, custom work widgets'
  },
  office: {
    label: 'PlexiiWrite, PlexiiCells and PlexiiDeck generation',
    covers: 'Creating a document, sheet, deck, diagram or design from a prompt; sheet columns, fills and formulas'
  },
  writing: {
    label: 'Writing and rewriting',
    covers: 'Drafting, rewriting a selection, email replies, AI Assist on a work widget'
  },
  summaries: {
    label: 'Summaries',
    covers: 'Trail and meeting summaries, living pages'
  },
  background: {
    label: 'Background tidying',
    covers: 'Titles for untitled items, document descriptions, tags, memory from chats, inbox sorting'
  },
  agents: {
    label: 'Agents and browsing',
    covers: 'Desk agents, multi-step agent runs, the web-browsing agent'
  },
  media: {
    label: 'Images and background removal',
    covers: 'Generating images (OpenAI) and removing image backgrounds (remove.bg); there is no on-device model for these'
  }
}

/**
 * Every AI purpose belongs to exactly one feature. `enrichment` is the local
 * document describer (it has no cloud model and so no AIPurpose); `media` stands
 * for image generation and background removal, which are not language-model calls.
 */
export const PURPOSE_FEATURE: Record<AIPurpose | 'enrichment' | 'generic' | 'media', AiFeature> = {
  chat: 'assistant',
  welcome: 'assistant',
  command_route: 'assistant',
  intent_classify: 'assistant',
  setup: 'build',
  smart_stack: 'build',
  document: 'office',
  custom_widget: 'build',
  doc_rewrite: 'writing',
  wire_transform: 'writing',
  email_reply_draft: 'writing',
  capture_cleanup: 'writing',
  tone_profile: 'writing',
  resume: 'writing',
  trail_summary: 'summaries',
  living_page: 'summaries',
  meeting_end: 'summaries',
  body_double: 'summaries',
  title_backfill: 'background',
  file_tag: 'background',
  mail_triage: 'background',
  memory_extract: 'background',
  enrichment: 'background',
  desk_agent: 'agents',
  agent_step: 'agents',
  browser_agent: 'agents',
  generic: 'writing',
  media: 'media'
}

export function featureForPurpose(purpose: string): AiFeature {
  return (PURPOSE_FEATURE as Record<string, AiFeature>)[purpose] ?? 'writing'
}

/**
 * How a purpose behaves when it runs on the local model:
 *   ok         — measured to work; runs locally with no caveat.
 *   labelled   — runs locally, but the user is told plainly that it works best
 *                with cloud AI and local results may be incomplete.
 *   cloud-only — measured to fail locally. The request is NOT attempted on the
 *                local model; the user is asked whether to send this one
 *                request to cloud AI, and nothing is sent unless they say yes.
 */
export type LocalGate = 'ok' | 'labelled' | 'cloud-only'

export interface LocalGateInfo {
  gate: LocalGate
  /** Measured pass rate of the local model on this purpose's eval family, 0..1, or null if not measured. */
  localPassRate: number | null
  /** Same family on the cloud reference model. */
  cloudPassRate: number | null
  /** The eval family the numbers come from. */
  family: string | null
}

/** A downloadable on-device model. The sha256 is the integrity anchor: it ships inside the signed app. */
export interface LocalModelTier {
  id: 'compact' | 'standard'
  /** Folder name inside the app bundle: Contents/Resources/models/<bundleId>/<file>. */
  bundleId: string
  /** Display name, e.g. "Qwen3.5 4B". */
  name: string
  /** File name under userData/models and under models/ on the download host. */
  file: string
  /** Bump when the file changes; part of the download URL path. */
  version: string
  sizeBytes: number
  sha256: string
  license: string
  licenseUrl: string
  /** Where the weights came from (the GGUF repo and commit), for attribution. */
  sourceUrl: string
  /** Context window the app opens the model with on this tier. */
  contextSize: number
  /** KV-cache precision the app opens the model with (see engineCore). */
  kvCache: 'f16' | 'q8_0'
  /** Below this much RAM the tier is not offered. */
  minRamGB: number
  /** At or above this much RAM the tier is the recommendation. */
  recommendedRamGB: number
}

export const MODEL_DOWNLOAD_BASE = 'https://dl.plexiidesk.com/models'

/**
 * Where a model downloads from: Plexii's host, laid out exactly like the
 * model's folder inside the app, per version:
 *
 *   <base>/<bundleId>/<version>/<file>
 *   <base>/<bundleId>/<version>/manifest.sha256   (the same manifest the app ships)
 *   <base>/<bundleId>/<version>/LICENSE.txt
 *
 * `base` overrides it (main reads PLEXII_MODEL_BASE_URL) so a local test build
 * can download from a file:// folder with the same layout; the manifest and the
 * sha256 compiled into the app are checked either way.
 */
export function modelDownloadDir(t: Pick<LocalModelTier, 'version' | 'bundleId'>, base: string = MODEL_DOWNLOAD_BASE): string {
  return `${base.replace(/\/$/, '')}/${t.bundleId}/${t.version}`
}
export function modelDownloadUrl(t: Pick<LocalModelTier, 'version' | 'bundleId' | 'file'>, base: string = MODEL_DOWNLOAD_BASE): string {
  return `${modelDownloadDir(t, base)}/${t.file}`
}
export function modelManifestUrl(t: Pick<LocalModelTier, 'version' | 'bundleId'>, base: string = MODEL_DOWNLOAD_BASE): string {
  return `${modelDownloadDir(t, base)}/manifest.sha256`
}

/**
 * The tier to recommend for a machine with `ramGB` of memory: the largest tier
 * whose recommendedRamGB fits, else the smallest whose minRamGB fits, else
 * null (the machine cannot run any tier well, and we say so).
 */
export function recommendTier<T extends Pick<LocalModelTier, 'id' | 'minRamGB' | 'recommendedRamGB'>>(
  tiers: readonly T[],
  ramGB: number
): T | null {
  const byRec = [...tiers].sort((a, b) => b.recommendedRamGB - a.recommendedRamGB)
  const rec = byRec.find((t) => ramGB >= t.recommendedRamGB)
  if (rec) return rec
  const byMin = [...tiers].sort((a, b) => a.minRamGB - b.minRamGB)
  return byMin.find((t) => ramGB >= t.minRamGB) ?? null
}

/**
 * Where one feature's requests go. 'cloud' = the account default (Plexii AI
 * credits when signed in, else your Anthropic key); the rest name a provider.
 */
export type AiFeatureRoute = 'local' | 'cloud' | 'anthropic' | 'openai' | 'credits'
export const AI_FEATURE_ROUTES: readonly AiFeatureRoute[] = ['local', 'cloud', 'anthropic', 'openai', 'credits']

/** The cloud providers this install can reach right now (keys saved / signed in). */
export interface CloudProvidersAvailable {
  anthropic: boolean
  openai: boolean
  credits: boolean
}

/** The on-device engine, live (localAi:engine): 'loading' with waiting > 0 is a cold start someone is waiting on. */
export interface LocalEngineState {
  state: 'idle' | 'loading' | 'ready' | 'error'
  waiting: number
  lastLoadMs: number | null
  error: string | null
}

/** What a surface says while the on-device model is loading. */
export const LOCAL_WARMING_COPY = 'Starting local AI — this happens once per session…'

/** Status of local AI, as main reports it to the renderer. */
export interface LocalAiStatus {
  provider: AiProviderChoice
  featureRoutes: Partial<Record<AiFeature, AiFeatureRoute>>
  cloudProviders: CloudProvidersAvailable
  /** OpenAI model per tier (the person's choice over the defaults). */
  openaiModels: { fast: string; standard: string; best: string }
  ramGB: number
  freeDiskBytes: number | null
  recommendedTier: LocalModelTier['id'] | null
  /** source: 'bundle' = shipped inside the app; 'userData' = downloaded or kept from an older bundle. */
  tiers: Array<LocalModelTier & { installed: boolean; offered: boolean; source: 'bundle' | 'userData' | null }>
  activeTier: LocalModelTier['id'] | null
  engine: { state: 'idle' | 'loading' | 'ready' | 'error'; error: string | null; gpu: string | false | null }
  download: LocalDownloadProgress | null
  gates: Record<AiFeature, { gate: LocalGate; localPassRate: number | null; cloudPassRate: number | null }>
  policy: LocalPolicy
  embeddings: { installed: boolean; name: string }
  /**
   * What will run the model on this computer, known before loading it:
   * 'metal' (Apple Silicon GPU), 'cpu' (Intel Macs — no GPU backend in the
   * shipped runtime) or 'auto' (Windows: Vulkan when a GPU driver supports it,
   * else CPU; known after the first load as engine.gpu).
   */
  hardware: 'metal' | 'cpu' | 'auto'
}

export interface LocalDownloadProgress {
  tierId: string
  file: string
  state: 'checking' | 'downloading' | 'verifying' | 'done' | 'cancelled' | 'error'
  receivedBytes: number
  totalBytes: number
  error: string | null
}

/** A request the local model is not allowed to answer, offered to cloud instead. */
export interface CloudConsentRequest {
  id: string
  feature: AiFeature
  featureLabel: string
  /** Why local is not used for this, with the measured numbers. */
  reason: string
  /** Whether a cloud route is actually configured (key or credits). */
  cloudAvailable: boolean
}

export const LOCAL_LABEL_COPY = 'Works best with cloud AI; local results may be incomplete.'

/**
 * How features are routed while the AI source is Local.
 *
 *   measured     — the quality gates decide: a feature that measured well runs
 *                  on the device, a weaker one runs with the label, and one that
 *                  measured poorly asks before sending that request to cloud.
 *   local-first  — everything the device can technically run, runs on it (the
 *                  weaker ones with the label). Cloud is the fallback: when a
 *                  local answer comes back unusable, the person is asked whether
 *                  to send that one request to cloud.
 *
 * In both, nothing goes to cloud without a yes, and features with no on-device
 * model at all (images, background removal) or that need tool use always ask.
 */
export type LocalPolicy = 'measured' | 'local-first'

/**
 * Owner decision (2026-10-20): the bundled model is the default and everything
 * it can technically run, runs on it ('local-first'). A feature that measured
 * weak runs with a quality note and an offer to upgrade with your own key;
 * what it cannot run at all (NOT_TECHNICALLY_LOCAL, and tool-using agents)
 * asks before each request. 'measured' stays selectable in Settings → AI.
 */
export const DEFAULT_LOCAL_POLICY: LocalPolicy = 'local-first'

/** Features the on-device model cannot run at all, whatever the policy. */
export const NOT_TECHNICALLY_LOCAL: readonly AiFeature[] = ['media']

/** A grounding review of content-writing output, as main reports it. */
export interface GroundingReport {
  path: 'local' | 'cloud'
  /** Replaced by a [placeholder] (local path, high confidence only). */
  repaired: Array<{ span: string; kind: string; confidence: 'high' | 'medium' | 'low'; reason: string }>
  /** Left as written, for the person to check. */
  flagged: Array<{ span: string; kind: string; confidence: 'high' | 'medium' | 'low'; reason: string }>
}
