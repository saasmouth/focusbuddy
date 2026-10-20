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
  type ContentWritingPolicy,
  type LocalPolicy,
  type LocalGateInfo,
  type AiFeature,
  type AiProviderChoice,
  type CloudConsentRequest
} from '@shared/localAi'
import { localGateFor } from '@shared/localAiGates'
import { MODEL_HAIKU } from '../modelRouting'
import {
  createLocalClient,
  purposeOfModel,
  LocalMessageStream,
  runLocal,
  LocalUnsupportedError,
  localUnusableReason,
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
  const route = routeForPurpose(purpose)
  if (route === 'local') return `local:${purpose}`
  if (route === 'cloud' && providerChoice() !== 'local') return cloudModel
  return `route:${route}:${purpose}:${cloudModel}`
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

async function withCreditFallback(
  client: Anthropic,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal },
  run: () => Promise<Anthropic.Message>,
  purpose = 'generic'
): Promise<Anthropic.Message> {
  try {
    return await run()
  } catch (err) {
    if (!creditFallback.isCredits(client) || opts.signal?.aborted) throw err
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
}

export class LocalModelMissingError extends Error {
  constructor() {
    super(
      'The on-device model is not downloaded yet. Open Settings → AI and download it under "Local on this device", or choose another AI source.'
    )
    this.name = 'LocalModelMissingError'
  }
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
export type NoticeAction = 'upgrade' | 'topup'
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
  ).then((m) => observeGrounding(body, m))
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
      `The on-device model's answer for ${label} did not come out in a usable shape (${unusable}).`,
      cloudModel
    )
    if (viaCloud) return viaCloud
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
const PROVIDER_ROUTE = /^route:(cloud|anthropic|openai|credits):([^:]+):(.+)$/

/** A tagged model id → the provider, purpose and real model it names. */
function parseRoute(model: string): { provider: string; purpose: string; model: string } | null {
  const r = PROVIDER_ROUTE.exec(model)
  if (r) return { provider: r[1], purpose: r[2], model: r[3] }
  const legacy = CLOUD_ROUTE.exec(model)
  return legacy ? { provider: 'cloud', purpose: legacy[1], model: legacy[2] } : null
}

function providerClient(provider: string, cloud: Anthropic | null): Anthropic | null {
  if (provider === 'anthropic') return providers.anthropic()
  if (provider === 'openai') return providers.openai()
  if (provider === 'credits') return providers.credits()
  return cloud
}

const NOT_SET_UP: Record<string, string> = {
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
    return withCreditFallback(
      client,
      real,
      opts,
      () => maybeGranted(feature, () => (client.messages.create as unknown as CreateFn)(real, { signal: opts.signal })),
      routed.purpose
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
  return withCreditFallback(target, body, opts, () => (target.messages.create as unknown as CreateFn)(body, { signal: opts.signal })).then((m) =>
    observeGrounding(body, m)
  )
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
          if (c && routed.provider === 'credits') {
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
          if (c) {
            // The SDK (or OpenAI) stream starts its request inside this
            // context, so a grant covers it.
            return maybeGranted(featureForPurpose(routed.purpose), () => c.messages.stream({ ...body, model: routed.model } as never))
          }
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
 * For the call sites that build a client from a key directly (title backfill,
 * custom work widgets, mind maps, voice notes, agents): the routed client for
 * that key, or a local-only client when there is no key but local routing
 * applies, or null when neither can serve.
 */
export function clientForKey(key: string | null, makeCloud: (key: string) => Anthropic): Anthropic | null {
  return routedClient(key ? makeCloud(key) : null)
}

/** A bare local client (no cloud fallback), for local-only jobs like document enrichment. */
export function localOnlyClient(): Anthropic {
  return createLocalClient(runtime) as unknown as Anthropic
}

/** Test hook: forget which labelled features already showed their notice. */
export function resetNotices(): void {
  noticed.clear()
}
