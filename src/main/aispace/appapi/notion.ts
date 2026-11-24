// Notion, the first direct app-API adapter (SPEC-CONNECTIONS.md §5, §8 Release 1
// "one direct API adapter").
//
// Auth is an internal integration token ("ntn_…", older "secret_…") sent as a
// bearer token to https://api.notion.com with Notion-Version 2022-06-28. The
// token only reaches pages someone shared with the integration (in Notion:
// page › ••• › Connections), which is why "not found" usually means "not shared".
//
// Operations:
//   notion.whoami             read   GET  /v1/users/me
//   notion.search             read   POST /v1/search            (pages only, ≤ 20)
//   notion.read_page          read   GET  /v1/pages/{id} + GET /v1/blocks/{id}/children (≤ 10 pages of 100)
//   notion.create_draft_page  WRITE  POST /v1/pages             (retry 'never')
//
// Notion has no idempotency key for writes, so create_draft_page is never
// retried, and a create that was sent without a definite answer comes back
// 'uncertain' with "Notion may or may not have created the page; check before
// trying again."
//
// Ids: Notion ids are UUIDs, written with or without dashes. Anything else (a
// link, a path, "../", "?", "#", "%2F") is refused BEFORE a request path is
// built, by the input schema's pattern, by normaliseNotionId, and again by
// apiPath, so tool input can never change where a request goes.

import type { JsonSchema } from '@shared/aispace/connections'
import { apiPath, defineAdapter, InputError, type AppAdapter, type AppOperation, type OperationContext } from './adapter'

export const NOTION_ORIGIN = 'https://api.notion.com'
export const NOTION_VERSION = '2022-06-28'

export const NOTION_LIMITS = {
  searchPageSize: 20,
  blocksPageSize: 100,
  maxBlockPages: 10,
  maxTextChars: 60_000,
  richTextChunk: 2_000,
  maxBlocksPerCreate: 100,
  maxDraftChars: 100_000
} as const

// ── Ids ───────────────────────────────────────────────────────────────────────

const HEX32 = '[0-9a-fA-F]{32}'
const DASHED = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
export const NOTION_ID_PATTERN = `^(?:${HEX32}|${DASHED})$`
const NOTION_ID_RE = new RegExp(NOTION_ID_PATTERN)

// 32 hex characters, with or without the usual dashes → lower-case dashed UUID.
// Returns null for anything else.
export function normaliseNotionId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !NOTION_ID_RE.test(raw)) return null
  const hex = raw.replace(/-/g, '').toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function requireId(raw: unknown, what: string): string {
  const id = normaliseNotionId(raw)
  if (!id) throw new InputError(`${what} must be a Notion id: 32 letters and digits (0-9, a-f), with or without dashes. Links and paths are not accepted.`)
  return id
}

// ── Reading Notion objects ────────────────────────────────────────────────────

interface RichText {
  plain_text?: string
}

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {})
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function plainText(rich: unknown): string {
  return Array.isArray(rich) ? (rich as RichText[]).map((r) => (typeof r?.plain_text === 'string' ? r.plain_text : '')).join('') : ''
}

// A page's title lives in whichever property has type 'title' (it is "title"
// for a plain page and the database's own name, e.g. "Name", for a row).
export function pageTitle(page: unknown): string {
  const props = asObj(asObj(page).properties)
  for (const p of Object.values(props)) {
    const prop = asObj(p)
    if (prop.type === 'title') return plainText(prop.title)
  }
  return ''
}

// Notion ids in replies are already dashed UUIDs; normalising keeps the output
// uniform, and a reply without a usable id is a bad reply, not a guess.
function replyId(raw: unknown, what: string): string {
  const id = normaliseNotionId(raw)
  if (!id) throw new Error(`${what} had no usable id`)
  return id
}

// ── Page text ─────────────────────────────────────────────────────────────────

interface TextState {
  lines: string[]
  numbered: number
  skipped: number
  nested: number
}

const HEADING_PREFIX: Record<string, string> = { heading_1: '# ', heading_2: '## ', heading_3: '### ' }

function addBlock(state: TextState, block: unknown): void {
  const b = asObj(block)
  const type = asStr(b.type) ?? ''
  const data = asObj(b[type])
  if (b.has_children === true) state.nested++
  if (type !== 'numbered_list_item') state.numbered = 0
  const text = plainText(data.rich_text)
  switch (type) {
    case 'paragraph':
    case 'callout':
    case 'toggle':
      state.lines.push(text)
      break
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      state.lines.push(HEADING_PREFIX[type] + text)
      break
    case 'bulleted_list_item':
      state.lines.push(`- ${text}`)
      break
    case 'numbered_list_item':
      state.numbered++
      state.lines.push(`${state.numbered}. ${text}`)
      break
    case 'to_do':
      state.lines.push(`${data.checked === true ? '[x]' : '[ ]'} ${text}`)
      break
    case 'quote':
      state.lines.push(`> ${text}`)
      break
    case 'code':
      state.lines.push('```', text, '```')
      break
    default:
      state.skipped++
  }
}

// Split on code points, so a chunk never ends in half a surrogate pair.
export function chunkText(text: string, size: number): string[] {
  const cps = [...text]
  const out: string[] = []
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''))
  return out
}

// Draft text → paragraph blocks. Paragraphs are separated by blank lines; a
// paragraph longer than 2,000 characters becomes several rich_text pieces in
// the same block (Notion caps each piece at 2,000).
export function draftBlocks(text: string): Obj[] {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim().length > 0)
  if (paragraphs.length > NOTION_LIMITS.maxBlocksPerCreate) {
    throw new InputError(
      `The text has ${paragraphs.length} paragraphs; Notion takes at most ${NOTION_LIMITS.maxBlocksPerCreate} in one new page. Join some paragraphs or shorten the draft.`
    )
  }
  return paragraphs.map((p) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: chunkText(p, NOTION_LIMITS.richTextChunk).map((content) => ({ type: 'text', text: { content } })) }
  }))
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const idSchema = (description: string): JsonSchema => ({ type: 'string', pattern: NOTION_ID_PATTERN, description })

const PAGE_SUMMARY: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'url', 'lastEditedTime'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string', nullable: true },
    lastEditedTime: { type: 'string', nullable: true }
  }
}

// ── Operations ────────────────────────────────────────────────────────────────

interface SearchInput {
  query: string
  pageSize?: number
}
interface ReadPageInput {
  pageId: string
}
interface CreateDraftInput {
  parentPageId: string
  title: string
  text?: string
}

function operations(timeoutOverride?: number): AppOperation[] {
  const t = (ms: number): number => timeoutOverride ?? ms

  const whoami: AppOperation = {
    id: 'notion.whoami',
    title: 'Check the Notion connection',
    description: 'Reads which Notion workspace and integration this token belongs to.',
    classification: 'read',
    scope: null,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['identity', 'workspaceName', 'ownerType'],
      properties: {
        identity: { type: 'string' },
        workspaceName: { type: 'string', nullable: true },
        ownerType: { type: 'string', nullable: true }
      }
    },
    rateLimitPerMinute: 30,
    timeoutMs: t(15_000),
    retry: 'safe_read',
    async execute(ctx: OperationContext) {
      const res = await ctx.request<Obj>({ method: 'GET', path: apiPath`/v1/users/me` })
      const user = asObj(res.body)
      const bot = asObj(user.bot)
      const userId = asStr(user.id)
      const workspaceId = asStr(bot.workspace_id)
      const identity = workspaceId ?? userId
      if (!identity) throw new Error('the bot user had no id')
      return {
        output: {
          identity,
          workspaceName: asStr(bot.workspace_name),
          ownerType: asStr(asObj(bot.owner).type)
        },
        rawIds: { bot_user_id: userId, workspace_id: workspaceId }
      }
    }
  }

  const search: AppOperation = {
    id: 'notion.search',
    title: 'Search Notion pages',
    description: 'Finds pages shared with this integration whose title matches the query. Returns at most 20.',
    classification: 'read',
    scope: 'read_content',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Words in the page title. Empty lists recently edited pages.' },
        pageSize: { type: 'integer', minimum: 1, maximum: NOTION_LIMITS.searchPageSize, description: 'How many pages to return (1–20, default 10).' }
      }
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['results', 'hasMore'],
      properties: {
        results: { type: 'array', maxItems: NOTION_LIMITS.searchPageSize, items: PAGE_SUMMARY },
        hasMore: { type: 'boolean' }
      }
    },
    rateLimitPerMinute: 60,
    timeoutMs: t(20_000),
    retry: 'safe_read',
    async execute(ctx: OperationContext, input: SearchInput) {
      const body: Obj = {
        filter: { property: 'object', value: 'page' },
        page_size: input.pageSize ?? 10
      }
      if (input.query.trim()) body.query = input.query.trim()
      const res = await ctx.request<Obj>({ method: 'POST', path: apiPath`/v1/search`, body })
      const list = asObj(res.body)
      const pages = (Array.isArray(list.results) ? list.results : []).filter((r) => asObj(r).object === 'page').slice(0, NOTION_LIMITS.searchPageSize)
      return {
        output: {
          results: pages.map((p) => {
            const page = asObj(p)
            return { id: replyId(page.id, 'A search result'), title: pageTitle(page), url: asStr(page.url), lastEditedTime: asStr(page.last_edited_time) }
          }),
          hasMore: list.has_more === true
        },
        rawIds: { page_ids: pages.map((p) => String(asObj(p).id)) }
      }
    }
  }

  const readPage: AppOperation = {
    id: 'notion.read_page',
    title: 'Read a Notion page',
    description: 'Reads a page’s title and its text (paragraphs, headings, lists, to-dos, quotes, callouts). Up to 60,000 characters.',
    classification: 'read',
    scope: 'read_content',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pageId'],
      properties: { pageId: idSchema('The page id (32 hex characters, dashes optional).') }
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'url', 'text', 'truncated', 'notes'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        url: { type: 'string', nullable: true },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        notes: { type: 'array', items: { type: 'string' } }
      }
    },
    rateLimitPerMinute: 30,
    timeoutMs: t(20_000),
    retry: 'safe_read',
    async execute(ctx: OperationContext, input: ReadPageInput) {
      const id = requireId(input.pageId, 'pageId')
      const pageRes = await ctx.request<Obj>({ method: 'GET', path: apiPath`/v1/pages/${id}` })
      const page = asObj(pageRes.body)

      const state: TextState = { lines: [], numbered: 0, skipped: 0, nested: 0 }
      let cursor: string | null = null
      let pagesRead = 0
      let moreLeft = false
      let length = 0
      for (;;) {
        const res: { body: Obj } = await ctx.request<Obj>({
          method: 'GET',
          path: apiPath`/v1/blocks/${id}/children`,
          query: { page_size: NOTION_LIMITS.blocksPageSize, start_cursor: cursor ?? undefined }
        })
        pagesRead++
        const list = asObj(res.body)
        for (const b of Array.isArray(list.results) ? list.results : []) addBlock(state, b)
        length = state.lines.reduce((n, l) => n + l.length + 1, 0)
        const next = asStr(list.next_cursor)
        if (list.has_more !== true || !next) break
        // No point fetching more than the text limit can hold.
        if (pagesRead >= NOTION_LIMITS.maxBlockPages || length > NOTION_LIMITS.maxTextChars) {
          moreLeft = true
          break
        }
        cursor = next
      }

      let text = state.lines.join('\n')
      const notes: string[] = []
      let truncated = false
      if (text.length > NOTION_LIMITS.maxTextChars) {
        text = `${text.slice(0, NOTION_LIMITS.maxTextChars)}\n\n[Truncated at 60,000 characters.]`
        truncated = true
        notes.push('The text was cut at 60,000 characters.')
      } else if (moreLeft) {
        truncated = true
        text += `\n\n[Stopped after ${pagesRead * NOTION_LIMITS.blocksPageSize} blocks; the rest of the page was not read.]`
        notes.push(`Only the first ${pagesRead * NOTION_LIMITS.blocksPageSize} blocks were read.`)
      }
      if (state.nested) notes.push(`${state.nested} block${state.nested === 1 ? ' has' : 's have'} nested content (toggles, nested lists, columns) that was not read.`)
      if (state.skipped) notes.push(`${state.skipped} block${state.skipped === 1 ? '' : 's'} of other kinds (images, tables, embeds…) ${state.skipped === 1 ? 'was' : 'were'} skipped.`)

      return {
        output: { id: replyId(page.id, 'The page'), title: pageTitle(page), url: asStr(page.url), text, truncated, notes },
        rawIds: { page_id: asStr(page.id) }
      }
    }
  }

  const createDraft: AppOperation = {
    id: 'notion.create_draft_page',
    title: 'Create a Notion draft page',
    description: 'Creates a new page under a parent page you choose, with a title and plain paragraphs. It never edits existing pages.',
    classification: 'write',
    scope: 'insert_content',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['parentPageId', 'title'],
      properties: {
        parentPageId: idSchema('The parent page id. The integration must have access to it.'),
        title: { type: 'string', minLength: 1, maxLength: 2_000 },
        text: { type: 'string', maxLength: NOTION_LIMITS.maxDraftChars, description: 'Paragraphs separated by blank lines (at most 100).' }
      }
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'url'],
      properties: { id: { type: 'string' }, url: { type: 'string', nullable: true } }
    },
    rateLimitPerMinute: 20,
    timeoutMs: t(30_000),
    retry: 'never',
    uncertainDetail: 'Notion may or may not have created the page; check before trying again.',
    async execute(ctx: OperationContext, input: CreateDraftInput) {
      const parent = requireId(input.parentPageId, 'parentPageId')
      // Built (and checked) before anything is sent.
      const children = draftBlocks(input.text ?? '')
      const body: Obj = {
        parent: { page_id: parent },
        properties: { title: { title: [{ type: 'text', text: { content: input.title } }] } }
      }
      if (children.length) body.children = children
      const res = await ctx.request<Obj>({ method: 'POST', path: apiPath`/v1/pages`, body })
      const page = asObj(res.body)
      return {
        output: { id: replyId(page.id, 'The new page'), url: asStr(page.url) },
        rawIds: { page_id: asStr(page.id), parent_page_id: parent }
      }
    }
  }

  return [whoami, search, readPage, createDraft]
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface NotionAdapterOptions {
  // A local reference server (tests). Only loopback http(s) origins are taken;
  // the real adapter is always https://api.notion.com.
  origin?: string
  // Tests only: shorten every operation's timeout.
  timeoutMs?: number
}

function checkOrigin(origin: string): string {
  if (origin === NOTION_ORIGIN) return origin
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    throw new Error('Notion adapter: origin is not a valid address.')
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (!loopback || u.origin !== origin) throw new Error('Notion adapter: only api.notion.com or a local reference server origin is allowed.')
  return origin
}

export function createNotionAdapter(options: NotionAdapterOptions = {}): AppAdapter {
  const origin = checkOrigin(options.origin ?? NOTION_ORIGIN)
  return defineAdapter({
    id: 'notion',
    name: 'Notion',
    origin,
    operations: operations(options.timeoutMs),
    headers: (secret: string) => ({ authorization: `Bearer ${secret}`, 'notion-version': NOTION_VERSION }),
    // Notion has no idempotency key, so no operation can be idempotent_write.
    idempotencyHeader: undefined,
    requestIdHeaders: ['x-request-id'],
    describeError(e) {
      if (e.status === 401) {
        return { code: 'reconnect_required', detail: 'Notion refused the token. Create or copy a current internal integration token and reconnect.' }
      }
      if (e.status === 403) {
        return {
          code: e.providerCode === 'restricted_resource' ? 'insufficient_scope' : 'forbidden',
          detail:
            e.providerCode === 'restricted_resource'
              ? 'This integration isn’t allowed to do that. In Notion’s integration settings, check its capabilities (Read content, Insert content).'
              : 'Notion refused access to that.'
        }
      }
      if (e.status === 404) {
        return { code: 'not_found', detail: 'Notion couldn’t find that page, or it isn’t shared with this integration. In Notion, open the page › ••• › Connections and add the integration.' }
      }
      if (e.status === 429) return { code: 'rate_limited', detail: 'Notion is rate limiting this integration. Wait and try again.' }
      return null
    },
    async verify(ctx) {
      const checkedAt = ctx.now()
      const appWrite = { capability: 'app_write' as const, state: 'untested' as const, checkedAt: null, detail: 'Checked on first approved draft' }
      const who = await ctx.invoke('notion.whoami', {})
      if (who.status !== 'ok') {
        return {
          ok: false,
          code: who.code,
          identity: null,
          providerOrg: null,
          detail: who.detail,
          capabilities: [{ capability: 'app_read', state: 'failed', checkedAt, detail: who.detail }, appWrite]
        }
      }
      const me = who.output as { identity: string; workspaceName: string | null }
      // A valid token is not proof the integration can read content: search is.
      const probe = await ctx.invoke('notion.search', { query: '', pageSize: 1 })
      const found = probe.status === 'ok' ? (probe.output as { results: unknown[] }).results.length : 0
      const readDetail =
        probe.status !== 'ok'
          ? probe.detail
          : found
            ? 'Read the list of pages shared with this integration.'
            : 'Works, but no pages are shared with this integration yet. In Notion, open a page › ••• › Connections and add it.'
      return {
        ok: probe.status === 'ok',
        code: probe.code,
        identity: me.identity,
        providerOrg: me.workspaceName,
        detail: probe.status === 'ok' ? `Connected to ${me.workspaceName ?? 'a Notion workspace'}.` : probe.detail,
        capabilities: [{ capability: 'app_read', state: probe.status === 'ok' ? 'passed' : 'failed', checkedAt, detail: readDetail }, appWrite]
      }
    }
  })
}

export const notionAdapter: AppAdapter = createNotionAdapter()
