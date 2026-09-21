// Per-site standing grants for agentic browsing (A6, R26): the first time a
// run wants to ACT on a site, the human confirms once; the grant persists,
// is listable, and is revocable — the reviewable middle between "confirm
// everything" and the zero-friction end state. Sites are keyed by hostname
// (scheme/port/path never widen or split a grant). Reading a page never
// needs a grant; acting does — the loop asks before its first mutating
// action per host.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface ConsentGrant {
  host: string
  grantedAt: string // ISO
}

interface ConsentShape {
  v: 1
  grants: Record<string, { grantedAt: string }>
}

const EMPTY: ConsentShape = { v: 1, grants: {} }

let cache: ConsentShape | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'browser-consent.json')
}

function load(): ConsentShape {
  if (cache) return cache
  try {
    if (existsSync(filePath())) {
      const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as ConsentShape
      if (raw && raw.v === 1 && raw.grants && typeof raw.grants === 'object') {
        cache = { v: 1, grants: raw.grants }
        return cache
      }
    }
  } catch {
    /* unreadable file → start clean; grants only ever widen by explicit consent */
  }
  cache = { ...EMPTY, grants: {} }
  return cache
}

function save(shape: ConsentShape): void {
  cache = shape
  try {
    writeFileSync(filePath(), JSON.stringify(shape, null, 2))
  } catch {
    /* disk trouble — the in-memory grant still holds for this session */
  }
}

// One canonical key per site: lowercase hostname, no port, no www prefix —
// "www.Foo.com:8080/path" and "foo.com" are the same consent decision.
export function consentHostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return h || null
  } catch {
    return null
  }
}

export function hasConsent(host: string): boolean {
  return Boolean(load().grants[host])
}

export function grantConsent(host: string): void {
  const s = load()
  save({ ...s, grants: { ...s.grants, [host]: { grantedAt: new Date().toISOString() } } })
}

export function revokeConsent(host: string): void {
  const s = load()
  if (!s.grants[host]) return
  const grants = { ...s.grants }
  delete grants[host]
  save({ ...s, grants })
}

export function listConsent(): ConsentGrant[] {
  const s = load()
  return Object.entries(s.grants)
    .map(([host, g]) => ({ host, grantedAt: g.grantedAt }))
    .sort((a, b) => a.host.localeCompare(b.host))
}

/**
 * What the loop must do before a MUTATING action on this page.
 *
 * FAILS CLOSED. The gate used to read `if (host && !hasConsent(host)) ask()`,
 * so when the host could not be determined the condition was simply false and
 * the click or keystroke went ahead with nobody asked. That is every page with
 * no hostname — a data: URL (which can carry a live form), a file:// page,
 * about:blank — and, more often, the ordinary transient where neither the
 * snapshot nor the read reported a URL and the loop fell back to ''. A safety
 * gate that opens whenever it cannot see is not a gate.
 *
 * An unknown site now asks every time and is never remembered: there is no
 * stable key to store a grant under, and inventing one would let a grant made
 * on one blank page silently cover the next.
 */
export type ConsentGate =
  | { ask: false }
  | {
      ask: true
      /** The key a grant would be stored under; '' when there is none. */
      host: string
      /** What to show the human. */
      label: string
      /** Whether "remember this site" can mean anything here. */
      rememberable: boolean
    }

export function consentGate(url: string): ConsentGate {
  const host = consentHostOf(url)
  if (!host) {
    return { ask: true, host: '', label: 'this page (it has no web address)', rememberable: false }
  }
  if (hasConsent(host)) return { ask: false }
  return { ask: true, host, label: host, rememberable: true }
}

// Test seam: forget the cache so a spec can point app.getPath at a fresh dir.
export function _resetConsentCache(): void {
  cache = null
}
