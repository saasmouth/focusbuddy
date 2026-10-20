// The egress guard: while the AI source is "Local on this device", no request
// may reach an AI service from the main process. It wraps the three ways main
// makes HTTP requests — global fetch (the Anthropic SDK, OpenAI calls, web
// search), node:https and node:http — and refuses, before any connection is
// opened, a request to:
//
//   - an AI provider API (Anthropic, OpenAI, remove.bg),
//   - Plexii's own AI proxy (the signal server's /ai/ routes),
//   - the web search the assistant uses (DuckDuckGo), because the query it
//     sends is the user's question.
//
// unless the current async context holds a cloud grant (providerRouter.ts):
// the user said yes to "use cloud for this request", or routed that feature to
// cloud. Everything else — sync, sign-in, model downloads, the user's own
// browsing in a browser work widget (a renderer webContents, not main) — is not
// AI traffic and passes untouched.
//
// This is defence in depth. The router already sends local work to the device;
// the guard is what makes the promise hold for a code path nobody routed.

import http from 'node:http'
import https from 'node:https'

export class LocalOnlyEgressError extends Error {
  constructor(public readonly host: string) {
    super(
      `Blocked: AI is set to run on this device, so nothing is sent to ${host}. ` +
        'Choose a cloud AI source in Settings → AI to use this.'
    )
    this.name = 'LocalOnlyEgressError'
  }
}

const AI_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.remove.bg',
  'duckduckgo.com',
  'html.duckduckgo.com',
  'lite.duckduckgo.com',
  'links.duckduckgo.com'
]

/**
 * Is this URL AI traffic? `signalBase` is the Plexii signal server, whose
 * /ai/ routes are the credits proxy. Exported for tests.
 */
export function isAiServiceUrl(raw: string, signalBase: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase()
  if (AI_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true
  try {
    const s = new URL(signalBase)
    if (host === s.hostname.toLowerCase() && u.pathname.startsWith('/ai/')) return true
  } catch {
    /* an unparseable signal base cannot match anything */
  }
  return false
}

function urlOfFetchInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url)
  return ''
}

function urlOfRequestArgs(proto: 'http:' | 'https:', args: unknown[]): string {
  const a = args[0]
  if (typeof a === 'string') return a
  if (a instanceof URL) return a.href
  if (a && typeof a === 'object') {
    const o = a as { protocol?: string; hostname?: string; host?: string; port?: number | string; path?: string }
    const host = o.hostname ?? (o.host ? String(o.host).split(':')[0] : 'localhost')
    return `${o.protocol ?? proto}//${host}${o.port ? `:${o.port}` : ''}${o.path ?? '/'}`
  }
  return ''
}

export interface EgressGuardDeps {
  /** True while nothing AI-related may leave (source Local, no grant). */
  localOnly: () => boolean
  signalBase: string
  onBlocked?: (host: string) => void
}

let installed: { restore: () => void } | null = null

/** Install the guard (idempotent). Returns a function that removes it (tests). */
export function installEgressGuard(deps: EgressGuardDeps): () => void {
  if (installed) installed.restore()
  const check = (raw: string): void => {
    if (!raw || !deps.localOnly() || !isAiServiceUrl(raw, deps.signalBase)) return
    const host = (() => {
      try {
        return new URL(raw).hostname
      } catch {
        return 'an AI service'
      }
    })()
    deps.onBlocked?.(host)
    throw new LocalOnlyEgressError(host)
  }

  const origFetch = globalThis.fetch
  const guardedFetch = ((input: unknown, init?: unknown) => {
    try {
      check(urlOfFetchInput(input))
    } catch (e) {
      return Promise.reject(e)
    }
    return (origFetch as (i: unknown, n?: unknown) => Promise<Response>)(input, init)
  }) as typeof fetch
  globalThis.fetch = guardedFetch

  const wrap = <M extends typeof http | typeof https>(mod: M, proto: 'http:' | 'https:') => {
    const origRequest = mod.request
    const origGet = mod.get
    ;(mod as { request: unknown }).request = (...args: unknown[]) => {
      check(urlOfRequestArgs(proto, args))
      return (origRequest as (...a: unknown[]) => unknown)(...args)
    }
    ;(mod as { get: unknown }).get = (...args: unknown[]) => {
      check(urlOfRequestArgs(proto, args))
      return (origGet as (...a: unknown[]) => unknown)(...args)
    }
    return () => {
      ;(mod as { request: unknown }).request = origRequest
      ;(mod as { get: unknown }).get = origGet
    }
  }
  const restoreHttp = wrap(http, 'http:')
  const restoreHttps = wrap(https, 'https:')

  const restore = (): void => {
    if (globalThis.fetch === guardedFetch) globalThis.fetch = origFetch
    restoreHttp()
    restoreHttps()
    installed = null
  }
  installed = { restore }
  return restore
}
