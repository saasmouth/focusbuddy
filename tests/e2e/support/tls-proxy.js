#!/usr/bin/env node
// Minimal TLS-terminating reverse proxy: https/wss on LISTEN_PORT -> plain
// http/ws on BACKEND_PORT (a local focusbuddy-signal dev instance).
//
// Exists purely to satisfy the built Electron app's Content-Security-Policy
// (connect-src 'self' ws: wss: https:), which explicitly disallows a plain
// http: fetch() but allows both wss: and (unencrypted) ws:. Fetch calls from
// the renderer to a local plain-http test signal server are refused outright
// by the CSP — verified directly, see tests/e2e/orgSyncTwoWindowLive.spec.ts
// for the full writeup. Putting an HTTPS front end (self-signed cert) on the
// same local server lets a specially-built test app (VITE_SIGNAL_HTTP_URL /
// VITE_SIGNAL_WS_URL pointed at this proxy) drive real sign-in and real sync
// network calls end to end. No application source is touched; the self-signed
// cert is accepted by launching Electron with the Chromium
// `--ignore-certificate-errors` switch.
//
// Usage: node tests/e2e/support/tls-proxy.js [listenPort] [backendPort]
//   defaults: listenPort=8791 backendPort=8790
//
// Generates a throwaway self-signed cert for localhost on first run (next to
// this script) if one isn't already present; certs are gitignored.
const https = require('node:https')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const LISTEN_PORT = Number(process.argv[2] || process.env.LISTEN_PORT || 8791)
const BACKEND_PORT = Number(process.argv[3] || process.env.BACKEND_PORT || 8790)
const DIR = __dirname
const KEY_PATH = path.join(DIR, 'localhost-key.pem')
const CERT_PATH = path.join(DIR, 'localhost-cert.pem')

function ensureCert() {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) return
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        KEY_PATH,
        '-out',
        CERT_PATH,
        '-days',
        '365',
        '-nodes',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1'
      ],
      { stdio: 'inherit' }
    )
  } catch (err) {
    console.error('Could not generate a self-signed cert via openssl:', err.message)
    console.error('Install openssl, or supply localhost-key.pem / localhost-cert.pem in', DIR)
    process.exit(1)
  }
}

ensureCert()

const options = { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) }

// Opt-in request log (TLS_PROXY_LOG=1). Off by default so ordinary runs stay
// quiet, but worth having: when a live spec fails with a message that makes no
// sense, the first question is what the app actually sent and what came back,
// and without this the proxy is a black box. A 502 raised HERE never reaches
// the backend's log at all, so the backend looking idle proves nothing.
const LOG = process.env.TLS_PROXY_LOG === '1'
const log = (...a) => {
  if (LOG) console.log('[proxy]', ...a)
}

const server = https.createServer(options, (clientReq, clientRes) => {
  const started = Date.now()
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: BACKEND_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers
    },
    (proxyRes) => {
      log(clientReq.method, clientReq.url, '->', proxyRes.statusCode, `${Date.now() - started}ms`)
      clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(clientRes)
    }
  )
  proxyReq.on('error', (err) => {
    // PLAIN TEXT, deliberately left as it is: this is what a gateway in front
    // of a real server does, and a client that mistranslates it is a client
    // bug. One did — sign-in reported "Invalid email or password." for a 502
    // whose body had no `error` field, which is how a correct password came
    // to look wrong. Fixed in accountClient; the shape stays realistic so
    // nothing re-learns the lesson by being handed tidy JSON.
    log('BACKEND UNREACHABLE', clientReq.method, clientReq.url, '->', err.message)
    clientRes.writeHead(502)
    clientRes.end(`proxy error: ${err.message}`)
  })
  clientReq.pipe(proxyReq)
})

// WebSocket upgrade proxying: raw TCP to the backend, replay the original
// upgrade request line + headers, then pipe bytes both ways.
server.on('upgrade', (req, clientSocket, head) => {
  const backendSocket = net.connect(BACKEND_PORT, '127.0.0.1', () => {
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
    headerLines.push('', '')
    backendSocket.write(headerLines.join('\r\n'))
    if (head && head.length) backendSocket.write(head)
    clientSocket.pipe(backendSocket)
    backendSocket.pipe(clientSocket)
  })
  backendSocket.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => backendSocket.destroy())
})

server.listen(LISTEN_PORT, () => {
  console.log(`TLS proxy listening on https://localhost:${LISTEN_PORT} -> http://127.0.0.1:${BACKEND_PORT}`)
})
