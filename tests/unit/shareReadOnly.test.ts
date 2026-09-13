// What a share window may do, now that its visitor can work on the desk.
//
// The policy reversed: the copy is theirs, it reaches nobody, and it is deleted
// in 48 hours, so there is no one to protect the desk from. What survives is the
// line around things that are NOT the desk -- an account, a subscription, an
// organisation, or sharing the thing onward -- because a share token travels in
// URLs and chat messages and must never work as a credential.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { decideCall, isReadOnlyCall, changesContent } from '../../src/web/api/readOnly'
import { noteShareEdit, resetShareEditNotice, SHARE_EDIT_EVENT } from '../../src/web/api/shareEdits'
import { INVOKE_CHANNELS } from '../../src/web/api/channelMap.generated'

const ALL = [...new Set(Object.values(INVOKE_CHANNELS) as string[])]
const allowed = (c: string, args: unknown[] = []): boolean => decideCall(c, args).allowed

describe('the desk is theirs to work on', () => {
  it.each([
    'widgets:create', 'widgets:update', 'widgets:delete', 'widgets:bringToFront',
    'nodes:update', 'tables:createRow', 'tables:updateRow', 'documents:update',
    'files:ingestBuffer', 'deskLayout:save'
  ])('%s is allowed', (c) => {
    expect(allowed(c)).toBe(true)
  })

  it('still reads freely', () => {
    for (const c of ['nodes:list', 'widgets:listByTask', 'files:get']) expect(allowed(c)).toBe(true)
  })
})

describe('what is not the desk stays out of reach', () => {
  it.each([
    'account:saveSession', 'billing:checkout', 'org:create', 'admin:setPlan',
    'teams:invite', 'apiKeys:create', 'crdt:push', 'workspace:pushChanges'
  ])('%s is refused', (c) => {
    expect(allowed(c)).toBe(false)
  })

  it('lets a viewer read those namespaces without acting on them', () => {
    expect(allowed('account:getSession')).toBe(true)
    expect(allowed('org:list')).toBe(true)
  })

  it('refuses onward sharing, which is the sender\'s decision', () => {
    expect(allowed('shares:createEphemeral')).toBe(false)
    expect(allowed('shares:revokeEphemeral')).toBe(false)
    // Except the one that puts the desk here in the first place.
    expect(allowed('shares:importBundle')).toBe(true)
  })

  it('fails closed inside those namespaces', () => {
    // A route added to billing or admin next year is refused without anyone
    // remembering that sharing exists.
    expect(allowed('billing:somethingNew')).toBe(false)
    expect(allowed('admin:obliterate')).toBe(false)
  })

  it('names every outward channel it refuses, so the list can be reviewed', () => {
    const refused = ALL.filter((c) => !allowed(c))
    expect(refused.length).toBeGreaterThan(20)
    // Nothing about the desk itself should be in there.
    for (const ns of ['widgets', 'nodes', 'tables', 'documents', 'deskLayout']) {
      expect(refused.filter((c) => c.startsWith(ns + ':'))).toEqual([])
    }
  })
})

describe('the warning fires once, at the first change', () => {
  afterEach(() => resetShareEditNotice())

  it('announces an edit', () => {
    const seen = vi.fn()
    window.addEventListener(SHARE_EDIT_EVENT, seen)
    noteShareEdit()
    expect(seen).toHaveBeenCalledOnce()
    window.removeEventListener(SHARE_EDIT_EVENT, seen)
  })

  it('does not fire again, because a warning on every keystroke is not read', () => {
    const seen = vi.fn()
    window.addEventListener(SHARE_EDIT_EVENT, seen)
    noteShareEdit(); noteShareEdit(); noteShareEdit()
    expect(seen).toHaveBeenCalledOnce()
    window.removeEventListener(SHARE_EDIT_EVENT, seen)
  })

  it('marks changes as edits and questions as not', () => {
    // A nudge is not the moment to warn somebody; a rewrite is.
    expect(decideCall('widgets:update', ['w', { x: 1 }]).edits).toBe(false)
    expect(decideCall('widgets:update', ['w', { content: 'x' }]).edits).toBe(true)
    expect(decideCall('widgets:create', [{}]).edits).toBe(true)
    expect(decideCall('nodes:list', []).edits).toBe(false)
    expect(isReadOnlyCall('files:get')).toBe(true)
    expect(isReadOnlyCall('files:delete')).toBe(false)
  })
})

describe('the gate is wired into the call path', () => {
  it('dbCall consults it, and announces the first edit', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(resolve(__dirname, '../../src/web/api/dbClient.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export function dbCall('))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('decideCall(channel, args)')
    expect(body).toContain('noteShareEdit()')
    expect(body.indexOf('decideCall')).toBeLessThan(body.indexOf('waiters.set'))
  })

  it('reads a verb as a word, not a prefix', () => {
    // checkout is not "check", cancel is not "can", issue is not "is". The
    // first of those was a payment route reading as a question, which is
    // exactly what a default-deny list exists to prevent -- and the /i flag
    // that made the boundary match uppercase too silently broke every
    // camelCase read while appearing to fix it.
    expect(isReadOnlyCall('billing:checkout')).toBe(false)
    expect(isReadOnlyCall('decisions:cancel')).toBe(false)
    expect(isReadOnlyCall('x:issue')).toBe(false)
    expect(isReadOnlyCall('x:check')).toBe(true)
    expect(isReadOnlyCall('ai:getStatus')).toBe(true)
    expect(isReadOnlyCall('aiChat:listConversations')).toBe(true)
    expect(isReadOnlyCall('vault:isUnlocked')).toBe(true)
  })
})

// The warning is for the moment somebody starts WORKING, and the app writes on
// its own before that: it saves the camera and nudges layout as the desk opens.
// The first version counted those, spent its one announcement on a startup
// write, and the visitor never saw it.
describe('what counts as a change worth warning about', () => {
  it('ignores the camera and the furniture', () => {
    expect(changesContent('deskLayout:save', [{}])).toBe(false)
    expect(changesContent('widgets:bringToFront', ['w'])).toBe(false)
    expect(changesContent('widgets:update', ['w', { x: 1, y: 2, width: 3 }])).toBe(false)
    expect(changesContent('nodes:list', [])).toBe(false)
  })

  it('ignores the app writing on its own account', () => {
    // trail, context, activity and the rest fire as a desk opens. Counting them
    // spent the one warning before the visitor had touched anything, which is
    // exactly how it came to be shown on an untouched desk.
    expect(changesContent('trail:record', [{}])).toBe(false)
    expect(changesContent('context:openDesk', ['d'])).toBe(false)
    expect(changesContent('activity:logPress', [{}])).toBe(false)
    expect(changesContent('model:set', ['m'])).toBe(false)
  })

  it('counts anything that alters what the desk says', () => {
    expect(changesContent('widgets:update', ['w', { content: 'hello' }])).toBe(true)
    expect(changesContent('widgets:update', ['w', { x: 1, content: 'hello' }])).toBe(true)
    expect(changesContent('widgets:create', [{}])).toBe(true)
    expect(changesContent('widgets:delete', ['w'])).toBe(true)
    expect(changesContent('documents:update', ['d', {}])).toBe(true)
    expect(changesContent('tables:createRow', ['t'])).toBe(true)
  })

  it('is what the decision reports, so the bar hears about the right ones', () => {
    expect(decideCall('widgets:update', ['w', { x: 1 }]).edits).toBe(false)
    expect(decideCall('widgets:update', ['w', { content: 'x' }]).edits).toBe(true)
    expect(decideCall('deskLayout:save', [{}]).edits).toBe(false)
  })
})
