// Local AI, wired into the running app. Called once from main start-up
// (initLocalAi) — it does NO model work there: it registers policy, installs
// the egress guard and points the engine host at the installed model. The
// model itself loads on the first on-device request, in a utility process.

import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import { statfs } from 'node:fs/promises'
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
  resolveAnthropicKey,
  resolveOpenAIKey
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
  withCloudGrant,
  effectiveGate,
  currentLocalPolicy,
  localOnlyActive,
  providerChoice,
  LocalModelMissingError
} from './providerRouter'
import { setModelTagger, resolveCloudModel } from '../modelRouting'
import { createOpenAIClient, DEFAULT_OPENAI_MODELS } from './openaiClient'
import { getModelClient } from '../modelClient'
import { installEgressGuard } from './egressGuard'
import { EngineHost, type WorkerHandle } from './engineHost'
import { downloadModel, removeModel, fetchWithFile, type DownloadProgress } from './downloadManager'
import { locateModel, verifyLocated, canonicalPath, type ModelSpec, type Located } from './modelLocator'
import { resolveDownloads } from './modelManifest'
import { setGroundingSink } from './localClient'
import { setBundledEmbedder } from '../localModel'
import { SIGNAL_BASE, getCreditClient, isCreditClient, creditRefusalNote } from '../creditMode'
import {
  AI_FEATURES,
  AI_FEATURE_ROUTES,
  DEFAULT_LOCAL_POLICY,
  recommendTier,
  modelDownloadUrl,
  modelManifestUrl,
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

/** The tier in use: the user's pick if it is offered here, else the recommendation. */
export function activeTier(): LocalModelTier | null {
  const picked = tierById(getLocalModelTier())
  if (picked && picked.minRamGB <= ramGB()) return picked
  return recommendTier(LOCAL_MODEL_TIERS, ramGB())
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

const verifiedCacheFile = (): string => join(modelsDir(), 'bundle-verified.json')

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
    policy: () => getLocalAiPolicy() ?? DEFAULT_LOCAL_POLICY
  })
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

  setLocalRuntime({
    installed: () => tierInstalled(activeTier()),
    modelLabel: () => activeTier()?.name.toLowerCase().replace(/\s+/g, '-') ?? 'none',
    engine: async () => {
      const t = activeTier()
      if (!t || !host) throw new LocalModelMissingError()
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
    const specs = await resolveDownloads(
      wanted.map((m) => ({ manifestUrl: modelManifestUrl(m, base), url: modelDownloadUrl(m, base), file: m.file, sizeBytes: m.sizeBytes, sha256: m.sha256 })),
      doFetch,
      ctrl.signal
    )
    if (!specs.ok) {
      emit({ file: tier.file, state: 'error', receivedBytes: 0, totalBytes: tier.sizeBytes, error: specs.error })
      return { ok: false, error: specs.error }
    }
    for (const spec of specs.files) {
      const r = await downloadModel(spec, { dir: modelsDir(), fetch: doFetch, freeBytes: async () => freeDisk(), onProgress: emit }, ctrl.signal)
      if (!r.ok) return { ok: false, error: r.error }
    }
    refreshEngineModel()
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
  // The one-time "local AI is now built in" notice (settingsStore.migrateAiMode).
  ipcMain.handle('localAi:getIntro', () => getLocalAiIntro())
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
