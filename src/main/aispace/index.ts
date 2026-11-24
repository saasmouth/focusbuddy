// The app's AI Space service: created on first use, so a person who never
// opens AI Space never creates its tables, vault file or timers.

import { BrowserWindow } from 'electron'
import { getDb } from '../db/database'
import { withCloudGrant } from '../ai/local/providerRouter'
import type { SqlDb } from '../db/eventStore'
import { createAiSpaceService, type AiSpaceService } from './service'
import { createToolGateway, type ToolGateway } from './tools'
import { getElectronVault } from './vault'
import { createMcpHost, type McpHost } from './mcpHost'

export interface AiSpace {
  svc: AiSpaceService
  tools: ToolGateway
  mcp: McpHost
}

let instance: Promise<AiSpace> | null = null

function broadcast(payload: { topic: string; projectId?: string | null; runId?: string | null }): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('aispace:changed', payload)
      } catch {
        /* a window closing mid-broadcast */
      }
    }
  } catch {
    /* no Electron (tests) */
  }
}

// Coalesce bursts (a streaming run writes many steps) into one push per tick.
let pendingPush: Map<string, { topic: string; projectId?: string | null; runId?: string | null }> | null = null
function emit(payload: { topic: string; projectId?: string | null; runId?: string | null }): void {
  if (!pendingPush) {
    pendingPush = new Map()
    setTimeout(() => {
      const batch = pendingPush
      pendingPush = null
      for (const p of batch?.values() ?? []) broadcast(p)
    }, 120)
  }
  pendingPush.set(`${payload.topic}:${payload.projectId ?? ''}:${payload.runId ?? ''}`, payload)
}

export function getAiSpace(): Promise<AiSpace> {
  if (!instance) {
    instance = (async () => {
      const vault = await getElectronVault()
      const grant = <T>(fn: () => Promise<T>) => withCloudGrant({ reason: 'connection-run' }, fn)
      const testBase = (id: string) => process.env[`AISPACE_${id.toUpperCase()}_BASE`]
      const svc = createAiSpaceService({ db: getDb() as unknown as SqlDb, vault, grant, emit, baseUrlFor: testBase })
      const mcp = createMcpHost({ store: svc.store, conns: svc.conns, vault, emit, card: (id) => svc.connectionCard(svc.conns.getConnection(id)!) })
      const tools = createToolGateway({ store: svc.store, conns: svc.conns, broker: svc.broker, mcp: () => mcp.caller })
      return { svc, tools, mcp }
    })()
  }
  return instance
}

// After launch: pick up background runs and mark interrupted work honestly.
// Only touches the service if AI Space tables already exist.
export async function recoverAiSpaceOnLaunch(): Promise<void> {
  try {
    const db = getDb() as unknown as SqlDb
    const has = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'ais_runs'`).get()
    if (!has) return
    const a = await getAiSpace()
    a.svc.recover()
    a.tools.recoverOnStartup()
  } catch {
    /* recovery is best-effort; the records are intact either way */
  }
}

export function disposeAiSpace(): void {
  void instance?.then((a) => a.svc.dispose())
}
