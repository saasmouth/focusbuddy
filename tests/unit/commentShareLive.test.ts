// The share-time comment copy against a REAL signal server.
//
// Everything else about this flow is tested with a fake, which is right for the
// decisions (what gets posted, in what order, with which anchor). But one claim
// cannot be tested with a fake at all: that the SERVER keeps the time we ask
// for. The fake keeps it because I wrote the fake. So this file runs the real
// client functions against a real server and reads back what it stored.
//
// OPT-IN, NEVER SKIPPED SILENTLY. A test that quietly skips when a server is
// absent is a test that reports success for work it did not do. This one runs
// only when SIGNAL_LIVE_BASE is set, and says so in its name, so a green suite
// without it is not claiming anything:
//
//   cd focusbuddy-signal && PORT=8799 DB_PATH=./data-test/v125.db node dist/server.js &
//   VITE_SIGNAL_HTTP_URL=http://localhost:8799 SIGNAL_LIVE_BASE=http://localhost:8799 \
//     npx vitest run tests/unit/commentShareLive.test.ts
//
// BOTH variables are needed and for different reasons: SIGNAL_LIVE_BASE is what
// this file talks to directly, and VITE_SIGNAL_HTTP_URL is what docCollabClient
// resolves at MODULE LOAD. Setting the latter from inside the test does not
// work — the static imports above have already loaded signalConfig by then, so
// the client silently keeps talking to production's URL and every call comes
// back null. Found that way round.
//
// Never against production: it creates accounts.

import { beforeAll, describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'

const BASE = process.env.SIGNAL_LIVE_BASE
const live = !!BASE

const PM = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The contentious clause lives in here.' }] }]
}

const stamp = Date.now().toString(36)

async function api(method: string, path: string, token: string | undefined, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  return res.json().catch(() => null)
}

async function signup(name: string): Promise<{ token: string; id: string; handle: string }> {
  const j = await api('POST', '/accounts/signup', undefined, {
    email: `${name}_${stamp}@example.com`,
    password: 'password12345',
    handle: `${name}_${stamp}`
  })
  if (!j?.sessionToken) throw new Error(`signup ${name} failed: ${JSON.stringify(j)}`)
  return { token: j.sessionToken, id: j.account.id, handle: j.account.handle }
}

describe.skipIf(!live)('share copy against a real signal server (SIGNAL_LIVE_BASE)', () => {
  let owner: { token: string; id: string; handle: string }
  let copy: typeof import('../../src/renderer/src/lib/commentShareCopy')
  let client: typeof import('../../src/renderer/src/lib/docCollabClient')

  beforeAll(async () => {
    const configured = (import.meta as unknown as { env: Record<string, string> }).env.VITE_SIGNAL_HTTP_URL
    // Fail loudly rather than quietly testing against production: without the
    // build-time variable the client would use PROD_HTTP, and this file creates
    // accounts.
    if (configured !== BASE) {
      throw new Error(
        `VITE_SIGNAL_HTTP_URL must equal SIGNAL_LIVE_BASE (${BASE}); it is ${configured ?? 'unset'}. ` +
          'See the header of this file for the command.'
      )
    }
    copy = await import('../../src/renderer/src/lib/commentShareCopy')
    client = await import('../../src/renderer/src/lib/docCollabClient')
    owner = await signup('shareowner')
  })

  it('keeps each comment’s REAL date, so nothing is "shown as added when shared"', async () => {
    const created = await client.createLiveDoc(owner.token, {
      docType: 'doc',
      title: 'Shared with comments',
      body: JSON.stringify({ doc: PM, headingStyles: {} })
    })
    expect(created?.id, 'the live document was created').toBeTruthy()

    const MONTH_AGO = Date.now() - 30 * 86_400_000
    const WEEK_AGO = Date.now() - 7 * 86_400_000
    const result = await copy.copyCommentsToLiveDoc(
      {
        token: owner.token,
        liveDocId: created!.id,
        pmJSON: PM,
        schema: getSchema(buildDocExtensions({ interactive: false })),
        comments: [
          {
            id: 'c1',
            parentId: null,
            anchor: JSON.stringify({
              kind: 'local',
              from: 1,
              to: 23,
              quote: { text: 'The contentious clause' }
            }),
            body: 'written a month ago',
            resolved: false,
            createdAt: MONTH_AGO
          },
          {
            id: 'c2',
            parentId: null,
            anchor: null,
            body: 'and this one last week, resolved',
            resolved: true,
            createdAt: WEEK_AGO
          },
          {
            id: 'r1',
            parentId: 'c1',
            anchor: null,
            body: 'a reply, also from a month ago',
            resolved: false,
            createdAt: MONTH_AGO + 3600_000
          }
        ]
      },
      { addComment: client.addComment, resolveComment: client.resolveComment }
    )

    // THE CONFIRMATION 9d ASKED FOR: the server honours createdAt, so the
    // evidence-driven note has nothing to report.
    expect(result.timeNotKept, 'v125 keeps the real dates').toBe(0)
    expect(copy.describeCopy(result)).not.toContain('added when shared')
    expect(result).toMatchObject({ threads: 2, replies: 1, failedThreads: 0, failedReplies: 0, notResolved: 0 })
    // One comment had no anchor to convert; the other's was verified.
    expect(result.unanchored).toBe(1)

    // And read it back off the server rather than trusting the response.
    const rows = await client.listComments(owner.token, created!.id)
    expect(rows).toHaveLength(3)
    const month = rows.find((r) => r.body === 'written a month ago')!
    expect(month.createdAt, 'the stored row carries the real date').toBe(MONTH_AGO)
    expect(month.anchor, 'and a converted live anchor').toBeTruthy()
    expect(JSON.parse(month.anchor as string).kind).toBe('yjs')
    expect(JSON.parse(month.anchor as string).quote.text).toBe('The contentious clause')

    const weekRow = rows.find((r) => r.body === 'and this one last week, resolved')!
    expect(weekRow.createdAt).toBe(WEEK_AGO)
    expect(weekRow.resolved, 'the resolved state travelled').toBe(true)
    expect(weekRow.anchor, 'no anchor invented for a comment that had none').toBeNull()

    const reply = rows.find((r) => r.body.startsWith('a reply'))!
    expect(reply.parentId).toBe(month.id)
    expect(reply.createdAt).toBe(MONTH_AGO + 3600_000)
  })

  it('a member who is NOT the owner cannot backdate a comment', async () => {
    // The bound that makes keeping the date safe. An editor asking for a
    // month-old date is not refused — the field is advisory — but the server
    // times their comment itself, which the client then reports honestly.
    const editor = await signup('shareeditor')
    const doc = await client.createLiveDoc(owner.token, {
      docType: 'doc',
      title: 'Backdating',
      body: JSON.stringify({ doc: PM, headingStyles: {} })
    })
    await client.inviteToLiveDoc(owner.token, doc!.id, editor.handle)
    const MONTH_AGO = Date.now() - 30 * 86_400_000
    const made = await client.addComment(editor.token, doc!.id, 'an editor backdating', { createdAt: MONTH_AGO })
    expect(made, 'the comment is accepted').toBeTruthy()
    expect(made!.createdAt, 'but timed by the server, not by the asker').toBeGreaterThan(Date.now() - 60_000)
  })
})

// Said out loud when the file did nothing, so a green run cannot be mistaken
// for a verified one.
describe.skipIf(live)('share copy against a real server', () => {
  it('did NOT run: set SIGNAL_LIVE_BASE to a local signal server to verify it', () => {
    expect(BASE).toBeUndefined()
  })
})
