import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { verifyToken, getApiConfig } from './db/apiTokens'
import { listNodes, createNode } from './db/nodes'
import { listTables, getTable, listRows, createRow } from './db/tables'
import { listKnowledge, createKnowledge } from './db/knowledge'
import { getFlow, runFlow } from './db/flows'
import type { ApiScope } from '@shared/apiAccess'
import { app } from 'electron'
import { handleWorkspaceMcpBody, liveWorkspaceDeps } from './mcpServer'

// The PlexiAPI local server. A small REST surface over the workspace, bound only
// to 127.0.0.1 so it is never reachable off the machine, and gated by a bearer
// token whose scopes decide read versus write. It is started only when the user
// enables it; nothing here opens a port on its own. Every handler reads and
// writes the same real stores the app uses, so the API can never return invented
// data, and an unknown token gets a clean 401 rather than any data at all.
//
// Defense in depth for a localhost server: any request carrying an Origin header
// is rejected, because a browser always attaches Origin on a cross-site request,
// so this blocks a malicious web page from driving the API even if a token leaks,
// while leaving header-less CLI and script callers untouched.

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1_000_000

// Track live sockets so disabling the server can drop in-flight connections at
// once rather than waiting for keep-alive to drain.
const sockets = new Set<import('net').Socket>()

let server: Server | null = null
let runningPort = 0

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(json)
}

type BodyResult = { ok: true; value: unknown } | { ok: false; reason: 'malformed' | 'too_large' }

function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (r: BodyResult): void => {
      if (done) return
      done = true
      resolve(r)
    }
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      // Reject an oversized body rather than truncating it into corrupt JSON.
      // Resolve now and stop buffering, but do NOT destroy the request here: the
      // handler still needs the open socket to write the 413 back. Pausing stops
      // us reading more of the oversized body while the response is sent.
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, reason: 'too_large' })
        req.pause()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return finish({ ok: true, value: {} })
      try {
        finish({ ok: true, value: JSON.parse(raw) })
      } catch {
        finish({ ok: false, reason: 'malformed' })
      }
    })
    req.on('error', () => finish({ ok: false, reason: 'malformed' }))
  })
}

function authScopes(req: IncomingMessage): ApiScope[] | null {
  const header = req.headers['authorization']
  if (!header || Array.isArray(header)) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const found = verifyToken(m[1].trim())
  return found ? found.scopes : null
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Block any browser-originated request. Browsers always attach Origin on a
  // cross-site request; CLI tools and scripts do not. This is the primary guard
  // that keeps a malicious web page from reaching the API at all.
  if (req.headers['origin']) return send(res, 403, { error: 'Cross-origin requests are not permitted.' })

  // DNS-rebinding guard: a rebinding page makes same-origin (Origin-less) simple
  // requests to its own hostname rebound to 127.0.0.1, slipping past the Origin
  // check above. Require the Host header to be loopback so only genuinely local
  // callers reach the API (the token-less webhook route especially).
  const host = (req.headers['host'] || '').split(':')[0].toLowerCase()
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
    return send(res, 403, { error: 'Only loopback host is permitted.' })
  }

  const url = new URL(req.url || '/', `http://${HOST}`)
  const path = url.pathname
  const method = (req.method || 'GET').toUpperCase()

  // Liveness probe, still behind the Origin guard above so browsers cannot use it
  // to fingerprint the app.
  if (path === '/api/health') return send(res, 200, { ok: true })

  // Inbound webhook trigger: POST /webhooks/:flowId runs a flow whose trigger is
  // 'webhook'. No bearer token — the flow id (a UUID) is the shared secret. Bound
  // to 127.0.0.1 like everything here, so an external service needs a tunnel to
  // reach it; local tools and scripts can call it directly.
  const hookMatch = path.match(/^\/webhooks\/([^/]+)$/)
  if (hookMatch && method === 'POST') {
    const flow = getFlow(hookMatch[1])
    if (!flow || flow.trigger.kind !== 'webhook' || !flow.enabled) {
      return send(res, 404, { error: 'No active webhook flow with that id.' })
    }
    const result = await runFlow(flow.id)
    return send(res, 200, { ok: result.ok, ran: true })
  }

  const scopes = authScopes(req)
  if (!scopes) return send(res, 401, { error: 'Missing or invalid bearer token.' })

  // POST /mcp — Plexii over MCP (Streamable HTTP, stateless JSON replies).
  // MCP speaks POST for reads AND writes, so this route asks for the READ
  // scope explicitly instead of riding the method-based write gate below,
  // and hands the token's scopes to the dispatcher: write tools are hidden
  // from, and refused to, a read-only token (mcpServer.ts / mcpProtocol.ts).
  // Auth, loopback and the Origin/rebind guards are the same ones every
  // PlexiAPI request already passed.
  if (path === '/mcp') {
    if (method !== 'POST') return send(res, 405, { error: 'MCP speaks POST here.' })
    if (!scopes.includes('read') && !scopes.includes('write'))
      return send(res, 403, { error: 'This token has no read scope.' })
    const b = await readBody(req)
    if (!b.ok) {
      return send(res, b.reason === 'too_large' ? 413 : 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: b.reason === 'too_large' ? 'Request too large.' : 'Parse error.' }
      })
    }
    const reply = await handleWorkspaceMcpBody(b.value, await liveWorkspaceDeps(app.getVersion()), { scopes })
    if (reply === null) {
      res.writeHead(202)
      res.end()
      return
    }
    return send(res, 200, reply)
  }

  const needWrite = method === 'POST'
  if (needWrite && !scopes.includes('write')) return send(res, 403, { error: 'This token is read-only.' })
  if (!needWrite && !scopes.includes('read') && !scopes.includes('write'))
    return send(res, 403, { error: 'This token has no read scope.' })

  // GET /api/tasks
  if (method === 'GET' && path === '/api/tasks') {
    const tasks = listNodes().filter((n) => n.kind === 'task').map((n) => ({ id: n.id, title: n.title, status: n.status }))
    return send(res, 200, { tasks })
  }
  // Parse a JSON body once, mapping the two failure modes to honest status codes.
  const parseBody = async (): Promise<
    { ok: true; value: Record<string, unknown> } | { ok: false }
  > => {
    const b = await readBody(req)
    if (!b.ok) {
      send(res, b.reason === 'too_large' ? 413 : 400, {
        error: b.reason === 'too_large' ? 'Request body too large.' : 'Malformed JSON body.'
      })
      // For an oversized body the client may still be uploading; once the 413 has
      // flushed, tear the socket down so it frees promptly rather than lingering
      // until the request timeout.
      if (b.reason === 'too_large') res.on('finish', () => req.destroy())
      return { ok: false }
    }
    return { ok: true, value: (b.value && typeof b.value === 'object' ? b.value : {}) as Record<string, unknown> }
  }

  // POST /api/tasks
  if (method === 'POST' && path === '/api/tasks') {
    const body = await parseBody()
    if (!body.ok) return
    const node = createNode({ parentId: null, kind: 'task', title: String(body.value.title || 'Untitled task') })
    return send(res, 201, { task: { id: node.id, title: node.title } })
  }
  // GET /api/tables
  if (method === 'GET' && path === '/api/tables') {
    return send(res, 200, { tables: listTables().map((t) => ({ id: t.id, title: t.title })) })
  }
  // /api/tables/:id/rows
  const rowsMatch = path.match(/^\/api\/tables\/([^/]+)\/rows$/)
  if (rowsMatch) {
    const tableId = decodeURIComponent(rowsMatch[1])
    // Validate the table exists so a typo or deleted id is a clean 404 rather
    // than an empty list (GET) or an orphan row (POST).
    if (!getTable(tableId)) return send(res, 404, { error: 'Unknown table.' })
    if (method === 'GET') return send(res, 200, { rows: listRows(tableId).map((r) => ({ id: r.id, cells: r.cells })) })
    if (method === 'POST') {
      const body = await parseBody()
      if (!body.ok) return
      const cells = (body.value.cells && typeof body.value.cells === 'object' ? body.value.cells : {}) as Record<string, unknown>
      const row = createRow({ tableId, cells })
      return send(res, 201, { row: { id: row.id, cells: row.cells } })
    }
  }
  // GET /api/knowledge
  if (method === 'GET' && path === '/api/knowledge') {
    return send(res, 200, { knowledge: listKnowledge().map((k) => ({ id: k.id, title: k.title, body: k.body })) })
  }
  // POST /api/knowledge
  if (method === 'POST' && path === '/api/knowledge') {
    const body = await parseBody()
    if (!body.ok) return
    const entry = createKnowledge({ title: String(body.value.title || 'Untitled entry'), body: String(body.value.body || '') })
    return send(res, 201, { knowledge: { id: entry.id, title: entry.title } })
  }

  return send(res, 404, { error: 'Unknown endpoint.' })
}

// Start the server on the given port, bound to localhost only. Resolves with the
// running state: ok false (and a reason) when the port is busy, so the UI can be
// honest rather than claim a server that is not actually listening.
export function startApiServer(port: number): Promise<{ ok: boolean; port: number; error?: string }> {
  return new Promise((resolve) => {
    if (server) {
      // Already running. Only report success if it is the requested port, so the
      // caller is never told it bound a port it did not.
      if (runningPort === port) return resolve({ ok: true, port: runningPort })
      return resolve({ ok: false, port, error: `Server already running on port ${runningPort}.` })
    }
    const s = createServer((req, res) => {
      void handle(req, res).catch(() => send(res, 500, { error: 'Internal error.' }))
    })
    // Pin timeouts so a slow client cannot hold a connection open indefinitely,
    // independent of Node version defaults.
    s.requestTimeout = 30_000
    s.headersTimeout = 20_000
    s.on('connection', (sock) => {
      sockets.add(sock)
      sock.on('close', () => sockets.delete(sock))
    })
    s.once('error', (err: NodeJS.ErrnoException) => {
      server = null
      resolve({ ok: false, port, error: err.code === 'EADDRINUSE' ? `Port ${port} is in use.` : err.message })
    })
    s.listen(port, HOST, () => {
      server = s
      runningPort = port
      resolve({ ok: true, port })
    })
  })
}

export function stopApiServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    const s = server
    // Drop in-flight and keep-alive sockets so the port frees immediately rather
    // than waiting for connections to drain.
    for (const sock of sockets) sock.destroy()
    sockets.clear()
    s.close(() => {
      server = null
      runningPort = 0
      resolve()
    })
  })
}

export function isApiServerRunning(): boolean {
  return server !== null
}

export function runningApiPort(): number {
  return runningPort
}

// On app start, bring the server up only if the user previously enabled it.
export async function initApiServer(): Promise<void> {
  const cfg = getApiConfig()
  if (cfg.enabled) await startApiServer(cfg.port)
}
