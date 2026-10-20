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
  setLocalModelTier
} from '../../settingsStore'
import {
  setRouterSettings,
  setLocalRuntime,
  setConsentAsker,
  setNoticeSink,
  setCloudModelResolver,
  routeForPurpose,
  cloudRoutedFromLocal,
  localOnlyActive,
  providerChoice,
  LocalModelMissingError
} from './providerRouter'
import { setLocalRouteResolver, resolveCloudModel } from '../modelRouting'
import { installEgressGuard } from './egressGuard'
import { EngineHost, type WorkerHandle } from './engineHost'
import { downloadModel, isInstalled, removeModel, finalPath, type DownloadProgress } from './downloadManager'
import { setBundledEmbedder } from '../localModel'
import { SIGNAL_BASE } from '../creditMode'
import {
  AI_FEATURES,
  recommendTier,
  modelDownloadUrl,
  type AiFeature,
  type CloudConsentRequest,
  type LocalAiStatus,
  type LocalModelTier,
  type LocalDownloadProgress
} from '@shared/localAi'
import { LOCAL_MODEL_TIERS, LOCAL_EMBED_MODEL, tierById } from '@shared/localModelCatalog'
import { localGateFor } from '@shared/localAiGates'
import type { AIPurpose } from '@shared/types'

const IDLE_MS = 10 * 60 * 1000

let host: EngineHost | null = null
let download: { ctrl: AbortController; progress: LocalDownloadProgress } | null = null

export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
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

function tierInstalled(t: LocalModelTier | null): boolean {
  return !!t && isInstalled(modelsDir(), t)
}

function embedInstalled(): boolean {
  return isInstalled(modelsDir(), LOCAL_EMBED_MODEL)
}

/** Re-point the engine host after a download, delete or tier change. */
export function refreshEngineModel(): void {
  const t = activeTier()
  if (host) host.setModel(tierInstalled(t) ? finalPath(modelsDir(), t!.file) : null, t?.contextSize ?? 8192, 'auto', t?.kvCache)
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
  setRouterSettings({ aiMode: getAiMode, featureRoutes: getAiFeatureRoutes })
  setLocalRouteResolver((p) => routeForPurpose(p) === 'local', cloudRoutedFromLocal)
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
      if (!tierInstalled(activeTier()) || !host) throw new LocalModelMissingError()
      return host
    }
  })
  setBundledEmbedder({
    installed: embedInstalled,
    label: () => LOCAL_EMBED_MODEL.label,
    embed: (texts, kind) => {
      if (!host || !embedInstalled()) return Promise.reject(new Error('No local embedding model is installed.'))
      return host.embed(finalPath(modelsDir(), LOCAL_EMBED_MODEL.file), texts, kind ?? 'document')
    }
  })
  setConsentAsker(askRendererForConsent)
  setNoticeSink((feature, message) => broadcast('localAi:notice', { feature, message }))

  app.on('before-quit', () => {
    void host?.stop()
  })
}

// ── Status ──────────────────────────────────────────────────────────────────

async function freeDisk(): Promise<number | null> {
  try {
    const dir = app.getPath('userData')
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
    const g = localGateFor(featureRepresentativePurpose(f))
    gates[f] = { gate: g.gate, localPassRate: g.localPassRate, cloudPassRate: g.cloudPassRate }
  }
  return {
    provider: providerChoice(),
    featureRoutes: getAiFeatureRoutes() as LocalAiStatus['featureRoutes'],
    ramGB: ram,
    freeDiskBytes: await freeDisk(),
    recommendedTier: rec?.id ?? null,
    tiers: LOCAL_MODEL_TIERS.map((t) => ({ ...t, installed: tierInstalled(t), offered: ram >= t.minRamGB })),
    activeTier: active?.id ?? null,
    engine: {
      state: host?.state ?? 'idle',
      error: host?.lastError ?? null,
      gpu: host?.gpu ?? null
    },
    download: download?.progress ?? null,
    gates,
    embeddings: { installed: embedInstalled(), name: LOCAL_EMBED_MODEL.name },
    hardware: process.platform === 'darwin' ? (process.arch === 'arm64' ? 'metal' : 'cpu') : 'auto'
  }
}

// The purpose whose gate stands for a whole feature in the status view.
function featureRepresentativePurpose(f: AiFeature): string {
  const map: Record<AiFeature, string> = {
    assistant: 'chat',
    build: 'setup',
    writing: 'doc_rewrite',
    summaries: 'trail_summary',
    background: 'title_backfill',
    agents: 'agent_step'
  }
  return map[f]
}

// ── Download / delete ───────────────────────────────────────────────────────

async function runDownload(tier: LocalModelTier): Promise<{ ok: boolean; error?: string }> {
  if (download) return { ok: false, error: 'A download is already running.' }
  const ctrl = new AbortController()
  const files = [
    { url: modelDownloadUrl(tier), file: tier.file, sizeBytes: tier.sizeBytes, sha256: tier.sha256 },
    ...(embedInstalled()
      ? []
      : [
          {
            url: modelDownloadUrl(LOCAL_EMBED_MODEL),
            file: LOCAL_EMBED_MODEL.file,
            sizeBytes: LOCAL_EMBED_MODEL.sizeBytes,
            sha256: LOCAL_EMBED_MODEL.sha256
          }
        ])
  ]
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
    for (const spec of files) {
      const r = await downloadModel(spec, { dir: modelsDir(), fetch: (i, n) => globalThis.fetch(i, n), freeBytes: async () => freeDisk(), onProgress: emit }, ctrl.signal)
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
  ipcMain.handle('localAi:setFeatureRoute', (_e, feature: string, route: 'local' | 'cloud' | null) => {
    if (!(AI_FEATURES as readonly string[]).includes(feature)) return { ok: false, error: 'Unknown feature.' }
    if (route !== null && route !== 'local' && route !== 'cloud') return { ok: false, error: 'Unknown route.' }
    setAiFeatureRoute(feature, route)
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
