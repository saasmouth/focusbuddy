// The provider router: for every AI request, local model or cloud?
//
// The user picks one source in Settings → AI — "Local on this device", "Your
// own API key" or "Plexii AI credits" — and may route individual features
// differently ("local, but Build with AI on cloud"). This module turns that
// choice into behaviour at the single client seam every AI call already goes
// through (getClient in anthropic.ts, and clientForKey here for the few call
// sites that use a key directly):
//
//   - resolveModel(purpose) returns `local:<purpose>` for a purpose routed
//     local (modelRouting.ts asks routeForPurpose), so the request itself
//     carries where it should run;
//   - the routed client sends `local:` requests to the on-device engine and
//     everything else to the cloud client — EXCEPT that while the source is
//     Local, a request naming a cloud model with no explicit grant is run on
//     the local model instead. Privacy wins over a stray hard-coded model id.
//
// Cloud is reached from Local mode only through a grant, held in
// AsyncLocalStorage for exactly one request: the user said yes to "use cloud for
// this request", or routed that feature to cloud in Settings. The egress guard
// (egressGuard.ts) refuses any request to an AI service while the source is
// Local and no grant is held, so a code path this router does not know about
// cannot leak either.
//
// Quality gates (src/shared/localAiGates.ts, measured by tools/local-ai-eval):
// a purpose the local model fails is not attempted locally. The user is asked
// whether to send that one request to cloud AI; if they decline, or no window
// can ask, the request fails with a plain explanation. Nothing degrades quietly.

import { AsyncLocalStorage } from 'node:async_hooks'
import type Anthropic from '@anthropic-ai/sdk'
import {
  featureForPurpose,
  AI_FEATURE_COPY,
  LOCAL_LABEL_COPY,
  DEFAULT_LOCAL_POLICY,
  NOT_TECHNICALLY_LOCAL,
  CONTENT_WRITING_FEATURES,
  DEFAULT_CONTENT_WRITING,
  DEFAULT_PREFERRED_KEY,
  type ContentWritingPolicy,
  type PreferredKey,
  type LocalPolicy,
  type LocalGateInfo,
  type AiFeature,
  type AiProviderChoice,
  type CloudConsentRequest
} from '@shared/localAi'
import { localGateFor } from '@shared/localAiGates'
import { MODEL_HAIKU } from '../modelRouting'
import {
  purposeOfModel,
  LocalMessageStream,
  runLocal,
  LocalUnsupportedError,
  localUnusableReason,
  localUnusableKind,
  type LocalUnusableKind,
  localContractOf,
  flattenRequest,
  emitGrounding
} from './localClient'
import { isContentWriting, suppliedText, reviewOutput } from './groundingCheck'
import type { LocalEngine } from './engineCore'

// ── Policy inputs (injected so this module stays testable without Electron) ──

/** A per-feature route. 'cloud' is the account default (credits, then your Anthropic key). */
export type FeatureRoute = 'local' | 'cloud' | 'anthropic' | 'openai' | 'credits'

export interface RouterSettings {
  aiMode: () => 'auto' | 'credits' | 'byok' | 'local' | 'openai'
  featureRoutes: () => Partial<Record<string, FeatureRoute>>
  /** Local routing policy; absent → DEFAULT_LOCAL_POLICY. */
  policy?: () => LocalPolicy
  /** Content writing under local-first: on the device, or ask each time (DEFAULT_CONTENT_WRITING). */
  contentWriting?: () => ContentWritingPolicy
  /** The saved key content writing prefers when both are saved. */
  preferredKey?: () => PreferredKey
}

let settings: RouterSettings = {
  aiMode: () => 'auto',
  featureRoutes: () => ({})
}

export function currentLocalPolicy(): LocalPolicy {
  return settings.policy?.() ?? DEFAULT_LOCAL_POLICY
}

export function setRouterSettings(s: RouterSettings): void {
  settings = s
}

export function providerChoice(): AiProviderChoice {
  const m = settings.aiMode()
  return m === 'local' ? 'local' : m === 'byok' ? 'byok' : m === 'openai' ? 'openai' : 'credits'
}

// ── Grants ──────────────────────────────────────────────────────────────────

export interface CloudGrant {
  reason: 'consent' | 'feature-route' | 'key-test'
  feature?: AiFeature
}

const grantStore = new AsyncLocalStorage<CloudGrant>()

/** The grant held by the current async context, if any. */
export function currentCloudGrant(): CloudGrant | undefined {
  return grantStore.getStore()
}

/** Run fn with cloud allowed for its duration (and only within its async context). */
export function withCloudGrant<T>(grant: CloudGrant, fn: () => Promise<T>): Promise<T> {
  return grantStore.run(grant, fn)
}

/**
 * True when nothing about AI may leave the machine right now: the source is
 * Local and the current context holds no grant. The egress guard reads this.
 */
export function localOnlyActive(): boolean {
  return providerChoice() === 'local' && !grantStore.getStore()
}

/** Where a purpose runs: its feature's override, else the global source. */
export function routeForPurpose(purpose: string): FeatureRoute {
  const override = settings.featureRoutes()[featureForPurpose(purpose)]
  if (override) return override
  const p = providerChoice()
  return p === 'local' ? 'local' : p === 'openai' ? 'openai' : 'cloud'
}

/** Whether any request could be served locally (global source or a feature route). */
export function anyLocalRouting(): boolean {
  if (providerChoice() === 'local') return true
  return Object.values(settings.featureRoutes()).includes('local')
}

/**
 * The model id a call site sends for a purpose: `local:<purpose>` on the
 * device; the plain cloud model on the account's default cloud route (unless
 * the source is Local, when cloud is only reached by a route tag); otherwise
 * `route:<provider>:<purpose>:<cloud model>`, which the routed client sends to
 * that provider. Registered with modelRouting at start-up.
 */
export function tagModel(purpose: string, cloudModel: string): string {
  const keyed = contentKeyFor(purpose)
  if (keyed) return `route:key-${keyed}:${purpose}:${cloudModel}`
  const route = routeForPurpose(purpose)
  if (route === 'local') return `local:${purpose}`
  // Always tagged, the default cloud route included: the routed client strips
  // the tag before anything is sent, and knowing the purpose is what lets it
  // say which engine answered which feature ("Answered by …").
  return `route:${route}:${purpose}:${cloudModel}`
}

/**
 * Content writing under 'cloud-if-key' while the source is Local and the
 * feature has no explicit route: the saved key to use (preferred when both
 * are saved, else whichever exists), or null to stay on the device.
 */
export function contentKeyFor(purpose: string): 'anthropic' | 'openai' | null {
  const feature = featureForPurpose(purpose)
  if (!CONTENT_WRITING_FEATURES.includes(feature)) return null
  if (providerChoice() !== 'local' || settings.featureRoutes()[feature]) return null
  if (currentContentWriting() !== 'cloud-if-key') return null
  const pref = settings.preferredKey?.() ?? DEFAULT_PREFERRED_KEY
  const other = pref === 'anthropic' ? 'openai' : 'anthropic'
  if (providers[pref]()) return pref
  if (providers[other]()) return other
  return null
}

/** Where a feature's requests go right now, every setting applied (for Settings). */
export function effectiveRouteFor(feature: AiFeature): 'local' | 'anthropic' | 'openai' | 'credits' | 'cloud' {
  const purpose = Object.entries(PURPOSE_FOR_FEATURE).find(([f]) => f === feature)?.[1] ?? 'chat'
  const keyed = contentKeyFor(purpose)
  if (keyed) return keyed
  const r = routeForPurpose(purpose)
  if (r !== 'cloud') return r
  return providerChoice() === 'byok' ? 'anthropic' : providerChoice() === 'credits' ? 'credits' : 'cloud'
}
const PURPOSE_FOR_FEATURE: Record<AiFeature, string> = {
  assistant: 'chat',
  build: 'setup',
  office: 'document',
  writing: 'doc_rewrite',
  summaries: 'trail_summary',
  background: 'title_backfill',
  agents: 'agent_step',
  media: 'media'
}

// ── Cloud providers (registered by the app; injected in tests) ──────────────

export interface CloudProviders {
  /** Your Anthropic key, direct. */
  anthropic: () => Anthropic | null
  /** Plexii AI credits (the metered proxy), when signed in. */
  credits: () => Anthropic | null
  /** Your OpenAI key (openaiClient.ts). */
  openai: () => Anthropic | null
}

let providers: CloudProviders = { anthropic: () => null, credits: () => null, openai: () => null }
export function setCloudProviders(p: CloudProviders): void {
  providers = p
}

// ── Plexii AI credits that cannot serve a request ───────────────────────────
//
// An explicit 'credits' choice is kept as it is. But when a credits request is
// refused (balance spent, payment lapsed, email unverified) or the proxy is
// down, that ONE request is answered on the device instead of failing, with a
// visible note naming why and offering a top-up. The stored choice is never
// changed. Only when the on-device model is installed; otherwise the original
// error stands.
export interface CreditFallback {
  /** Is this client the credits proxy? */
  isCredits: (c: Anthropic) => boolean
  /** The note to show when this error means credits cannot serve; null when it is some other error. */
  refusal: (err: unknown) => string | null
}
let creditFallback: CreditFallback = { isCredits: () => false, refusal: () => null }
export function setCreditFallback(f: CreditFallback): void {
  creditFallback = f
}

// ── Which engine answered ───────────────────────────────────────────────────
//
// Every request that completes reports the engine that produced it, per
// feature, so each AI surface can say "Answered by: Local (Qwen3 4B) /
// Anthropic (your key) / OpenAI (your key) / Plexii AI credits".
export type AnswerEngine = 'local' | 'anthropic' | 'openai' | 'credits'
export type AnsweredSink = (a: { feature: AiFeature; purpose: string; engine: AnswerEngine; model: string; at: number }) => void
let answeredSink: AnsweredSink = () => undefined
export function setAnsweredSink(fn: AnsweredSink): void {
  answeredSink = fn
}
function answered(purpose: string, engine: AnswerEngine, model: string): void {
  try {
    answeredSink({ feature: featureForPurpose(purpose), purpose, engine, model, at: Date.now() })
  } catch {
    /* reporting never affects the answer */
  }
}
function engineOfClient(c: Anthropic | null): AnswerEngine {
  if (c && creditFallback.isCredits(c)) return 'credits'
  if (c && c === providers.openai()) return 'openai'
  return 'anthropic'
}

/** Why a saved key could not serve a request (refused, out of credit, rate-limited), or null. */
export function keyRefusalNote(err: unknown, provider: 'anthropic' | 'openai'): string | null {
  const e = err as { status?: number; message?: string } | null
  const name = provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
  const status = typeof e?.status === 'number' ? e.status : Number(/\((\d{3})\)/.exec(e?.message ?? '')?.[1] ?? NaN)
  const text = e?.message ?? ''
  if (status === 401 || status === 403 || /invalid.{0,20}(api )?key|authentication/i.test(text)) return `Your ${name} key was refused`
  if (status === 429 || status === 402 || /quota|credit balance|insufficient/i.test(text)) return `Your ${name} key is out of credit or rate-limited`
  return null
}

async function withCreditFallback(
  client: Anthropic,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal },
  run: () => Promise<Anthropic.Message>,
  purpose = 'generic',
  keyProvider: 'anthropic' | 'openai' | null = null
): Promise<Anthropic.Message> {
  try {
    return await run()
  } catch (err) {
    if (opts.signal?.aborted) throw err
    // A saved key used automatically for content writing ('cloud-if-key'):
    // refused or out of credit → this request on the device, with a note.
    if (keyProvider) {
      const why = keyRefusalNote(err, keyProvider)
      if (!why || !runtime.installed()) throw err
      const feature = featureForPurpose(purpose)
      const model = typeof body.model === 'string' ? body.model : undefined
      let local: Anthropic.Message
      try {
        local = await serveLocal({ ...body, model: `local:${purpose}` }, null, opts, model, { noCloud: true })
      } catch {
        throw err
      }
      noticeSink(feature, `${why}, so this was answered by the on-device AI.`, 'keys')
      return local
    }
    if (!creditFallback.isCredits(client)) throw err
    const why = creditFallback.refusal(err)
    if (!why || !runtime.installed()) throw err
    const feature = featureForPurpose(purpose)
    const model = typeof body.model === 'string' ? body.model : undefined
    let local: Anthropic.Message
    try {
      local = await serveLocal({ ...body, model: `local:${purpose}` }, null, opts, model, { noCloud: true })
    } catch {
      throw err // the device cannot do this one either: the credits refusal is the honest answer
    }
    noticeSink(feature, `${why}, so this was answered by the on-device AI.`, 'topup')
    return local
  }
}

const PROVIDER_NAME: Record<string, string> = {
  anthropic: 'Anthropic with your key',
  openai: 'OpenAI with your key',
  credits: 'Plexii AI credits',
  cloud: 'cloud AI'
}

/** The upgrade a weak or unsupported local request is offered: your Anthropic key, else your OpenAI key, else credits. */
function preferredUpgrade(cloud: Anthropic | null): { client: Anthropic; name: string } | null {
  const a = providers.anthropic()
  if (a) return { client: a, name: PROVIDER_NAME.anthropic }
  const o = providers.openai()
  if (o) return { client: o, name: PROVIDER_NAME.openai }
  const c = providers.credits() ?? cloud
  if (c) return { client: c, name: PROVIDER_NAME.credits }
  return null
}

// ── The engine, consent and notices (wired by the app; injected in tests) ───

export interface LocalRuntime {
  /** The loaded engine, loading the installed model if needed. Throws LocalModelMissingError when none is installed. */
  engine: () => Promise<LocalEngine>
  /** Short model label for responses, e.g. "qwen3.5-4b". */
  modelLabel: () => string
  /** Whether a bundled model file is installed and verified (no loading). */
  installed: () => boolean
  /** The on-device model's context window, in tokens (the active tier's). */
  contextTokens?: () => number
}

export class LocalModelMissingError extends Error {
  constructor() {
    super(
      'The on-device model is not downloaded yet. Open Settings → AI and download it under "Local on this device", or choose another AI source.'
    )
    this.name = 'LocalModelMissingError'
  }
}

/**
 * The computer has less memory than the smallest on-device model needs, so no
 * model can run here and downloading one would not help. Says so, and names
 * the sources that do work.
 */
export class LocalModelNoMemoryError extends Error {
  constructor(
    public readonly ramGB: number,
    public readonly neededGB: number
  ) {
    super(
      `This computer has ${ramGB} GB of memory and the on-device model needs at least ${neededGB} GB, so AI cannot run on this computer. ` +
        'To use AI, choose your own Anthropic or OpenAI key, or Plexii AI credits, as the AI source in Settings › AI.'
    )
    this.name = 'LocalModelNoMemoryError'
  }
}

/**
 * Why there is no on-device model to run: too little memory for every tier
 * (LocalModelNoMemoryError), or a tier this computer can run that is not
 * downloaded (LocalModelMissingError).
 */
export function noLocalModelError(ramGB: number, tiers: readonly { minRamGB: number }[]): Error {
  if (tiers.length > 0) {
    const neededGB = Math.min(...tiers.map((t) => t.minRamGB))
    if (ramGB < neededGB) return new LocalModelNoMemoryError(ramGB, neededGB)
  }
  return new LocalModelMissingError()
}

/**
 * What the person reads when the on-device model could not produce what a
 * call promised. Plain words, no parser jargon; says nothing was sent, and
 * what to do next. Exported for tests.
 */
export function unusableMessage(promised: string, kind: LocalUnusableKind | null, featureLabel: string): string {
  const useKey = `or use your own key for ${featureLabel} in Settings → AI.`
  if (kind === 'too-long') {
    return `That was more than the on-device model can read at once, so it could not write ${promised}. Nothing was sent anywhere. Ask about less at a time, ${useKey}`
  }
  if (kind === 'out-of-room') {
    return `The on-device model ran out of room before it finished ${promised}. Nothing was sent anywhere. Ask for something shorter or narrower, ${useKey}`
  }
  return `The on-device model could not write ${promised} this time. Nothing was sent anywhere. Try again or rephrase it, ${useKey}`
}

export class LocalUnavailableError extends Error {
  constructor(
    public readonly feature: AiFeature,
    message: string
  ) {
    super(message)
    this.name = 'LocalUnavailableError'
  }
}

let runtime: LocalRuntime = {
  engine: async () => {
    throw new LocalModelMissingError()
  },
  modelLabel: () => 'none',
  installed: () => false
}
/**
 * The on-device model's context window in tokens, or null when unknown. Call
 * sites that pack retrieved material size it to this when the call runs on
 * the device: a cloud model reads 200k tokens, the on-device one 16k.
 */
export function localContextTokens(): number | null {
  try {
    const n = runtime.contextTokens?.()
    return typeof n === 'number' && n > 0 ? n : null
  } catch {
    return null
  }
}
export function getLocalRuntime(): LocalRuntime {
  return runtime
}
export function setLocalRuntime(r: LocalRuntime): void {
  runtime = r
}

export type ConsentAsker = (req: Omit<CloudConsentRequest, 'id'>) => Promise<boolean>
let askConsent: ConsentAsker = async () => false
export function setConsentAsker(fn: ConsentAsker): void {
  askConsent = fn
}

/** 'upgrade' → offer your own key; 'topup' → offer Plexii AI credits top-up. */
export type NoticeAction = 'upgrade' | 'topup' | 'keys'
export type NoticeSink = (feature: AiFeature, message: string, action?: NoticeAction) => void
let noticeSink: NoticeSink = () => undefined
const noticed = new Set<AiFeature>()
export function setNoticeSink(fn: NoticeSink): void {
  noticeSink = fn
  noticed.clear()
}

// The gate table. Overridable ONLY so the eval harness can measure every
// family on the local model regardless of the gates the last run produced.
let gateResolver: typeof localGateFor = localGateFor
export function setGateResolver(fn: typeof localGateFor | null): void {
  gateResolver = fn ?? localGateFor
}

// The cloud model a purpose uses when it is granted cloud. Injected by
// modelRouting to avoid an import cycle.
let cloudModelFor: (purpose: string) => string = () => MODEL_HAIKU
export function setCloudModelResolver(fn: (purpose: string) => string): void {
  cloudModelFor = fn
}

// ── The routed client ───────────────────────────────────────────────────────

type CreateFn = (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<Anthropic.Message>

function percent(n: number | null): string {
  return n === null ? 'not measured' : `${Math.round(n * 100)}%`
}

/**
 * The gate a purpose gets under the current policy. 'measured' is the measured
 * gate. 'local-first' runs everything the device can technically run: a
 * cloud-only gate becomes 'labelled', except features with no on-device model.
 */
export function effectiveGate(purpose: string): LocalGateInfo {
  const g = gateResolver(purpose)
  if (currentLocalPolicy() !== 'local-first') return g
  const feature = featureForPurpose(purpose)
  if (NOT_TECHNICALLY_LOCAL.includes(feature)) return { ...g, gate: 'cloud-only' }
  // Content writing follows its own switch (DEFAULT_CONTENT_WRITING): 'ask'
  // keeps a measured cloud-only gate as cloud-only, so each request asks.
  if (CONTENT_WRITING_FEATURES.includes(feature) && currentContentWriting() === 'ask') return g
  return g.gate === 'cloud-only' ? { ...g, gate: 'labelled' } : g
}

/** The content-writing switch in force (setRouterSettings.contentWriting, else the default). */
export function currentContentWriting(): ContentWritingPolicy {
  return settings.contentWriting?.() ?? DEFAULT_CONTENT_WRITING
}

/** Ask, then (on yes) send this one request to cloud with the cloud model. */
async function cloudForThisRequest(
  body: Record<string, unknown>,
  cloud: Anthropic | null,
  opts: { signal?: AbortSignal },
  feature: AiFeature,
  reason: string,
  cloudModel: string
): Promise<Anthropic.Message | null> {
  const label = AI_FEATURE_COPY[feature].label
  const up = preferredUpgrade(cloud)
  const yes = await askConsent({ feature, featureLabel: label, reason: up ? `${reason} It would go to ${up.name}.` : reason, cloudAvailable: up !== null })
  if (!yes) return null
  if (!up) throw new LocalUnavailableError(feature, NO_CLOUD_SET_UP)
  return withCloudGrant({ reason: 'consent', feature }, () =>
    (up.client.messages.create as unknown as CreateFn)({ ...body, model: cloudModel }, { signal: opts.signal })
  ).then((m) => {
    answered(purposeOfModel(body.model), engineOfClient(up.client), cloudModel)
    return observeGrounding(body, m)
  })
}

const NO_CLOUD_SET_UP =
  'Cloud AI is not set up: add your own Anthropic or OpenAI API key, or sign in for Plexii AI credits, in Settings → AI.'

async function serveLocal(
  body: Record<string, unknown>,
  cloud: Anthropic | null,
  opts: { signal?: AbortSignal; onText?: (d: string) => void },
  /** The cloud model the call site itself named, when it named one. */
  callSiteModel?: string,
  /** noCloud: a fallback FROM cloud (credits could not serve): never offer cloud again; fail instead. */
  mode: { noCloud?: boolean } = {}
): Promise<Anthropic.Message> {
  const purpose = purposeOfModel(body.model)
  const feature = featureForPurpose(purpose)
  const gate = effectiveGate(purpose)
  const cloudModel = callSiteModel || cloudModelFor(purpose) || MODEL_HAIKU
  if (gate.gate === 'cloud-only' && mode.noCloud) throw new LocalUnavailableError(feature, `${AI_FEATURE_COPY[feature].label} cannot run on the on-device model.`)
  if (gate.gate === 'cloud-only') {
    const label = AI_FEATURE_COPY[feature].label
    const reason =
      gate.localPassRate === null || gate.cloudPassRate === null
        ? `${label} is not run on the on-device model: it has not been shown to work there in our tests.`
        : `${label} is not run on the on-device model: in our tests it passed ${percent(gate.localPassRate)} of ` +
          `tasks locally against ${percent(gate.cloudPassRate)} on cloud AI.`
    const viaCloud = await cloudForThisRequest(body, cloud, opts, feature, reason, cloudModel)
    if (viaCloud) return viaCloud
    throw new LocalUnavailableError(
      feature,
      `${reason} Nothing was sent anywhere. To use it, choose "Use cloud for this request" when asked, or route ${label} to a cloud provider in Settings → AI.`
    )
  }
  if (gate.gate === 'labelled' && !noticed.has(feature)) {
    noticed.add(feature)
    noticeSink(feature, `${AI_FEATURE_COPY[feature].label} ran on the on-device model. ${LOCAL_LABEL_COPY}`)
  }
  let msg: Anthropic.Message
  try {
    msg = await runLocal(runtime, body, opts)
    answered(purpose, 'local', runtime.modelLabel())
  } catch (e) {
    // Tool use, images or attached files: the on-device model cannot do it at
    // all, under either policy. Ask before this one request goes to cloud.
    if (!(e instanceof LocalUnsupportedError) || mode.noCloud) throw e
    const viaCloud = await cloudForThisRequest(body, cloud, opts, feature, `${e.message}`, cloudModel)
    if (viaCloud) return viaCloud
    throw new LocalUnavailableError(feature, `${e.message} Nothing was sent anywhere.`)
  }
  // Local-first: the fallback for an answer that came back unusable is cloud,
  // for this one request, if the person agrees. Otherwise the call site fails
  // honestly on the local text.
  const unusable = localUnusableReason(msg)
  if (unusable && currentLocalPolicy() === 'local-first' && !opts.onText && !mode.noCloud) {
    const label = AI_FEATURE_COPY[feature].label
    const viaCloud = await cloudForThisRequest(
      body,
      cloud,
      opts,
      feature,
      localUnusableKind(msg) === 'too-long'
        ? `${label} was more than the on-device model can read at once.`
        : localUnusableKind(msg) === 'out-of-room'
          ? `The on-device model ran out of room before it finished the answer for ${label}.`
          : `The on-device model's answer for ${label} did not come out in a usable shape.`,
      cloudModel
    )
    if (viaCloud) return viaCloud
  }
  // A call with a known contract never gets an unusable reply passed off as
  // its answer (an empty table, no cards): it fails plainly instead.
  const promised = localContractOf(msg)
  if (unusable && promised) {
    // The technical reason goes to the log; the person reads what happened in
    // plain words ("no JSON object was found" next to an answer was 4.3.40).
    console.warn(`[local-ai] ${purpose}: unusable structured reply (${localUnusableKind(msg) ?? 'shape'}): ${unusable}`)
    throw new LocalUnavailableError(feature, unusableMessage(promised, localUnusableKind(msg), AI_FEATURE_COPY[feature].label))
  }
  return msg
}

/**
 * For AI that has no on-device model at all (image generation, background
 * removal): while the source is Local, ask before the one request goes to the
 * cloud service. 'not-local' means the source is cloud and nothing needs asking;
 * 'allowed' means run the request inside withCloudGrant; 'declined' means do
 * not send it, and say so.
 */
export async function askCloudForNonLocalFeature(
  feature: AiFeature,
  service: string,
  cloudAvailable: boolean
): Promise<'not-local' | 'allowed' | 'declined'> {
  if (!localOnlyActive()) return 'not-local'
  const label = AI_FEATURE_COPY[feature].label
  const yes = await askConsent({
    feature,
    featureLabel: label,
    reason: `${label} has no on-device model: this request would go to ${service}.`,
    cloudAvailable
  })
  return yes ? 'allowed' : 'declined'
}

/** True when the source is Local and this purpose's feature is routed to a cloud provider. */
export function cloudRoutedFromLocal(purpose: string): boolean {
  return providerChoice() === 'local' && routeForPurpose(purpose) !== 'local'
}

const CLOUD_ROUTE = /^cloudroute:([^:]+):(.+)$/
const PROVIDER_ROUTE = /^route:(cloud|anthropic|openai|credits|key-anthropic|key-openai):([^:]+):(.+)$/

/** A tagged model id → the provider, purpose and real model it names. */
function parseRoute(model: string): { provider: string; purpose: string; model: string } | null {
  const r = PROVIDER_ROUTE.exec(model)
  if (r) return { provider: r[1], purpose: r[2], model: r[3] }
  const legacy = CLOUD_ROUTE.exec(model)
  return legacy ? { provider: 'cloud', purpose: legacy[1], model: legacy[2] } : null
}

function providerClient(provider: string, cloud: Anthropic | null): Anthropic | null {
  if (provider === 'anthropic' || provider === 'key-anthropic') return providers.anthropic()
  if (provider === 'openai' || provider === 'key-openai') return providers.openai()
  if (provider === 'credits') return providers.credits()
  return cloud
}

const NOT_SET_UP: Record<string, string> = {
  'key-anthropic': 'Your Anthropic key is no longer saved. Add it again in Settings → AI · API keys.',
  'key-openai': 'Your OpenAI key is no longer saved. Add it again in Settings → AI · API keys.',
  anthropic: 'This feature is set to use your Anthropic key, but none is saved. Add it in Settings → AI · API keys.',
  openai: 'This feature is set to use your OpenAI key, but none is saved. Add it in Settings → AI · API keys.',
  credits: 'This feature is set to use Plexii AI credits. Sign in to your Plexii account in Settings to use them.',
  cloud: 'This feature is set to use cloud AI, but cloud AI is not set up. Add your own API key or sign in for Plexii AI credits in Settings → AI.'
}

/** Run fn under a grant when the source is Local (a route the person chose is the grant). */
function maybeGranted<T>(feature: AiFeature, fn: () => T): T {
  return providerChoice() === 'local' ? grantStore.run({ reason: 'feature-route', feature }, fn) : fn()
}

function dispatch(
  body: Record<string, unknown>,
  cloud: Anthropic | null,
  opts: { signal?: AbortSignal; onText?: (d: string) => void }
): Promise<Anthropic.Message> {
  const model = typeof body.model === 'string' ? body.model : ''
  if (model.startsWith('local:')) return serveLocal(body, cloud, opts)
  const routed = parseRoute(model)
  if (routed) {
    const client = providerClient(routed.provider, cloud)
    if (!client) return Promise.reject(new Error(NOT_SET_UP[routed.provider]))
    const feature = featureForPurpose(routed.purpose)
    const real = { ...body, model: routed.model }
    const keyProvider = routed.provider === 'key-anthropic' ? 'anthropic' : routed.provider === 'key-openai' ? 'openai' : null
    return withCreditFallback(
      client,
      real,
      opts,
      () =>
        maybeGranted(feature, () => (client.messages.create as unknown as CreateFn)(real, { signal: opts.signal })).then((m) => {
          answered(routed.purpose, engineOfClient(client), routed.model)
          return m
        }),
      routed.purpose,
      keyProvider
    ).then((m) => observeGrounding(real, m))
  }
  if (localOnlyActive()) {
    // A cloud model id reached the client while the source is Local and no
    // grant is held — a call site that names its model directly. Run it on the
    // device rather than send it anywhere.
    return serveLocal({ ...body, model: 'local:generic' }, cloud, opts, model || undefined)
  }
  // Source is OpenAI: a call site that names a Claude model goes to OpenAI too.
  const target = providerChoice() === 'openai' ? providers.openai() : cloud
  if (!target) {
    return Promise.reject(
      new Error(providerChoice() === 'openai' ? NOT_SET_UP.openai : 'No Anthropic API key set. Open Settings → AI → API keys and paste your key.')
    )
  }
  return withCreditFallback(target, body, opts, () =>
    (target.messages.create as unknown as CreateFn)(body, { signal: opts.signal }).then((m) => {
      answered('generic', engineOfClient(target), model)
      return m
    })
  ).then((m) => observeGrounding(body, m))
}

/**
 * Cloud replies to content-writing prompts are reviewed for specifics the
 * request never supplied. Observation only: the reply is returned exactly as
 * the model wrote it, and findings go to the person as "check this".
 */
function observeGrounding(body: Record<string, unknown>, msg: Anthropic.Message): Anthropic.Message {
  try {
    const flat = flattenRequest(body)
    if (!isContentWriting(flat.system)) return msg
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? b.text : ''))
      .join('')
    if (!text) return msg
    const supplied = suppliedText(flat.system, flat.messages)
    const r = reviewOutput(text, supplied, false)
    emitGrounding({ ...r, path: 'cloud', original: text, supplied, applied: false })
  } catch {
    /* a review that cannot run never touches the reply */
  }
  return msg
}

/**
 * Wrap the cloud client (or null) so each request goes where the person's
 * choices say: the device, their Anthropic key, their OpenAI key, Plexii AI
 * credits, or the account default. Untagged cloud requests reach the cloud
 * client unchanged (only content-writing replies are observed for grounding).
 * Null when nothing at all can serve (no model routed locally, no cloud).
 */
export function routedClient(cloud: Anthropic | null): Anthropic | null {
  if (!cloud && !anyLocalRouting() && !providers.openai() && !providers.anthropic() && !providers.credits()) return null
  const client = {
    // isCreditClient() reads baseURL: the routed client reports the default
    // cloud client's, so a credits client is still recognised as the proxy.
    get baseURL() {
      return anyLocalRouting() || providerChoice() === 'openai' ? 'local://device' : (cloud as unknown as { baseURL?: string } | null)?.baseURL
    },
    messages: {
      create: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
        dispatch(body, cloud, { signal: options?.signal }),
      stream: (body: Record<string, unknown>) => {
        const model = typeof body.model === 'string' ? body.model : ''
        const routed = parseRoute(model)
        if (routed) {
          const c = providerClient(routed.provider, cloud)
          if (c && (routed.provider === 'credits' || creditFallback.isCredits(c))) {
            // The credits proxy refuses streaming: run it whole and deliver the
            // text in one piece through the same stream surface.
            return new LocalMessageStream((signal, onText) =>
              dispatch(body, cloud, { signal }).then((m) => {
                const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
                if (text) onText(text)
                return m
              })
            )
          }
          if (c) return routedStream(c, routed, body)
        }
        if (!model.startsWith('local:') && !routed && !localOnlyActive()) {
          const target = providerChoice() === 'openai' ? providers.openai() : cloud
          if (target) return target.messages.stream(body as never)
        }
        return new LocalMessageStream((signal, onText) => dispatch(body, cloud, { signal, onText }))
      }
    }
  }
  return client as unknown as Anthropic
}

/**
 * A routed cloud request, streamed: the provider's own stream (started inside
 * the grant, so the egress guard lets it through), relayed through the same
 * on('text') / finalMessage() / abort() surface, reporting which engine
 * answered. A saved key used automatically for content writing that is
 * refused before any text arrived answers on the device instead, with a note.
 */
function routedStream(
  c: Anthropic,
  routed: { provider: string; purpose: string; model: string },
  body: Record<string, unknown>
): LocalMessageStream {
  const feature = featureForPurpose(routed.purpose)
  const keyProvider = routed.provider === 'key-anthropic' ? 'anthropic' : routed.provider === 'key-openai' ? 'openai' : null
  return new LocalMessageStream(async (signal, onText) => {
    let emitted = false
    try {
      const st = maybeGranted(feature, () => c.messages.stream({ ...body, model: routed.model } as never)) as unknown as {
        on: (e: string, fn: (d: string) => void) => unknown
        abort: () => void
        finalMessage: () => Promise<Anthropic.Message>
      }
      st.on('text', (d: string) => {
        emitted = true
        onText(d)
      })
      if (signal.aborted) st.abort()
      else signal.addEventListener('abort', () => st.abort(), { once: true })
      const m = await st.finalMessage()
      answered(routed.purpose, engineOfClient(c), routed.model)
      return observeGrounding({ ...body, model: routed.model }, m)
    } catch (err) {
      if (!keyProvider || emitted || signal.aborted) throw err
      const why = keyRefusalNote(err, keyProvider)
      if (!why || !runtime.installed()) throw err
      let local: Anthropic.Message
      try {
        local = await serveLocal({ ...body, model: `local:${routed.purpose}` }, null, { signal, onText }, routed.model, { noCloud: true })
      } catch {
        throw err
      }
      noticeSink(feature, `${why}, so this was answered by the on-device AI.`, 'keys')
      return local
    }
  })
}

/**
 * For the call sites that build a client from a key directly (title backfill,
 * custom work widgets, mind maps, voice notes, agents): the routed client for
 * that key, or a local-only client when there is no key but local routing
 * applies, or null when neither can serve.
 */
export function clientForKey(key: string | null, makeCloud: (key: string) => Anthropic): Anthropic | null {
  return routedClient(key ? makeCloud(key) : null)
}

/** Test hook: forget which labelled features already showed their notice. */
export function resetNotices(): void {
  noticed.clear()
}
