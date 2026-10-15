import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve(__dirname, '../../src/renderer/src/styles/globals.css'),
  'utf8'
)

describe('Gemstone theme room effects', () => {
  it('does not paint a fixed lattice over the application', () => {
    expect(css).not.toContain('.gemstone body::after')
    expect(css).not.toContain('@keyframes gem-facet-drift')
  })

  it('keeps the ambient jewel room and sparkle treatment', () => {
    expect(css).toContain('.gemstone body {')
    expect(css).toContain('.gemstone body::before {')
    expect(css).toContain('@keyframes gem-sparkle-a')
  })
})
