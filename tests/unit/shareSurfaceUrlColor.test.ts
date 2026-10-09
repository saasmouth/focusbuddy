// The two value checks every share-rendered surface leans on: is this an
// address the browser may open, and is this a colour and nothing else.
//
// Both exist because the same renderer serves the public share page, where a
// desk's addresses and colours were written by whoever minted the link.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isHttpUrl, toHttpUrl } from '../../src/shared/safeUrl'
import { isSafeCssColor, safeCssColor } from '../../src/shared/cssColor'
import { openHttpUrl } from '../../src/renderer/src/lib/openUrl'

describe('toHttpUrl', () => {
  it.each([
    ['https://example.com/pricing?a=1#x', 'https://example.com/pricing?a=1#x'],
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://Example.COM', 'https://example.com/'],
    ['example.com/pricing', 'https://example.com/pricing'],
    ['  www.youtube.com/embed/abc  ', 'https://www.youtube.com/embed/abc'],
    ['localhost:5180/x', 'https://localhost:5180/x']
  ])('accepts %s', (raw, href) => {
    expect(toHttpUrl(raw)?.href).toBe(href)
  })

  it.each([
    'javascript:alert(document.domain)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'javascript://%0aalert(1)//',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://plexiidesk.com/0b3a',
    'file:///etc/passwd',
    'fb-file://abc',
    'vbscript:msgbox(1)',
    'mailto:someone@example.com',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    '/share/fb-file/abc',
    '//evil.example/x',
    '\\\\evil.example\\x',
    '',
    '   ',
    null,
    undefined,
    42,
    { href: 'https://example.com' }
  ])('refuses %s', (raw) => {
    expect(toHttpUrl(raw)).toBeNull()
    expect(isHttpUrl(raw)).toBe(false)
  })

  it('never returns anything but http: or https:', () => {
    // Whatever the prefixing does to odd input, the result is http(s) or null.
    for (const raw of ['javascript://example.com/%0aalert(1)', 'https:javascript:x', 'ht tp://x', 'https://javascript:alert(1)']) {
      const u = toHttpUrl(raw)
      if (u) expect(['http:', 'https:']).toContain(u.protocol)
    }
  })
})

describe('openHttpUrl', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens http(s) in a new tab with noopener and noreferrer', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    expect(openHttpUrl('example.com/a')).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
  })

  it.each(['javascript:alert(1)', 'data:text/html,x', 'https://u:p@example.com', '/relative', ''])('opens nothing for %s', (raw) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    expect(openHttpUrl(raw)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('isSafeCssColor', () => {
  it.each([
    '#fff', '#FFFF', '#6d5dfc', '#6d5dfc80', 'red', 'transparent', 'currentColor', 'rebeccapurple',
    'rgb(255,0,0)', 'rgba(109, 93, 252, 0.12)', 'rgb(255 0 0 / 50%)', 'hsl(250 96% 68%)', 'hsla(0,0%,0%,.5)',
    'oklch(70% 0.1 250)', 'color(display-p3 1 0 0)'
  ])('accepts %s', (c) => {
    expect(isSafeCssColor(c)).toBe(true)
  })

  it.each([
    'red"/><script>alert(1)</script>',
    'red;background:url(https://tracker.example/p.gif)',
    'red}body{display:none}',
    'url(https://tracker.example/p.gif)',
    'url(#grad-x)',
    'var(--accent)',
    'rgb(var(--x))',
    'rgb(calc(1+1),0,0)',
    'expression(alert(1))',
    'image-set("x.png" 1x)',
    "rgb(1,2,3)'",
    '#ggg',
    '#12',
    'red blue',
    '',
    `#${'f'.repeat(200)}`,
    null,
    7
  ])('refuses %s', (c) => {
    expect(isSafeCssColor(c)).toBe(false)
  })

  it('safeCssColor trims a real colour and falls back for anything else', () => {
    expect(safeCssColor('  #abc ', '#000')).toBe('#abc')
    expect(safeCssColor('red;x:y', '#000')).toBe('#000')
    expect(safeCssColor(undefined, undefined)).toBeUndefined()
  })
})

// ── Guards over the renderer source ─────────────────────────────────────────
// Cheap, and they catch the next one: a new window.open without noopener, or a
// new innerHTML sink, fails here and has to be looked at.

const RENDERER = join(__dirname, '../../src/renderer/src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}

describe('renderer source guards', () => {
  const files = sourceFiles(RENDERER)
  // changelog.ts quotes "window.open()" in prose; it is not a call.
  const codeFiles = files.filter((f) => !f.endsWith('lib/changelog.ts'))

  it('every window.open passes noopener,noreferrer', () => {
    const offenders: string[] = []
    let calls = 0
    for (const f of codeFiles) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/window\.open\(([^)]*)\)/g)) {
        calls++
        if (!m[1].includes("'noopener,noreferrer'")) offenders.push(`${relative(RENDERER, f)}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
    // Not vacuous: openUrl.ts, the upgrade prompt, the trial badge, the footer.
    expect(calls).toBeGreaterThanOrEqual(5)
  })

  it('dangerouslySetInnerHTML appears only where its input is a constant, sanitized, or app-generated', () => {
    // Each entry was read and is safe for a stated reason; a new file using the
    // sink must be added here deliberately, after the same reading.
    const reviewed = new Map<string, string>([
      ['components/Icon.tsx', 'PLEXII_ICONS: bundled constant SVG'],
      ['components/attention/BellIcon.tsx', 'PLEXII_ICONS: bundled constant SVG'],
      ['components/brand/PlexiLogo.tsx', 'constant CSS'],
      ['components/documents/DocEditor.tsx', 'scoped CSS: useId scope, numeric page geometry, headingCss (values checked)'],
      ['components/documents/DesignAiPanel.tsx', 'sanitizeHtml'],
      ['components/documents/sheet/SheetAiPanel.tsx', 'sanitizeHtml'],
      ['components/documents/editor/DocSidePanel.tsx', 'sanitizeHtml']
    ])
    // The attribute itself, not a mention: DrawStudio's comment explaining why
    // the sink was removed does not count.
    const users = codeFiles
      .filter((f) => /dangerouslySetInnerHTML=\{/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(RENDERER, f).split('\\').join('/'))
    expect(users.filter((f) => !reviewed.has(f))).toEqual([])
    expect(users).not.toContain('components/documents/DrawStudio.tsx')
  })

  it('every iframe states a referrer policy', () => {
    const offenders: string[] = []
    let frames = 0
    for (const f of codeFiles) {
      const src = readFileSync(f, 'utf8')
      // `<iframe` followed by whitespace: an element with attributes, not the
      // word "<iframe>" in a comment.
      for (const m of src.matchAll(/<iframe\s[\s\S]*?\/>/g)) {
        if (!/referrerPolicy=/.test(m[0])) offenders.push(relative(RENDERER, f))
        if (/no-referrer-when-downgrade|unsafe-url/.test(m[0])) offenders.push(`${relative(RENDERER, f)} (weak policy)`)
        frames++
      }
    }
    expect(offenders).toEqual([])
    // Not vacuous: mail body, PDF, custom widget, embedded site.
    expect(frames).toBeGreaterThanOrEqual(4)
  })
})
