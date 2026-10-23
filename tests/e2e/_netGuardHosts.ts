// Which hosts the e2e net guard refuses, derived from the app's own
// src/shared/productDomains.ts and never typed here as literals.
//
// WHY DERIVED: a literal host list stopped matching once already, after the
// api cutover (b59cf033). productDomains is the one place a rename happens, so
// the guard reads every ProductDomains-shaped export it has (PRODUCTION,
// CURRENT, ACTIVE, and any added later) instead of naming them. The unit test
// tests/unit/e2eNetGuardHosts.test.ts asserts this set equals what
// productDomains exports, so a new origin cannot silently open a hole.
//
// TWO KINDS OF ORIGIN, TWO RULES:
//  - PRODUCTION (and ACTIVE) name domains Plexii OWNS. Their registrable domain
//    (plexiidesk.com) and every subdomain are refused, so a new
//    something.plexiidesk.com is covered before anyone remembers to add it.
//  - Every other export (CURRENT today) names hosts on SHARED platforms
//    (fly.dev, vercel.app, github.com). Widening those to the platform apex
//    would refuse every other tenant, so they are refused as the exact host plus
//    its own subdomains. focusbuddy-signal.fly.dev is the same server as
//    api.plexiidesk.com under another name (same IP), which is why it is here.

import * as domains from '../../src/shared/productDomains'
import type { ProductDomains } from '../../src/shared/productDomains'

/** A refused host: `host` itself, and any name ending in `.${host}`. */
export interface HostRule {
  host: string
  /** The productDomains export and field it came from, e.g. "CURRENT.api". */
  from: string[]
}

const FIELDS: Array<keyof ProductDomains> = ['site', 'api', 'viewer', 'downloads']

function isProductDomains(v: unknown): v is ProductDomains {
  return (
    typeof v === 'object' &&
    v !== null &&
    FIELDS.every((f) => typeof (v as Record<string, unknown>)[f] === 'string')
  )
}

/** Every ProductDomains-shaped export of productDomains.ts, by export name. */
export function productDomainExports(): Array<[string, ProductDomains]> {
  return Object.entries(domains).filter((e): e is [string, ProductDomains] => isProductDomains(e[1]))
}

/** Last two labels: plexiidesk.com for api.plexiidesk.com. Owned domains only. */
function registrable(host: string): string {
  return host.split('.').slice(-2).join('.')
}

/** The refused hosts, deduplicated and sorted, each with where it came from. */
export function productionHostRules(): HostRule[] {
  const owned = new Set<ProductDomains>([domains.PRODUCTION, domains.ACTIVE])
  const rules = new Map<string, Set<string>>()
  for (const [name, d] of productDomainExports()) {
    for (const field of FIELDS) {
      const host = new URL(d[field]).hostname.toLowerCase()
      const rule = owned.has(d) ? registrable(host) : host
      if (!rules.has(rule)) rules.set(rule, new Set())
      rules.get(rule)!.add(`${name}.${field}`)
    }
  }
  return [...rules.entries()]
    .map(([host, from]) => ({ host, from: [...from].sort() }))
    .sort((a, b) => a.host.localeCompare(b.host))
}

export function hostIsRefused(host: string, rules: HostRule[] = productionHostRules()): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return rules.some((r) => h === r.host || h.endsWith(`.${r.host}`))
}

export function urlIsRefused(url: string, rules: HostRule[] = productionHostRules()): boolean {
  try {
    return hostIsRefused(new URL(url).hostname, rules)
  } catch {
    return false
  }
}

/** One RegExp over the URL, for Playwright's server-side route matching. */
export function refusedUrlRegExp(rules: HostRule[] = productionHostRules()): RegExp {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hosts = rules.map((r) => esc(r.host)).join('|')
  // scheme://[userinfo@][sub.]host[:port][/?#]  — http, https, ws, wss.
  return new RegExp(`^(?:https?|wss?)://(?:[^/?#@]*@)?(?:[^/?#@:]+\\.)?(?:${hosts})\\.?(?::\\d+)?(?:[/?#]|$)`, 'i')
}
