// The e2e net guard refuses exactly the hosts src/shared/productDomains.ts
// names, and every Electron launch in tests/e2e goes through it.
//
// Why this exists: a literal host list stopped matching once already after the
// api cutover (b59cf033). If productDomains gains an origin, renames one, or a
// new spec launches Electron by hand, one of these fails instead of the guard
// silently letting production traffic through.

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import * as domains from '../../src/shared/productDomains'
import {
  hostIsRefused,
  productDomainExports,
  productionHostRules,
  refusedUrlRegExp,
  urlIsRefused
} from '../e2e/_netGuardHosts'

const E2E = join(__dirname, '../e2e')

/** Every hostname named anywhere in productDomains, by any ProductDomains export. */
function exportedHosts(): string[] {
  const out = new Set<string>()
  for (const v of Object.values(domains)) {
    if (typeof v !== 'object' || v === null) continue
    for (const field of Object.values(v as unknown as Record<string, unknown>)) {
      if (typeof field === 'string' && /^https?:\/\//.test(field)) out.add(new URL(field).hostname)
    }
  }
  return [...out].sort()
}

describe('e2e net guard host set', () => {
  it('reads every ProductDomains export productDomains has, not a fixed list', () => {
    const names = productDomainExports().map(([n]) => n).sort()
    expect(names).toEqual(expect.arrayContaining(['ACTIVE', 'CURRENT', 'PRODUCTION']))
    // Anything URL-bearing that productDomains exports is one of these.
    const bearing = Object.entries(domains)
      .filter(([, v]) => typeof v === 'object' && v !== null && Object.values(v).some((f) => typeof f === 'string' && /^https?:/.test(f)))
      .map(([n]) => n)
      .sort()
    expect(names).toEqual(bearing)
  })

  it('refuses every host productDomains names, and nothing that does not trace back to one', () => {
    const hosts = exportedHosts()
    expect(hosts.length).toBeGreaterThan(0)
    for (const h of hosts) expect(hostIsRefused(h), h).toBe(true)
    // Each rule is either one of those hosts or the registrable domain of one
    // of PRODUCTION's (the domains Plexii owns) — never an extra literal.
    const owned = new Set(
      Object.values(domains.PRODUCTION).map((u) => new URL(u).hostname.split('.').slice(-2).join('.'))
    )
    for (const r of productionHostRules()) {
      expect(hosts.includes(r.host) || owned.has(r.host), r.host).toBe(true)
      expect(r.from.length, r.host).toBeGreaterThan(0)
    }
    // And every exported (export, field) pair is accounted for by some rule.
    const from = new Set(productionHostRules().flatMap((r) => r.from))
    for (const [name] of productDomainExports()) {
      for (const f of ['site', 'api', 'viewer', 'downloads']) expect(from.has(`${name}.${f}`), `${name}.${f}`).toBe(true)
    }
  })

  it('covers both names of the signal server and the owned domain with its subdomains', () => {
    for (const u of [domains.ACTIVE.api, domains.CURRENT.api, domains.wsUrlFor(domains.ACTIVE.api), domains.wsUrlFor(domains.CURRENT.api)]) {
      expect(urlIsRefused(u), u).toBe(true)
      expect(refusedUrlRegExp().test(u), u).toBe(true)
    }
    const owned = new URL(domains.PRODUCTION.api).hostname.split('.').slice(-2).join('.')
    for (const h of [owned, `www.${owned}`, `new-thing.${owned}`, `a.b.${owned}`, `${owned}.`]) {
      expect(hostIsRefused(h), h).toBe(true)
    }
    const re = refusedUrlRegExp()
    expect(re.test(`https://${owned}:443/x`)).toBe(true)
    expect(re.test(`wss://user@api.${owned}/ws`)).toBe(true)
  })

  it('does not refuse local hosts, other tenants of a shared platform, or look-alikes', () => {
    const shared = new URL(domains.CURRENT.api).hostname.split('.').slice(-2).join('.') // fly.dev
    const owned = new URL(domains.PRODUCTION.api).hostname.split('.').slice(-2).join('.')
    const re = refusedUrlRegExp()
    for (const u of [
      'http://localhost:8787/ws',
      'https://localhost:8798/conversations',
      'http://127.0.0.1:9/',
      `https://someone-else.${shared}/`,
      `https://${shared}/`,
      `https://not${owned}/`,
      `https://${owned}.evil.example/`,
      `https://example.com/?next=https://api.${owned}/`
    ]) {
      expect(urlIsRefused(u), u).toBe(false)
      expect(re.test(u), u).toBe(false)
    }
  })

  it('the main-process hook carries no host literal of its own', () => {
    const src = readFileSync(join(E2E, '_netGuardMain.cjs'), 'utf8')
    for (const r of productionHostRules()) expect(src.includes(r.host), r.host).toBe(false)
  })
})

describe('every Electron launch in tests/e2e goes through the net guard', () => {
  it('only _netGuard.ts calls electron.launch', () => {
    const offenders = readdirSync(E2E)
      .filter((f) => /\.(ts|tsx|js|cjs|mjs)$/.test(f) && f !== '_netGuard.ts')
      .filter((f) => /\belectron\s*\.\s*launch\s*\(|_electron\b/.test(readFileSync(join(E2E, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the allowlist names real spec files only', async () => {
    const { PRODUCTION_ALLOWED_SPECS } = await import('../e2e/_netGuardAllowlist')
    const files = new Set(readdirSync(E2E))
    for (const s of PRODUCTION_ALLOWED_SPECS) expect(files.has(s), s).toBe(true)
  })
})
