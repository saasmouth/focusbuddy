// Local reference servers for the model adapters (src/main/aispace/providers).
//
// Each one speaks the documented wire protocol of its provider closely enough
// to exercise an adapter end to end: auth headers checked, JSON error bodies in
// the provider's shape, Server-Sent Events in the provider's event vocabulary,
// and (OpenAI) the background lifecycle queued → in_progress → completed across
// polls, plus cancel. They listen on 127.0.0.1:0 only.
//
// `state` is live: flip `mode` (or any field) between calls. With
// `echoKeyInErrors` a 401 body repeats the key that was sent. Real providers do
// not do that in full; it is the worst case the adapters' scrubbing must cover.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: string
  json: Record<string, unknown> | null
}

interface FakeBase {
  url: string
  requests: RecordedRequest[]
  // Streams the client closed before the server finished them.
  abortedStreams: number
  close(): Promise<void>
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function alive(res: http.ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, rec: RecordedRequest) => Promise<void>,
  base: { requests: RecordedRequest[]; abortedStreams: number }
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readBody(req)
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      let json: Record<string, unknown> | null = null
      try {
        const v = JSON.parse(body) as unknown
        if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>
      } catch {
        /* not JSON */
      }
      const rec: RecordedRequest = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body, json }
      base.requests.push(rec)
      res.on('close', () => {
        if (!res.writableEnded) base.abortedStreams++
      })
      await handler(req, res, rec)
    })().catch((e) => {
      if (alive(res)) sendJson(res, 500, { error: { message: `fake server bug: ${String(e)}` } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

export type AnthropicMode =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'credit_balance'
  | 'billing_402'
  | 'bad_request'
  // Streaming only: after the first text delta…
  | 'stall' // …send nothing more and keep the connection open
  | 'error_event' // …send an `error` event (overloaded_error)
  | 'truncated' // …close the stream without message_stop
  | 'max_tokens' // finish normally with stop_reason max_tokens

export interface FakeAnthropicState {
  mode: AnthropicMode
  key: string
  org: string | null
  models: string[]
  // The server's own page-size cap, to exercise pagination.
  pageSize: number
  chunks: string[]
  inputTokens: number
  outputTokens: number
  retryAfter: string | null
  chunkDelayMs: number
  crlf: boolean
  echoKeyInErrors: boolean
}

export interface FakeAnthropic extends FakeBase {
  state: FakeAnthropicState
}

const anthropicError = (type: string, message: string): unknown => ({ type: 'error', error: { type, message } })

export async function startFakeAnthropic(init: Partial<FakeAnthropicState> & { key: string }): Promise<FakeAnthropic> {
  const state: FakeAnthropicState = {
    mode: 'ok',
    org: null,
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    pageSize: 1000,
    chunks: ['Hello', ', ', 'world', '. Ça va? 日本'],
    inputTokens: 42,
    outputTokens: 17,
    retryAfter: null,
    chunkDelayMs: 0,
    crlf: false,
    echoKeyInErrors: true,
    ...init
  }
  const fake = { requests: [] as RecordedRequest[], abortedStreams: 0, state } as FakeAnthropic
  let n = 0

  const server = await startServer(async (req, res, rec) => {
    res.setHeader('request-id', `req_fake_${++n}`)
    if (req.headers['anthropic-version'] !== '2023-06-01') {
      return sendJson(res, 400, anthropicError('invalid_request_error', 'anthropic-version: header is required'))
    }
    const sent = String(req.headers['x-api-key'] ?? '')
    if (state.mode === 'unauthorized' || sent !== state.key) {
      return sendJson(res, 401, anthropicError('authentication_error', state.echoKeyInErrors ? `invalid x-api-key: ${sent}` : 'invalid x-api-key'))
    }
    if (state.org) res.setHeader('anthropic-organization-id', state.org)
    const retry: Record<string, string> = state.retryAfter ? { 'retry-after': state.retryAfter } : {}
    switch (state.mode) {
      case 'forbidden':
        return sendJson(res, 403, anthropicError('permission_error', 'Your API key does not have permission to use the specified resource.'))
      case 'rate_limited':
        return sendJson(res, 429, anthropicError('rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit.'), {
          'retry-after': state.retryAfter ?? '7'
        })
      case 'overloaded':
        return sendJson(res, 529, anthropicError('overloaded_error', 'Overloaded'), retry)
      case 'server_error':
        return sendJson(res, 500, anthropicError('api_error', 'Internal server error'), retry)
      case 'credit_balance':
        return sendJson(
          res,
          400,
          anthropicError(
            'invalid_request_error',
            'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
          )
        )
      case 'billing_402':
        return sendJson(res, 402, anthropicError('billing_error', 'Your organization has an outstanding balance.'))
      case 'bad_request':
        return sendJson(res, 400, anthropicError('invalid_request_error', 'max_tokens: Field required'))
      default:
        break
    }

    if (rec.method === 'GET' && rec.path === '/v1/models') {
      const limit = Math.min(Number(rec.query.get('limit') ?? '20'), state.pageSize)
      const after = rec.query.get('after_id')
      const start = after ? state.models.indexOf(after) + 1 : 0
      const page = state.models.slice(start, start + limit)
      return sendJson(res, 200, {
        data: page.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-10-01T00:00:00Z' })),
        has_more: start + limit < state.models.length,
        first_id: page[0] ?? null,
        last_id: page[page.length - 1] ?? null
      })
    }

    if (rec.method === 'POST' && rec.path === '/v1/messages') {
      const b = rec.json
      if (!b || typeof b.model !== 'string' || typeof b.max_tokens !== 'number' || !Array.isArray(b.messages) || b.messages.length === 0) {
        return sendJson(res, 400, anthropicError('invalid_request_error', 'messages: Field required'))
      }
      if (req.headers['content-type'] !== 'application/json') {
        return sendJson(res, 400, anthropicError('invalid_request_error', 'content-type must be application/json'))
      }
      const stop = state.mode === 'max_tokens' ? 'max_tokens' : 'end_turn'
      if (b.stream !== true) {
        return sendJson(res, 200, {
          id: 'msg_fake_1',
          type: 'message',
          role: 'assistant',
          model: b.model,
          content: [{ type: 'text', text: state.chunks.join('') }],
          stop_reason: stop,
          stop_sequence: null,
          usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens }
        })
      }
      const nl = state.crlf ? '\r\n' : '\n'
      const send = (event: string, data: unknown): void => {
        if (alive(res)) res.write(`event: ${event}${nl}data: ${JSON.stringify(data)}${nl}${nl}`)
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`: stream open${nl}${nl}`)
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_fake_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: b.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: state.inputTokens, output_tokens: 1 }
        }
      })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send('ping', { type: 'ping' })
      for (let i = 0; i < state.chunks.length; i++) {
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: state.chunks[i] } })
        if (i === 0 && state.mode === 'stall') return
        if (i === 0 && state.mode === 'error_event') {
          send('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
          return void res.end()
        }
        if (i === 0 && state.mode === 'truncated') return void res.end()
        if (state.chunkDelayMs) await delay(state.chunkDelayMs)
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: state.outputTokens }
      })
      send('message_stop', { type: 'message_stop' })
      return void res.end()
    }

    return sendJson(res, 404, anthropicError('not_found_error', `Not found: ${rec.method} ${rec.path}`))
  }, fake)

  fake.url = server.url
  fake.close = server.close
  return fake
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

export type OpenAIMode =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'insufficient_quota'
  | 'server_error'
  | 'unavailable_503'
  | 'bad_request'
  // Streaming only: after the first text delta…
  | 'stall'
  | 'error_event'
  | 'truncated'
  // Streaming terminal event, and the end state of a background run:
  | 'failed'
  | 'incomplete'

export interface FakeBackgroundRun {
  id: string
  model: string
  polls: number
  cancelled: boolean
}

export interface FakeOpenAIState {
  mode: OpenAIMode
  key: string
  org: string | null
  models: string[]
  chunks: string[]
  inputTokens: number
  outputTokens: number
  retryAfter: string | null
  chunkDelayMs: number
  echoKeyInErrors: boolean
  failMessage: string
  // A background run reads in_progress until it has been polled this many
  // times, then reaches its end state.
  completeAfterPolls: number
  background: Map<string, FakeBackgroundRun>
}

export interface FakeOpenAI extends FakeBase {
  state: FakeOpenAIState
}

const openaiError = (message: string, type: string | null, code: string | null): unknown => ({
  error: { message, type, param: null, code }
})

// The snapshot the fake says it "ran", so tests can see the adapter report the
// provider's model rather than the requested alias.
export const OPENAI_SNAPSHOT_SUFFIX = '-2026-10-01'

export async function startFakeOpenAI(init: Partial<FakeOpenAIState> & { key: string }): Promise<FakeOpenAI> {
  const state: FakeOpenAIState = {
    mode: 'ok',
    org: null,
    models: ['gpt-5.5', 'gpt-5.4-mini-2026-08-01', 'text-embedding-3-small'],
    chunks: ['The ', 'answer', ' is 42', '. Ça va? 日本'],
    inputTokens: 31,
    outputTokens: 12,
    retryAfter: null,
    chunkDelayMs: 0,
    echoKeyInErrors: true,
    failMessage: 'The model failed to produce a response.',
    completeAfterPolls: 2,
    background: new Map(),
    ...init
  }
  const fake = { requests: [] as RecordedRequest[], abortedStreams: 0, state } as FakeOpenAI
  let n = 0
  let ids = 0

  const responseObject = (
    id: string,
    status: string,
    model: string,
    extra: { background?: boolean; store?: boolean; instructions?: unknown; maxOutput?: unknown } = {}
  ): Record<string, unknown> => {
    const done = status === 'completed' || status === 'incomplete'
    const text = status === 'incomplete' ? state.chunks.slice(0, 2).join('') : state.chunks.join('')
    return {
      id,
      object: 'response',
      created_at: 1764000000,
      status,
      background: extra.background ?? false,
      error: status === 'failed' ? { code: 'server_error', message: state.failMessage } : null,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      instructions: extra.instructions ?? null,
      max_output_tokens: extra.maxOutput ?? null,
      model: `${model}${OPENAI_SNAPSHOT_SUFFIX}`,
      output: done
        ? [
            { id: 'rs_fake_1', type: 'reasoning', summary: [] },
            {
              id: 'msg_fake_1',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }]
            }
          ]
        : [],
      usage: done || status === 'failed'
        ? {
            input_tokens: state.inputTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: state.outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: state.inputTokens + state.outputTokens
          }
        : null,
      store: extra.store ?? true,
      metadata: {}
    }
  }

  const backgroundStatus = (run: FakeBackgroundRun): string => {
    if (run.cancelled) return 'cancelled'
    if (run.polls < state.completeAfterPolls) return run.polls === 0 ? 'queued' : 'in_progress'
    return state.mode === 'failed' ? 'failed' : state.mode === 'incomplete' ? 'incomplete' : 'completed'
  }

  const server = await startServer(async (req, res, rec) => {
    res.setHeader('x-request-id', `req_fake_${++n}`)
    const auth = String(req.headers.authorization ?? '')
    if (state.mode === 'unauthorized' || auth !== `Bearer ${state.key}`) {
      const sent = auth.replace(/^Bearer /, '')
      return sendJson(
        res,
        401,
        openaiError(
          state.echoKeyInErrors ? `Incorrect API key provided: ${sent}. You can find your API key at https://platform.openai.com/account/api-keys.` : 'Incorrect API key provided.',
          'invalid_request_error',
          'invalid_api_key'
        )
      )
    }
    if (state.org) res.setHeader('openai-organization', state.org)
    const retry: Record<string, string> = state.retryAfter ? { 'retry-after': state.retryAfter } : {}
    switch (state.mode) {
      case 'forbidden':
        return sendJson(res, 403, openaiError('You have insufficient permissions for this operation. Missing scopes: api.responses.write.', 'invalid_request_error', null))
      case 'rate_limited':
        return sendJson(res, 429, openaiError('Rate limit reached for requests.', 'requests', 'rate_limit_exceeded'), {
          'retry-after': state.retryAfter ?? '5'
        })
      case 'insufficient_quota':
        return sendJson(
          res,
          429,
          openaiError('You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota')
        )
      case 'server_error':
        return sendJson(res, 500, openaiError('The server had an error while processing your request.', 'server_error', null), retry)
      case 'unavailable_503':
        return sendJson(res, 503, openaiError('The engine is currently overloaded, please try again later.', 'server_error', null), retry)
      case 'bad_request':
        return sendJson(res, 400, openaiError("Invalid value for 'max_output_tokens'.", 'invalid_request_error', 'invalid_value'))
      default:
        break
    }

    if (rec.method === 'GET' && rec.path === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: state.models.map((id) => ({ id, object: 'model', created: 1764000000, owned_by: 'system' }))
      })
    }

    if (rec.method === 'POST' && rec.path === '/v1/responses') {
      const b = rec.json
      if (!b || typeof b.model !== 'string' || !Array.isArray(b.input) || typeof b.max_output_tokens !== 'number') {
        return sendJson(res, 400, openaiError("Missing required parameter: 'input'.", 'invalid_request_error', 'missing_required_parameter'))
      }
      const extra = { background: b.background === true, store: b.store !== false, instructions: b.instructions, maxOutput: b.max_output_tokens }
      if (b.background === true) {
        if (b.store !== true) return sendJson(res, 400, openaiError('Background mode requires store=true.', 'invalid_request_error', null))
        if (b.stream === true) return sendJson(res, 400, openaiError('This fake does not stream background runs.', 'invalid_request_error', null))
        const id = `resp_fake${++ids}`
        state.background.set(id, { id, model: b.model, polls: 0, cancelled: false })
        return sendJson(res, 200, responseObject(id, 'queued', b.model, extra))
      }
      const id = `resp_fake${++ids}`
      if (b.stream !== true) {
        const status = state.mode === 'incomplete' ? 'incomplete' : 'completed'
        return sendJson(res, 200, responseObject(id, status, b.model, extra))
      }
      let seq = 0
      const send = (type: string, payload: Record<string, unknown>): void => {
        if (alive(res)) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`)
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      send('response.created', { response: responseObject(id, 'in_progress', b.model, extra) })
      send('response.in_progress', { response: responseObject(id, 'in_progress', b.model, extra) })
      send('response.output_item.added', { output_index: 0, item: { id: 'msg_fake_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
      send('response.content_part.added', { item_id: 'msg_fake_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      const deltas = state.mode === 'incomplete' ? state.chunks.slice(0, 2) : state.chunks
      for (let i = 0; i < deltas.length; i++) {
        send('response.output_text.delta', { item_id: 'msg_fake_1', output_index: 0, content_index: 0, delta: deltas[i], logprobs: [] })
        if (i === 0 && state.mode === 'stall') return
        if (i === 0 && state.mode === 'error_event') {
          send('error', { code: 'server_error', message: 'The server had an error while processing your request.', param: null })
          return void res.end()
        }
        if (i === 0 && state.mode === 'truncated') return void res.end()
        if (state.chunkDelayMs) await delay(state.chunkDelayMs)
      }
      send('response.output_text.done', { item_id: 'msg_fake_1', output_index: 0, content_index: 0, text: deltas.join('') })
      if (state.mode === 'failed') send('response.failed', { response: responseObject(id, 'failed', b.model, extra) })
      else if (state.mode === 'incomplete') send('response.incomplete', { response: responseObject(id, 'incomplete', b.model, extra) })
      else send('response.completed', { response: responseObject(id, 'completed', b.model, extra) })
      return void res.end()
    }

    const m = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(rec.path)
    if (m) {
      const run = state.background.get(m[1])
      if (!run) return sendJson(res, 404, openaiError(`No response found with id '${m[1]}'.`, 'invalid_request_error', null))
      const extra = { background: true, store: true }
      if (m[2] && rec.method === 'POST') {
        if (backgroundStatus(run) !== 'completed') run.cancelled = true
        return sendJson(res, 200, responseObject(run.id, backgroundStatus(run), run.model, extra))
      }
      if (!m[2] && rec.method === 'GET') {
        run.polls++
        return sendJson(res, 200, responseObject(run.id, backgroundStatus(run), run.model, extra))
      }
    }

    return sendJson(res, 404, openaiError(`Invalid URL (${rec.method} ${rec.path})`, 'invalid_request_error', null))
  }, fake)

  fake.url = server.url
  fake.close = server.close
  return fake
}
