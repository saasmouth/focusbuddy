// Secrets in the cloud runtime: deliberately absent.
//
// On the desktop these are the user's own provider keys, encrypted by the OS
// keychain through Electron's safeStorage and never leaving the machine. A
// browser has no equivalent. localStorage is readable by any script that gets
// into the page, so putting an Anthropic or OpenAI key there would take a
// secret that is currently protected by the operating system and expose it to
// every XSS in the product's future.
//
// So this refuses. Features that need a user-supplied key fail with a message
// saying why, which is the honest outcome: BYOK is a desktop capability until
// the keys are held server-side against the account, encrypted at rest, and
// used by Signal on the user's behalf -- so that the browser never holds one at
// all. That is a product and trust decision, not a porting task, and it is the
// reason this file is short.
export type SecretName = 'anthropic' | 'openai' | 'tenor' | 'pexels' | 'removebg'
export type AiMode = 'auto' | 'credits' | 'byok'

const UNSUPPORTED = 'Provider keys are not stored in the browser. Use the desktop app, or account credits.'

export function encryptionAvailable(): boolean {
  return false
}

export function setSecret(_name: SecretName, _plaintext: string): void {
  throw new Error(UNSUPPORTED)
}

export function getSecret(_name: SecretName): string | null {
  return null
}

export function clearSecret(_name: SecretName): void {
  // Nothing is stored, so clearing is already true rather than an error.
}

export function hint(_name: SecretName): { hasKey: boolean; last4: string | null } {
  return { hasKey: false, last4: null }
}

// The resolvers return null rather than throwing: callers already handle "no
// key configured" by falling back to account credits, which is exactly the
// behaviour wanted here. Throwing would turn a supported path into an error.
export function resolveAnthropicKey(): string | null { return null }
export function resolveOpenAIKey(): string | null { return null }
export function resolveTenorKey(): string | null { return null }
export function resolvePexelsKey(): string | null { return null }
export function resolveRemoveBgKey(): string | null { return null }

export function hasOwnAnthropicKey(): boolean {
  return false
}

/** Credits, always: the browser has no key of its own to prefer. */
export function getAiMode(): AiMode {
  return 'credits'
}

export function setAiMode(_mode: AiMode): void {
  throw new Error(UNSUPPORTED)
}
