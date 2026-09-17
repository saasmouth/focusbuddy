#!/usr/bin/env node
'use strict'

// Plexii MCP bridge — stdio in, Plexii's local /mcp endpoint out.
//
// Why this exists: Claude Desktop (and Cowork) only run LOCAL MCP servers over
// stdio; their "remote" connectors are brokered from Anthropic's cloud and can
// never reach 127.0.0.1. Plexii's MCP surface lives on the PlexiAPI server
// bound to loopback (apiServer.ts → mcpServer.ts). This bridge is the adapter:
// it reads newline-delimited JSON-RPC from stdin, POSTs each message to Plexii
// with the bearer token, and writes the reply back on stdout. It has no
// opinion about the protocol — every capability, tool and refusal is decided
// by Plexii itself, so adding a tool in the app needs no change here.
//
// Deliberately dependency-free (node:http, node:readline only) so the .mcpb
// bundle is a handful of kilobytes and there is nothing to audit.
//
// Refusals:
//   - Loopback only. A URL whose host is not 127.0.0.1 / localhost / ::1 is
//     refused at startup: this bridge exists to keep data on the machine, and
//     it will not be used to tunnel a token to somewhere else.
//   - The token is never logged. Errors mention that auth failed, never what
//     was sent.
//
// Claude Code does NOT need this bridge: it can send bearer headers to an HTTP
// MCP server directly (`claude mcp add --transport http …`). See README.md.

const http = require('node:http')
const readline = require('node:readline')

const URL_RAW = (process.env.PLEXII_MCP_URL || 'http://127.0.0.1:8787/mcp').trim()
const TOKEN = (process.env.PLEXII_API_TOKEN || '').trim()
const TIMEOUT_MS = Number(process.env.PLEXII_MCP_TIMEOUT_MS || 120000)

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function log(msg) {
  // stdout is the protocol channel; diagnostics go to stderr, which Claude
  // Desktop shows in its MCP logs.
  process.stderr.write(`[plexii-mcp-bridge] ${msg}\n`)
}

function fatal(msg) {
  log(msg)
  process.exit(1)
}

let target
try {
  target = new URL(URL_RAW)
} catch {
  fatal(`PLEXII_MCP_URL is not a valid URL: ${URL_RAW}`)
}
if (target.protocol !== 'http:') fatal('Plexii is a local server: the URL must be http://, not https://.')
if (!LOOPBACK.has(target.hostname)) fatal(`Refusing a non-loopback host (${target.hostname}). This bridge only talks to the Plexii on this machine.`)
if (!TOKEN) fatal('PLEXII_API_TOKEN is empty. Create a token in Plexii under PlexiBrain → APIs and paste it into the extension settings.')

/** POST one JSON-RPC payload (message or batch). Resolves {status, body}. */
function post(payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = http.request(
      {
        host: target.hostname === '[::1]' ? '::1' : target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TOKEN}`,
          'Content-Length': data.length
        },
        timeout: TIMEOUT_MS
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error(`Plexii did not answer within ${TIMEOUT_MS} ms`)))
    req.on('error', reject)
    req.end(data)
  })
}

/** A JSON-RPC error for every request in the payload that carried an id, so
 *  the host shows a real message instead of hanging on a lost reply. */
function errorsFor(payload, code, message) {
  const msgs = Array.isArray(payload) ? payload : [payload]
  const out = msgs
    .filter((m) => m && typeof m === 'object' && m.id !== undefined && m.id !== null)
    .map((m) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } }))
  if (out.length === 0) return null
  return Array.isArray(payload) ? out : out[0]
}

function explain(status, body) {
  if (status === 401) return 'Plexii rejected the token (401). Check the token in the extension settings; it may have been revoked.'
  if (status === 403) return `Plexii refused the request (403): ${body || 'no detail'}`
  if (status === 404) return 'Plexii answered 404 for /mcp — the URL path is wrong or this Plexii is too old for MCP.'
  return `Plexii answered HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

// Requests run CONCURRENTLY. JSON-RPC correlates a reply to its request by
// `id`, and MCP does not require replies in arrival order, so serialising buys
// nothing and costs a lot: one slow call (a flow, a big search) would block
// every other message behind it — including `ping` — and the host would look
// hung for as long as it took. Each reply is written with a single
// process.stdout.write, so concurrent replies cannot interleave mid-line.
//
// In-flight work is tracked only so close/exit can wait for it rather than
// cutting a reply off half-written.
const inFlight = new Set()

function track(p) {
  inFlight.add(p)
  p.finally(() => inFlight.delete(p))
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let payload
  try {
    payload = JSON.parse(trimmed)
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } })
    return
  }
  track((async () => {
    try {
      const { status, body } = await post(payload)
      if (status === 202 || (status === 200 && !body.trim())) return // notification: no reply
      if (status !== 200) {
        const err = errorsFor(payload, -32000, explain(status, body))
        if (err) write(err)
        else log(explain(status, body))
        return
      }
      let reply
      try {
        reply = JSON.parse(body)
      } catch {
        const err = errorsFor(payload, -32700, 'Plexii returned a reply that was not JSON.')
        if (err) write(err)
        return
      }
      write(reply)
    } catch (e) {
      const reason = e && e.code === 'ECONNREFUSED'
        ? `Plexii is not reachable at ${URL_RAW}. Is Plexii running with the API server turned on (PlexiBrain → APIs)?`
        : `Could not reach Plexii: ${e && e.message ? e.message : String(e)}`
      const err = errorsFor(payload, -32001, reason)
      if (err) write(err)
      else log(reason)
    }
  })())
})

rl.on('close', () => {
  // Let anything still in flight finish writing its reply before exiting.
  Promise.allSettled([...inFlight]).then(() => process.exit(0))
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
