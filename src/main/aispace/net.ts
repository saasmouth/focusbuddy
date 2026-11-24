// The one network door for Connections (SPEC-CONNECTIONS.md §3, §5).
//
// Every provider, MCP and app-API request goes through `guardedFetch`:
//  - the URL must pass validateEndpoint (https, no userinfo, no private hosts);
//  - the request must stay on ONE approved origin, so a credential attached by
//    the caller can only ever reach the origin it was approved for;
//  - the hostname is resolved and refused if any address is private (unless
//    loopback is explicitly allowed for tests and local reference servers);
//  - redirects are never followed automatically: a same-origin redirect is
//    followed at most 3 times, a cross-origin one is refused;
//  - every request has a timeout.
//
// It uses globalThis.fetch so Plexii's own AI egress guard (local-only mode)
// sees and can refuse AI calls; callers run AI calls inside withCloudGrant.
//
// Known limit, stated rather than hidden: the DNS check and the connection are
// two lookups, so a hostile resolver could rebind between them. The origin pin
// still keeps credentials on the approved hostname.

import { lookup } from 'node:dns/promises'
import { isPrivateAddress, validateEndpoint } from '@shared/aispace/netPolicy'

export class EgressRefused extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_endpoint' | 'origin_mismatch' | 'private_destination' | 'redirect_refused' | 'timeout'
  ) {
    super(message)
    this.name = 'EgressRefused'
  }
}

export interface GuardOptions {
  // The only origin this request (and any redirect) may reach.
  allowedOrigin: string
  allowLoopback?: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
  resolve?: (host: string) => Promise<string[]>
}

// Tests and local reference servers opt in to loopback through this switch; it
// is read once per call so a test can flip it.
export function loopbackAllowedByEnv(): boolean {
  return process.env.AISPACE_ALLOW_LOOPBACK === '1'
}

async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true, verbatim: true })
  return res.map((r) => r.address)
}

export async function checkDestination(rawUrl: string, opts: Pick<GuardOptions, 'allowedOrigin' | 'allowLoopback' | 'resolve'>): Promise<URL> {
  const allowLoopback = opts.allowLoopback ?? loopbackAllowedByEnv()
  const v = validateEndpoint(rawUrl, { allowLoopback })
  if (!v.ok || !v.url) throw new EgressRefused(v.reason, 'invalid_endpoint')
  if (v.origin !== new URL(opts.allowedOrigin).origin) {
    throw new EgressRefused(`Refused: ${v.origin} is not the approved origin ${new URL(opts.allowedOrigin).origin}.`, 'origin_mismatch')
  }
  const host = v.url.hostname.replace(/^\[|\]$/g, '')
  const isLiteral = /^[\d.]+$/.test(host) || host.includes(':')
  if (!isLiteral && !(allowLoopback && host === 'localhost')) {
    let addrs: string[] = []
    try {
      addrs = await (opts.resolve ?? defaultResolve)(host)
    } catch {
      throw new EgressRefused(`Couldn’t find ${host}.`, 'invalid_endpoint')
    }
    const priv = addrs.find((a) => isPrivateAddress(a) && !(allowLoopback && (a === '127.0.0.1' || a === '::1')))
    if (priv) throw new EgressRefused(`Refused: ${host} points at a private address.`, 'private_destination')
  }
  return v.url
}

export async function guardedFetch(rawUrl: string, init: RequestInit, opts: GuardOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  let url = await checkDestination(rawUrl, opts)
  const timeoutMs = opts.timeoutMs ?? 30_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  for (let hop = 0; hop < 4; hop++) {
    let res: Response
    try {
      res = await doFetch(url.toString(), { ...init, signal, redirect: 'manual' })
    } catch (e) {
      if (timeout.aborted) throw new EgressRefused(`No answer from ${url.host} within ${Math.round(timeoutMs / 1000)} s.`, 'timeout')
      throw e
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    const next = new URL(loc, url)
    if (next.origin !== url.origin) {
      throw new EgressRefused(`Refused a redirect from ${url.origin} to ${next.origin}.`, 'redirect_refused')
    }
    if (hop === 3) throw new EgressRefused('Too many redirects.', 'redirect_refused')
    url = await checkDestination(next.toString(), opts)
  }
  throw new EgressRefused('Too many redirects.', 'redirect_refused')
}
