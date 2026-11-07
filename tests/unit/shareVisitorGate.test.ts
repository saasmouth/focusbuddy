// What a shared desk's visitor may do (owner, 2026-11-07): look around, arrange
// the desk, drag apps, widgets, files and tools onto it. "if someone goes to
// create a desk, or room, use ai assist, or do anything other than drag apps,
// widgets, files and tools to the desk, it says download this desk on plexii."
//
// And the line that matters as much: the app writing on its own, with nobody
// behind it, NEVER opens the gate. A download prompt nobody asked for is the
// worst thing the page could do.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { decideCall, gateLabel } from '../../src/web/api/readOnly'
import {
  callContext, installShareGestures, noteActForTests, noteOwnWidget, resetShareGestures,
  USER_ACTED_MS, ADD_WINDOW_MS, type CallContext
} from '../../src/web/api/shareGate'
import { INVOKE_CHANNELS } from '../../src/web/api/channelMap.generated'
import { isReadOnlyCall } from '../../src/web/api/readOnly'

const ALL = [...new Set(Object.values(INVOKE_CHANNELS) as string[])]
const ACTED: CallContext = { userActed: true, adding: false, ownWidget: () => false }
const DROPPING: CallContext = { userActed: true, adding: true, ownWidget: () => false }
const AUTO: CallContext = { userActed: false, adding: false, ownWidget: () => false }

describe('the visitor doing something that needs Plexii', () => {
  it.each([
    ['nodes:create', [{ kind: 'task', title: 'Mine' }], 'Creating a desk'],
    ['nodes:create', [{ kind: 'folder', title: 'Mine' }], 'Creating a room'],
    ['ai:chat', [{}], 'AI'],
    ['aiChat:send', [{}], 'AI'],
    ['chat:sendStream', [{}], 'AI'],
    ['documents:generate', [{}], 'AI'],
    ['widgets:update', ['w', { content: 'typed' }], 'Editing this desk'],
    ['documents:updateBody', ['d', {}], 'Editing this desk'],
    ['tables:updateRow', ['r', {}], 'Editing this desk'],
    ['nodes:update', ['d', { title: 'Renamed' }], 'Editing this desk'],
    ['nodes:delete', ['d'], 'Deleting'],
    ['widgets:delete', ['not-theirs'], 'Removing things from the desk'],
    ['widgets:create', [{ kind: 'sticky' }], 'Adding things this way'],
    ['shares:create', [{}], 'Sharing'],
    ['meetings:create', [{}], 'Working with other people'],
    ['focus:start', [{}], 'Focus sessions']
  ])('%s is the gate ("%s")', (channel, args, label) => {
    const d = decideCall(channel as string, args as unknown[], ACTED)
    expect(d.allowed).toBe(false)
    expect(d.gate).toBe(label)
  })
})

describe('what the visitor may do', () => {
  it('reads freely', () => {
    for (const c of ['nodes:list', 'widgets:listByTask', 'files:get', 'ai:getStatus']) {
      expect(decideCall(c, [], ACTED)).toMatchObject({ allowed: true, edits: false })
    }
  })

  it('arranges the desk: moving, sizing, bringing to front, the Workcentre', () => {
    expect(decideCall('widgets:update', ['w', { x: 10, y: 20, width: 300, height: 200 }], ACTED)).toMatchObject({ allowed: true, edits: false })
    expect(decideCall('widgets:bringToFront', ['w'], ACTED).allowed).toBe(true)
    expect(decideCall('deskLayout:save', [{}], ACTED).allowed).toBe(true)
    expect(decideCall('deskLayout:saveWorkcentre', ['u', 'd', 'desktop', {}], ACTED).allowed).toBe(true)
  })

  it('moves around without a prompt: history, trail, zoom', () => {
    for (const c of ['history:record', 'trail:record', 'app:zoom', 'app:setZoomFactor', 'onboarding:record']) {
      expect(decideCall(c, [{}], ACTED).allowed).toBe(true)
    }
  })

  it('drags apps, widgets, files and tools onto the desk', () => {
    for (const c of ['widgets:create', 'files:ingestBuffer', 'files:ingestUrl', 'widgetFiles:createAndPlace', 'documents:create', 'tables:create']) {
      expect(decideCall(c, [{}], DROPPING)).toMatchObject({ allowed: true, edits: true })
    }
  })

  it('a drop does not open everything: editing and AI are still the gate', () => {
    expect(decideCall('widgets:update', ['w', { content: 'x' }], DROPPING).gate).toBe('Editing this desk')
    expect(decideCall('nodes:create', [{ kind: 'task' }], DROPPING).gate).toBe('Creating a desk')
    expect(decideCall('ai:chat', [{}], DROPPING).gate).toBe('AI')
  })

  it('takes back a widget they dropped, and only theirs', () => {
    const ctx: CallContext = { userActed: true, adding: false, ownWidget: (id) => id === 'mine' }
    expect(decideCall('widgets:delete', ['mine'], ctx).allowed).toBe(true)
    expect(decideCall('widgets:delete', ['the-senders'], ctx).gate).toBe('Removing things from the desk')
  })
})

describe('the app on its own never opens the gate', () => {
  it('nothing the app does with nobody behind it is gated', () => {
    for (const c of ALL) {
      expect(decideCall(c, [{}], AUTO).gate, c).toBeUndefined()
    }
  })

  it('keeps the old answers for automatic calls: the desk is written, the account is not', () => {
    expect(decideCall('widgets:update', ['w', { content: 'auto-save' }], AUTO).allowed).toBe(true)
    expect(decideCall('nodes:update', ['d', { status: 'open' }], AUTO).allowed).toBe(true)
    expect(decideCall('account:saveSession', [], AUTO).allowed).toBe(false)
    expect(decideCall('shares:create', [], AUTO).allowed).toBe(false)
  })

  it('a decision with no moment given is an automatic one', () => {
    expect(decideCall('nodes:create', [{ kind: 'task' }]).gate).toBeUndefined()
  })
})

describe('every channel, swept', () => {
  // The desk and Plexii's features are gated by NAME (DESK_NAMESPACES,
  // FEATURE_NAMESPACES in readOnly.ts): everything else the app writes right
  // after a click -- a cache, a cursor, its people directory, a click log -- is
  // its own bookkeeping, and a download prompt for that is the worst thing the
  // page could do.
  const GATED_AREAS = /^(widgets|nodes|documents|tables|files|fileManager|widgetLinks|widgetFiles|workItems|projects|docComments|ai|aiChat|localAi|agents|agent|agentBrowser|browserAgent|assistant|knowledge|memory|brain|voice|meetings|meet|bodyDouble|chat|mail|mailTags|extcal|calendar|timeblocks|planner|focus|export|print|backup|fileImport|snapshots|connectedApps|apps|localApp|liveDesk|share|shares|webNotifications|vault|snippets|templates|customWidget|flows|wires|design|draw|forms|decisions|reports|slides|sheet|mindmap|speeddeck|livingPage|dashboardWizard|smartStack|marketplace|image|gif|mdext|office|browserExt|streamdeck|api|webhooks|guestCapture|settings|account|billing|org|orgs|admin|teams|scim|apiKeys|sso|invites|contacts|messaging|sign):/

  it('in the desk and the features, every change is the gate unless it is named as free', () => {
    const free: string[] = []
    for (const c of ALL) {
      if (!GATED_AREAS.test(c)) continue
      const d = decideCall(c, [{}], ACTED)
      if (d.allowed) {
        if (!isReadOnlyCall(c)) free.push(c)
      } else if (!d.gate) {
        free.push(`${c} (refused quietly)`)
      }
    }
    // The whole list, so that growing it is a decision someone reads.
    expect(free.sort()).toEqual([
      'account:offlineSignInEmail',
      'agents:recordOutcome', 'agents:statsForSlug',
      'ai:localModelStatus', 'ai:setConversationSnapshot', 'aiChat:setMessageApplied',
      'brain:coverage',
      'chat:proactiveWelcome',
      'contacts:desks',
      'customWidget:inputs', 'customWidget:markUsed',
      'decisions:forObject', 'decisions:withRisk',
      'documents:changed', 'documents:enrichAll', 'documents:metadata', 'documents:reindex', 'documents:semanticActive',
      'extcal:accounts', 'extcal:remoteCalendars',
      'fileManager:allTags', 'fileManager:entriesByTag', 'fileManager:locateDocument', 'fileManager:path',
      'fileManager:reveal', 'fileManager:smartFolderEntries', 'fileManager:unfiledDocuments', 'fileManager:untaggedEntries',
      'files:extractText', 'files:open', 'files:openExternal', 'files:suggestTags', 'files:thumbnail',
      'focus:recent',
      'knowledge:semanticActive',
      'localAi:consentReply',
      'mail:markSeen', 'mail:storedThread',
      'meetings:audioInfo', 'meetings:segments',
      'nodes:staleDesks',
      'settings:encryptionAvailable', 'settings:hintAnthropic', 'settings:hintOpenAI', 'settings:hintPexels',
      'settings:hintRemoveBg', 'settings:hintTenor',
      'shares:importBundle', 'shares:inbox',
      'snapshots:create',
      'snippets:recordUse',
      'voice:preloadLocal',
      'widgetFiles:instances', 'widgetFiles:placements',
      'widgets:bringToFront', 'widgets:countsByTask',
      // Free only as a layout patch (here: no patch at all); a content patch
      // is the gate, as tested above.
      'widgets:update',
      'workItems:applySyncEvent', 'workItems:badgeCounts', 'workItems:classify', 'workItems:clearDetached',
      'workItems:kindOf', 'workItems:markRead', 'workItems:proposeCleanup', 'workItems:reclassify', 'workItems:scanPeople'
    ].filter((c) => ALL.includes(c.replace(' (refused quietly)', ''))).sort())
  })

  it('says something for every gate', () => {
    for (const c of ALL) {
      if (isReadOnlyCall(c)) continue
      expect(gateLabel(c, [{}]).length, c).toBeGreaterThan(1)
    }
  })
})

describe('the app writing on its own right after a click is not the visitor', () => {
  // Each of these opened the gate on a plain click in a real share page, or
  // runs as one: caches, cursors, logs, presence.
  it.each([
    'people:setDirectory', 'people:setSelf', 'activity:logPress', 'workspace:setCursor', 'crdt:record',
    'presence:heartbeat', 'telemetry:collect', 'deskPopup:setBounds', 'webMenu:setSurface', 'energy:log'
  ])('%s does not open the gate', (c) => {
    expect(decideCall(c, [{}], ACTED).gate).toBeUndefined()
  })
})

describe('the moment a call is made in', () => {
  afterEach(() => resetShareGestures())

  it('a click, a key or a drop is the visitor acting; a modifier alone is not', () => {
    const target = new EventTarget() as unknown as Window
    installShareGestures(target)
    resetShareGestures()
    expect(callContext().userActed).toBe(false)
    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Shift' }))
    expect(callContext().userActed).toBe(false)
    target.dispatchEvent(new Event('pointerdown'))
    expect(callContext().userActed).toBe(true)
    expect(callContext().adding).toBe(false)
    target.dispatchEvent(new Event('drop'))
    expect(callContext().adding).toBe(true)
  })

  it('wears off', () => {
    noteActForTests('drop', 1000)
    expect(callContext(1000 + USER_ACTED_MS).userActed).toBe(true)
    expect(callContext(1000 + USER_ACTED_MS + 1).userActed).toBe(false)
    expect(callContext(1000 + ADD_WINDOW_MS).adding).toBe(true)
    expect(callContext(1000 + ADD_WINDOW_MS + 1).adding).toBe(false)
  })

  it('remembers the widgets the visitor dropped', () => {
    noteOwnWidget({ id: 'w-dropped' })
    noteOwnWidget(null)
    expect(callContext().ownWidget('w-dropped')).toBe(true)
    expect(callContext().ownWidget('w-other')).toBe(false)
  })
})

describe('the doors that make no call', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.resetModules()
  })

  it('opens the gate in a share window and leaves the desktop alone', async () => {
    const seen = vi.fn()
    window.addEventListener('plexii:share-gate', seen)
    const { shareGate } = await import('../../src/renderer/src/lib/shareGate')
    expect(shareGate('Settings')).toBe(false)
    expect(seen).not.toHaveBeenCalled()
    vi.resetModules()
    const mode = await import('../../src/renderer/src/lib/shareMode')
    mode.markShareRecipient('t'.repeat(32))
    const fresh = await import('../../src/renderer/src/lib/shareGate')
    expect(fresh.shareGate('Settings')).toBe(true)
    expect(seen).toHaveBeenCalledOnce()
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ what: 'Settings' })
    window.removeEventListener('plexii:share-gate', seen)
  })

  it('asking to sign in is the gate for a visitor', async () => {
    const mode = await import('../../src/renderer/src/lib/shareMode')
    mode.markShareRecipient('t'.repeat(32))
    const { useSignInPrompt } = await import('../../src/renderer/src/stores/signInPrompt')
    const seen = vi.fn()
    window.addEventListener('plexii:share-gate', seen)
    useSignInPrompt.getState().requestOpen()
    expect(useSignInPrompt.getState().open).toBe(false)
    expect(seen).toHaveBeenCalledOnce()
    window.removeEventListener('plexii:share-gate', seen)
  })
})
