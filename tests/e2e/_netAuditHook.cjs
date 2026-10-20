// Preloaded into Electron's MAIN process (NODE_OPTIONS=--require) by
// _networkInventory.spec.ts. Records every outbound socket Node opens: global
// fetch (undici), http/https, ws, IMAP/SMTP — anything that ends in
// net.Socket#connect. Chromium-side traffic (renderer fetch, WebSockets,
// webviews, images, Electron's net module) is not visible here; the spec
// captures that with Chromium's --log-net-log. Together they cover both stacks.
//
// One JSON line per connection to $PLEXII_NETAUDIT_FILE. Local/loopback and
// IPC-path sockets are recorded too and filtered by the spec, so nothing is
// silently dropped here.

'use strict'
const fs = require('fs')
const net = require('net')

const out = process.env.PLEXII_NETAUDIT_FILE
if (out) {
  const log = (rec) => {
    try {
      fs.appendFileSync(out, JSON.stringify({ t: Date.now(), ...rec }) + '\n')
    } catch {
      /* never break the app under audit */
    }
  }
  const origConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    try {
      let opts = args[0]
      if (Array.isArray(opts)) opts = opts[0]
      let host
      let port
      let path
      if (opts && typeof opts === 'object') {
        host = opts.host || opts.hostname
        port = opts.port
        path = opts.path
      } else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) {
        port = Number(opts)
        host = typeof args[1] === 'string' ? args[1] : 'localhost'
      } else if (typeof opts === 'string') {
        path = opts
      }
      // TLS sockets carry the SNI name, which is the real destination when the
      // socket itself was given an IP (undici connects by resolved address).
      const servername = opts && typeof opts === 'object' ? opts.servername : undefined
      log({ stack: 'node', host: servername || host || null, port: port || null, path: path || null })
    } catch {
      /* ignore */
    }
    return origConnect.apply(this, args)
  }
  const dns = require('dns')
  const origLookup = dns.lookup
  dns.lookup = function (hostname, ...rest) {
    log({ stack: 'node-dns', host: hostname })
    return origLookup.call(this, hostname, ...rest)
  }
}
