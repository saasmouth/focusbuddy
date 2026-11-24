// @vitest-environment node
//
// Direct app-API integrations (SPEC-CONNECTIONS.md §5): the declarative
// operation framework (src/main/aispace/appapi) and the Notion adapter, run
// over real HTTP through guardedFetch against a local server that speaks the
// documented Notion API (tests/unit/helpers/aispaceFakeNotion.ts).
//
//   input validated before any request; ids normalised and path injection
//   refused; whoami / verify; search; read_page text + pagination + caps;
//   create_draft_page body; safe_read retries honouring Retry-After; writes
//   never retried and 'uncertain' after a post-send timeout; error
//   normalisation; cross-origin redirects refused with the token kept home;
//   tool input never changes the destination; rate limit fail-fast;
//   secrets redacted from every detail.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  apiPath,
  appAdapterFor,
  appOperationDefs,
  assertSupportedSchema,
  canonicalJson,
  createNotionAdapter,
  defineAdapter,
  invokeOperation,
  normaliseNotionId,
  notionAdapter,
  operationSchemaHash,
  parseRetryAfter,
  RateLimiter,
  toOperationDef,
  validateJson,
  verifyConnection,
  InputError,
  type ApiPath,
  type AppAdapter,
  type AppOperation,
  type InvokeOptions,
  type InvokeResult
} from '../../src/main/aispace/appapi'
import { chunkText } from '../../src/main/aispace/appapi/notion'
import { Bystander, FAKE_BOT_ID, FAKE_NOTION_TOKEN, FAKE_WORKSPACE_ID, FakeNotion, IDS, seedFakeNotion } from './helpers/aispaceFakeNotion'

const ODD_TOKEN = 'plexii-odd-shaped-credential-0042'
const UNCERTAIN = 'Notion may or may not have created the page; check before trying again.'

const fake = new FakeNotion()
const bystander = new Bystander()
let adapter: AppAdapter
let limiter: RateLimiter
let sleeps: number[] = []
const allResults: InvokeResult[] = []

async function run(operationId: string, input: unknown, extra: Partial<InvokeOptions> = {}): Promise<InvokeResult> {
  const r = await invokeOperation({
    adapter,
    operationId,
    connectionId: 'conn-notion-1',
    input,
    secret: FAKE_NOTION_TOKEN,
    allowLoopback: true,
    limiter,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0,
    ...extra
  })
  allResults.push(r)
  return r
}

beforeAll(async () => {
  await fake.start()
  await bystander.start()
  adapter = createNotionAdapter({ origin: fake.origin })
})

afterAll(async () => {
  await fake.stop()
  await bystander.stop()
})

beforeEach(() => {
  fake.reset()
  seedFakeNotion(fake)
  bystander.requests = []
  limiter = new RateLimiter()
  sleeps = []
})

// ── JSON schema subset ────────────────────────────────────────────────────────

describe('app-API input schemas', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'count'],
    properties: {
      name: { type: 'string', maxLength: 5, minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      kind: { type: 'string', enum: ['a', 'b'] },
      ratio: { type: 'number' },
      flag: { type: 'boolean' },
      tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
      code: { type: 'string', pattern: '^[0-9]+$' },
      maybe: { type: 'string', nullable: true }
    }
  }

  it('accepts valid input', () => {
    expect(validateJson(schema, { name: 'ab', count: 2, kind: 'a', ratio: 0.5, flag: true, tags: ['x'], code: '12', maybe: null })).toEqual({ ok: true, errors: [] })
  })

  it('names the path and the rule for each failure, without echoing the value', () => {
    const r = validateJson(schema, { name: 'secret-value-123', count: 1.5, kind: 'c', ratio: 'x', flag: 1, tags: ['x', 'y', 'z'], code: '12a', extra: 1 })
    expect(r.ok).toBe(false)
    const lines = r.errors.map((e) => `${e.path}: ${e.message}`)
    expect(lines).toEqual(
      expect.arrayContaining([
        'input: unknown property “extra” (allowed: name, count, kind, ratio, flag, tags, code, maybe).',
        'input.name: must be at most 5 characters (got 16).',
        'input.count: expected a whole number, got number.',
        'input.kind: must be one of “a”, “b”.',
        'input.ratio: expected a number, got string.',
        'input.flag: expected a boolean, got integer.',
        'input.tags: must have at most 2 items (got 3).',
        'input.code: is not in the expected format.'
      ])
    )
    expect(JSON.stringify(r.errors)).not.toContain('secret-value-123')
  })

  it('reports missing required properties, wrong top-level types and out-of-range numbers', () => {
    expect(validateJson(schema, { name: 'a' }).errors).toEqual([{ path: 'input', message: 'missing required property “count”.' }])
    expect(validateJson(schema, [1]).errors[0].message).toBe('expected an object, got array.')
    expect(validateJson(schema, null).errors[0].message).toBe('expected an object, got null.')
    expect(validateJson(schema, { name: 'a', count: 9 }).errors[0].message).toBe('must be at most 3 (got 9).')
    expect(validateJson(schema, { name: 'a', count: 0 }).errors[0].message).toBe('must be at least 1 (got 0).')
    expect(validateJson(schema, { name: '', count: 1 }).errors[0].message).toBe('must be at least 1 characters (got 0).')
  })

  it('treats prototype names as ordinary unknown properties', () => {
    const r = validateJson(schema, JSON.parse('{"name":"a","count":1,"constructor":{},"__proto__":{"x":1}}'))
    expect(r.ok).toBe(false)
    expect(r.errors[0].message).toContain('“constructor”, “__proto__”')
  })

  it('refuses to load a schema that uses a rule it would not enforce', () => {
    expect(() => assertSupportedSchema({ type: 'string', format: 'uri' })).toThrow(/keyword “format” is not supported/)
    expect(() => assertSupportedSchema({ type: 'object', oneOf: [] })).toThrow(/“oneOf”/)
    expect(() => assertSupportedSchema({ type: 'object', required: ['x'], properties: {} })).toThrow(/not declared/)
    expect(() => assertSupportedSchema({ properties: {} })).toThrow(/needs a type/)
  })
})

// ── Ids and paths ─────────────────────────────────────────────────────────────

const HEX = '1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d'
const INJECTIONS = [
  '../users/me',
  `${HEX}/../../users/me`,
  `${HEX}?filter=1`,
  `${HEX}#frag`,
  `..%2F..%2Fusers%2Fme`,
  `${HEX}%2F..`,
  `https://www.notion.so/Launch-plan-${HEX}`,
  `//evil.example/${HEX}`,
  `127.0.0.1:9/${HEX}`,
  HEX.slice(1),
  HEX + 'a',
  HEX.replace('a', 'g'),
  `${HEX}\n`,
  ` ${HEX}`,
  '1a2b-3c4d5e6f4a7b8c9d0e1f2a3b4c5d',
  ''
]

describe('Notion ids and request paths', () => {
  it('normalises 32 hex characters, with or without dashes, to a lower-case dashed UUID', () => {
    const want = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
    expect(normaliseNotionId(HEX)).toBe(want)
    expect(normaliseNotionId(HEX.toUpperCase())).toBe(want)
    expect(normaliseNotionId(want)).toBe(want)
    expect(normaliseNotionId(want.toUpperCase())).toBe(want)
  })

  it.each(INJECTIONS)('refuses %j as a Notion id', (raw) => {
    expect(normaliseNotionId(raw)).toBeNull()
  })

  it('builds paths only from plain segments', () => {
    expect(apiPath`/v1/pages/${'1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'}`).toBe('/v1/pages/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')
    for (const bad of ['..', '.', '.hidden', 'a/b', 'a?b', 'a#b', '%2F', 'a b', '', 'http://evil.example', 'a\\b']) {
      expect(() => apiPath`/v1/pages/${bad}`, bad).toThrow(InputError)
    }
    expect(() => apiPath`/v1/pages/${42}`).toThrow(InputError)
  })

  it.each(INJECTIONS)('read_page with pageId %j is refused before any request', async (pageId) => {
    const r = await run('notion.read_page', { pageId })
    expect(r).toMatchObject({ status: 'error', code: 'invalid_input', attempts: 0 })
    expect(fake.requests).toHaveLength(0)
    expect(bystander.requests).toHaveLength(0)
  })

  it('create_draft_page with a link as the parent is refused before any request', async () => {
    const r = await run('notion.create_draft_page', { parentPageId: `${bystander.origin}/v1/pages`, title: 'x' })
    expect(r).toMatchObject({ status: 'error', code: 'invalid_input', attempts: 0 })
    expect(r.detail).toContain('input.parentPageId: is not in the expected format.')
    expect(fake.requests).toHaveLength(0)
  })

  it('splits draft text on code points, so no chunk holds half an emoji', () => {
    expect(chunkText('😀😀😀', 2)).toEqual(['😀😀', '😀'])
    expect(chunkText('', 2)).toEqual([])
  })
})

// ── Definitions ───────────────────────────────────────────────────────────────

describe('operation definitions', () => {
  it('publishes each Notion operation as an approved catalogue OperationDef', () => {
    const defs = appOperationDefs('notion', 'conn-9')
    expect(defs.map((d) => [d.id, d.classification, d.retry])).toEqual([
      ['notion.whoami', 'read', 'safe_read'],
      ['notion.search', 'read', 'safe_read'],
      ['notion.read_page', 'read', 'safe_read'],
      ['notion.create_draft_page', 'write', 'never']
    ])
    for (const d of defs) {
      expect(d).toMatchObject({ connectionId: 'conn-9', adapter: 'notion', destination: 'https://api.notion.com', origin: 'catalogue', reviewState: 'approved', schemaVersion: 1 })
      expect(d.schemaHash).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(new Set(defs.map((d) => d.schemaHash)).size).toBe(4)
    expect(appAdapterFor('notion')).toBe(notionAdapter)
    expect(appAdapterFor('constructor')).toBeUndefined()
  })

  it('hashes sha256 over the canonical JSON of id, schemas, classification and scope', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }, null], e: 'x' })).toBe('{"a":[{"d":2},null],"b":1,"e":"x"}')
    const op = notionAdapter.operations.find((o) => o.id === 'notion.search')!
    const expected = createHash('sha256')
      .update(
        canonicalJson({ classification: op.classification, id: op.id, inputSchema: op.inputSchema, outputSchema: op.outputSchema, scope: op.scope })
      )
      .digest('hex')
    expect(toOperationDef(notionAdapter, op, null).schemaHash).toBe(expected)

    // Same definition, keys in another order: same hash.
    const reordered = { ...op, inputSchema: Object.fromEntries(Object.entries(op.inputSchema).reverse()) }
    expect(Object.keys(reordered.inputSchema)).not.toEqual(Object.keys(op.inputSchema))
    expect(operationSchemaHash(reordered)).toBe(expected)
    // Title, rate limit and timeout are not part of the contract hash...
    expect(operationSchemaHash({ ...op, title: 'Other' } as AppOperation)).toBe(expected)
    // ...a schema rule is.
    const tightened = { ...op, inputSchema: { ...op.inputSchema, properties: { ...op.inputSchema.properties, query: { type: 'string', maxLength: 199 } } } }
    expect(operationSchemaHash(tightened)).not.toBe(expected)
    expect(operationSchemaHash({ ...op, classification: 'write' })).not.toBe(expected)
  })

  const op = (over: Partial<AppOperation>): AppOperation => ({
    id: 'acme.thing',
    title: 'Thing',
    description: '',
    classification: 'read',
    scope: null,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object' },
    rateLimitPerMinute: 10,
    timeoutMs: 1000,
    retry: 'safe_read',
    execute: async () => ({ output: {}, rawIds: {} }),
    ...over
  })
  const acme = (ops: AppOperation[], extra: Partial<AppAdapter> = {}): AppAdapter => ({
    id: 'acme',
    name: 'Acme',
    origin: 'http://127.0.0.1:9',
    operations: ops,
    headers: () => ({}),
    verify: async () => {
      throw new Error('unused')
    },
    ...extra
  })

  it('refuses an adapter that is not honest about its operations', () => {
    expect(() => defineAdapter(acme([op({ classification: 'write', retry: 'safe_read' })]))).toThrow(/a write cannot use the safe_read/)
    expect(() => defineAdapter(acme([op({ classification: 'write', retry: 'idempotent_write' })]))).toThrow(/needs a provider idempotency header/)
    expect(() => defineAdapter(acme([op({ inputSchema: { type: 'object', properties: {} } })]))).toThrow(/additionalProperties: false/)
    expect(() => defineAdapter(acme([op({ inputSchema: { type: 'object', additionalProperties: false, format: 'x' } })]))).toThrow(/not supported/)
    expect(() => defineAdapter(acme([op({ id: 'other.thing' })]))).toThrow(/id must be/)
    expect(() => defineAdapter(acme([op({}), op({})]))).toThrow(/duplicate/)
    expect(() => defineAdapter(acme([op({ rateLimitPerMinute: 0 })]))).toThrow(/rateLimitPerMinute/)
    expect(() => defineAdapter(acme([op({})], { origin: 'http://127.0.0.1:9/api' }))).toThrow(/bare origin/)
    expect(() => defineAdapter(acme([op({ classification: 'write', retry: 'idempotent_write' })], { idempotencyHeader: 'Idempotency-Key' }))).not.toThrow()
  })

  it('takes only api.notion.com or a loopback reference server as the Notion origin', () => {
    expect(notionAdapter.origin).toBe('https://api.notion.com')
    expect(() => createNotionAdapter({ origin: 'https://evil.example' })).toThrow(/only api.notion.com/)
    expect(() => createNotionAdapter({ origin: 'https://api.notion.com.evil.example' })).toThrow(/only api.notion.com/)
    expect(() => createNotionAdapter({ origin: 'http://127.0.0.1:1234/x' })).toThrow(/only api.notion.com/)
    expect(createNotionAdapter({ origin: 'http://127.0.0.1:1234' }).origin).toBe('http://127.0.0.1:1234')
  })

  it('returns unknown_operation for an id the adapter does not have', async () => {
    const r = await run('notion.delete_everything', {})
    expect(r).toMatchObject({ status: 'error', code: 'unknown_operation', attempts: 0 })
    expect(fake.requests).toHaveLength(0)
  })
})

// ── Validation before any request ─────────────────────────────────────────────

describe('input is validated before anything is sent', () => {
  it.each([
    ['notion.search', { query: 'x', pageSize: 50 }, 'input.pageSize: must be at most 20 (got 50).'],
    ['notion.search', { query: 'x', pageSize: 2.5 }, 'input.pageSize: expected a whole number'],
    ['notion.search', {}, 'missing required property “query”'],
    ['notion.search', { query: 'x'.repeat(201) }, 'input.query: must be at most 200 characters'],
    ['notion.search', { query: 'x', url: 'http://evil.example' }, 'unknown property “url”'],
    ['notion.search', { query: 'x', headers: { authorization: 'Bearer evil' } }, 'unknown property “headers”'],
    ['notion.search', { query: 'x', origin: 'http://evil.example', path: '/v1/users' }, 'unknown properties “origin”, “path”'],
    ['notion.search', 'just a string', 'expected an object, got string'],
    ['notion.whoami', { anything: 1 }, 'no properties are allowed'],
    ['notion.read_page', { pageId: 123 }, 'input.pageId: expected a string, got integer'],
    ['notion.create_draft_page', { parentPageId: HEX, title: '' }, 'input.title: must be at least 1 characters'],
    ['notion.create_draft_page', { parentPageId: HEX, title: 'x', text: 'y', archived: true }, 'unknown property “archived”']
  ])('%s %j → invalid_input', async (opId, input, message) => {
    const r = await run(opId, input)
    expect(r).toMatchObject({ status: 'error', code: 'invalid_input', attempts: 0, httpStatus: null })
    expect(r.detail).toContain(message)
    expect(fake.requests).toHaveLength(0)
  })

  it('refuses a draft with more than 100 paragraphs before sending it', async () => {
    const text = Array.from({ length: 101 }, (_, i) => `Paragraph ${i}`).join('\n\n')
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 'Too long', text })
    expect(r).toMatchObject({ status: 'error', code: 'invalid_input', attempts: 0 })
    expect(r.detail).toContain('101 paragraphs')
    expect(fake.requests).toHaveLength(0)
  })

  it('does not spend a rate-limit token on invalid input', async () => {
    // whoami allows 30 a minute; 40 invalid calls at one instant must leave the bucket full.
    for (let i = 0; i < 40; i++) await run('notion.whoami', { bad: true }, { now: () => 0 })
    const r = await run('notion.whoami', {}, { now: () => 0 })
    expect(r.status).toBe('ok')
  })
})

// ── whoami and verify ─────────────────────────────────────────────────────────

describe('notion.whoami and verify', () => {
  it('reads the bot user with the bearer token and Notion-Version on the pinned origin', async () => {
    const r = await run('notion.whoami', {})
    expect(r).toMatchObject({
      status: 'ok',
      code: 'ok',
      attempts: 1,
      httpStatus: 200,
      output: { identity: FAKE_WORKSPACE_ID, workspaceName: 'Plexii Test Workspace', ownerType: 'workspace' },
      rawIds: { bot_user_id: FAKE_BOT_ID, workspace_id: FAKE_WORKSPACE_ID }
    })
    expect(fake.requests).toHaveLength(1)
    const req = fake.requests[0]
    expect([req.method, req.path]).toEqual(['GET', '/v1/users/me'])
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_NOTION_TOKEN}`)
    expect(req.headers['notion-version']).toBe('2022-06-28')
    expect(req.headers.accept).toBe('application/json')
  })

  it('falls back to the bot user id when the reply has no workspace id', async () => {
    fake.workspaceId = null
    const r = await run('notion.whoami', {})
    expect(r.output).toEqual({ identity: FAKE_BOT_ID, workspaceName: 'Plexii Test Workspace', ownerType: 'workspace' })
  })

  it('verify: identity and workspace from whoami, app_read proven by a real search, app_write untested', async () => {
    const v = await verifyConnection({ adapter, connectionId: 'c1', secret: FAKE_NOTION_TOKEN, allowLoopback: true, limiter, now: () => 1234 })
    expect(v).toEqual({
      ok: true,
      code: 'ok',
      identity: FAKE_WORKSPACE_ID,
      providerOrg: 'Plexii Test Workspace',
      detail: 'Connected to Plexii Test Workspace.',
      capabilities: [
        { capability: 'app_read', state: 'passed', checkedAt: 1234, detail: 'Read the list of pages shared with this integration.' },
        { capability: 'app_write', state: 'untested', checkedAt: null, detail: 'Checked on first approved draft' }
      ]
    })
    expect(fake.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual(['GET /v1/users/me', 'POST /v1/search'])
    expect(fake.requests[1].json).toEqual({ filter: { property: 'object', value: 'page' }, page_size: 1 })
  })

  it('verify with a wrong token: reconnect_required, no identity, app_read failed', async () => {
    const v = await verifyConnection({ adapter, connectionId: 'c1', secret: 'ntn_wrongWrongWrong0123456789', allowLoopback: true, limiter, now: () => 1 })
    expect(v.ok).toBe(false)
    expect(v.code).toBe('reconnect_required')
    expect(v.identity).toBeNull()
    expect(v.capabilities[0]).toMatchObject({ capability: 'app_read', state: 'failed' })
    expect(v.capabilities[0].detail).toContain('Notion refused the token')
    expect(v.capabilities[1]).toMatchObject({ capability: 'app_write', state: 'untested' })
    expect(fake.requests).toHaveLength(1)
  })

  it('verify with nothing shared yet: read works, and it says how to share a page', async () => {
    fake.pages.clear()
    const v = await verifyConnection({ adapter, connectionId: 'c1', secret: FAKE_NOTION_TOKEN, allowLoopback: true, limiter, now: () => 1 })
    expect(v.ok).toBe(true)
    expect(v.capabilities[0].state).toBe('passed')
    expect(v.capabilities[0].detail).toContain('no pages are shared with this integration yet')
  })

  it('verify when the integration lacks Read content: identity known, app_read failed', async () => {
    const v1 = await verifyConnection({
      adapter,
      connectionId: 'c1',
      secret: FAKE_NOTION_TOKEN,
      allowLoopback: true,
      limiter,
      now: () => 1,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        // Let whoami through, then make the search look like Notion's 403.
        if (String(url).endsWith('/v1/search')) fake.failNext(403, 'restricted_resource', 'Insufficient permissions for this endpoint.')
        return fetch(url, init)
      }) as typeof fetch
    })
    expect(v1).toMatchObject({ ok: false, code: 'insufficient_scope', identity: FAKE_WORKSPACE_ID, providerOrg: 'Plexii Test Workspace' })
    expect(v1.capabilities[0].state).toBe('failed')
    expect(v1.capabilities[0].detail).toContain('check its capabilities')
  })
})

// ── search, read_page, create_draft_page ──────────────────────────────────────

describe('notion.search', () => {
  it('posts the documented body and returns normalised pages with raw ids kept', async () => {
    const r = await run('notion.search', { query: '  plan ', pageSize: 5 })
    expect(fake.requests[0].json).toEqual({ query: 'plan', filter: { property: 'object', value: 'page' }, page_size: 5 })
    expect(fake.requests[0].headers['content-type']).toBe('application/json')
    expect(r.status).toBe('ok')
    expect(r.output).toEqual({
      results: [{ id: IDS.plan, title: 'Launch plan', url: `https://www.notion.so/Launch-plan-${IDS.plan.replace(/-/g, '')}`, lastEditedTime: '2026-11-22T08:00:00.000Z' }],
      hasMore: false
    })
    expect(r.rawIds).toEqual({ page_ids: [IDS.plan] })
  })

  it('reads the title from whichever property has type title (a database row’s “Name”)', async () => {
    const r = await run('notion.search', { query: 'roadmap' })
    expect((r.output as { results: Array<{ title: string }> }).results.map((p) => p.title)).toEqual(['Q4 roadmap row'])
    expect(fake.requests[0].json).toMatchObject({ page_size: 10 })
  })

  it('reports hasMore and caps the page size', async () => {
    const r = await run('notion.search', { query: '', pageSize: 2 })
    expect(fake.requests[0].json).toEqual({ filter: { property: 'object', value: 'page' }, page_size: 2 })
    expect((r.output as { results: unknown[]; hasMore: boolean }).results).toHaveLength(2)
    expect((r.output as { hasMore: boolean }).hasMore).toBe(true)
  })
})

describe('notion.read_page', () => {
  it('extracts plain text with heading marks, list and to-do markers, and notes what it skipped', async () => {
    const r = await run('notion.read_page', { pageId: IDS.plan.replace(/-/g, '').toUpperCase() })
    expect(r.status).toBe('ok')
    expect(fake.requests.map((q) => q.path)).toEqual([`/v1/pages/${IDS.plan}`, `/v1/blocks/${IDS.plan}/children?page_size=100`])
    expect(r.output).toEqual({
      id: IDS.plan,
      title: 'Launch plan',
      url: `https://www.notion.so/Launch-plan-${IDS.plan.replace(/-/g, '')}`,
      text: [
        '# Goals',
        'Ship the beta.',
        '## Steps',
        '- Write the brief',
        '- Review it',
        '1. Draft',
        '2. Publish',
        '### Checks',
        '[x] Legal review',
        '[ ] Price page',
        '> Ship small, ship often.',
        'Launch is on Friday.',
        'Details'
      ].join('\n'),
      truncated: false,
      notes: [
        '1 block has nested content (toggles, nested lists, columns) that was not read.',
        '2 blocks of other kinds (images, tables, embeds…) were skipped.'
      ]
    })
    expect(r.rawIds).toEqual({ page_id: IDS.plan })
  })

  it('follows next_cursor across pages of 100 blocks', async () => {
    const r = await run('notion.read_page', { pageId: IDS.long })
    const children = fake.requests.filter((q) => q.pathname.endsWith('/children'))
    expect(children.map((q) => [q.query.get('page_size'), q.query.get('start_cursor')])).toEqual([
      ['100', null],
      ['100', fake.pageById(IDS.long)!.blocks[100].id],
      ['100', fake.pageById(IDS.long)!.blocks[200].id]
    ])
    const out = r.output as { text: string; truncated: boolean; notes: string[] }
    expect(out.text.split('\n')).toEqual(Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`))
    expect(out.truncated).toBe(false)
    expect(out.notes).toEqual([])
    expect(r.attempts).toBe(4)
  })

  it('stops after 10 pages of blocks and says the rest was not read', async () => {
    const r = await run('notion.read_page', { pageId: IDS.huge })
    expect(fake.requests.filter((q) => q.pathname.endsWith('/children'))).toHaveLength(10)
    const out = r.output as { text: string; truncated: boolean; notes: string[] }
    expect(out.truncated).toBe(true)
    expect(out.text).toContain('Entry 1000')
    expect(out.text).not.toContain('Entry 1001')
    expect(out.text.endsWith('[Stopped after 1000 blocks; the rest of the page was not read.]')).toBe(true)
    expect(out.notes).toEqual(['Only the first 1000 blocks were read.'])
  })

  it('truncates at 60,000 characters with a note, and stops fetching once past the limit', async () => {
    const r = await run('notion.read_page', { pageId: IDS.big })
    // 100 blocks of 500 characters is 50,100; the second page passes 60,000, so no third request.
    expect(fake.requests.filter((q) => q.pathname.endsWith('/children'))).toHaveLength(2)
    const out = r.output as { text: string; truncated: boolean; notes: string[] }
    const note = '\n\n[Truncated at 60,000 characters.]'
    expect(out.truncated).toBe(true)
    expect(out.text.endsWith(note)).toBe(true)
    expect(out.text.length).toBe(60_000 + note.length)
    expect(out.notes).toEqual(['The text was cut at 60,000 characters.'])
  })

  it('a page that is missing or not shared → not_found, with Notion’s request id kept', async () => {
    const r = await run('notion.read_page', { pageId: IDS.missing })
    expect(r).toMatchObject({ status: 'error', code: 'not_found', httpStatus: 404, attempts: 1 })
    expect(r.detail).toContain('isn’t shared with this integration')
    expect(r.detail).toContain('Notion said: “Could not find page with ID')
    expect(r.providerRequestId).toMatch(/^fake-req-\d+$/)
  })
})

describe('notion.create_draft_page', () => {
  const para = (...chunks: string[]): unknown => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: chunks.map((content) => ({ type: 'text', text: { content } })) } })

  it('posts parent, title and ≤2,000-character paragraph chunks, and returns the new page', async () => {
    const long = 'x'.repeat(4_500)
    const text = `First paragraph.\r\n\r\nSecond line one\nSecond line two\n\n\n${long}\n\n   \n\nLast.`
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts.replace(/-/g, ''), title: 'Weekly update', text })
    expect(fake.requests).toHaveLength(1)
    expect([fake.requests[0].method, fake.requests[0].path]).toEqual(['POST', '/v1/pages'])
    expect(fake.requests[0].json).toEqual({
      parent: { page_id: IDS.drafts },
      properties: { title: { title: [{ type: 'text', text: { content: 'Weekly update' } }] } },
      children: [para('First paragraph.'), para('Second line one\nSecond line two'), para('x'.repeat(2_000), 'x'.repeat(2_000), 'x'.repeat(500)), para('Last.')]
    })
    expect(r).toMatchObject({ status: 'ok', attempts: 1, idempotencyKey: null })
    const out = r.output as { id: string; url: string }
    const created = fake.pageById(out.id)!
    expect(created.title).toBe('Weekly update')
    expect(created.parentId).toBe(IDS.drafts)
    expect(out.url).toContain(out.id.replace(/-/g, ''))
    expect(r.rawIds).toEqual({ page_id: out.id, parent_page_id: IDS.drafts })
  })

  it('omits children for a title-only draft', async () => {
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 'Empty' })
    expect(r.status).toBe('ok')
    expect(fake.requests[0].json).toEqual({ parent: { page_id: IDS.drafts }, properties: { title: { title: [{ type: 'text', text: { content: 'Empty' } }] } } })
  })
})

// ── Retries, timeouts, uncertainty ────────────────────────────────────────────

describe('retry rules', () => {
  it('safe_read: a 429 is retried after exactly the Retry-After wait, then succeeds', async () => {
    fake.rateLimitNext(1, '2')
    const r = await run('notion.search', { query: 'plan' })
    expect(r).toMatchObject({ status: 'ok', attempts: 2 })
    expect(sleeps).toEqual([2_000])
    expect(fake.requests).toHaveLength(2)
  })

  it('safe_read: 503s back off exponentially with jitter, at most 3 attempts', async () => {
    fake.unavailableNext(2)
    const ok = await run('notion.whoami', {}, { random: () => 0 })
    expect(ok).toMatchObject({ status: 'ok', attempts: 3 })
    expect(sleeps).toEqual([250, 500])

    sleeps = []
    fake.unavailableNext(3)
    const bad = await run('notion.whoami', {}, { random: () => 1 })
    expect(bad).toMatchObject({ status: 'error', code: 'unavailable', attempts: 3, httpStatus: 503 })
    expect(sleeps).toEqual([500, 1_000])
    expect(fake.requests).toHaveLength(6)
  })

  it('safe_read: a Retry-After longer than the cap is not slept on; it comes back as rate_limited with the wait', async () => {
    fake.rateLimitNext(1, '120')
    const r = await run('notion.search', { query: 'x' })
    expect(r).toMatchObject({ status: 'error', code: 'rate_limited', attempts: 1, retryAfterMs: 120_000 })
    expect(sleeps).toEqual([])
  })

  it('safe_read: a dropped connection is retried', async () => {
    let calls = 0
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      if (++calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
      return fetch(url, init)
    }) as typeof fetch
    const r = await run('notion.whoami', {}, { fetchImpl: flaky })
    expect(r).toMatchObject({ status: 'ok', attempts: 2 })
    expect(sleeps).toEqual([250])
  })

  it('a read that times out is an error (not uncertain) and is not retried', async () => {
    fake.hang = true
    const r = await run('notion.search', { query: 'x' }, { adapter: createNotionAdapter({ origin: fake.origin, timeoutMs: 250 }) })
    expect(r).toMatchObject({ status: 'error', code: 'timeout', attempts: 1 })
    expect(fake.requests).toHaveLength(1)
  })

  it('write: a 429 is never retried', async () => {
    fake.rateLimitNext(1, '1')
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 'Once' })
    expect(r).toMatchObject({ status: 'error', code: 'rate_limited', attempts: 1, retryAfterMs: 1_000 })
    expect(fake.requests).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it('write: a 503 is never retried and is uncertain', async () => {
    fake.unavailableNext(1)
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 'Once' })
    expect(r).toMatchObject({ status: 'uncertain', code: 'unavailable', attempts: 1, httpStatus: 503 })
    expect(r.detail).toContain(UNCERTAIN)
    expect(fake.requests).toHaveLength(1)
  })

  it('write: a timeout after the request was sent is uncertain, never retried, and says to check first', async () => {
    fake.hang = true
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 'Maybe made' }, { adapter: createNotionAdapter({ origin: fake.origin, timeoutMs: 300 }) })
    expect(r).toMatchObject({ status: 'uncertain', code: 'timeout', attempts: 1, output: null })
    expect(r.detail).toContain(UNCERTAIN)
    expect(fake.requests).toHaveLength(1)
    expect(sleeps).toEqual([])
    // Exactly why it is uncertain: Notion did create it, the answer never came.
    expect([...fake.pages.values()].filter((p) => p.title === 'Maybe made')).toHaveLength(1)
  })

  it('write: a refused connection (nothing sent) is a plain error, not uncertain', async () => {
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 'x' }, { adapter: createNotionAdapter({ origin: `http://127.0.0.1:${port}` }) })
    expect(r).toMatchObject({ status: 'error', code: 'network_error', attempts: 1 })
    expect(r.detail).toContain('ECONNREFUSED')
  })
})

describe('idempotent_write (framework, provider with an idempotency header)', () => {
  const calls: Array<{ url: string; key: string | undefined }> = []
  const stub = (statuses: number[]) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), key: (init?.headers as Record<string, string>)['Idempotency-Key'] })
      const status = statuses.shift() ?? 500
      return new Response(JSON.stringify(status < 300 ? { id: 'ch_1' } : { error: { type: 'api_error', message: 'try later' } }), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  const acme = defineAdapter({
    id: 'acme',
    name: 'Acme Pay',
    origin: 'http://127.0.0.1:9',
    idempotencyHeader: 'Idempotency-Key',
    headers: (s: string) => ({ authorization: `Bearer ${s}` }),
    verify: async () => {
      throw new Error('unused')
    },
    operations: [
      {
        id: 'acme.charge',
        title: 'Charge',
        description: '',
        classification: 'write',
        scope: null,
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        outputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        rateLimitPerMinute: 100,
        timeoutMs: 1000,
        retry: 'idempotent_write',
        execute: async (ctx) => {
          const res = await ctx.request<{ id: string }>({ method: 'POST', path: apiPath`/v1/charges`, body: {} })
          return { output: { id: res.body.id }, rawIds: { charge_id: res.body.id } }
        }
      }
    ]
  })

  beforeEach(() => {
    calls.length = 0
  })

  it('retries with ONE key across attempts and returns it', async () => {
    const r = await run('acme.charge', {}, { adapter: acme, fetchImpl: stub([503, 201]) })
    expect(r).toMatchObject({ status: 'ok', attempts: 2, output: { id: 'ch_1' } })
    expect(calls).toHaveLength(2)
    expect(calls[0].key).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[1].key).toBe(calls[0].key)
    expect(r.idempotencyKey).toBe(calls[0].key)
  })

  it('reuses a caller’s key, and a still-failing write stays uncertain with that key', async () => {
    const r = await run('acme.charge', {}, { adapter: acme, fetchImpl: stub([503, 503, 503]), idempotencyKey: 'run-7-step-3' })
    expect(r).toMatchObject({ status: 'uncertain', code: 'unavailable', attempts: 3, idempotencyKey: 'run-7-step-3' })
    expect(r.detail).toContain('Acme Pay may or may not have completed this')
    expect(calls.map((c) => c.key)).toEqual(['run-7-step-3', 'run-7-step-3', 'run-7-step-3'])
  })
})

// ── Error normalisation ───────────────────────────────────────────────────────

describe('error normalisation', () => {
  it('401 → reconnect_required', async () => {
    const r = await run('notion.whoami', {}, { secret: 'ntn_notTheRightOne0123456789' })
    expect(r).toMatchObject({ status: 'error', code: 'reconnect_required', httpStatus: 401, attempts: 1 })
    expect(r.detail).toContain('Notion refused the token')
  })

  it('403 restricted_resource → insufficient_scope; another 403 → forbidden', async () => {
    fake.failNext(403, 'restricted_resource', 'API token does not have access to this resource.')
    expect((await run('notion.search', { query: 'x' })).code).toBe('insufficient_scope')
    fake.failNext(403, 'something_else', 'No.')
    expect((await run('notion.search', { query: 'x' })).code).toBe('forbidden')
  })

  it('400 → provider_rejected with Notion’s message; 409 → conflict; 500 on a read → unavailable, not retried', async () => {
    fake.failNext(400, 'validation_error', 'body failed validation.')
    const bad = await run('notion.search', { query: 'x' })
    expect(bad).toMatchObject({ status: 'error', code: 'provider_rejected' })
    expect(bad.detail).toContain('Notion said: “body failed validation.”')
    fake.failNext(409, 'conflict_error', 'Conflict occurred while saving.')
    expect((await run('notion.search', { query: 'x' })).code).toBe('conflict')
    fake.failNext(500, 'internal_server_error', 'Unexpected error.')
    expect(await run('notion.search', { query: 'x' })).toMatchObject({ code: 'unavailable', attempts: 1 })
  })

  it('a reply that does not match the declared output is bad_response, never ok', async () => {
    const weird = (async () => new Response(JSON.stringify({ object: 'user', bot: {} }), { status: 200 })) as unknown as typeof fetch
    const r = await run('notion.whoami', {}, { fetchImpl: weird })
    expect(r).toMatchObject({ status: 'error', code: 'bad_response' })
    const notJson = (async () => new Response('<html>hi</html>', { status: 200 })) as unknown as typeof fetch
    expect((await run('notion.whoami', {}, { fetchImpl: notJson })).code).toBe('bad_response')
  })

  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('3', 0)).toBe(3_000)
    expect(parseRetryAfter('0.5', 0)).toBe(500)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000)
    expect(parseRetryAfter('soon', 0)).toBeNull()
    expect(parseRetryAfter(null, 0)).toBeNull()
  })
})

// ── Destination: origin pinning, redirects, tool input ────────────────────────

describe('the credential stays on the approved origin', () => {
  it('a cross-origin redirect is refused for a read, and the token never reaches the other server', async () => {
    fake.redirectTo = `${bystander.origin}/v1/users/me`
    const r = await run('notion.whoami', {})
    expect(r).toMatchObject({ status: 'blocked', code: 'redirect_refused', attempts: 1 })
    expect(r.detail).toContain(`Refused a redirect from ${fake.origin} to ${bystander.origin}`)
    expect(bystander.requests).toHaveLength(0)
  })

  it('a cross-origin redirect after a write is refused and reported as uncertain', async () => {
    fake.redirectTo = `${bystander.origin}/v1/pages`
    const r = await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 'x' })
    expect(r).toMatchObject({ status: 'uncertain', code: 'redirect_refused', attempts: 1 })
    expect(r.detail).toContain(UNCERTAIN)
    expect(bystander.requests).toHaveLength(0)
  })

  it('URL-like text in tool input only ever travels as JSON data to the pinned path', async () => {
    const query = `${bystander.origin}/steal?x=../../v1/users#frag`
    const r = await run('notion.search', { query })
    expect(r.status).toBe('ok')
    expect(fake.requests.map((q) => q.path)).toEqual(['/v1/search'])
    expect((fake.requests[0].json as { query: string }).query).toBe(query)
    expect(bystander.requests).toHaveLength(0)
  })

  it('every request an operation makes goes to an allowed Notion path', async () => {
    await run('notion.read_page', { pageId: IDS.long })
    await run('notion.search', { query: 'a' })
    await run('notion.whoami', {})
    await run('notion.create_draft_page', { parentPageId: IDS.drafts, title: 't', text: 'b' })
    const allowed = /^\/v1\/(users\/me|search|pages|pages\/[0-9a-f-]{36}|blocks\/[0-9a-f-]{36}\/children)$/
    for (const q of fake.requests) expect(q.pathname).toMatch(allowed)
  })

  it('even an operation that casts a raw string to ApiPath cannot leave the origin', async () => {
    const seen: string[] = []
    const spy = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    for (const raw of ['//evil.example/steal', 'http://evil.example/', '/v1/../steal', '/v1/./x', '/v1/x?y=1', '/v1/x#y', '/v1/%2e%2e/x', '/v1//x', 'v1/x', '/v1/x\n']) {
      const rogue = defineAdapter({
        id: 'rogue',
        name: 'Rogue',
        origin: 'http://127.0.0.1:9',
        headers: () => ({}),
        verify: async () => {
          throw new Error('unused')
        },
        operations: [
          {
            id: 'rogue.go',
            title: 'Go',
            description: '',
            classification: 'read',
            scope: null,
            inputSchema: { type: 'object', additionalProperties: false, properties: {} },
            outputSchema: { type: 'object' },
            rateLimitPerMinute: 100,
            timeoutMs: 1000,
            retry: 'never',
            execute: async (ctx) => {
              await ctx.request({ method: 'GET', path: raw as ApiPath })
              return { output: {}, rawIds: {} }
            }
          }
        ]
      })
      const r = await run('rogue.go', {}, { adapter: rogue, fetchImpl: spy })
      expect(r, raw).toMatchObject({ status: 'error', code: 'invalid_input', attempts: 0 })
    }
    expect(seen).toEqual([])
  })
})

// ── Rate limit ────────────────────────────────────────────────────────────────

describe('rate limiting (fail fast)', () => {
  it('a token bucket per (connection, operation): over the limit is blocked with retryAfterMs and sends nothing', async () => {
    let t = 1_000_000
    const now = (): number => t
    for (let i = 0; i < 30; i++) expect((await run('notion.whoami', {}, { now })).status).toBe('ok')
    const over = await run('notion.whoami', {}, { now })
    expect(over).toMatchObject({ status: 'blocked', code: 'rate_limited', attempts: 0, retryAfterMs: 2_000 })
    expect(over.detail).toContain('limited to 30 a minute')
    expect(fake.requests).toHaveLength(30)
    // Other operations and other connections have their own buckets.
    expect((await run('notion.search', { query: 'x' }, { now })).status).toBe('ok')
    expect((await run('notion.whoami', {}, { now, connectionId: 'conn-notion-2' })).status).toBe('ok')
    // The next token arrives after 60 s / 30.
    t += 1_999
    expect((await run('notion.whoami', {}, { now })).status).toBe('blocked')
    t += 1
    expect((await run('notion.whoami', {}, { now })).status).toBe('ok')
  })

  it('refills continuously up to the per-minute capacity', () => {
    const l = new RateLimiter()
    expect(l.take('c', 'o', 2, 0)).toEqual({ ok: true })
    expect(l.take('c', 'o', 2, 0)).toEqual({ ok: true })
    expect(l.take('c', 'o', 2, 0)).toEqual({ ok: false, retryAfterMs: 30_000 })
    expect(l.take('c', 'o', 2, 15_000)).toEqual({ ok: false, retryAfterMs: 15_000 })
    expect(l.take('c', 'o', 2, 30_000)).toEqual({ ok: true })
    // Ten idle minutes never bank more than one minute's worth.
    expect(l.take('c', 'o', 2, 630_000)).toEqual({ ok: true })
    expect(l.take('c', 'o', 2, 630_000)).toEqual({ ok: true })
    expect(l.take('c', 'o', 2, 630_000).ok).toBe(false)
    l.forgetConnection('c')
    expect(l.take('c', 'o', 2, 630_000)).toEqual({ ok: true })
  })
})

// ── Secrets ───────────────────────────────────────────────────────────────────

describe('secrets never reach a detail string', () => {
  it('a server echoing the Authorization header gets it redacted (known token shape)', async () => {
    fake.echoAuthInError = 'header'
    const r = await run('notion.search', { query: 'x' })
    expect(r.code).toBe('provider_rejected')
    expect(r.detail).toBe('Notion rejected the request. Notion said: “Bad request with credential Bearer [redacted] (rejected)”')

    fake.echoAuthInError = 'bare'
    const bare = await run('notion.search', { query: 'x' })
    expect(bare.detail).toBe('Notion rejected the request. Notion said: “Bad request with credential [redacted] (rejected)”')
  })

  it('a token of a shape no pattern knows, echoed bare, is masked by exact match', async () => {
    fake.echoAuthInError = 'bare'
    fake.token = ODD_TOKEN
    const r = await run('notion.search', { query: 'x' }, { secret: ODD_TOKEN })
    expect(r.detail).toBe('Notion rejected the request. Notion said: “Bad request with credential [redacted] (rejected)”')
  })

  it('a token with a line break is refused before sending, without echoing it', async () => {
    const r = await run('notion.whoami', {}, { secret: `${FAKE_NOTION_TOKEN}\n` })
    expect(r).toMatchObject({ status: 'error', code: 'reconnect_required', attempts: 0 })
    expect(r.detail).toContain('spaces or line breaks')
    expect(fake.requests).toHaveLength(0)
  })

  it('no result in this file carried a token anywhere', () => {
    expect(allResults.length).toBeGreaterThan(50)
    for (const r of allResults) {
      const s = JSON.stringify(r)
      expect(s).not.toContain(FAKE_NOTION_TOKEN)
      expect(s).not.toContain(ODD_TOKEN)
    }
  })
})
