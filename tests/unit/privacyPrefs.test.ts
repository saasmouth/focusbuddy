// @vitest-environment node
// Main-process privacy switches (privacyPrefs.ts): update checks default ON,
// Background AI tasks default OFF; only a real boolean on disk overrides a
// default; a change is written through and announced.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'privacy-prefs-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import {
  PRIVACY_DEFAULTS,
  __resetPrivacyPrefsCache,
  autoUpdateChecksEnabled,
  backgroundAiEnabled,
  getPrivacyPrefs,
  normalisePrivacyPrefs,
  onPrivacyPrefsChange,
  setPrivacyPrefs, learnFromDocumentsEnabled } from '../../src/main/privacyPrefs'

const file = join(dir, 'privacy-prefs.json')

beforeEach(() => {
  rmSync(file, { force: true })
  __resetPrivacyPrefsCache()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('defaults', () => {
  it('update checks on, background AI off, learning from documents on, with no file', () => {
    // learnFromDocuments (4.3.50): on by default; on-device only, nothing leaves.
    expect(PRIVACY_DEFAULTS).toEqual({ autoUpdateChecks: true, backgroundAi: false, learnFromDocuments: true })
    expect(learnFromDocumentsEnabled()).toBe(true)
    expect(autoUpdateChecksEnabled()).toBe(true)
    expect(backgroundAiEnabled()).toBe(false)
  })

  it('a corrupt or partial file falls back to the defaults, never to on', () => {
    writeFileSync(file, '{ not json')
    expect(getPrivacyPrefs()).toEqual(PRIVACY_DEFAULTS)
    expect(normalisePrivacyPrefs({ backgroundAi: 'yes', autoUpdateChecks: 0, learnFromDocuments: 'no' })).toEqual(PRIVACY_DEFAULTS)
    expect(normalisePrivacyPrefs({ learnFromDocuments: false }).learnFromDocuments).toBe(false)
  })
})

describe('changes', () => {
  it('persist, survive a reload and are announced', () => {
    const seen: unknown[] = []
    const off = onPrivacyPrefsChange((p) => seen.push(p))
    setPrivacyPrefs({ backgroundAi: true })
    setPrivacyPrefs({ autoUpdateChecks: false })
    setPrivacyPrefs({ learnFromDocuments: false })
    off()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ autoUpdateChecks: false, backgroundAi: true })
    __resetPrivacyPrefsCache()
    expect(getPrivacyPrefs()).toEqual({ autoUpdateChecks: false, backgroundAi: true, learnFromDocuments: false })
    expect(learnFromDocumentsEnabled()).toBe(false)
    expect(seen).toEqual([
      { autoUpdateChecks: true, backgroundAi: true, learnFromDocuments: true },
      { autoUpdateChecks: false, backgroundAi: true, learnFromDocuments: true },
      { autoUpdateChecks: false, backgroundAi: true, learnFromDocuments: false }
    ])
  })
})
