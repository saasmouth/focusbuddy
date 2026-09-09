// Provider keys in the browser: held by the server, never by the page.
//
// On the desktop a key lives in the OS keychain and the app calls the provider
// directly. A tab has no keychain, and localStorage is readable by any script
// that reaches the page -- so a key put there would be exposed by any future
// XSS, on every visit, for every user. That is why the browser runtime refused
// keys outright to begin with.
//
// The way to have BYOK in a browser is for the key never to be in the browser.
// It goes from the input box to Signal over HTTPS, is encrypted at rest with a
// master key held only in the server's environment, and is used in-process when
// Signal proxies the call. Nothing reads it back out: the routes report whether
// a key is configured and its last four characters, which is enough for the
// settings UI to say WHICH key is set and nothing else.
//
// Only Anthropic has this today. OpenAI, Tenor, Pexels and remove.bg each need
// their own proxy before their keys can be stored server-side -- storing a key
// the server cannot use on the caller's behalf would just be moving the risk
// somewhere new -- so those refuse, and say so.
import { signalConfig } from '@renderer/lib/signalConfig'
import { sessionToken } from './session'

const base = (): string => signalConfig.httpUrl.replace(/\/+$/, '')

interface KeyHint {
  hasKey: boolean
  last4: string | null
}

interface SaveResult {
  ok: boolean
  hasKey?: boolean
  last4?: string | null
  error?: string
}

function authHeaders(): Record<string, string> {
  const token = sessionToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function keyRequest(
  method: 'GET' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${base()}/account/ai-key`, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    return (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch {
    // Unreachable server. Reported as such by the callers rather than as "no
    // key", which would invite the user to re-enter one they already have.
    return null
  }
}

const NO_SERVER_HOME =
  'This key cannot be stored from the browser yet: Plexii would have to make the calls for you, ' +
  'and only Anthropic is proxied so far. Use the desktop app for this one.'

const unsupported = {
  hint: async (): Promise<KeyHint> => ({ hasKey: false, last4: null }),
  save: async (): Promise<SaveResult> => ({ ok: false, error: NO_SERVER_HOME }),
  clear: async (): Promise<{ ok: boolean; error?: string }> => ({ ok: false, error: NO_SERVER_HOME }),
  test: async (): Promise<{ ok: boolean; error?: string }> => ({ ok: false, error: NO_SERVER_HOME })
}

export function settingsNamespace(): Record<string, unknown> {
  return {
    // "Available" here means the server has somewhere safe to put a key, which
    // is the browser's equivalent of the desktop's keychain being usable.
    encryptionAvailable: async (): Promise<boolean> => {
      const body = await keyRequest('GET')
      return body?.serverSupported === true
    },

    hintAnthropic: async (): Promise<KeyHint> => {
      const body = await keyRequest('GET')
      return { hasKey: body?.configured === true, last4: (body?.last4 as string | null) ?? null }
    },

    saveAnthropicKey: async (plaintext: string): Promise<SaveResult> => {
      const body = await keyRequest('PUT', { key: plaintext })
      if (!body) return { ok: false, error: 'Could not reach Plexii to store the key.' }
      if (body.ok !== true) return { ok: false, error: String(body.error ?? 'The key was not accepted.') }
      return { ok: true, hasKey: body.configured === true, last4: (body.last4 as string | null) ?? null }
    },

    clearAnthropicKey: async (): Promise<{ ok: boolean; error?: string }> => {
      const body = await keyRequest('DELETE')
      if (!body) return { ok: false, error: 'Could not reach Plexii to remove the key.' }
      return body.ok === true ? { ok: true } : { ok: false, error: String(body.error ?? 'Could not remove the key.') }
    },

    /**
     * Prove the key works by using it, which is the only way to know. One token,
     * through the same proxy the app uses, so a pass here means the real path
     * works rather than that the string looked plausible.
     */
    testAnthropicKey: async (): Promise<{ ok: boolean; model?: string; error?: string }> => {
      try {
        const res = await fetch(`${base()}/ai/anthropic/v1/messages`, {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }]
          })
        })
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (res.ok) return { ok: true, model: String(body?.model ?? 'claude-sonnet-4-6') }
        const err = (body?.error ?? {}) as { message?: string }
        return { ok: false, error: err.message ?? `The provider refused the key (${res.status}).` }
      } catch {
        return { ok: false, error: 'Could not reach Plexii to test the key.' }
      }
    },

    hintOpenAI: unsupported.hint,
    saveOpenAIKey: unsupported.save,
    clearOpenAIKey: unsupported.clear,
    testOpenAIKey: unsupported.test,
    hintTenor: unsupported.hint,
    saveTenorKey: unsupported.save,
    clearTenorKey: unsupported.clear,
    hintPexels: unsupported.hint,
    savePexelsKey: unsupported.save,
    clearPexelsKey: unsupported.clear,
    hintRemoveBg: unsupported.hint,
    saveRemoveBgKey: unsupported.save,
    clearRemoveBgKey: unsupported.clear
  }
}
