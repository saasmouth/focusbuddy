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
  type AiFeature,
  type AiProviderChoice,
  type CloudConsentRequest
} from '@shared/localAi'
import { localGateFor } from '@shared/localAiGates'
import { MODEL_HAIKU } from '../modelRouting'
import { createLocalClient, purposeOfModel, LocalMessageStream, runLocal } from './localClient'
import type { LocalEngine } from './engineCore'

// ── Policy inputs (injected so this module stays testable without Electron) ──

export interface RouterSettings {
  aiMode: () => 'auto' | 'credits' | 'byok' | 'local'
  featureRoutes: () => Partial<Record<string, 'local' | 'cloud'>>
}

let settings: RouterSettings = {
  aiMode: () => 'auto',
  featureRoutes: () => ({})
}

export function setRouterSettings(s: RouterSettings): void {
  settings = s
}

export function providerChoice(): AiProviderChoice {
  const m = settings.aiMode()
  return m === 'local' ? 'local' : m === 'byok' ? 'byok' : 'credits'
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
export function routeForPurpose(purpose: string): 'local' | 'cloud' {
  const override = settings.featureRoutes()[featureForPurpose(purpose)]
  if (override) return override
  return providerChoice() === 'local' ? 'local' : 'cloud'
}

/** Whether any request could be served locally (global source or a feature route). */
export function anyLocalRouting(): boolean {
  if (providerChoice() === 'local') return true
  return Object.values(settings.featureRoutes()).includes('local')
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

export type NoticeSink = (feature: AiFeature, message: string) => void
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

async function serveLocal(
  body: Record<string, unknown>,
  cloud: Anthropic | null,
  opts: { signal?: AbortSignal; onText?: (d: string) => void },
  /** The cloud model the call site itself named, when it named one. */
  callSiteModel?: string
): Promise<Anthropic.Message> {
  const purpose = purposeOfModel(body.model)
  const feature = featureForPurpose(purpose)
  const gate = gateResolver(purpose)
  if (gate.gate === 'cloud-only') {
    const label = AI_FEATURE_COPY[feature].label
    const reason =
      gate.localPassRate === null || gate.cloudPassRate === null
        ? `${label} is not run on the on-device model: it has not been shown to work there in our tests.`
        : `${label} is not run on the on-device model: in our tests it passed ${percent(gate.localPassRate)} of ` +
          `tasks locally against ${percent(gate.cloudPassRate)} on cloud AI.`
    const yes = await askConsent({ feature, featureLabel: label, reason, cloudAvailable: cloud !== null })
    if (!yes) {
      throw new LocalUnavailableError(
        feature,
        `${reason} Nothing was sent anywhere. To use it, choose "Use cloud for this request" when asked, or route ${label} to cloud in Settings → AI.`
      )
    }
    if (!cloud) {
      throw new LocalUnavailableError(
        feature,
        'Cloud AI is not set up: add your own Anthropic API key or sign in for Plexii AI credits in Settings → AI.'
      )
    }
    // 'generic' and 'enrichment' are not cloud purposes: use the model the call
    // site named, else the cheapest; never send an empty model id.
    const cloudBody = { ...body, model: callSiteModel || cloudModelFor(purpose) || MODEL_HAIKU }
    return withCloudGrant({ reason: 'consent', feature }, () =>
      (cloud.messages.create as unknown as CreateFn)(cloudBody, { signal: opts.signal })
    )
  }
  if (gate.gate === 'labelled' && !noticed.has(feature)) {
    noticed.add(feature)
    noticeSink(feature, `${AI_FEATURE_COPY[feature].label} ran on the on-device model. ${LOCAL_LABEL_COPY}`)
  }
  return runLocal(runtime, body, opts)
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

/** True when the source is Local and this purpose's feature is routed to cloud. */
export function cloudRoutedFromLocal(purpose: string): boolean {
  return providerChoice() === 'local' && routeForPurpose(purpose) === 'cloud'
}

const CLOUD_ROUTE = /^cloudroute:([^:]+):(.+)$/

function dispatch(
  body: Record<string, unknown>,
  cloud: Anthropic | null,
  opts: { signal?: AbortSignal; onText?: (d: string) => void }
): Promise<Anthropic.Message> {
  const model = typeof body.model === 'string' ? body.model : ''
  if (model.startsWith('local:')) return serveLocal(body, cloud, opts)
  const routed = CLOUD_ROUTE.exec(model)
  if (routed) {
    // The user routed this feature to cloud while the source is Local: that
    // setting is the grant, for this request.
    if (!cloud) {
      return Promise.reject(
        new Error('This feature is set to use cloud AI, but cloud AI is not set up. Add your own API key or sign in for Plexii AI credits in Settings → AI.')
      )
    }
    const feature = featureForPurpose(routed[1])
    return withCloudGrant({ reason: 'feature-route', feature }, () =>
      (cloud.messages.create as unknown as CreateFn)({ ...body, model: routed[2] }, { signal: opts.signal })
    )
  }
  if (localOnlyActive()) {
    // A cloud model id reached the client while the source is Local and no
    // grant is held — a call site that names its model directly. Run it on the
    // device rather than send it anywhere.
    return serveLocal({ ...body, model: 'local:generic' }, cloud, opts, model || undefined)
  }
  if (!cloud) {
    return Promise.reject(
      new Error('No Anthropic API key set. Open Settings → AI → API keys and paste your key.')
    )
  }
  return (cloud.messages.create as unknown as CreateFn)(body, { signal: opts.signal })
}

/**
 * Wrap the cloud client (or null) so each request goes where policy says.
 * With no local routing configured anywhere, the cloud client is returned
 * untouched — the cloud path is byte-for-byte what it was before.
 */
export function routedClient(cloud: Anthropic | null): Anthropic | null {
  if (!anyLocalRouting()) return cloud
  const client = {
    // isCreditClient() reads baseURL; a routed client is never the proxy, so
    // streaming is attempted and the local stream serves it.
    baseURL: 'local://device',
    messages: {
      create: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
        dispatch(body, cloud, { signal: options?.signal }),
      stream: (body: Record<string, unknown>) => {
        const model = typeof body.model === 'string' ? body.model : ''
        const routed = CLOUD_ROUTE.exec(model)
        if (routed && cloud) {
          // Feature routed to cloud while the source is Local. The SDK stream
          // starts its request inside this context, so the grant covers it.
          const feature = featureForPurpose(routed[1])
          return withCloudGrantSync({ reason: 'feature-route', feature }, () =>
            cloud.messages.stream({ ...body, model: routed[2] } as never)
          )
        }
        if (!model.startsWith('local:') && !routed && !localOnlyActive() && cloud) {
          // Cloud streaming keeps the SDK's own stream object.
          return cloud.messages.stream(body as never)
        }
        return new LocalMessageStream((signal, onText) => dispatch(body, cloud, { signal, onText }))
      }
    }
  }
  return client as unknown as Anthropic
}

function withCloudGrantSync<T>(grant: CloudGrant, fn: () => T): T {
  return grantStore.run(grant, fn)
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
