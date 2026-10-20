// @vitest-environment node
// The egress guard: while AI is set to run on this device, no request reaches
// an AI service from the main process, by any of fetch / http / https, unless
// the request holds an explicit one-request grant.
import { describe, it, expect, afterEach } from 'vitest'
import https from 'node:https'
import http from 'node:http'
import { installEgressGuard, isAiServiceUrl, LocalOnlyEgressError } from '../../src/main/ai/local/egressGuard'
import { setRouterSettings, localOnlyActive, withCloudGrant } from '../../src/main/ai/local/providerRouter'

const SIGNAL = 'https://focusbuddy-signal.fly.dev'
let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
  setRouterSettings({ aiMode: () => 'auto', featureRoutes: () => ({}) })
})

describe('isAiServiceUrl', () => {
  it('names the AI services and only those', () => {
    for (const u of [
      'https://api.anthropic.com/v1/messages',
      'https://api.openai.com/v1/embeddings',
      'https://api.openai.com/v1/audio/transcriptions',
      'https://html.duckduckgo.com/html/?q=x',
      'https://api.remove.bg/v1.0/removebg',
      `${SIGNAL}/ai/anthropic/v1/messages`
    ]) {
      expect(isAiServiceUrl(u, SIGNAL), u).toBe(true)
    }
    for (const u of [
      'https://dl.plexiidesk.com/models/1/model.gguf',
      `${SIGNAL}/sync/pull`,
      'http://localhost:11434/api/chat',
      'https://www.plexiidesk.com/',
      'not a url'
    ]) {
      expect(isAiServiceUrl(u, SIGNAL), u).toBe(false)
    }
  })
})

describe('installEgressGuard', () => {
  function install(blocked: string[]): void {
    restore = installEgressGuard({ localOnly: localOnlyActive, signalBase: SIGNAL, onBlocked: (h) => blocked.push(h) })
  }

  it('refuses fetch to an AI service in local mode, before connecting', async () => {
    setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    const blocked: string[] = []
    install(blocked)
    await expect(fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toBeInstanceOf(LocalOnlyEgressError)
    await expect(fetch(`${SIGNAL}/ai/credits`)).rejects.toBeInstanceOf(LocalOnlyEgressError)
    expect(() => https.request('https://api.openai.com/v1/embeddings')).toThrow(LocalOnlyEgressError)
    expect(() => https.get({ hostname: 'html.duckduckgo.com', path: '/html/' })).toThrow(LocalOnlyEgressError)
    expect(() => http.request({ hostname: 'api.openai.com', path: '/' })).toThrow(LocalOnlyEgressError)
    expect(blocked).toEqual(['api.anthropic.com', 'focusbuddy-signal.fly.dev', 'api.openai.com', 'html.duckduckgo.com', 'api.openai.com'])
  })

  it('lets a granted request through (the user said yes for this one request)', async () => {
    setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    const blocked: string[] = []
    install(blocked)
    // Reaching the real network is not the point; passing the guard is. A
    // non-guard failure (DNS, offline) is fine; a LocalOnlyEgressError is not.
    const err = await withCloudGrant({ reason: 'consent' }, () =>
      fetch('https://api.anthropic.com/v1/messages', { signal: AbortSignal.timeout(1) }).then(
        () => null,
        (e: unknown) => e
      )
    )
    expect(err).not.toBeInstanceOf(LocalOnlyEgressError)
    expect(blocked).toEqual([])
    // ...and the grant does not leak to the next request outside it.
    await expect(fetch('https://api.anthropic.com/v1/messages')).rejects.toBeInstanceOf(LocalOnlyEgressError)
  })

  it('does nothing when the AI source is cloud', async () => {
    setRouterSettings({ aiMode: () => 'byok', featureRoutes: () => ({}) })
    const blocked: string[] = []
    install(blocked)
    const err = await fetch('https://api.anthropic.com/v1/messages', { signal: AbortSignal.timeout(1) }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).not.toBeInstanceOf(LocalOnlyEgressError)
    expect(blocked).toEqual([])
  })

  it('never blocks the model download host or localhost', () => {
    setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    install([])
    const a = new AbortController()
    a.abort()
    // Aborted immediately: these reach the network layer (not the guard).
    return Promise.all([
      fetch('https://dl.plexiidesk.com/models/1/x.gguf', { signal: a.signal }).catch((e) => expect(e).not.toBeInstanceOf(LocalOnlyEgressError)),
      fetch('http://localhost:1/x', { signal: a.signal }).catch((e) => expect(e).not.toBeInstanceOf(LocalOnlyEgressError))
    ])
  })
})
