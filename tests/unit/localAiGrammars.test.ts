// @vitest-environment node
// The engine's JSON grammars are embedded text (the packaged app cannot read
// node-llama-cpp's grammars folder from inside the asar). They must stay
// byte-identical to the grammars of the node-llama-cpp version installed.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSON_OBJECT_GBNF, JSON_ARRAY_GBNF } from '../../src/main/ai/local/jsonGrammars'

const dir = join(__dirname, '../../node_modules/node-llama-cpp/llama/grammars')

describe('embedded JSON grammars', () => {
  it('equal the installed llama.cpp grammars', () => {
    expect(JSON_OBJECT_GBNF).toBe(readFileSync(join(dir, 'json.gbnf'), 'utf8'))
    expect(JSON_ARRAY_GBNF).toBe(readFileSync(join(dir, 'json_arr.gbnf'), 'utf8'))
  })

  it('are what the engine uses (never the grammars-folder lookup)', () => {
    const src = readFileSync(join(__dirname, '../../src/main/ai/local/engineCore.ts'), 'utf8')
    expect(src).not.toMatch(/this\.llama\.getGrammarFor\(/)
    expect(src).toMatch(/createGrammar\(\{\s*grammar: JSON_OBJECT_GBNF/)
  })
})
