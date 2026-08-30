// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// DEC-060 — the boot path must not touch the OS keychain.
//
// safeStorage blocks the main thread waiting on securityd. If macOS decides to
// prompt for authorization, that dialog has no visible parent while the window
// is still show:false, so the app sits at 0% CPU with its port open and nothing
// painted. It is not crashed and not busy; it just never appears.
//
// It reached the boot path by accident rather than by decision: localActor() —
// which emitObjectEvent calls for EVERY Object Event — went through
// loadAccountState(), which eagerly decrypts the session token in order to
// return a `cachedEmail` that is stored in plaintext and needed no decrypting.
// So the identity lookup for every event paid for a Keychain round trip it had
// no use for, and a boot replay made hundreds of them.
//
// These are structural, because that is the only kind of test that would have
// caught it: every unit test passed the whole time this bug existed.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('dec_060 — the Object Event path never reads the keychain', () => {
  it('dec_060_localActor_does_not_go_through_loadAccountState', () => {
    const src = read('../../src/main/context/engine.ts')
    // Strip comments so the explanation of the bug does not read as the bug.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).toContain('accountEmail()')
    expect(code).not.toContain('loadAccountState')
  })

  it('dec_060_the_context_engine_never_imports_safeStorage', () => {
    const code = read('../../src/main/context/engine.ts').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('safeStorage')
  })

  it('dec_060_accountEmail_reads_plaintext_and_never_decrypts', () => {
    const src = read('../../src/main/db/account.ts')
    const fn = src.slice(src.indexOf('export function accountEmail'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('cachedEmail')
    expect(body).not.toContain('safeStorage')
    expect(body).not.toContain('decryptString')
  })
})

describe('dec_060 — the guards that make a regression loud instead of silent', () => {
  it('dec_060_a_pre_window_decrypt_warns', () => {
    const src = read('../../src/main/db/account.ts')
    expect(src).toContain('markUiVisible')
    // The warning must sit before the decrypt, not after it.
    expect(src.indexOf('uiVisible')).toBeLessThan(src.indexOf('safeStorage.isEncryptionAvailable'))
  })

  it('dec_060_the_window_is_revealed_even_if_ready_to_show_never_fires', () => {
    const src = read('../../src/main/index.ts')
    expect(src).toContain('markUiVisible')
    expect(src).toMatch(/isVisible\(\)/)
  })

  it('dec_060_the_token_decrypt_is_memoised', () => {
    // A signed-in user still needs one decrypt; they must not need one per call.
    const src = read('../../src/main/db/account.ts')
    expect(src).toContain('tokenCache')
    expect(src).toMatch(/tokenCache\s*=\s*null/) // invalidated on write
  })
})
