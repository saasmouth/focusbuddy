// @vitest-environment node
//
// The mail-thread widget's content whitelist.
//
// A whitelist silently drops what it forgets, and that is exactly what happened:
// `accountKey` was added to MailThreadContent and written at pin time, while the
// widget's inline parser -- which rebuilt the object field by field -- quietly
// discarded it on every read. Nothing failed. The widget simply stopped being
// able to find its own message once a different mailbox was connected.
//
// So the whitelist has its own tests, and one of them reads the interface out of
// types.ts and fails when a field is declared but not carried.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMailThreadContent } from '../../src/renderer/src/lib/mailThreadContent'
import type { MailThreadContent } from '../../src/shared/types'

const root = join(__dirname, '..', '..')

describe('parseMailThreadContent', () => {
  it('carries every field of a fully populated widget', () => {
    const full: Required<MailThreadContent> = {
      mode: 'thread',
      uids: [11, 12],
      rootMessageId: '<root@example.test>',
      subject: 'Strata levy notice',
      fromName: 'Dana Reed',
      collapsed: true,
      accountKey: 'someone@example.test'
    }
    expect(parseMailThreadContent(JSON.stringify(full))).toEqual(full)
  })

  it('carries every field the interface declares', () => {
    // The guard the original bug needed. Adding a field to MailThreadContent
    // without adding it here leaves it declared, written, and silently dropped.
    const types = readFileSync(join(root, 'src/shared/types.ts'), 'utf8')
    const start = types.indexOf('export interface MailThreadContent {')
    expect(start, 'MailThreadContent not found — did it move?').toBeGreaterThan(-1)
    const body = types.slice(start, types.indexOf('\n}', start))
    const declared = [...body.matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1])

    expect(declared.length, 'interface parse is broken').toBeGreaterThan(5)
    expect(declared).toContain('accountKey')

    const parser = readFileSync(
      join(root, 'src/renderer/src/lib/mailThreadContent.ts'),
      'utf8'
    )
    const missing = declared.filter((f) => !new RegExp(`\\b${f}\\b`).test(parser))
    expect(missing, 'declared on MailThreadContent but never carried by the parser').toEqual([])
  })

  it('defaults to a single message rather than a thread', () => {
    // A widget that guessed 'thread' from broken content would pull in unrelated
    // correspondence, which is the worse of the two wrong answers.
    expect(parseMailThreadContent('{}').mode).toBe('one')
    expect(parseMailThreadContent('{"mode":"something-else"}').mode).toBe('one')
  })

  it('never throws on content that is not the shape it claims', () => {
    for (const raw of ['', null, undefined, 'not json', '[]', 'null', '42', '"a string"']) {
      const c = parseMailThreadContent(raw as string)
      expect(c.mode).toBe('one')
      expect(c.uids).toEqual([])
      expect(c.accountKey).toBeUndefined()
    }
  })

  it('drops uids that are not usable as store keys', () => {
    const c = parseMailThreadContent(
      JSON.stringify({ uids: [1, 2.5, NaN, null, '3', Number.MAX_SAFE_INTEGER + 2, 4] })
    )
    // NaN and Infinity serialise to null, so this also covers what JSON does to them.
    expect(c.uids).toEqual([1, 4])
  })

  it('treats a blank account key as absent', () => {
    // '' would be a real partition value and would match nothing. Absent means
    // "fall back to the connected mailbox", which is the correct old behaviour.
    expect(parseMailThreadContent('{"accountKey":"   "}').accountKey).toBeUndefined()
    expect(parseMailThreadContent('{"accountKey":123}').accountKey).toBeUndefined()
  })
})

describe('mail account key derivation', () => {
  it('is computed in exactly one place', () => {
    // It was two, and a third was about to be added in the renderer. Every row in
    // the mail store is partitioned by this value, so a copy that drifts reads an
    // empty store and reports that the mail is not there.
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execSync(
      `grep -rln "user\\.trim()\\.toLowerCase()" ${JSON.stringify(join(root, 'src'))} || true`,
      { encoding: 'utf8' }
    )
    const files = out
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(root + '/', ''))
    expect(files, 'derive the account key via mailAccountKey() instead').toEqual([
      'src/shared/mailAccountKey.ts'
    ])
  })
})
