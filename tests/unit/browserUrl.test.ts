import { describe, it, expect } from 'vitest'
import { normalizeUrl, resolveAddressInput, sanitizeWebviewUrl, webviewSrc } from '../../src/renderer/src/lib/browserUrl'

describe('normalizeUrl — address bar input', () => {
  it('returns null only for empty input', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })

  it('navigates to a real dotted host, adding https when missing', () => {
    expect(normalizeUrl('github.com')).toBe('https://github.com/')
    expect(normalizeUrl('github.com/saasmouth')).toBe('https://github.com/saasmouth')
    expect(normalizeUrl('news.ycombinator.com')).toBe('https://news.ycombinator.com/')
  })

  it('respects an explicit scheme', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/')
    expect(normalizeUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('treats localhost, ports and IPs as navigations', () => {
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000/')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('https://127.0.0.1:8080/')
    expect(normalizeUrl('192.168.1.10')).toBe('https://192.168.1.10/')
  })

  it('runs a multi-word query as a Google search instead of a broken page', () => {
    expect(normalizeUrl('best pizza recipes')).toBe(
      'https://www.google.com/search?q=best%20pizza%20recipes'
    )
    // The percent-encoded broken page is exactly what we are avoiding.
    expect(normalizeUrl('best pizza recipes')).not.toContain('best%20pizza%20recipes/')
  })

  it('runs a bare word with no dot as a search, not https://word', () => {
    expect(normalizeUrl('weather')).toBe('https://www.google.com/search?q=weather')
    expect(normalizeUrl('react')).toBe('https://www.google.com/search?q=react')
  })

  it('searches a question and encodes punctuation safely', () => {
    expect(normalizeUrl('what is 2+2?')).toBe('https://www.google.com/search?q=what%20is%202%2B2%3F')
  })

  it('searches a domain-looking phrase that contains a space', () => {
    // A space means search even if a dotted token is present.
    expect(normalizeUrl('apple.com vs google.com')).toContain('https://www.google.com/search?q=')
  })

  it('falls back to a search when a scheme is typed but the rest is unparseable', () => {
    expect(normalizeUrl('https://')).toBe('https://www.google.com/search?q=https%3A%2F%2F')
  })
})

describe('sanitizeWebviewUrl — guard for <webview src> and stored webview content', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeWebviewUrl('')).toBe('')
    expect(sanitizeWebviewUrl('   ')).toBe('')
  })

  it('passes a valid absolute http/https URL through', () => {
    expect(sanitizeWebviewUrl('https://github.com')).toBe('https://github.com/')
    expect(sanitizeWebviewUrl('http://localhost:5173/foo')).toBe('http://localhost:5173/foo')
  })

  it('preserves a valid fb-file:// content value (pdf/file widgets)', () => {
    expect(sanitizeWebviewUrl('fb-file://abc-123')).toContain('fb-file://abc-123')
  })

  it('never returns a relative/scheme-less string that would resolve against the bundle', () => {
    // The original bug class: a relative asset path must NOT pass through, or
    // Electron would resolve it against file:///.../out/renderer/ and render
    // the bundle source as text.
    //
    // These two used to assert the value came back as a GOOGLE SEARCH, which
    // is the behaviour being removed — see the leak test below. Refusing is
    // what matters here, and refusing now means ''.
    expect(sanitizeWebviewUrl('assets/index-C5zD_VfV.js')).toBe('')
    // 'plexioffice.html' is DOTTED, so looksLikeHost takes it for a hostname
    // and it becomes https://plexioffice.html/ — which will not load, but is
    // not a relative path either, so the guard above still holds. That was
    // true before this change too; only the search fallback has gone.
    const relative = sanitizeWebviewUrl('plexioffice.html')
    expect(relative.startsWith('https://')).toBe(true)
    expect(relative).not.toBe('plexioffice.html')
  })

  it('NEVER sends anything to a third-party search', () => {
    // THE LEAK (d1, 2026-10-24). A pdf widget stores a bare fb_files id in
    // `content`; renderWidget sends 'pdf' to WebViewWidget; WebViewWidget
    // sanitised it; the sanitiser handed anything unparseable to normalizeUrl,
    // which is a Google search. So the file id went to Google and the person
    // got search results where their PDF should have been.
    for (const input of [
      '0f3b9a21-44d7-4c0e-9a11-2b6c5d8e7f90',
      'quarterly report',
      'some random text an AI wrote into content',
      'assets/index-C5zD_VfV.js'
    ]) {
      const out = sanitizeWebviewUrl(input)
      expect(out, `${input} must not become a search`).not.toContain('google.com')
      expect(out).not.toContain('search?q=')
    }
  })

  it('still accepts a host typed without a scheme', () => {
    // Removing the search fallback must not stop a real host loading.
    expect(sanitizeWebviewUrl('example.com')).toBe('https://example.com/')
    expect(sanitizeWebviewUrl('localhost:5173')).toContain('localhost:5173')
  })
})

describe('webviewSrc — what a pdf/file/gdoc widget actually loads', () => {
  const fileSrcFor = (id: string): string => `fb-file://${id}`

  it('resolves a bare fb_files id to the LOCAL file, not to the internet', () => {
    const id = '0f3b9a21-44d7-4c0e-9a11-2b6c5d8e7f90'
    expect(webviewSrc(id, fileSrcFor)).toBe(`fb-file://${id}`)
  })

  it('leaves a real URL alone', () => {
    expect(webviewSrc('https://example.com/a.pdf', fileSrcFor)).toBe('https://example.com/a.pdf')
    expect(webviewSrc('fb-file://abc-123', fileSrcFor)).toContain('fb-file://abc-123')
  })

  it('returns nothing for text that is neither — the caller says so honestly', () => {
    // Not a search, not a guess at a file that does not exist.
    expect(webviewSrc('quarterly report', fileSrcFor)).toBe('')
    expect(webviewSrc('', fileSrcFor)).toBe('')
    expect(webviewSrc('   ', fileSrcFor)).toBe('')
  })

  it('does not mistake a short stray word for a file id', () => {
    // An id is long; "notes" is somebody's typo and resolving it would show a
    // broken file instead of an honest message.
    expect(webviewSrc('notes', fileSrcFor)).toBe('')
  })

  it('never reaches a search engine for any of these', () => {
    for (const input of ['abc-123-def-456', 'quarterly report', 'notes', 'assets/x.js']) {
      expect(webviewSrc(input, fileSrcFor)).not.toContain('google.com')
    }
  })

  it('refuses free-text AI prose (the observed corruption) rather than searching it', () => {
    // This asserted the prose became a Google search, which was the safe
    // answer while the alternative was loading a bundle asset. It is not the
    // safe answer once you notice what else lands here: a pdf widget's file
    // id. Sending either to Google is the thing being removed; refusing is
    // what both cases actually need, and the widget says so on screen.
    const out = sanitizeWebviewUrl('Origin of the Name Michael Etymology derives from Hebrew')
    expect(out).toBe('')
    expect(out).not.toContain('google.com')
  })
})

describe('resolveAddressInput — the unified surface, engine-aware (A2 unification)', () => {
  const brave = (q: string): string => `https://search.brave.com/search?q=${encodeURIComponent(q)}`

  it('navigates a real address without consulting the engine', () => {
    expect(resolveAddressInput('github.com', brave)).toBe('https://github.com/')
    expect(resolveAddressInput('https://example.com/a?b=1', brave)).toBe('https://example.com/a?b=1')
  })

  it("hands searchy input to the CALLER'S engine, not a hard-coded one", () => {
    expect(resolveAddressInput('best pizza recipes', brave)).toBe(
      'https://search.brave.com/search?q=best%20pizza%20recipes'
    )
    expect(resolveAddressInput('weather', brave)).toBe('https://search.brave.com/search?q=weather')
  })

  it('returns null only for empty input', () => {
    expect(resolveAddressInput('', brave)).toBeNull()
    expect(resolveAddressInput('   ', brave)).toBeNull()
  })

  it('normalizeUrl stays the fixed-Google special case of the same logic', () => {
    expect(normalizeUrl('best pizza recipes')).toBe(
      resolveAddressInput('best pizza recipes', (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`)
    )
  })
})
