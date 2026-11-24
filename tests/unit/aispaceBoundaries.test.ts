// @vitest-environment node
// AI Space privacy boundaries (asked for by the coordinator, 2026-11-24):
//  1. A share window can't reach ANY aispace channel, not even to read, and
//     the browser runtime serves none of them.
//  2. A stored key never reaches the renderer: no IPC handler reads the vault,
//     and nothing the service returns (or the database stores) contains it,
//     including after a failed call whose provider echoes the key.

import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decideCall, PRIVATE_NAMESPACES } from '../../src/web/api/readOnly'
import { memSqlDb } from './_memdb'
import { createAiSpaceService } from '../../src/main/aispace/service'
import { createVault } from '../../src/main/aispace/vault'
import { startFakeAnthropic, type FakeAnthropic } from './helpers/aispaceFakeModelApis'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

function aispaceChannels(): string[] {
  const src = read('src/main/aispace/ipc.ts')
  return [...src.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1])
}

describe('share window: AI Space is private', () => {
  it('finds the channels, so a parse failure cannot pass as safety', () => {
    expect(aispaceChannels().length).toBeGreaterThan(60)
    expect(aispaceChannels().every((c) => c.startsWith('aispace:'))).toBe(true)
  })

  it('refuses every aispace channel, reads included, whether or not the visitor acted', () => {
    expect(PRIVATE_NAMESPACES.has('aispace')).toBe(true)
    for (const ch of aispaceChannels()) {
      for (const userActed of [false, true]) {
        const d = decideCall(ch, [], { userActed, adding: false, ownWidget: () => false, mode: 'use' } as never)
        expect(d.allowed, `${ch} userActed=${userActed}`).toBe(false)
        // Quiet: no "download Plexii" gate for something a visitor never sees.
        expect(d.gate).toBeUndefined()
      }
    }
  })

  it('serves no aispace channel in the browser runtime', () => {
    const handlers = read('src/web/worker/handlers.ts')
    expect(handlers).not.toMatch(/'aispace:/)
  })
})

describe('secrets never reach a renderer', () => {
  it('no IPC handler reads the vault or holds a secret callback', () => {
    const ipc = read('src/main/aispace/ipc.ts')
    expect(ipc).not.toMatch(/vault\.get|withSecret|getSecret|\.get\(vaultRef/)
    // The preload offers no way to ask for a key back.
    const preload = read('src/preload/index.ts')
    const block = preload.slice(preload.indexOf('  aiSpace: {'), preload.indexOf('  webMenu: {'))
    expect(block.length).toBeGreaterThan(1000)
    expect(block).not.toMatch(/reveal|getSecret|readKey|showKey|exportKey/i)
  })

  let fake: FakeAnthropic | null = null
  afterEach(async () => {
    await fake?.close()
    fake = null
    delete process.env.AISPACE_ALLOW_LOOPBACK
  })

  it('keeps the key out of every service result and every database row, even when a provider echoes it', async () => {
    const KEY = 'sk-ant-test-SECRETVALUE-abcdefghijk'
    fake = await startFakeAnthropic({ key: KEY, org: 'org_saasmouth' })
    process.env.AISPACE_ALLOW_LOOPBACK = '1'
    const db = memSqlDb()
    const vaultPath = join(mkdtempSync(join(tmpdir(), 'aisb-')), 'v.json')
    const vault = createVault(vaultPath, { available: () => true, encrypt: (s) => Buffer.from(s.split('').reverse().join('')), decrypt: (b) => b.toString().split('').reverse().join('') })
    const svc = createAiSpaceService({ db, vault, grant: (fn) => fn(), baseUrlFor: () => fake!.url })
    const ws = svc.getContext().workspaces[0]
    const added = await svc.addModelApi({ providerId: 'anthropic', workspaceId: ws.id, alias: 'SaaSMouth Claude', secret: KEY })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const p = svc.createProject({ title: 'Launch', brief: 'Brief text' })
    svc.setProjectDefault(p.id, added.connection.id, 'claude-sonnet-5-5')
    const brief = svc.store.getOutput(p.briefOutputId!)!
    const ok = svc.startRun({ projectId: p.id, connectionId: added.connection.id, model: 'claude-sonnet-5-5', instruction: 'Write it', inputs: [{ type: 'version', id: brief.latestVersionId!, versionId: brief.latestVersionId! }], newOutput: { kind: 'document', title: 'Hero' } })
    expect(ok.ok).toBe(true)
    // A failing call whose body repeats the key.
    for (let i = 0; i < 50 && !['succeeded', 'failed'].includes(svc.listRuns({ projectId: p.id })[0]?.status); i++) await new Promise((r) => setTimeout(r, 20))
    expect(svc.listRuns({ projectId: p.id })[0].status).toBe('succeeded')
    fake.state.mode = 'unauthorized' // the 401 body echoes the key
    const tested = await svc.testConnection(added.connection.id)
    expect(tested.connection.status).toBe('reconnect_required')

    const everything = JSON.stringify([
      added,
      tested,
      svc.home(),
      svc.listConnections({ includeDisconnected: true }),
      svc.connectionDetail(added.connection.id),
      svc.accessImpact(added.connection.id),
      svc.projectView(p.id),
      svc.impact(p.id),
      svc.listRuns(),
      ...svc.listRuns().map((r) => svc.runDetail(r.id)),
      svc.search('Launch'),
      svc.catalogue()
    ])
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain('SECRETVALUE')
    expect(everything).toContain('…hijk') // the hint is the only trace

    // No table holds it either.
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ais_%'`).all() as Array<{ name: string }>).map((t) => t.name)
    expect(tables.length).toBeGreaterThan(15)
    for (const t of tables) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())
      expect(rows, t).not.toContain('SECRETVALUE')
    }
    // The vault file never holds it in plain text.
    expect(readdirSync(join(vaultPath, '..')).length).toBeGreaterThan(0)
    expect(readFileSync(vaultPath, 'utf8')).not.toContain('SECRETVALUE')
    svc.dispose()
  })
})
