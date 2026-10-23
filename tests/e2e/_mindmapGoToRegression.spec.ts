import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { ACTIVE, CURRENT } from '../../src/shared/productDomains'

// The signal server, by every name it answers to.
//
// THIS SPEC WENT RED ON A HOSTNAME. Its error filter already excluded live
// signal traffic as "unrelated to this diff" — correctly, since the subject is
// the mindmap card — but it named the host as a literal, 'focusbuddy-signal
// .fly.dev'. productDomains then completed the api cutover to
// api.plexiidesk.com, which is the SAME origin by a different name (DNS-only,
// same IP, per the note on ACTIVE), so the filter stopped matching while the
// traffic it was written for carried on exactly as before.
//
// Derived from productDomains instead, so it follows the next cutover on its
// own. Both names are kept because both still answer, and a client or a stale
// link can reach either.
const SIGNAL_HOSTS = [new URL(ACTIVE.api).host, new URL(CURRENT.api).host]
const fromSignal = (text: string): boolean => SIGNAL_HOSTS.some((h) => text.includes(h))

// Regression check for plexi-4.5 commits 4b558f1 / 7305bde:
//   - MindMap's proposal apply now runs on the shared resolvedIds +
//     resolveGoToTarget primitives instead of a before/after node/widget diff.
//   - Applied proposal cards inside the mindmap node panel now render a
//     compact "Go to" button alongside Undo.
//
// This does NOT drive a live agent invocation (no Anthropic key available).
// It seeds an already-`applied` proposalState with a createdEntityRef,
// exactly the shape the new apply path produces, and asserts the UI renders
// without throwing and "Go to" is wired to a real target.

let launched: LaunchedApp | null = null
const consoleErrors: string[] = []

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
  consoleErrors.length = 0
})

test('Applied proposal card renders Go-to + Undo without console errors, and Go-to navigates', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`)
  })
  // A 404 on OUR OWN bundle is a defect: a missing icon, a dead asset path.
  // A 404 from the signal server is deployment state, and the one this spec
  // tripped on is intended — GET /public/server-features. LaunchSignInModal
  // says so at the call site: "Today's server has no such route: the answer is
  // a 404, the list stays empty and the link stays hidden", and capabilities.ts
  // asks for it behind `if (res.ok)`, so the public feature list stays empty
  // and the "restore your account" link is correctly withheld.
  //
  // Verified rather than assumed, with read-only GETs against the live API:
  // /public/server-features answers Fastify's "Route GET:... not found", while
  // /public/plans answers 200 and /conversations answers 401 — the server is up
  // and routing, and that one route simply is not deployed yet.
  window.on('response', (res) => {
    if (res.status() !== 404) return
    if (fromSignal(res.url())) return
    consoleErrors.push(`404: ${res.url()}`)
  })

  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'MindMap GoTo Regression'
    })
    // A second task standing in for "what the agent created" — the
    // createdEntityRef points at this one so Go-to has a real target.
    const createdTask = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Created by agent'
    })

    const seededState = {
      root: {
        id: 'root',
        label: 'Launch plan',
        kind: 'idea',
        children: [],
        attachedWidgetIds: [],
        assignedAgentSlugs: []
      },
      selectedId: 'root',
      agentSuggestions: {
        root: [
          {
            slug: 'positioning-and-gtm-brief-builder',
            name: 'positioning-and-gtm-brief-builder',
            rationale: 'fit',
            path: '/Applications/agentic-starter-kit-main/.claude/agents/positioning-and-gtm-brief-builder.md'
          }
        ]
      },
      agentConversations: {
        'root:positioning-and-gtm-brief-builder': {
          agentName: 'positioning-and-gtm-brief-builder',
          agentSlug: 'positioning-and-gtm-brief-builder',
          capped: false,
          userReplies: [],
          turns: [
            {
              rawReply: '{"reply":"Done.","proposals":[]}',
              reply: 'Created the follow-up task.',
              proposalStates: [
                {
                  proposal: {
                    id: 'p-applied-1',
                    kind: 'create-task',
                    title: 'Created by agent'
                  },
                  state: 'applied',
                  createdEntityRef: `task:${createdTask.id}`
                }
              ],
              invocationId: 'inv-applied-1',
              conversationTurn: 1,
              at: Date.now()
            }
          ]
        }
      },
      agentStats: {}
    }

    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'mindmap',
      title: '',
      content: JSON.stringify(seededState),
      x: 200,
      y: 200,
      width: 720,
      height: 480
    })
    return { taskId: task.id, widgetId: w.id, createdTaskId: createdTask.id }
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'MindMap GoTo Regression' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // Mindmap renders without throwing.
  await expect(window.locator('[data-testid="mindmap-svg"]').first()).toBeVisible({
    timeout: 5_000
  })

  // The applied card's reply text is visible (conversation section rendered).
  await expect(window.getByText('Created the follow-up task.')).toBeVisible({ timeout: 5_000 })

  // Go-to button renders alongside Undo for the applied proposal.
  const goToBtn = window.locator('[data-testid="mindmap-goto-p-applied-1"]').first()
  await expect(goToBtn).toBeVisible({ timeout: 5_000 })
  const undoBtn = window.locator('[data-testid="mindmap-undo-p-applied-1"]').first()
  await expect(undoBtn).toBeVisible()

  // Clicking Go-to sets the created task active (real navigation, not a stub).
  await goToBtn.click()
  await window.waitForTimeout(300)
  const activeTaskId = await window.evaluate(() => {
    const w = window as unknown as {
      __fbNodes?: { getState: () => { activeTaskId?: string | null } }
    }
    return w.__fbNodes?.getState().activeTaskId ?? null
  })
  expect(activeTaskId).toBe(seeded.createdTaskId)

  const relevantErrors = consoleErrors.filter(
    (e) =>
      !e.includes('database connection is not open') && // known unrelated teardown noise
      !e.includes('ERR_CONNECTION_REFUSED') && // signal-server not reachable in this harness
      !fromSignal(e) && // live network call unrelated to this diff — see SIGNAL_HOSTS
      !e.includes('Failed to load resource') // generic echo of the network 404 above
  )
  expect(relevantErrors).toEqual([])
})
