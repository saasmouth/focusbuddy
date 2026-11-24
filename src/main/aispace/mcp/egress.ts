// Where the MCP client may send, and how "the resource" is spelled.
//
// Every request goes through guardedFetch (../net.ts) pinned to the ONE origin
// it is meant for. This file decides, per URL, whether loopback is allowed:
//
//  - A person may type a server on this computer (http://127.0.0.1:3000/mcp).
//    The connection then carries `localEndpoint: true`, and loopback is allowed
//    for that same loopback host only — never for anything else.
//  - For a remote endpoint, every URL the server hands us (resource metadata,
//    authorization servers, their endpoints) that is loopback or private is
//    refused. Otherwise a hostile remote server could steer Plexii at services
//    on the person's own machine or network.
//
// AISPACE_ALLOW_LOOPBACK / `allowLoopback` stays as a tests-only override.

import { isLoopback, validateEndpoint } from '@shared/aispace/netPolicy'
import { checkDestination, guardedFetch, loopbackAllowedByEnv } from '../net'
import { McpError, fromNetworkError } from './errors'

export interface McpNetOptions {
  // The person typed a loopback address for this connection. Allowed only when
  // the configured endpoint's host really is loopback.
  localEndpoint?: boolean
  // Tests only: allow loopback for every URL. Defaults to AISPACE_ALLOW_LOOPBACK.
  allowLoopback?: boolean
  fetchImpl?: typeof fetch
  resolve?: (host: string) => Promise<string[]>
}

// One spelling of "the resource" (RFC 8707, MCP authorization): scheme and
// host lower-cased, default port dropped, no query or fragment, no trailing
// slash. Tokens are stored against this string and compared with it, so one
// server can never be spelled two ways.
export function canonicalResource(raw: string): string {
  const u = new URL(raw)
  const path = u.pathname.replace(/\/+$/, '')
  return path ? `${u.origin}${path}` : u.origin
}

// Same origin and path, tolerant of a trailing slash (RFC 9728 §3.3 check).
export function sameResource(a: string, b: string): boolean {
  try {
    return canonicalResource(a) === canonicalResource(b)
  } catch {
    return false
  }
}

function hostnameOf(raw: string): string {
  return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

export class EgressPolicy {
  readonly endpoint: string
  readonly origin: string
  private readonly localHost: string | null
  private readonly override: boolean

  constructor(endpoint: string, readonly net: McpNetOptions = {}) {
    this.override = net.allowLoopback ?? loopbackAllowedByEnv()
    let host: string
    try {
      host = hostnameOf(endpoint)
    } catch {
      throw new McpError('refused', 'That isn’t a valid web address.', { reason: 'invalid_endpoint' })
    }
    const loop = isLoopback(host)
    if (net.localEndpoint && !loop) {
      // The flag is a promise about the typed address. A name that merely
      // resolves to this machine does not count.
      throw new McpError('refused', 'Only an address on this computer (127.0.0.1, ::1 or localhost) can be a local server.', {
        reason: 'not_local'
      })
    }
    if (loop && !net.localEndpoint && !this.override) {
      throw new McpError('refused', 'This address is on this computer. Mark the connection as a local server to use it.', {
        reason: 'loopback_not_confirmed'
      })
    }
    this.localHost = loop && net.localEndpoint ? host : null
    const v = validateEndpoint(endpoint, { allowLoopback: this.loopbackFor(endpoint) })
    if (!v.ok || !v.url || !v.origin) throw new McpError('refused', v.reason, { reason: 'invalid_endpoint' })
    this.endpoint = v.url.toString()
    this.origin = v.origin
  }

  // Loopback is allowed only for the loopback host the person typed.
  loopbackFor(url: string): boolean {
    if (this.override) return true
    if (!this.localHost) return false
    try {
      return hostnameOf(url) === this.localHost
    } catch {
      return false
    }
  }

  // Validate a URL the server handed us, before we use it at all.
  check(url: string, what: string): URL {
    const v = validateEndpoint(url, { allowLoopback: this.loopbackFor(url) })
    if (!v.ok || !v.url) {
      throw new McpError('refused', `Refused the ${what} this server named: ${v.reason}`, { reason: 'unsafe_discovered_url' })
    }
    return v.url
  }

  // The DNS half of the check, for a URL we hand to the browser rather than
  // fetch ourselves (the authorization endpoint).
  async checkResolves(url: string, what: string): Promise<void> {
    this.check(url, what)
    try {
      await checkDestination(url, { allowedOrigin: new URL(url).origin, allowLoopback: this.loopbackFor(url), resolve: this.net.resolve })
    } catch (e) {
      const err = fromNetworkError(e, new URL(url).host)
      throw new McpError('refused', `Refused the ${what} this server named: ${err.message}`, { reason: 'unsafe_discovered_url' })
    }
  }

  // Every request: pinned to `allowedOrigin`, loopback only when allowed for it.
  fetch(url: string, init: RequestInit, allowedOrigin: string, timeoutMs: number): Promise<Response> {
    return guardedFetch(url, init, {
      allowedOrigin,
      allowLoopback: this.loopbackFor(url),
      timeoutMs,
      fetchImpl: this.net.fetchImpl,
      resolve: this.net.resolve
    })
  }
}
