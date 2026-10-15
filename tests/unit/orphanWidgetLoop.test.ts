// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
const sync = read('src/renderer/src/lib/crdtSync.ts')
const flow = read('src/renderer/src/lib/deleteDeskFlow.ts')
const trash = read('src/renderer/src/components/views/TrashView.tsx')
const nodesDb = read('src/main/db/nodes.ts')
const preload = read('src/preload/index.ts')

// DEC-142 — the orphan-widget retry loop.
//
// Measured on the operator's machine, 2026-09-08: 888 failed `widgets:create`
// calls a MINUTE while the app sat idle, every one a FOREIGN KEY failure,
// filling 33,823 of the dev log's 34,622 lines (the previous log: 205,877
// lines, 12 MB, same cause). One desk — "SMOKE Trash Test", created and
// permanently deleted on 2026-08-26 — was behind all of it: five widget
// snapshots for it still live on the workspace, name a node no device has,
// and can never be created.
//
// Two halves, both pinned here: the client stops retrying what cannot work,
// and a permanent delete stops producing such snapshots in the first place.

describe('dec_142 — the client parks a create whose parent will never arrive', () => {
  it('the retry budget is named, and exhausting it PARKS the create instead of forgetting it', () => {
    expect(sync).toContain('const CREATE_RETRY_BUDGET = 40')
    expect(sync).toContain('else if (++p.tries >= CREATE_RETRY_BUDGET) {')
    expect(sync).toContain('parkCreate(key, p.dependsOn)')
    // The old line forgot it, so the 20s poll re-armed the same doomed retries.
    expect(sync).not.toContain('else if (++p.tries >= 40) pendingCreates.delete(key)')
  })

  it('a parked create is skipped by later poll passes', () => {
    expect(sync).toContain('if (parkedOn.has(key)) return Promise.resolve()')
  })

  it('parking is against the SPECIFIC id waited for, and released only when THAT id is created', () => {
    // Releasing on any node create looks equivalent and is not: `nodes.create`
    // is create-if-missing, so every already-present node "succeeds" on every
    // poll pass, a blanket release fires constantly and parks nothing. Measured
    // that way the loop got WORSE — 1,776 failures a minute against 888.
    expect(sync).toContain('const parkedOn = new Map<string, string>()')
    expect(sync).toContain('const parkedBy = new Map<string, Set<string>>()')
    expect(sync).toContain('function unparkFor(id: string): void {')
    expect(sync).toContain('const waiting = parkedBy.get(id)')
    expect(sync).not.toContain('parkedCreates.clear()')
    const nodeCreate = sync.slice(sync.indexOf('async function tryCreateNode'))
    expect(nodeCreate.slice(0, 900)).toContain('unparkFor(node.id)')
  })

  it('a widget parks on its task — the id its FOREIGN KEY names', () => {
    expect(sync).toContain("const taskId = typeof snapshot.taskId === 'string' ? snapshot.taskId : null")
    expect(sync).toContain('applyCreateGuarded(`widget:${id}`, () => tryCreateWidget(snapshot), taskId)')
  })

  it('a create whose dependency is unknown keeps the old behaviour exactly', () => {
    expect(sync).toContain('dependsOn: string | null = null')
    expect(sync).toContain('function parkCreate(key: string, dependsOn: string | null): void {\n  if (!dependsOn) return')
  })

  it('the buffer itself is unchanged: a create is still never dropped on its first failure', () => {
    expect(sync).toContain('pendingCreates.set(key, { attempt, tries: 0, dependsOn })')
    expect(sync).toContain('}, 1500)')
  })
})

describe('dec_142 — a permanent delete tombstones what it erased', () => {
  it('the purge returns the erased ids instead of discarding them', () => {
    expect(nodesDb).toContain('nodeIds: string[]')
    expect(nodesDb).toContain('widgetIds: string[]')
    expect(nodesDb).toContain('nodeIds: purge.nodeIds,\n      widgetIds: purge.widgetIds')
    // The old shape returned counts only.
    expect(nodesDb).not.toContain('return { purgedNodes: purge.purgedNodes, revived: purge.revived, memory }')
  })

  it('the preload contract carries them to the renderer', () => {
    const block = preload.slice(preload.indexOf('deletePermanent:'), preload.indexOf('restore:'))
    expect(block).toContain('nodeIds: string[]')
    expect(block).toContain('widgetIds: string[]')
  })

  it('tombstonePurged emits children first, then their parents', () => {
    expect(flow).toContain("import { crdtEmitNodeDelete, crdtEmitWidgetDelete } from './crdtBridge'")
    expect(flow).toContain('export function tombstonePurged(purged: { nodeIds: string[]; widgetIds: string[] }): void {')
    const body = flow.slice(flow.indexOf('export function tombstonePurged'))
    const widgets = body.indexOf('crdtEmitWidgetDelete(widgetId)')
    const nodes = body.indexOf('crdtEmitNodeDelete(purged.nodeIds)')
    expect(widgets).toBeGreaterThan(-1)
    expect(nodes).toBeGreaterThan(widgets)
  })

  it('BOTH permanent-delete doors call it — the per-item flow and the Trash bulk arm', () => {
    expect(flow).toContain('const result = await window.api.nodes.deletePermanent(entry.id)\n  tombstonePurged(result)')
    expect(trash).toContain("import { confirmPermanentDelete, tombstonePurged } from '../../lib/deleteDeskFlow'")
    expect(trash).toContain('const r = await window.api.nodes.deletePermanent(id)\n          tombstonePurged(r)')
  })
})
