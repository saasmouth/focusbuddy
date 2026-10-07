// The parser that tells the BUILD which hostnames to compile in.
//
// A wrong answer here is not a deploy to redo, it is a release to redo, found
// by a user who cannot sign in. And it has exactly one consumer per platform,
// so a shape or encoding it cannot read takes out a whole platform's build.
//
// The case that actually happened: GitHub's Windows runner checks out with
// core.autocrlf=true. The statement terminator the parser looks for is "\n\n",
// which under CRLF is "\r\n\r\n", so the captured expression ran to the end of
// the file and matched no shape. The build died claiming ACTIVE was "a shape
// this parser does not understand" while pointing at a shape it supports. It
// passed on macOS every time, and Windows builds are infrequent, so it stayed
// broken from the moment the parser landed until the next Windows release.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { readActiveDomains } = require_('../../scripts/read-active-domains.cjs') as {
  readActiveDomains: (root: string) => { domains: Record<string, string>; describe: string }
}

const REAL = readFileSync(join(__dirname, '../../src/shared/productDomains.ts'), 'utf8')
const CURRENT_DECL = /export const ACTIVE: ProductDomains = [\s\S]*?\n\n/

/** Write a productDomains.ts with `decl` as ACTIVE, in the given line ending. */
function fixture(decl: string, eol: '\n' | '\r\n'): string {
  const src = REAL.replace(CURRENT_DECL, `${decl}\n\n`)
  const dir = mkdtempSync(join(tmpdir(), 'rad-'))
  mkdirSync(join(dir, 'src/shared'), { recursive: true })
  writeFileSync(join(dir, 'src/shared/productDomains.ts'), eol === '\n' ? src : src.replace(/\n/g, '\r\n'))
  return dir
}

const SHAPES: Array<[string, string, (d: Record<string, string>) => void]> = [
  [
    'a bare set name',
    'export const ACTIVE: ProductDomains = PRODUCTION',
    (d) => expect(d.api).toBe('https://api.plexiidesk.com')
  ],
  [
    'a spread with a reference override',
    "export const ACTIVE: ProductDomains = {\n  ...CURRENT,\n  downloads: PRODUCTION.downloads\n}",
    (d) => {
      expect(d.downloads).toBe('https://dl.plexiidesk.com')
      expect(d.api).toBe('https://focusbuddy-signal.fly.dev')
    }
  ],
  [
    'a spread with a literal override',
    "export const ACTIVE: ProductDomains = {\n  ...CURRENT,\n  site: 'https://literal.example'\n}",
    (d) => expect(d.site).toBe('https://literal.example')
  ]
]

describe('readActiveDomains', () => {
  for (const [name, decl, assert] of SHAPES) {
    // Both line endings for every shape. The encoding is not a property of the
    // shape, so testing one shape on CRLF would not have caught this.
    for (const eol of ['\n', '\r\n'] as const) {
      const label = eol === '\n' ? 'LF' : 'CRLF'
      it(`reads ${name} (${label})`, () => {
        const { domains } = readActiveDomains(fixture(decl, eol))
        assert(domains)
        for (const key of ['site', 'api', 'viewer', 'downloads']) {
          // Never partially filled, and never with a stray carriage return —
          // a trailing \r in a compiled hostname is a URL that 404s forever.
          expect(domains[key], key).toMatch(/^https:\/\/\S+$/)
          expect(domains[key], key).not.toMatch(/[\r\n]/)
        }
      })
    }
  }

  it('resolves the real file identically under either line ending', () => {
    const lf = readActiveDomains(fixture(SHAPES[0][1], '\n'))
    const crlf = readActiveDomains(fixture(SHAPES[0][1], '\r\n'))
    expect(crlf).toEqual(lf)
  })

  it('throws rather than guessing on a shape it cannot read', () => {
    const dir = fixture('export const ACTIVE: ProductDomains = someCall(CURRENT)', '\n')
    expect(() => readActiveDomains(dir)).toThrow(/does not understand/)
  })
})
