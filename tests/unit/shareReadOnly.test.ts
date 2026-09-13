// A shared desk cannot be changed.
//
// Hiding buttons is not read-only: it holds until someone finds a shortcut, a
// context menu, a drag handle or a paste target that was missed, and then a
// visitor edits a copy they were only shown. The guarantee has to live at the
// one point every renderer call passes through, and it has to fail closed.
import { describe, it, expect } from 'vitest'
import { decideCall, isPermittedChannel, LAYOUT_FIELDS } from '../../src/web/api/readOnly'
import { INVOKE_CHANNELS } from '../../src/web/api/channelMap.generated'

const ALL = [...new Set(Object.values(INVOKE_CHANNELS) as string[])]

describe('what a viewer may do', () => {
  it.each([
    'nodes:list', 'nodes:get', 'widgets:listByTask', 'files:get', 'documents:get',
    'tables:listRows', 'files:thumbnail', 'ai:getStatus'
  ])('%s is a question, so it is allowed', (c) => {
    expect(isPermittedChannel(c)).toBe(true)
  })

  it.each([
    'nodes:create', 'nodes:update', 'nodes:delete', 'widgets:create', 'widgets:delete', 'tables:createRow', 'tables:updateRow',
    'documents:update', 'files:delete', 'files:ingestBuffer', 'nodes:move',
    'widgets:restore', 'tables:reorderRows', 'knowledge:create', 'apps:create'
  ])('%s changes something, so it is refused', (c) => {
    expect(isPermittedChannel(c)).toBe(false)
  })

  it('lets the bundle be unpacked, because that IS the share', () => {
    expect(isPermittedChannel('shares:importBundle')).toBe(true)
  })
})

describe('the policy fails closed', () => {
  it('refuses a channel it has never seen', () => {
    // The property that matters: a mutating channel added next year is refused
    // without anyone remembering that sharing exists.
    expect(isPermittedChannel('somethingNew:doTheThing')).toBe(false)
    expect(isPermittedChannel('futureFeature:obliterate')).toBe(false)
    expect(isPermittedChannel('noColonAtAll')).toBe(false)
  })

  it('refuses the clear majority of the real channel list', () => {
    // A sanity check on the shape of the rule rather than a fixed number: if a
    // future edit made this permissive, this is what would notice.
    const refused = ALL.filter((c) => !isPermittedChannel(c)).length
    expect(ALL.length).toBeGreaterThan(400)
    expect(refused / ALL.length).toBeGreaterThan(0.6)
  })

  it('refuses every channel whose verb is plainly a mutation', () => {
    const MUTATING = /^(create|update|delete|remove|set|add|move|reorder|rename|trash|restore|archive|save|write|apply|import|clear|wipe|revoke|send|post|run|start|stop|toggle|mark|assign|attach|detach|duplicate|merge|split|generate|reindex|enrich)/i
    const leaked = ALL.filter((c) => {
      const verb = c.slice(c.indexOf(':') + 1)
      return MUTATING.test(verb) && isPermittedChannel(c)
    })
    // Exactly one mutation is permitted, and it is the one that puts the desk
    // there in the first place. Asserting the whole list rather than filtering
    // it out means a second exception cannot be added quietly.
    expect(leaked.sort()).toEqual(['deskLayout:save', 'shares:importBundle'])
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
    expect(body).toContain('decideCall(channel, args)')
    // Before anything is queued or dispatched, or it is not a gate.
    expect(body.indexOf('isWriteChannel')).toBeLessThan(body.indexOf('waiters.set'))
  })
})

// Looking at a spatial canvas means moving things around on it. A recipient was
// stuck at whatever zoom the sender left behind, unable to put two widgets side
// by side -- read-only had been read as "frozen", which is not the same thing.
describe('a viewer can rearrange the desk without changing it', () => {
  const patch = (p: Record<string, unknown>) => decideCall('widgets:update', ['w1', p])

  it('lets a widget be moved and resized', () => {
    const d = patch({ x: 10, y: 20, width: 300, height: 200 })
    expect(d.allowed).toBe(true)
    expect(d.args[1]).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })

  it('lets one be raised, pinned and filed into a section', () => {
    expect(patch({ zIndex: 9 }).allowed).toBe(true)
    expect(patch({ pinned: true, pinnedZone: 'tr' }).allowed).toBe(true)
    expect(patch({ parentSectionId: 's1' }).allowed).toBe(true)
  })

  it('lets the camera be remembered, so a reload does not throw them back', () => {
    expect(isPermittedChannel('deskLayout:save')).toBe(true)
    expect(isPermittedChannel('widgets:bringToFront')).toBe(true)
  })

  it('refuses an edit to what a widget says', () => {
    expect(patch({ content: 'rewritten' }).allowed).toBe(false)
    expect(patch({ title: 'renamed' }).allowed).toBe(false)
    expect(patch({ archived: true }).allowed).toBe(false)
  })

  it('keeps the move and drops the edit when one call carries both', () => {
    // The case that decides whether this is a real boundary or a suggestion: a
    // patch containing geometry AND content must not smuggle the content
    // through on the strength of the geometry.
    const d = patch({ x: 5, y: 6, content: 'rewritten', title: 'renamed' })
    expect(d.allowed).toBe(true)
    expect(d.args[1]).toEqual({ x: 5, y: 6 })
    expect(JSON.stringify(d.args)).not.toContain('rewritten')
    expect(JSON.stringify(d.args)).not.toContain('renamed')
  })

  it('treats a field nobody has classified as content', () => {
    // WidgetPatch grows. A new field is refused until someone decides it is
    // layout, which is the safe direction for a boundary to fail in.
    expect(patch({ somethingNew: 'x' }).allowed).toBe(false)
    expect(LAYOUT_FIELDS.has('content')).toBe(false)
    expect(LAYOUT_FIELDS.has('title')).toBe(false)
  })

  it('refuses a patch that is not a patch', () => {
    expect(decideCall('widgets:update', ['w1', null]).allowed).toBe(false)
    expect(decideCall('widgets:update', ['w1']).allowed).toBe(false)
  })
})
