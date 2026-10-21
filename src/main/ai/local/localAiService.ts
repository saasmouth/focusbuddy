// Local AI, wired into the running app. Called once from main start-up
// (initLocalAi) — it does NO model work there: it registers policy, installs
// the egress guard and points the engine host at the installed model. The
// model itself loads on the first on-device request, in a utility process.

import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import { statfs } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  getAiMode,
  getAiFeatureRoutes,
  setAiFeatureRoute,
  getLocalModelTier,
  setLocalModelTier,
  getLocalAiPolicy,
  setLocalAiPolicy,
  getOpenAIModels,
  setOpenAIModels,
  getLocalAiIntro,
  dismissLocalAiIntro,
  getContentWriting,
  setContentWriting,
  getPreferredKey,
  setPreferredKey,
  resolveAnthropicKey,
  resolveOpenAIKey,
  setLocalModelReadinessProbe,
  localAiMigrationPending,
  completeLocalAiMigration,
  type LocalModelReadiness
} from '../../settingsStore'
import {
  setRouterSettings,
  setLocalRuntime,
  setConsentAsker,
  setNoticeSink,
  setCloudModelResolver,
  tagModel,
  setCloudProviders,
  setCreditFallback,
  anyLocalRouting,
  setAnsweredSink,
  effectiveRouteFor,
  currentContentWriting,
  type AnswerEngine,
  withCloudGrant,
  effectiveGate,
  currentLocalPolicy,
  localOnlyActive,
  providerChoice,
  LocalModelMissingError,
  noLocalModelError
} from './providerRouter'
import { setModelTagger, resolveCloudModel } from '../modelRouting'
import { createOpenAIClient, DEFAULT_OPENAI_MODELS } from './openaiClient'
import { getModelClient } from '../modelClient'
import { installEgressGuard } from './egressGuard'
import { EngineHost, type WorkerHandle } from './engineHost'
import { removeModel, fetchWithFile, type DownloadProgress } from './downloadManager'
import { downloadModels } from './modelDownload'
import { locateModel, verifyLocated, cachedVerification, canonicalPath, type ModelSpec, type Located } from './modelLocator'
import { setGroundingSink, setLocalTraceSink } from './localClient'
import { setBundledEmbedder } from '../localModel'
import { SIGNAL_BASE, getCreditClient, isCreditClient, creditRefusalNote } from '../creditMode'
import {
  AI_FEATURES,
  AI_FEATURE_ROUTES,
  DEFAULT_LOCAL_POLICY,
  DEFAULT_CONTENT_WRITING,
  DEFAULT_PREFERRED_KEY,
  recommendTier,
  type AiFeature,
  type AiFeatureRoute,
  type CloudConsentRequest,
  type LocalAiStatus,
  type LocalModelTier,
  type LocalDownloadProgress
} from '@shared/localAi'
import { LOCAL_MODEL_TIERS, LOCAL_EMBED_MODEL, tierById } from '@shared/localModelCatalog'
import type { AIPurpose } from '@shared/types'

const IDLE_MS = 10 * 60 * 1000

let host: EngineHost | null = null
let download: { ctrl: AbortController; progress: LocalDownloadProgress } | null = null

/**
 * userData/models, canonical. userData may be reached through a symlink
 * (Application Support/focusbuddy → …/plexii; installed builds pass the
 * symlinked spelling), and there is only ever one copy of each model: resolve
 * once so downloads, the installed check and the disk-space figure all name
 * the real directory.
 */
export function modelsDir(): string {
  return canonicalPath(join(app.getPath('userData'), 'models'))
}

export function ramGB(): number {
  return Math.round(totalmem() / 2 ** 30)
}

/** The tier a choice resolves to here: the pick if this computer can run it, else the recommendation. */
function tierFor(chosen: string | null): LocalModelTier | null {
  const picked = tierById(chosen)
  if (picked && picked.minRamGB <= ramGB()) return picked
  return recommendTier(LOCAL_MODEL_TIERS, ramGB())
}

/** The tier in use: the user's pick if it is offered here, else the recommendation. */
export function activeTier(): LocalModelTier | null {
  return tierFor(getLocalModelTier())
}

/**
 * The models shipped inside the app (extraResources → Resources/models/<bundleId>/).
 */
export function bundleModelsDir(): string | null {
  // Packaged: Contents/Resources/models (electron-builder extraResources from
  // resources/models). Dev: the staged build input itself.
  // Dev/test only: PLEXII_BUNDLED_MODELS_DIR stands in for the bundle, so the
  // e2e suite can exercise an install that came WITHOUT the model (the update
  // zip case). A packaged app always uses its own Resources/models.
  if (!app.isPackaged && process.env.PLEXII_BUNDLED_MODELS_DIR) return canonicalPath(process.env.PLEXII_BUNDLED_MODELS_DIR)
  return canonicalPath(app.isPackaged ? join(process.resourcesPath, 'models') : join(app.getAppPath(), 'resources', 'models'))
}

function dirs(): { userDir: string; bundleDir: string | null } {
  return { userDir: modelsDir(), bundleDir: bundleModelsDir() }
}

/** Every catalog model the app may carry in its bundle (for the updater). */
export function bundledModelSpecs(): ModelSpec[] {
  return [...LOCAL_MODEL_TIERS, LOCAL_EMBED_MODEL]
}

export function locate(spec: ModelSpec | null): Located | null {
  return spec ? locateModel(spec, dirs()) : null
}

function tierInstalled(t: LocalModelTier | null): boolean {
  return !!locate(t)
}

function embedInstalled(): boolean {
  return !!locate(LOCAL_EMBED_MODEL)
}

// Where the bundled-model checksum result is remembered. Development and test
// runs may share one cache across throwaway profiles (PLEXII_MODEL_VERIFY_CACHE,
// set by the e2e harness) so each launched app does not re-hash 2.5 GB; the
// entry is keyed by path, size, mtime and the expected sha256, so sharing it
// cannot vouch for a different file. A packaged app always uses its own.
const verifiedCacheFile = (): string =>
  !app.isPackaged && process.env.PLEXII_MODEL_VERIFY_CACHE
    ? process.env.PLEXII_MODEL_VERIFY_CACHE
    : join(modelsDir(), 'bundle-verified.json')

/**
 * Is the model this computer would use here and usable, known without hashing
 * (settingsStore.migrateAiMode decides the AI source with it)? `chosenTier` is
 * passed in because the settings store asks while it is still loading.
 */
export function localModelReadiness(chosenTier: string | null = getLocalModelTier()): LocalModelReadiness {
  const t = tierFor(chosenTier)
  if (!t) return 'unsupported'
  const loc = locate(t)
  if (!loc) return 'absent'
  const v = cachedVerification(t, loc, verifiedCacheFile())
  return v === true ? 'ready' : v === false ? 'absent' : 'unverified'
}
// Registered as the module loads, before anything can read settings.
setLocalModelReadinessProbe((chosen) => localModelReadiness(chosen))

let settling: Promise<boolean> | null = null
/**
 * Complete a switch to Local that was waiting for the model
 * (settingsStore.migrateAiMode): when the model this computer uses is here and
 * passes its checksum, a profile still on the source it was kept on moves to
 * Local. Runs at start-up (a fresh install's bundled model is checked once, in
 * the background) and after a download. Returns true when the source changed.
 */
export function settleLocalAiMigration(): Promise<boolean> {
  if (settling) return settling
  // Cleared by .finally on the promise, not a finally inside the async body:
  // when the body returns before its first await (no model yet, the usual
  // start-up case), an inner finally runs BEFORE this assignment, leaving the
  // already-resolved `false` here for good, and every later call (the one
  // after a download included) returned it without checking anything.
  const run = async (): Promise<boolean> => {
    try {
      if (!localAiMigrationPending()) return false
      const t = activeTier()
      const loc = locate(t)
      if (!t || !loc) return false
      const ok = await verifyLocated(t, loc, verifiedCacheFile(), (why) => console.warn(`[local-ai] bundled model not used: ${why}`))
      if (!ok || !localAiMigrationPending()) return false
      completeLocalAiMigration()
      console.info('[local-ai] the on-device model is here and verified: the deferred switch to Local is complete')
      refreshEngineModel()
      try {
        ;(await import('../anthropic')).invalidateAnthropicClient()
      } catch {
        /* the next AI call resolves its client afresh anyway */
      }
      broadcast('localAi:changed', null)
      return true
    } catch (e) {
      console.warn(`[local-ai] could not complete the switch to Local: ${(e as Error).message}`)
      return false
    }
  }
  const p = run().finally(() => {
    if (settling === p) settling = null
  })
  settling = p
  return p
}

/** What the one-time card needs to know about the model (localAi:getIntro). */
export function introModelState(): { state: 'ready' | 'checking' | 'absent' | 'unsupported'; tierId: string | null; bytes: number } {
  const t = activeTier()
  const r = localModelReadiness()
  return {
    state: r === 'unverified' ? 'checking' : r,
    tierId: t?.id ?? null,
    bytes: t ? t.sizeBytes + (embedInstalled() ? 0 : LOCAL_EMBED_MODEL.sizeBytes) : 0
  }
}

/** Checksum the located file once (bundled files: first use only). */
async function ensureVerified(spec: ModelSpec): Promise<Located> {
  const loc = locate(spec)
  if (!loc) throw new LocalModelMissingError()
  if (!(await verifyLocated(spec, loc, verifiedCacheFile(), (why) => console.warn(`[local-ai] bundled model not used: ${why}`)))) {
    throw new Error(
      'The on-device AI model that came with the app did not match its checksum, so it was not used. Reinstall PlexiiDesk, or download the model again in Settings → AI.'
    )
  }
  return loc
}

/** Re-point the engine host after a download, delete or tier change. */
export function refreshEngineModel(): void {
  const t = activeTier()
  const loc = locate(t)
  if (host) host.setModel(loc ? loc.path : null, t?.contextSize ?? 8192, 'auto', t?.kvCache)
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

// ── Consent: "use cloud for this request?" ──────────────────────────────────

const consentWaiters = new Map<string, (allow: boolean) => void>()
const CONSENT_TIMEOUT_MS = 2 * 60 * 1000

function askRendererForConsent(req: Omit<CloudConsentRequest, 'id'>): Promise<boolean> {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  // No window to ask means nobody is waiting on this request (a background
  // job): the answer is no, and nothing is sent.
  if (!target) return Promise.resolve(false)
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      consentWaiters.delete(id)
      resolve(false)
    }, CONSENT_TIMEOUT_MS)
    consentWaiters.set(id, (allow) => {
      clearTimeout(timer)
      consentWaiters.delete(id)
      resolve(allow)
    })
    target.webContents.send('localAi:consentRequest', { ...req, id } satisfies CloudConsentRequest)
  })
}

// ── Start-up ────────────────────────────────────────────────────────────────

export function initLocalAi(): void {
  setRouterSettings({
    aiMode: getAiMode,
    featureRoutes: getAiFeatureRoutes,
    policy: () => getLocalAiPolicy() ?? DEFAULT_LOCAL_POLICY,
    contentWriting: () => getContentWriting() ?? DEFAULT_CONTENT_WRITING,
    preferredKey: () => getPreferredKey() ?? DEFAULT_PREFERRED_KEY
  })
  // Which engine answered, per feature, for the "Answered by" line on every AI surface.
  setAnsweredSink((a) => broadcast('localAi:answered', { ...a, label: engineLabel(a.engine) }))
  setModelTagger(tagModel)
  const openai = createOpenAIClient({ key: resolveOpenAIKey, models: () => ({ ...DEFAULT_OPENAI_MODELS, ...getOpenAIModels() }) })
  setCloudProviders({
    anthropic: () => {
      const k = resolveAnthropicKey()
      return k ? getModelClient(k) : null
    },
    credits: getCreditClient,
    openai: () => (resolveOpenAIKey() ? openai : null)
  })
  setCloudModelResolver((p) => resolveCloudModel(p as AIPurpose))
  installEgressGuard({
    localOnly: localOnlyActive,
    signalBase: SIGNAL_BASE,
    // Host only — never the path or anything of the request.
    onBlocked: (h) => console.warn(`[local-ai] blocked an AI request to ${h} (AI is set to run on this device)`)
  })

  host = new EngineHost({
    idleMs: IDLE_MS,
    log: (m) => console.info(m),
    // Every surface that runs AI shows "Starting local AI…" while a load is in
    // progress (renderer lib/localAiEngine.ts), so a cold start reads as what it is.
    onState: (st) => broadcast('localAi:engine', st),
    fork: (): WorkerHandle => {
      const child = utilityProcess.fork(join(__dirname, 'localAiWorker.js'), [], {
        serviceName: 'Plexii Local AI',
        stdio: 'pipe'
      })
      child.stdout?.on('data', (d: Buffer) => console.info(`[local-ai worker] ${String(d).trimEnd()}`))
      child.stderr?.on('data', (d: Buffer) => console.warn(`[local-ai worker] ${String(d).trimEnd()}`))
      return child as unknown as WorkerHandle
    }
  })
  refreshEngineModel()
  // A switch to Local waiting on a model that is in fact here (a fresh
  // install's bundled model, checked once in the background).
  void settleLocalAiMigration()

  // Diagnostics only: PLEXII_LOCAL_AI_TRACE=<file> records the model's raw
  // output per request (localClient.ts). Off unless set; nothing leaves the device.
  const traceFile = process.env.PLEXII_LOCAL_AI_TRACE
  if (traceFile) setLocalTraceSink((entry) => appendFileSync(traceFile, JSON.stringify(entry) + '\n'))
  setLocalRuntime({
    installed: () => tierInstalled(activeTier()),
    modelLabel: () => activeTier()?.name.toLowerCase().replace(/\s+/g, '-') ?? 'none',
    // The same figure refreshEngineModel loads the engine with.
    contextTokens: () => activeTier()?.contextSize ?? 8192,
    engine: async () => {
      const t = activeTier()
      // No tier at all means this computer has too little memory for any of
      // them: say that, not "not downloaded yet", which a download cannot fix.
      if (!t) throw noLocalModelError(ramGB(), LOCAL_MODEL_TIERS)
      if (!host) throw new LocalModelMissingError()
      await ensureVerified(t)
      return host
    }
  })
  schedulePreload()
  setBundledEmbedder({
    installed: embedInstalled,
    label: () => LOCAL_EMBED_MODEL.label,
    embed: async (texts, kind) => {
      if (!host || !embedInstalled()) throw new Error('No local embedding model is installed.')
      const loc = await ensureVerified(LOCAL_EMBED_MODEL)
      return host.embed(loc.path, texts, kind ?? 'document')
    }
  })
  setConsentAsker(askRendererForConsent)
  setNoticeSink((feature, message, action) => broadcast('localAi:notice', { feature, message, action: action ?? 'upgrade' }))
  // Plexii AI credits that cannot serve a request fall back to the device for
  // that request (providerRouter.withCreditFallback). The stored choice stays.
  setCreditFallback({
    isCredits: (c) => isCreditClient(c as unknown as { baseURL?: string }),
    refusal: creditRefusalNote
  })
  // Invented-specifics review of content-writing output (groundingCheck.ts):
  // the person sees what was replaced with a placeholder and what to check.
  setGroundingSink((r) =>
    broadcast('localAi:grounding', { path: r.path, repaired: r.repaired.slice(0, 12), flagged: r.flagged.slice(0, 12) })
  )

  app.on('before-quit', () => {
    void host?.stop()
  })
}

/** "Local (Qwen3 4B)" / "Anthropic (your key)" / … for the Answered-by line. */
export function engineLabel(e: AnswerEngine): string {
  if (e === 'local') return `Local (${(activeTier()?.name ?? 'on-device model').replace(/ Instruct$/, '')})`
  if (e === 'anthropic') return 'Anthropic (your key)'
  if (e === 'openai') return 'OpenAI (your key)'
  return 'Plexii AI credits'
}

// ── Background preload ──────────────────────────────────────────────────────
//
// Loading the model takes seconds (most of it the first read of 2.5 GB). Left
// lazy, that wait lands on whatever the person asks first. So when AI would run
// on the device, start loading it in the background a while after launch —
// after the window has painted and start-up work has settled — and let the
// idle timer unload it as usual if it goes unused.
//
// Skipped: when AI does not route to the device; when the model is not here;
// on a Mac below the tier's recommended memory; in macOS Low Power Mode; and
// under the e2e harness (FB_TEST_USER_DATA), where a 2.5 GB load in every
// launched test app would only add load. PLEXII_LOCAL_AI_PRELOAD=0 turns it
// off (start-up measurements); =1 forces it on under the harness.
const PRELOAD_DELAY_MS = 8_000

async function lowPowerMode(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const { execFile } = await import('node:child_process')
    const out = await new Promise<string>((resolve) =>
      execFile('/usr/bin/pmset', ['-g'], { timeout: 2000 }, (_e, stdout) => resolve(String(stdout ?? '')))
    )
    return /lowpowermode\s+1/.test(out)
  } catch {
    return false
  }
}

export type PreloadOutcome = { ran: false; why: string } | { ran: true; loadMs: number | null }
export let lastPreload: PreloadOutcome | null = null

export async function preloadIfLocal(): Promise<PreloadOutcome> {
  const env = process.env.PLEXII_LOCAL_AI_PRELOAD
  const skip = (why: string): PreloadOutcome => {
    console.info(`[local-ai] preload skipped: ${why}`)
    return (lastPreload = { ran: false, why })
  }
  if (env === '0') return skip('PLEXII_LOCAL_AI_PRELOAD=0')
  if (process.env.FB_TEST_USER_DATA && env !== '1') return skip('test harness')
  if (!anyLocalRouting()) return skip('AI does not run on this device')
  const t = activeTier()
  if (!t || !locate(t)) return skip('no on-device model here')
  if (ramGB() < t.recommendedRamGB) return skip(`${ramGB()} GB memory is below the ${t.recommendedRamGB} GB this model wants`)
  if (await lowPowerMode()) return skip('Low Power Mode is on')
  if (!host || host.state === 'loading' || host.state === 'ready') return skip('already loading or loaded')
  try {
    await ensureVerified(t)
    const loadMs = await host.preload()
    console.info(`[local-ai] preloaded in ${loadMs} ms`)
    return (lastPreload = { ran: true, loadMs })
  } catch (e) {
    return skip(`load failed: ${(e as Error).message}`)
  }
}

function schedulePreload(): void {
  const timer = setTimeout(() => void preloadIfLocal(), PRELOAD_DELAY_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

// ── Status ──────────────────────────────────────────────────────────────────

export async function freeDiskBytes(): Promise<number | null> {
  return freeDisk()
}

// Free space on the volume that really holds userData (statfs of the canonical
// path). It is a property of the volume, so a symlinked spelling of userData
// cannot count anything twice; the models already on disk are not added to it.
async function freeDisk(): Promise<number | null> {
  try {
    const dir = canonicalPath(app.getPath('userData'))
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export async function localAiStatus(): Promise<LocalAiStatus> {
  const ram = ramGB()
  const rec = recommendTier(LOCAL_MODEL_TIERS, ram)
  const active = activeTier()
  const gates = {} as LocalAiStatus['gates']
  for (const f of AI_FEATURES) {
    // The gate under the current policy, with the measured numbers.
    const g = effectiveGate(featureRepresentativePurpose(f))
    gates[f] = { gate: g.gate, localPassRate: g.localPassRate, cloudPassRate: g.cloudPassRate }
  }
  return {
    provider: providerChoice(),
    featureRoutes: getAiFeatureRoutes() as LocalAiStatus['featureRoutes'],
    cloudProviders: { anthropic: Boolean(resolveAnthropicKey()), openai: Boolean(resolveOpenAIKey()), credits: getCreditClient() !== null },
    effectiveRoutes: Object.fromEntries(AI_FEATURES.map((f) => [f, effectiveRouteFor(f)])) as LocalAiStatus['effectiveRoutes'],
    contentWriting: currentContentWriting(),
    preferredKey: getPreferredKey() ?? DEFAULT_PREFERRED_KEY,
    openaiModels: { ...DEFAULT_OPENAI_MODELS, ...getOpenAIModels() },
    ramGB: ram,
    freeDiskBytes: await freeDisk(),
    recommendedTier: rec?.id ?? null,
    tiers: LOCAL_MODEL_TIERS.map((t) => ({ ...t, installed: tierInstalled(t), source: locate(t)?.where ?? null, offered: ram >= t.minRamGB })),
    activeTier: active?.id ?? null,
    engine: {
      state: host?.state ?? 'idle',
      error: host?.lastError ?? null,
      gpu: host?.gpu ?? null
    },
    download: download?.progress ?? null,
    gates,
    embeddings: { installed: embedInstalled(), name: LOCAL_EMBED_MODEL.name },
    hardware: process.platform === 'darwin' ? (process.arch === 'arm64' ? 'metal' : 'cpu') : 'auto',
    policy: currentLocalPolicy()
  }
}

// The purpose whose gate stands for a whole feature in the status view.
function featureRepresentativePurpose(f: AiFeature): string {
  const map: Record<AiFeature, string> = {
    assistant: 'chat',
    build: 'setup',
    office: 'document',
    writing: 'doc_rewrite',
    summaries: 'trail_summary',
    background: 'title_backfill',
    agents: 'agent_step',
    media: 'media'
  }
  return map[f]
}

// ── Download / delete ───────────────────────────────────────────────────────

async function runDownload(tier: LocalModelTier): Promise<{ ok: boolean; error?: string }> {
  if (download) return { ok: false, error: 'A download is already running.' }
  const ctrl = new AbortController()
  // PLEXII_MODEL_BASE_URL: a local test build downloads from a file:// folder
  // laid out like the host (<bundleId>/<version>/{<file>,manifest.sha256});
  // the manifest and checksums are verified the same.
  const base = process.env.PLEXII_MODEL_BASE_URL || undefined
  const doFetch = fetchWithFile((i, n) => globalThis.fetch(i, n))
  const wanted = [tier, ...(embedInstalled() ? [] : [LOCAL_EMBED_MODEL])]
  download = {
    ctrl,
    progress: { tierId: tier.id, file: tier.file, state: 'checking', receivedBytes: 0, totalBytes: tier.sizeBytes, error: null }
  }
  const emit = (p: DownloadProgress): void => {
    if (!download) return
    download.progress = { tierId: tier.id, ...p }
    broadcast('localAi:progress', download.progress)
  }
  try {
    const r = await downloadModels(wanted, { dir: modelsDir(), fetch: doFetch, freeBytes: async () => freeDisk(), onProgress: emit, base }, ctrl.signal)
    if (!r.ok) return { ok: false, error: r.error }
    refreshEngineModel()
    download = null
    await settleLocalAiMigration()
    return { ok: true }
  } finally {
    download = null
    broadcast('localAi:changed', null)
  }
}

export function registerLocalAiIpc(): void {
  ipcMain.handle('localAi:getStatus', () => localAiStatus())
  ipcMain.handle('localAi:download', async (_e, tierId: string) => {
    const t = tierById(tierId)
    if (!t) return { ok: false, error: 'Unknown model.' }
    if (t.minRamGB > ramGB()) {
      return { ok: false, error: `This model needs at least ${t.minRamGB} GB of memory; this computer has ${ramGB()} GB.` }
    }
    return runDownload(t)
  })
  ipcMain.handle('localAi:cancelDownload', () => {
    download?.ctrl.abort()
    return { ok: true }
  })
  ipcMain.handle('localAi:deleteModel', async (_e, tierId: string) => {
    const t = tierById(tierId)
    if (!t) return { ok: false, error: 'Unknown model.' }
    if (download?.progress.tierId === tierId) download.ctrl.abort()
    if (activeTier()?.id === t.id) await host?.stop()
    removeModel(modelsDir(), t.file)
    // The embedding model is shared by every tier; it goes when no tier is left.
    if (!LOCAL_MODEL_TIERS.some((x) => tierInstalled(x))) removeModel(modelsDir(), LOCAL_EMBED_MODEL.file)
    refreshEngineModel()
    broadcast('localAi:changed', null)
    return { ok: true }
  })
  ipcMain.handle('localAi:setTier', async (_e, tierId: string | null) => {
    if (tierId !== null && !tierById(tierId)) return { ok: false, error: 'Unknown model.' }
    setLocalModelTier(tierId)
    await host?.stop()
    refreshEngineModel()
    broadcast('localAi:changed', null)
    return { ok: true }
  })
  ipcMain.handle('localAi:setFeatureRoute', (_e, feature: string, route: AiFeatureRoute | null) => {
    if (!(AI_FEATURES as readonly string[]).includes(feature)) return { ok: false, error: 'Unknown feature.' }
    if (route !== null && !AI_FEATURE_ROUTES.includes(route)) return { ok: false, error: 'Unknown route.' }
    setAiFeatureRoute(feature, route)
    broadcast('localAi:changed', null)
    return { ok: true }
  })
  ipcMain.handle('localAi:getEngine', () => ({
    state: host?.state ?? 'idle',
    waiting: host?.waitingCount ?? 0,
    lastLoadMs: host?.lastLoadMs ?? null,
    error: host?.lastError ?? null,
    preload: lastPreload
  }))
  ipcMain.handle('localAi:setContentWriting', (_e, v: string | null) => {
    if (v !== null && v !== 'cloud-if-key' && v !== 'local' && v !== 'ask') return { ok: false, error: 'Unknown setting.' }
    setContentWriting(v)
    broadcast('localAi:changed', null)
    return { ok: true }
  })
  ipcMain.handle('localAi:setPreferredKey', (_e, v: string | null) => {
    if (v !== null && v !== 'anthropic' && v !== 'openai') return { ok: false, error: 'Unknown key.' }
    setPreferredKey(v)
    broadcast('localAi:changed', null)
    return { ok: true }
  })
  // The one-time "local AI is now built in" notice (settingsStore.migrateAiMode).
  ipcMain.handle('localAi:getIntro', () => {
    const r = effectiveRouteFor('office')
    return { ...getLocalAiIntro(), contentKey: r === 'anthropic' || r === 'openai' ? r : null, model: introModelState() }
  })
  ipcMain.handle('localAi:dismissIntro', () => {
    dismissLocalAiIntro()
    return { ok: true }
  })
  ipcMain.handle('localAi:setOpenAIModels', (_e, models: { fast?: string; standard?: string; best?: string }) => {
    if (!models || typeof models !== 'object') return { ok: false, error: 'Bad models.' }
    setOpenAIModels(models)
    broadcast('localAi:changed', null)
    return { ok: true }
  })
  // The chat models on the person's OpenAI account, for the model pickers. A
  // listing sends no content, so it is allowed while AI runs on this device.
  ipcMain.handle('localAi:listOpenAIModels', async () => {
    const key = resolveOpenAIKey()
    if (!key) return { ok: false, error: 'No OpenAI key saved.', models: [] as string[] }
    try {
      const res = await withCloudGrant({ reason: 'key-test' }, () =>
        fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } })
      )
      if (!res.ok) return { ok: false, error: `OpenAI answered ${res.status}.`, models: [] as string[] }
      const body = (await res.json()) as { data?: Array<{ id: string }> }
      const models = (body.data ?? [])
        .map((m) => m.id)
        .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
        .sort()
      return { ok: true, models }
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200), models: [] as string[] }
    }
  })
  ipcMain.handle('localAi:setPolicy', (_e, policy: string | null) => {
    if (policy !== null && policy !== 'measured' && policy !== 'local-first') return { ok: false, error: 'Unknown policy.' }
    setLocalAiPolicy(policy)
    broadcast('localAi:changed', null)
    return { ok: true }
  })
  ipcMain.handle('localAi:consentReply', (_e, id: string, allow: boolean) => {
    consentWaiters.get(String(id))?.(allow === true)
    return { ok: true }
  })
  // "Try it": one short real completion, so the user sees the model work (and
  // how fast) before relying on it. Runs only on the device.
  ipcMain.handle('localAi:tryIt', async () => {
    if (!activeTier()) return { ok: false, error: noLocalModelError(ramGB(), LOCAL_MODEL_TIERS).message }
    if (!host || !tierInstalled(activeTier())) return { ok: false, error: 'The on-device model is not downloaded yet.' }
    const t0 = Date.now()
    try {
      const r = await host.generate({
        system: 'You are a concise assistant.',
        messages: [{ role: 'user', content: 'In one sentence, what can you help me with in a work app?' }],
        maxTokens: 60
      })
      return { ok: true, text: r.text.trim(), ms: Date.now() - t0, outputTokens: r.outputTokens, ttftMs: r.ttftMs }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
