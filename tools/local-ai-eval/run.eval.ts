// @vitest-environment node
//
// Local-AI eval runner. Runs every task in tasks.ts through the REAL product
// functions against one target, then (optionally) has a cloud judge score the
// outputs that passed their deterministic checks.
//
//   EVAL_TARGET=local EVAL_MODEL=/path/model.gguf EVAL_LABEL=qwen3.5-4b \
//     npx vitest run --config tools/local-ai-eval/vitest.eval.config.ts
//   EVAL_TARGET=cloud EVAL_LABEL=cloud-claude \
//     npx vitest run --config tools/local-ai-eval/vitest.eval.config.ts
//
// Optional: EVAL_CTX (context tokens, default 32768), EVAL_ONLY (comma list of
// families or task ids), EVAL_JUDGE=0 (skip judging), EVAL_JUDGE_ONLY=1 (re-judge
// an existing run file without regenerating).
//
// ANTHROPIC_API_KEY is read from the environment, or from the repo's .env when
// absent, for the cloud target and the judge. It is never printed.
//
// Output: tools/local-ai-eval/results/run-<label>.json — every task's output,
// check results, judge verdict, latency, and (local) every non-localhost
// network request observed while generating, which must be none.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, totalmem, cpus } from 'node:os'
import http from 'node:http'
import https from 'node:https'

const ROOT = resolve(__dirname, '..', '..')
const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-eval-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => USERDATA,
    getName: () => 'plexii',
    getVersion: () => '0.0.0-eval',
    isPackaged: false,
    on: () => undefined
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openExternal: async () => undefined },
  net: {},
  default: {}
}))

let db: import('../../src/web/worker/sqlite').SqliteDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'eval@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

import { buildTasks, type EvalTask, type Check } from './tasks'
import { seedWorkspace } from './fixtures'
import { judge, judgeAvailable, JUDGE_MODEL, JUDGE_PASS, type Verdict } from './judge'

const TARGET = process.env.EVAL_TARGET === 'cloud' ? 'cloud' : 'local'
const LABEL = process.env.EVAL_LABEL || (TARGET === 'cloud' ? 'cloud' : 'local')
const MODEL = process.env.EVAL_MODEL || ''
const CTX = Number(process.env.EVAL_CTX || 32768)
// KV-cache precision; the shipped catalog uses q8_0 (EVAL_KV=q8_0).
const KV = process.env.EVAL_KV === 'q8_0' ? 'q8_0' : 'f16'
// A/B switches for the local path's quality work (default: the shipped setting, on).
const SCHEMA = process.env.EVAL_SCHEMA !== '0'
const VARIANTS = process.env.EVAL_VARIANTS !== '0'
const SMALL_RULE = process.env.EVAL_SMALL_RULE !== '0'
const CHECK = process.env.EVAL_CHECK !== '0'
// Evidence mode: run the invented-specifics check without changing output and
// record every finding (EVAL_CHECK=0 EVAL_CHECK_OBSERVE=1).
const CHECK_OBSERVE = process.env.EVAL_CHECK_OBSERVE === '1'
const ONLY = (process.env.EVAL_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
const JUDGE = process.env.EVAL_JUDGE !== '0'
const JUDGE_ONLY = process.env.EVAL_JUDGE_ONLY === '1'
// Re-run only the EVAL_ONLY tasks and replace their entries in the existing run
// file (used after a transient provider error, e.g. "Connection error.").
const MERGE = process.env.EVAL_MERGE === '1'
// With EVAL_JUDGE_ONLY: discard existing verdicts and judge again.
const REJUDGE = process.env.EVAL_REJUDGE === '1'
const OUT_DIR = join(__dirname, 'results')
const OUT = join(OUT_DIR, `run-${LABEL}.json`)

if (!process.env.ANTHROPIC_API_KEY && existsSync(join(ROOT, '.env'))) {
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)
  if (m) process.env.ANTHROPIC_API_KEY = m[1].trim().replace(/^["']|["']$/g, '')
}
// Never let the eval reach OpenAI (embeddings, transcription): the cloud
// reference is Anthropic, and a local run must show zero egress.
delete process.env.OPENAI_API_KEY

interface TaskResult {
  id: string
  family: string
  branch?: string
  prompt: string
  ok: boolean
  checks: Check[]
  checksPassed: boolean
  verdict: Verdict | null
  passed: boolean
  ms: number
  /** Local runs: tokens the engine was given / produced, and model calls (incl. one JSON retry). */
  engine?: { input: number; output: number; calls: number }
  text: string
  /** Grounding review findings during this task. */
  grounding?: { repaired: number; flagged: number }
  groundingDetail?: unknown[]
  /** The product's structured output (proposals, suggestions, metadata), for re-checking. */
  data?: unknown
  error?: string
}

interface RunFile {
  label: string
  target: 'local' | 'cloud'
  model: string
  contextSize: number | null
  kvCache?: string
  localOptions?: { schemaDecoding: boolean; promptVariants: boolean; smallGroundingRule: boolean; groundingCheck: boolean; groundingObserve?: boolean }
  startedAt: string
  finishedAt: string | null
  machine: { cpu: string; ramGB: number; platform: string }
  judge: { model: string; passScore: number } | null
  egress: string[]
  blocked: string[]
  results: TaskResult[]
}

// Every non-localhost request seen while generating. For a local run this must
// stay empty; the guard additionally refuses AI hosts.
const egress: string[] = []
const blocked: string[] = []
let watching = true
function watchNetwork(): void {
  const note = (raw: string): void => {
    if (!watching) return
    try {
      const u = new URL(raw)
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) egress.push(`${u.hostname}${u.pathname}`)
    } catch {
      /* not a URL */
    }
  }
  const f = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    note(typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? ''))
    return (f as (a: unknown, b?: unknown) => Promise<Response>)(input, init)
  }) as typeof fetch
  for (const [mod, proto] of [
    [http, 'http:'],
    [https, 'https:']
  ] as const) {
    const orig = mod.request
    ;(mod as { request: unknown }).request = (...args: unknown[]) => {
      const a = args[0] as { hostname?: string; host?: string } | string | URL
      note(typeof a === 'string' ? a : a instanceof URL ? a.href : `${proto}//${a?.hostname ?? a?.host ?? 'localhost'}/`)
      return (orig as (...x: unknown[]) => unknown)(...args)
    }
  }
}

let tasks: EvalTask[] = []
const engineTokens = { input: 0, output: 0, calls: 0 }
// Grounding findings per task (local repairs / reports, cloud reports).
let groundingNow = { repaired: 0, flagged: 0 }
// Every finding in full, for review: span, kind, confidence, reason, offset,
// whether it was applied, and the original output and supplied context.
type GroundingDetail = { path: string; applied: boolean; original: string; supplied: string; repaired: unknown[]; flagged: unknown[] }
let groundingDetail: GroundingDetail[] = []
let restoreGuard: (() => void) | null = null
let contextSize: number | null = null

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  await seedWorkspace()
  tasks = buildTasks(() => import('../../src/main/ai/anthropic')).filter(
    (t) =>
      (ONLY.length === 0 || ONLY.includes(t.family) || ONLY.includes(t.id)) &&
      (!t.targets || t.targets.includes(TARGET))
  )

  if (TARGET === 'local' && !JUDGE_ONLY) {
    if (!MODEL || !existsSync(MODEL)) throw new Error(`EVAL_MODEL must point at a GGUF file (got "${MODEL}")`)
    const router = await import('../../src/main/ai/local/providerRouter')
    const { setLocalRouteResolver } = await import('../../src/main/ai/modelRouting')
    const { EngineCore } = await import('../../src/main/ai/local/engineCore')
    const { installEgressGuard } = await import('../../src/main/ai/local/egressGuard')
    const { SIGNAL_BASE } = await import('../../src/main/ai/creditMode')
    const { setLocalClientOptions } = await import('../../src/main/ai/local/localClient')
    setLocalClientOptions({ schemaDecoding: SCHEMA, promptVariants: VARIANTS, smallGroundingRule: SMALL_RULE, groundingCheck: CHECK, groundingObserve: CHECK_OBSERVE })
    const core = new EngineCore()
    const st = await core.load({ modelPath: MODEL, contextSize: CTX, kvCache: KV })
    contextSize = st.contextSize
    // Count what the engine is actually given, per task (prompt size explains latency).
    const counted = {
      generate: async (...a: Parameters<typeof core.generate>) => {
        const r = await core.generate(...a)
        engineTokens.input += r.inputTokens
        engineTokens.output += r.outputTokens
        engineTokens.calls++
        return r
      }
    }
    router.setLocalRuntime({ engine: async () => counted as never, modelLabel: () => LABEL, installed: () => true })
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    setLocalRouteResolver((p) => router.routeForPurpose(p) === 'local')
    // Measure every family locally, whatever the gates of the last run said.
    router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
    restoreGuard = installEgressGuard({
      localOnly: router.localOnlyActive,
      signalBase: SIGNAL_BASE,
      onBlocked: (h) => blocked.push(h)
    })
  }
  {
    const { setGroundingSink } = await import('../../src/main/ai/local/localClient')
    setGroundingSink((r) => {
      groundingNow.repaired += r.repaired.length
      groundingNow.flagged += r.flagged.length
      groundingDetail.push({
        path: r.path,
        applied: r.applied === true,
        original: r.original ?? '',
        supplied: r.supplied ?? '',
        repaired: r.repaired,
        flagged: r.flagged
      })
    })
  }
  watchNetwork()
})

function toJsonSafe(v: unknown): unknown {
  if (v instanceof Map) return { __map: [...v.entries()] }
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}
function fromJsonSafe(v: unknown): unknown {
  if (v && typeof v === 'object' && '__map' in (v as object)) return new Map((v as { __map: [unknown, unknown][] }).__map)
  return v
}

function mergeRuns(previous: RunFile, fresh: RunFile): RunFile {
  const byId = new Map(fresh.results.map((r) => [r.id, r]))
  return {
    ...previous,
    egress: [...previous.egress, ...fresh.egress],
    blocked: [...previous.blocked, ...fresh.blocked],
    // Replace re-run tasks in place; append tasks the previous run did not have.
    results: [
      ...previous.results.map((r) => byId.get(r.id) ?? r),
      ...fresh.results.filter((r) => !previous.results.some((p) => p.id === r.id))
    ],
    finishedAt: fresh.finishedAt ?? previous.finishedAt
  }
}

function save(run: RunFile): void {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT, JSON.stringify(run, null, 2) + '\n')
}

describe(`local-ai eval: ${LABEL}`, () => {
  it('runs every task and records the result', async () => {
    let run: RunFile
    if (JUDGE_ONLY) {
      run = JSON.parse(readFileSync(OUT, 'utf8')) as RunFile
      // Re-apply the current checks to the stored outputs (a harness fix must
      // not need a regeneration to take effect, and must not change outputs).
      const byId = new Map(tasks.map((t) => [t.id, t]))
      // Drop results for tasks that do not apply to this target (e.g. local-only
      // enrichment in a cloud run), unless this pass is narrowed by EVAL_ONLY.
      if (ONLY.length === 0) run.results = run.results.filter((r) => byId.has(r.id))
      for (const r of run.results) {
        const t = byId.get(r.id)
        if (!t) continue
        // Build outputs are judged from the full structured result, not the
        // display text (which older runs truncated).
        const d = fromJsonSafe(r.data) as { suggestions?: unknown; intent?: unknown } | undefined
        if (t.family === 'build' && d && Array.isArray(d.suggestions)) r.text = JSON.stringify({ intent: d.intent, suggestions: d.suggestions })
        if (REJUDGE) r.verdict = null
        r.checks = t.checks({ ok: r.ok, text: r.text, data: fromJsonSafe(r.data), error: r.error })
        r.checksPassed = r.checks.every((x) => x.ok)
        r.passed = r.checksPassed && !t.rubric
      }
    } else {
      const previous = MERGE && existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as RunFile) : null
      run = {
        label: LABEL,
        target: TARGET,
        model: TARGET === 'local' ? MODEL.split('/').pop()! : 'resolveModel(purpose): claude-sonnet-5-5 / claude-haiku-5-5',
        contextSize,
        kvCache: TARGET === 'local' ? KV : undefined,
        localOptions: TARGET === 'local' ? { schemaDecoding: SCHEMA, promptVariants: VARIANTS, smallGroundingRule: SMALL_RULE, groundingCheck: CHECK, groundingObserve: CHECK_OBSERVE } : undefined,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        machine: { cpu: cpus()[0]?.model ?? '', ramGB: Math.round(totalmem() / 2 ** 30), platform: `${process.platform}-${process.arch}` },
        judge: null,
        egress,
        blocked,
        results: []
      }
      for (const t of tasks) {
        const t0 = Date.now()
        const before = { ...engineTokens }
        groundingNow = { repaired: 0, flagged: 0 }
        groundingDetail = []
        let out
        try {
          out = await t.run()
        } catch (e) {
          out = { ok: false, text: '', error: (e as Error).message }
        }
        const ms = Date.now() - t0
        let checks: Check[]
        try {
          checks = t.checks(out)
        } catch (e) {
          checks = [{ name: 'checks ran', ok: false, detail: (e as Error).message }]
        }
        const checksPassed = checks.every((x) => x.ok)
        run.results.push({
          id: t.id,
          family: t.family,
          branch: t.branch,
          prompt: t.prompt,
          ok: out.ok,
          checks,
          checksPassed,
          verdict: null,
          passed: checksPassed && !t.rubric,
          ms,
          ...(TARGET === 'local'
            ? { engine: { input: engineTokens.input - before.input, output: engineTokens.output - before.output, calls: engineTokens.calls - before.calls } }
            : {}),
          text: out.text.slice(0, 60000),
          grounding: { ...groundingNow },
          ...(groundingDetail.length ? { groundingDetail } : {}),
          data: toJsonSafe(out.data),
          error: out.error
        })
        // eslint-disable-next-line no-console
        console.log(`[eval ${LABEL}] ${t.id} ${checksPassed ? 'checks-pass' : 'checks-FAIL'} ${ms}ms ${checks.filter((x) => !x.ok).map((x) => x.name).join('; ')}`)
        // In merge mode every save is the merged view, so an interrupted re-run
        // never leaves the file holding only the re-run tasks.
        save(previous ? mergeRuns(previous, run) : run)
      }
      run.finishedAt = new Date().toISOString()
      if (previous) run = mergeRuns(previous, run)
      save(run)
    }

    // Generation is over: from here on the only traffic is the judge's.
    watching = false
    // Judge phase. The guard comes off first: the judge is the evaluator's own
    // cloud call, made after every local generation has finished.
    restoreGuard?.()
    if (JUDGE && judgeAvailable()) {
      run.judge = { model: JUDGE_MODEL, passScore: JUDGE_PASS }
      const byId = new Map(tasks.map((t) => [t.id, t]))
      for (const r of run.results) {
        const t = byId.get(r.id)
        if (!t?.rubric) continue
        if ((MERGE || (JUDGE_ONLY && !REJUDGE)) && r.verdict) continue
        if (!r.checksPassed) {
          r.verdict = null
          r.passed = false
          continue
        }
        try {
          r.verdict = await judge({ task: t.prompt, rubric: t.rubric, context: t.judgeContext, output: r.text })
        } catch (e) {
          r.verdict = { score: 0, reason: `judge call failed: ${(e as Error).message}` }
        }
        r.passed = r.checksPassed && r.verdict.score >= JUDGE_PASS
        save(run)
      }
    }
    save(run)
    if (TARGET === 'local' && !JUDGE_ONLY) expect(run.egress).toEqual([])
  })
})
