// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-10-08 — the password field that "wasn't typing properly" ───────────
//
// A password with mixed case and symbols came out wrong while pasting it
// worked. The app was cleared by experiment (tests/e2e/_signinTyping.spec.ts):
// the field keeps every character at a 0ms typing delay, with Shift held
// across runs of letters and symbols, and with the main thread stalled 70ms
// out of every 90ms. What those tests CANNOT see is the macOS text-input
// layer, because Playwright injects key events through the debug protocol and
// bypasses it — and that layer is where automatic capitalisation, smart
// punctuation and Text Replacement live.
//
// Hence two changes, and these assertions over them: opt every auth field out
// of those substitutions, and give the user a reveal toggle so a field that
// takes the wrong characters stops being unfalsifiable from their side.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

const AUTH_FIELDS = [
  'src/renderer/src/components/LaunchSignInModal.tsx',
  'src/renderer/src/components/FirstRunOnboarding.tsx',
  'src/renderer/src/components/officeApp/OfficeAccountBar.tsx'
]

describe('auth fields opt out of macOS text substitution', () => {
  for (const f of AUTH_FIELDS) {
    it(`${f.split('/').pop()} hardens its password input`, () => {
      const s = read(f)
      // Every password input in the file carries all three opt-outs. Split on
      // the tag so a file with several fields cannot pass on one of them.
      const tags = s.split('<input').slice(1).filter((t) => {
        const head = t.slice(0, t.indexOf('/>') + 2)
        return head.includes('type="password"') || head.includes('type={showPassword')
      })
      expect(tags.length).toBeGreaterThan(0)
      for (const t of tags) {
        const head = t.slice(0, t.indexOf('/>') + 2)
        expect(head).toContain('autoCapitalize="none"')
        expect(head).toContain('autoCorrect="off"')
        expect(head).toContain('spellCheck={false}')
      }
    })
  }
})

describe('the sign-in password can be revealed', () => {
  const modal = read('src/renderer/src/components/LaunchSignInModal.tsx')

  it('the input type follows the reveal state', () => {
    expect(modal).toContain("type={showPassword ? 'text' : 'password'}")
    expect(modal).toContain('data-testid="signin-password"')
    expect(modal).toContain('data-testid="signin-password-reveal"')
  })

  it('reveal starts off on every open and is never persisted', () => {
    expect(modal).toContain('const [showPassword, setShowPassword] = useState(false)')
    // No storage of the choice — a password left on screen because of a
    // setting chosen days ago is worse than one extra click.
    expect(modal).not.toMatch(/localStorage[^\n]*showPassword/)
  })

  it('the toggle is labelled for both states and announces its state', () => {
    expect(modal).toContain("aria-label={showPassword ? 'Hide password' : 'Show password'}")
    expect(modal).toContain('aria-pressed={showPassword}')
  })

  it('the email field is hardened too — autocapitalising an address is the same bug', () => {
    const emailTag = modal.slice(modal.indexOf('type="email"'))
    const head = emailTag.slice(0, emailTag.indexOf('/>') + 2)
    expect(head).toContain('autoCapitalize="none"')
  })
})
