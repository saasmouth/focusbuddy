// A local stand-in for the Notion REST API (https://developers.notion.com/reference),
// for the app-API adapter tests. It listens on 127.0.0.1:0 and speaks the parts
// the adapter uses:
//
//   GET  /v1/users/me                     the integration's bot user
//   POST /v1/search                       pages only, title match, page_size
//   GET  /v1/pages/{id}                   a page (ids with or without dashes)
//   GET  /v1/blocks/{id}/children         paginated, start_cursor = next block id
//   POST /v1/pages                        create under a parent page, Notion's limits checked
//
// Every request is recorded (method, path, headers, body). Requests without
// `Notion-Version: 2022-06-28` get Notion's 400 missing_version; a wrong bearer
// token gets 401 unauthorized. Errors carry Notion's { object: 'error', status,
// code, message, request_id } body.
//
// Switches simulate what the real service and a hostile network can do: 429
// with Retry-After, 503, any other error, a hang (the request is read and acted
// on, then never answered), a 302 to another origin, and a server that echoes
// the Authorization header into an error message.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const FAKE_NOTION_TOKEN = 'ntn_' + 'T3stT0kenAbcdefghijklmnopqrstuvwxyz0123456789'
export const FAKE_WORKSPACE_ID = '5f1d2c3b-4a59-4687-9a7b-0c1d2e3f4a5b'
export const FAKE_BOT_ID = '16d84278-ab0e-484c-9bdd-b35da3bd8905'

export interface FakeRequest {
  method: string
  path: string
  pathname: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: string
  json: unknown
}

export interface FakeBlock {
  id: string
  type: string
  text?: string
  checked?: boolean
  hasChildren?: boolean
}

export interface FakePage {
  id: string
  title: string
  // The name of the title property: 'title' for a plain page, e.g. 'Name' for a database row.
  titleProp?: string
  parentId?: string | null
  lastEditedTime?: string
  blocks: FakeBlock[]
}

interface QueuedFailure {
  status: number
  code: string
  message: string
  headers?: Record<string, string>
}

const compact = (id: string): string => id.replace(/-/g, '').toLowerCase()
const dashed = (hex: string): string => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

let idCounter = 0
// Deterministic, unique ids for created pages and blocks ('f' + zero-padded seed).
export function fakeId(seed: number = ++idCounter): string {
  return dashed('f' + seed.toString(16).padStart(31, '0'))
}

function richText(text: string): unknown[] {
  return [{ type: 'text', text: { content: text, link: null }, annotations: {}, plain_text: text, href: null }]
}

export class FakeNotion {
  origin = ''
  token = FAKE_NOTION_TOKEN
  workspaceId: string | null = FAKE_WORKSPACE_ID
  workspaceName = 'Plexii Test Workspace'
  requests: FakeRequest[] = []
  pages = new Map<string, FakePage>()

  // Switches.
  hang = false
  redirectTo: string | null = null
  // 'header': echo "Bearer <token>"; 'bare': echo just the token (no prefix a
  // generic pattern could key on).
  echoAuthInError: false | 'header' | 'bare' = false
  private queue: QueuedFailure[] = []
  private requestSeq = 0
  private server: http.Server | null = null

  rateLimitNext(times: number, retryAfter: string | null = '1'): void {
    for (let i = 0; i < times; i++) {
      this.queue.push({ status: 429, code: 'rate_limited', message: 'You have been rate limited. Please try again in a few minutes.', headers: retryAfter === null ? {} : { 'retry-after': retryAfter } })
    }
  }

  unavailableNext(times: number): void {
    for (let i = 0; i < times; i++) this.queue.push({ status: 503, code: 'service_unavailable', message: 'Notion is unavailable, please try again later.' })
  }

  failNext(status: number, code: string, message: string): void {
    this.queue.push({ status, code, message })
  }

  addPage(page: FakePage): FakePage {
    this.pages.set(compact(page.id), page)
    return page
  }

  pageById(id: string): FakePage | undefined {
    return this.pages.get(compact(id))
  }

  reset(): void {
    this.requests = []
    this.queue = []
    this.hang = false
    this.redirectTo = null
    this.echoAuthInError = false
    this.token = FAKE_NOTION_TOKEN
    this.workspaceId = FAKE_WORKSPACE_ID
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')))
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()))
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((r) => this.server!.close(() => r()))
    this.server = null
  }

  private requestId(): string {
    return `fake-req-${++this.requestSeq}`
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  private error(res: http.ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
    this.send(res, status, { object: 'error', status, code, message, request_id: this.requestId() }, headers)
  }

  private pageJson(p: FakePage): unknown {
    const prop = p.titleProp ?? 'title'
    const properties: Record<string, unknown> = { [prop]: { id: 'title', type: 'title', title: richText(p.title) } }
    if (prop !== 'title') properties.Status = { id: 'abc', type: 'select', select: { name: 'Draft' } }
    return {
      object: 'page',
      id: p.id,
      created_time: '2026-11-01T10:00:00.000Z',
      last_edited_time: p.lastEditedTime ?? '2026-11-20T09:30:00.000Z',
      archived: false,
      url: `https://www.notion.so/${p.title.replace(/\W+/g, '-')}-${compact(p.id)}`,
      parent: p.parentId ? { type: 'page_id', page_id: p.parentId } : { type: 'workspace', workspace: true },
      properties
    }
  }

  private blockJson(b: FakeBlock): unknown {
    const data: Record<string, unknown> = {}
    if (b.text !== undefined) data.rich_text = richText(b.text)
    if (b.type === 'to_do') data.checked = b.checked === true
    if (b.type === 'image') Object.assign(data, { type: 'external', external: { url: 'https://example.com/a.png' } })
    return { object: 'block', id: b.id, type: b.type, has_children: b.hasChildren === true, archived: false, [b.type]: data }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const url = new URL(req.url ?? '/', 'http://fake.local')
    let json: unknown = null
    try {
      json = body ? JSON.parse(body) : null
    } catch {
      json = undefined
    }
    this.requests.push({ method: req.method ?? '', path: req.url ?? '', pathname: url.pathname, query: url.searchParams, headers: req.headers, body, json })

    if (this.echoAuthInError) {
      // A hostile or buggy server putting the credential into its error text.
      const auth = String(req.headers.authorization)
      const shown = this.echoAuthInError === 'bare' ? auth.replace(/^Bearer /, '') : auth
      return this.error(res, 400, 'validation_error', `Bad request with credential ${shown} (rejected)`)
    }
    if (this.redirectTo) {
      res.writeHead(302, { location: this.redirectTo })
      return void res.end()
    }
    const queued = this.queue.shift()
    if (queued) return this.error(res, queued.status, queued.code, queued.message, queued.headers)

    if (req.headers.authorization !== `Bearer ${this.token}`) return this.error(res, 401, 'unauthorized', 'API token is invalid.')
    if (req.headers['notion-version'] !== '2022-06-28') {
      return this.error(res, 400, 'missing_version', 'Notion-Version header failed validation: Notion-Version header should be defined, instead was `undefined`.')
    }
    if (json === undefined) return this.error(res, 400, 'invalid_json', 'Error parsing JSON body.')

    const m = req.method ?? ''
    const p = url.pathname

    if (m === 'GET' && p === '/v1/users/me') {
      if (this.hang) return
      const bot: Record<string, unknown> = { owner: { type: 'workspace', workspace: true }, workspace_name: this.workspaceName }
      if (this.workspaceId) bot.workspace_id = this.workspaceId
      return this.send(res, 200, { object: 'user', id: FAKE_BOT_ID, name: 'Plexii', avatar_url: null, type: 'bot', bot })
    }

    if (m === 'POST' && p === '/v1/search') {
      if (this.hang) return
      const q = json as { query?: string; page_size?: number; filter?: { property?: string; value?: string } }
      const size = Math.min(q.page_size ?? 100, 100)
      const needle = (q.query ?? '').toLowerCase()
      const all = [...this.pages.values()].filter((pg) => pg.title.toLowerCase().includes(needle))
      return this.send(res, 200, { object: 'list', results: all.slice(0, size).map((pg) => this.pageJson(pg)), next_cursor: null, has_more: all.length > size, type: 'page_or_database', page_or_database: {} })
    }

    const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(p)
    if (m === 'GET' && pageMatch) {
      if (this.hang) return
      const pg = this.pageById(decodeURIComponent(pageMatch[1]))
      if (!pg) return this.error(res, 404, 'object_not_found', `Could not find page with ID: ${pageMatch[1]}. Make sure the relevant pages and databases are shared with your integration.`)
      return this.send(res, 200, this.pageJson(pg))
    }

    const childMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(p)
    if (m === 'GET' && childMatch) {
      if (this.hang) return
      const pg = this.pageById(decodeURIComponent(childMatch[1]))
      if (!pg) return this.error(res, 404, 'object_not_found', `Could not find block with ID: ${childMatch[1]}.`)
      const size = Math.min(Number(url.searchParams.get('page_size') ?? 100), 100)
      const cursor = url.searchParams.get('start_cursor')
      const start = cursor ? pg.blocks.findIndex((b) => b.id === cursor) : 0
      if (start < 0) return this.error(res, 400, 'validation_error', 'start_cursor provided is invalid.')
      const slice = pg.blocks.slice(start, start + size)
      const next = pg.blocks[start + size]
      return this.send(res, 200, { object: 'list', results: slice.map((b) => this.blockJson(b)), next_cursor: next ? next.id : null, has_more: Boolean(next), type: 'block', block: {} })
    }

    if (m === 'POST' && p === '/v1/pages') {
      const b = json as {
        parent?: { page_id?: string }
        properties?: { title?: { title?: Array<{ text?: { content?: string } }> } }
        children?: Array<{ type?: string; paragraph?: { rich_text?: Array<{ text?: { content?: string } }> } }>
      }
      const parent = b.parent?.page_id ? this.pageById(b.parent.page_id) : undefined
      if (!parent) return this.error(res, 404, 'object_not_found', 'Could not find page with ID. Make sure the relevant pages and databases are shared with your integration.')
      const title = b.properties?.title?.title?.[0]?.text?.content
      if (typeof title !== 'string') return this.error(res, 400, 'validation_error', 'body failed validation: body.properties.title should be defined.')
      const children = b.children ?? []
      if (children.length > 100) return this.error(res, 400, 'validation_error', 'body failed validation: body.children.length should be ≤ `100`.')
      for (const c of children) {
        for (const rt of c.paragraph?.rich_text ?? []) {
          if ((rt.text?.content ?? '').length > 2000) return this.error(res, 400, 'validation_error', 'body failed validation: text.content.length should be ≤ `2000`.')
        }
      }
      const created = this.addPage({
        id: fakeId(),
        title,
        parentId: parent.id,
        blocks: children.map((c) => ({ id: fakeId(), type: 'paragraph', text: (c.paragraph?.rich_text ?? []).map((r) => r.text?.content ?? '').join('') }))
      })
      // The page now exists; a hang here is exactly the "did it or didn't it" case.
      if (this.hang) return
      return this.send(res, 200, this.pageJson(created))
    }

    return this.error(res, 400, 'invalid_request_url', 'Invalid request URL.')
  }
}

// A second server that must never be reached: it records anything that arrives.
export class Bystander {
  origin = ''
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }> = []
  private server: http.Server | null = null

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"object":"user","id":"16d84278-ab0e-484c-9bdd-b35da3bd8905","bot":{}}')
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()))
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((r) => this.server!.close(() => r()))
    this.server = null
  }
}

// ── Seed content ──────────────────────────────────────────────────────────────

export const IDS = {
  plan: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  long: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
  huge: '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f',
  big: '4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a',
  row: '5e6f7a8b-9c0d-4e1f-8a3b-4c5d6e7f8a9b',
  drafts: '6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f8a9b0c',
  missing: '7a8b9c0d-1e2f-4a3b-8c5d-6e7f8a9b0c1d'
}

function blocks(n: number, make: (i: number) => Omit<FakeBlock, 'id'>, seedBase: number): FakeBlock[] {
  return Array.from({ length: n }, (_, i) => ({ id: fakeId(seedBase + i), ...make(i) }))
}

export function seedFakeNotion(f: FakeNotion): void {
  f.pages.clear()
  f.addPage({
    id: IDS.plan,
    title: 'Launch plan',
    lastEditedTime: '2026-11-22T08:00:00.000Z',
    blocks: [
      { id: fakeId(0x9000001), type: 'heading_1', text: 'Goals' },
      { id: fakeId(0x9000002), type: 'paragraph', text: 'Ship the beta.' },
      { id: fakeId(0x9000003), type: 'heading_2', text: 'Steps' },
      { id: fakeId(0x9000004), type: 'bulleted_list_item', text: 'Write the brief' },
      { id: fakeId(0x9000005), type: 'bulleted_list_item', text: 'Review it' },
      { id: fakeId(0x9000006), type: 'numbered_list_item', text: 'Draft' },
      { id: fakeId(0x9000007), type: 'numbered_list_item', text: 'Publish' },
      { id: fakeId(0x9000008), type: 'heading_3', text: 'Checks' },
      { id: fakeId(0x9000009), type: 'to_do', text: 'Legal review', checked: true },
      { id: fakeId(0x900000a), type: 'to_do', text: 'Price page', checked: false },
      { id: fakeId(0x900000b), type: 'quote', text: 'Ship small, ship often.' },
      { id: fakeId(0x900000c), type: 'callout', text: 'Launch is on Friday.' },
      { id: fakeId(0x900000d), type: 'image' },
      { id: fakeId(0x900000e), type: 'toggle', text: 'Details', hasChildren: true },
      { id: fakeId(0x900000f), type: 'divider' }
    ]
  })
  f.addPage({ id: IDS.long, title: 'Meeting notes', blocks: blocks(250, (i) => ({ type: 'paragraph', text: `Line ${i + 1}` }), 0xa000000) })
  f.addPage({ id: IDS.huge, title: 'Huge log', blocks: blocks(1_050, (i) => ({ type: 'paragraph', text: `Entry ${i + 1}` }), 0xb000000) })
  // 300 blocks × 500 characters = 150,000: past the 60,000 limit on the second page of blocks.
  f.addPage({ id: IDS.big, title: 'Big essay', blocks: blocks(300, (i) => ({ type: 'paragraph', text: String.fromCharCode(97 + (i % 26)).repeat(500) }), 0xc000000) })
  f.addPage({ id: IDS.row, title: 'Q4 roadmap row', titleProp: 'Name', blocks: [] })
  f.addPage({ id: IDS.drafts, title: 'Drafts', blocks: [] })
}
