// A shared desk cannot be changed.
//
// Hiding buttons is not read-only: it holds until someone finds a shortcut, a
// context menu, a drag handle or a paste target that was missed, and then a
// visitor edits a copy they were only shown. The guarantee has to live at the
// one point every renderer call passes through, and it has to fail closed.
import { describe, it, expect } from 'vitest'
import { isWriteChannel } from '../../src/web/api/readOnly'
import { INVOKE_CHANNELS } from '../../src/web/api/channelMap.generated'

const ALL = [...new Set(Object.values(INVOKE_CHANNELS) as string[])]

describe('what a viewer may do', () => {
  it.each([
    'nodes:list', 'nodes:get', 'widgets:listByTask', 'files:get', 'documents:get',
    'tables:listRows', 'files:thumbnail', 'ai:getStatus'
  ])('%s is a question, so it is allowed', (c) => {
    expect(isWriteChannel(c)).toBe(false)
  })

  it.each([
    'nodes:create', 'nodes:update', 'nodes:delete', 'widgets:create', 'widgets:update',
    'widgets:delete', 'widgets:bringToFront', 'tables:createRow', 'tables:updateRow',
    'documents:update', 'files:delete', 'files:ingestBuffer', 'nodes:move',
    'widgets:restore', 'tables:reorderRows', 'knowledge:create', 'apps:create'
  ])('%s changes something, so it is refused', (c) => {
    expect(isWriteChannel(c)).toBe(true)
  })

  it('lets the bundle be unpacked, because that IS the share', () => {
    expect(isWriteChannel('shares:importBundle')).toBe(false)
  })
})

describe('the policy fails closed', () => {
  it('refuses a channel it has never seen', () => {
    // The property that matters: a mutating channel added next year is refused
    // without anyone remembering that sharing exists.
    expect(isWriteChannel('somethingNew:doTheThing')).toBe(true)
    expect(isWriteChannel('futureFeature:obliterate')).toBe(true)
    expect(isWriteChannel('noColonAtAll')).toBe(true)
  })

  it('refuses the clear majority of the real channel list', () => {
    // A sanity check on the shape of the rule rather than a fixed number: if a
    // future edit made this permissive, this is what would notice.
    const refused = ALL.filter(isWriteChannel).length
    expect(ALL.length).toBeGreaterThan(400)
    expect(refused / ALL.length).toBeGreaterThan(0.6)
  })

  it('refuses every channel whose verb is plainly a mutation', () => {
    const MUTATING = /^(create|update|delete|remove|set|add|move|reorder|rename|trash|restore|archive|save|write|apply|import|clear|wipe|revoke|send|post|run|start|stop|toggle|mark|assign|attach|detach|duplicate|merge|split|generate|reindex|enrich)/i
    const leaked = ALL.filter((c) => {
      const verb = c.slice(c.indexOf(':') + 1)
      return MUTATING.test(verb) && !isWriteChannel(c)
    })
    // Exactly one mutation is permitted, and it is the one that puts the desk
    // there in the first place. Asserting the whole list rather than filtering
    // it out means a second exception cannot be added quietly.
    expect(leaked).toEqual(['shares:importBundle'])
  })
})

describe('the gate is wired into the call path, not just defined', () => {
  it('dbCall consults it before dispatching', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(resolve(__dirname, '../../src/web/api/dbClient.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export function dbCall('))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('isShareRecipient()')
    expect(body).toContain('isWriteChannel(channel)')
    // Before anything is queued or dispatched, or it is not a gate.
    expect(body.indexOf('isWriteChannel')).toBeLessThan(body.indexOf('waiters.set'))
  })
})
