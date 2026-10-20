import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, typeInComposer, waitForReady } from './_helpers'

// The retrieval trace, end to end.
//
// Only the model is faked, and it is faked at the far end: the real
// `chat:sendStream` main-process handler is swapped for one that plays a
// scripted event sequence onto the real per-request channel. Everything after
// that is the shipping code — the preload bridge, the channel naming, the event
// decoding, the store, the derivation and the component. That matters, because
// the contract under test is "the UI may only show what the server reported",
// and stubbing nearer the UI would test the stub instead.
//
// (Stubbing in the renderer is not an option anyway: contextBridge deep-freezes
// window.api, so assigning over api.chat.* silently does nothing.)
//
// e2e here is hermetic by design — _helpers strips the AI keys from the env —
// so a real key would neither be available nor deterministic.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface StreamScript {
  sources?: Array<{ n: number; docId: string; title: string; docType: string; snippet: string }>
  elapsedMs?: number
  reply?: string
  tools?: Array<{ index: number; kind: string; label: string }>
  // Emitted instead of `complete` when set.
  error?: string
}

// Replace the real handler with a scripted one. Events go out on the same
// channel, in the same shape and the same order the real one uses.
async function stubStream(app: ElectronApplication, script: StreamScript): Promise<void> {
  await app.evaluate(({ ipcMain }, s: StreamScript) => {
    try {
      ipcMain.removeHandler('chat:sendStream')
    } catch {
      /* first install — nothing to remove */
    }
    ipcMain.handle(
      'chat:sendStream',
      async (e: Electron.IpcMainInvokeEvent, input: { requestId: string }) => {
        const channel = `chat:stream:${input.requestId}`
        const send = (type: string, payload: unknown): void => {
          if (!e.sender.isDestroyed()) e.sender.send(channel, { type, payload })
        }
        const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        await wait(20)
        send('sources', { sources: s.sources ?? [], elapsedMs: s.elapsedMs ?? 240 })
        if (s.reply !== undefined) {
          await wait(40)
          send('reply', s.reply)
        }
        for (const t of s.tools ?? []) {
          await wait(40)
          send('tool', t)
        }
        await wait(40)
        if (s.error !== undefined) {
          send('error', { ok: false, error: s.error })
        } else {
          send('complete', {
            ok: true,
            message: { role: 'assistant', content: s.reply ?? '', ts: Date.now() },
            sources: s.sources && s.sources.length > 0 ? s.sources : undefined
          })
        }
        return { ok: true }
      }
    )
  }, script)
}

async function openAssistant(window: Page): Promise<void> {
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  // The overlay defaults to the Today tab (Assistant 4.5); the chat panel only
  // renders visible on the Chat tab, so select it before waiting on the panel.
  await window.locator('[data-testid="assistant-tab-chat"]').click()
  await window.locator('[data-testid="assistant-panel"]').waitFor({ state: 'visible', timeout: 8000 })
}

async function ask(window: Page, text: string): Promise<void> {
  await typeInComposer(window, text)
  await window.getByRole('button', { name: /^Send$/ }).click()
}

const src = (
  n: number,
  title: string
): { n: number; docId: string; title: string; docType: string; snippet: string } => ({
  n,
  docId: `doc-${n}`,
  title,
  docType: 'document',
  snippet: `snippet ${n}`
})

// ART-0 stubs NOTHING. It is the lock on the one failure the other tests here
// cannot see: the streaming transport not actually reaching the running app.
//
// The store falls back to the non-streaming `chat:send` when
// window.api.chat.sendStream is missing — correct behaviour, but it degrades
// silently, and a silent degrade is indistinguishable from "the trace doesn't
// work". If the preload surface ever stops shipping, this goes red instead.
test('ART-0 — the streaming transport is really exposed and really wired, with nothing stubbed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  // This spec exercises the CLOUD path with no key. Since 4.3.39 a fresh
  // profile's AI source is Local (the model ships in the app), so choose the
  // automatic cloud source explicitly, as an existing cloud user would have.
  await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))

  // 1. The preload exposes it. Without this the store silently falls back and
  //    no trace can ever appear, however correct the rest of the code is.
  const surface = await window.evaluate(() => {
    const api = (window as unknown as { api: { chat: Record<string, unknown> } }).api
    return { sendStream: typeof api.chat.sendStream, send: typeof api.chat.send }
  })
  expect(surface.sendStream).toBe('function')
  // The non-streaming path must survive alongside it — other callers use it.
  expect(surface.send).toBe('function')

  // 2. It is wired all the way through. e2e runs with the AI keys stripped, so
  //    the real handler reaches the real sendChatStream and returns the real
  //    no-key error — which can only reach the trace via the real channel, the
  //    real preload bridge and the real store.
  await openAssistant(window)
  await ask(window, 'is the streaming path connected?')
  await expect(window.locator('[data-testid="trace-error"]')).toContainText('No Anthropic API key', {
    timeout: 15_000
  })
  // And it releases the spinner rather than hanging.
  await expect(window.locator('[data-testid="chat-pending"]')).toHaveCount(0, { timeout: 8000 })
})

test('ART-1 — nothing retrieved and nothing prepared renders no trace at all', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await stubStream(app, {
    sources: [],
    reply: "I don't have Ryan's email address in your canvas or context."
  })
  await ask(window, "what's ryan's email?")

  // The answer arrives…
  await expect(window.getByText(/don't have Ryan's email address/)).toBeVisible({ timeout: 8000 })
  // …and once the request settles, no trace is left behind. Not a collapsed
  // badge, not an empty shell — nothing.
  await expect(window.locator('[data-testid="assistant-trace"]')).toHaveCount(0, { timeout: 8000 })
  await expect(window.locator('[data-testid="trace-collapsed"]')).toHaveCount(0)
})

test('ART-2 — an answer that cites nothing shows no source chips, even when retrieval returned rows', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  // The exact reported bug: six documents retrieved, an answer that used none.
  await stubStream(app, {
    sources: [1, 2, 3, 4, 5, 6].map((n) => src(n, `Retrieved doc ${n}`)),
    reply: "I don't have Ryan's email address in your canvas or context."
  })
  await ask(window, "what's ryan's email?")

  await expect(window.getByText(/don't have Ryan's email address/)).toBeVisible({ timeout: 8000 })
  // Retrieval happened, so the trace exists and names what was searched…
  await expect(window.locator('[data-testid="trace-leaf"]').first()).toBeVisible({ timeout: 8000 })
  // …but nothing was cited, so no chip row appears under the prose.
  await expect(window.locator('[data-testid="chat-sources"]')).toHaveCount(0)
})

test('ART-3 — only the cited sources become chips', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await stubStream(app, {
    sources: [src(1, 'Release checklist'), src(2, 'updater-notes.md'), src(3, 'Decisions Ledger')],
    reply: 'The signing cert is still unsigned [2].'
  })
  await ask(window, 'where is the release blocked?')

  const chipRow = window.locator('[data-testid="chat-sources"]')
  await expect(chipRow).toBeVisible({ timeout: 8000 })
  await expect(chipRow.locator('> span')).toHaveCount(1)
  await expect(chipRow).toContainText('updater-notes.md')
  await expect(chipRow).not.toContainText('Decisions Ledger')
  await expect(chipRow).not.toContainText('Release checklist')
})

test('ART-4 — real sources and prepared tools appear in the trace, then collapse to a summary', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await stubStream(app, {
    sources: [src(1, 'Release checklist'), src(2, 'updater-notes.md'), src(3, 'Decisions Ledger')],
    elapsedMs: 240,
    reply: 'Drafted the update and a note for the team [1].',
    tools: [
      { index: 0, kind: 'compose-mail', label: 'Email draft → Ryan' },
      { index: 1, kind: 'create-page', label: 'Page — Release update' }
    ]
  })
  await ask(window, 'draft the release update')

  const trace = window.locator('[data-testid="assistant-trace"]')
  await expect(trace).toBeVisible({ timeout: 8000 })
  // The real elapsed retrieval time is reported, not an estimate.
  await expect(trace).toContainText('Searched your workspace · 3 sources · 240ms', { timeout: 8000 })
  // Three source leaves plus two tool leaves.
  await expect(window.locator('[data-testid="trace-leaf"]')).toHaveCount(5, { timeout: 8000 })
  await expect(trace).toContainText('Prepared 2 tools')
  await expect(trace).toContainText('Email draft → Ryan')

  // Once done it holds, fades, and folds to a one-line summary that names only
  // what actually happened.
  const collapsed = window.locator('[data-testid="trace-collapsed"]')
  await expect(collapsed).toBeVisible({ timeout: 10_000 })
  await expect(collapsed).toContainText('3 sources · 2 tools')
  await expect(trace).toHaveCount(0)

  // Clicking it puts the detail back.
  await collapsed.click()
  await expect(trace).toBeVisible({ timeout: 4000 })
  await expect(trace).toContainText('Prepared 2 tools')

  // …and the disclosure goes BOTH ways. Re-opening used to be a one-way door:
  // the trace stayed expanded for the rest of the conversation with no way to
  // put it away, because the auto-collapse timer never fires again once the user
  // has taken control.
  const collapseControl = window.locator('[data-testid="trace-collapse"]')
  await expect(collapseControl).toBeVisible()
  await expect(collapseControl).toContainText('3 sources · 2 tools')
  await collapseControl.click()
  await expect(collapsed).toBeVisible({ timeout: 4000 })
  await expect(trace).toHaveCount(0)

  // And it opens again after that — the toggle is stable, not one-shot.
  await collapsed.click()
  await expect(trace).toBeVisible({ timeout: 4000 })
  await expect(window.locator('[data-testid="trace-collapse"]')).toBeVisible()
})

test('ART-7 — a failed trace can be put away too, and folds without looking successful', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await stubStream(app, {
    sources: [src(1, 'Release checklist')],
    elapsedMs: 33,
    error: 'Conversation hit the model context window. Start a fresh session.'
  })
  await ask(window, 'summarise everything')

  const trace = window.locator('[data-testid="assistant-trace"]')
  await expect(window.locator('[data-testid="trace-error"]')).toBeVisible({ timeout: 8000 })
  // A failure never auto-collapses — it is the only explanation on screen — so
  // without its own control it would be permanent.
  const collapseControl = window.locator('[data-testid="trace-collapse"]')
  await expect(collapseControl).toBeVisible()
  await collapseControl.click()
  // The folded summary leads with the failure: "1 source" alone would read like
  // a request that went fine.
  await expect(window.locator('[data-testid="trace-collapsed"]')).toContainText(
    'Failed · 1 source',
    { timeout: 4000 }
  )
  await expect(trace).toHaveCount(0)
})

test('ART-5 — a failure ends red and never claims work it did not do', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await stubStream(app, {
    sources: [src(1, 'Release checklist')],
    elapsedMs: 33,
    error: 'Conversation hit the model context window. Start a fresh session.'
  })
  await ask(window, 'summarise everything')

  const trace = window.locator('[data-testid="assistant-trace"]')
  await expect(trace).toBeVisible({ timeout: 8000 })
  await expect(window.locator('[data-testid="trace-error"]')).toContainText(
    'Conversation hit the model context window',
    { timeout: 8000 }
  )
  // Retrieval genuinely finished, so it stays. Nothing was written, so nothing
  // says it was — and the failed trace does not collapse itself away.
  await expect(trace).toContainText('Searched your workspace · 1 source · 33ms')
  await expect(trace).not.toContainText('Wrote the answer')
  await window.waitForTimeout(2200)
  await expect(window.locator('[data-testid="trace-collapsed"]')).toHaveCount(0)
  // The spinner is released — a failed request must not leave the composer stuck.
  await expect(window.locator('[data-testid="chat-pending"]')).toHaveCount(0)
})

test('ART-8 — a trace stays as you left it when you navigate away and back', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await stubStream(app, {
    sources: [src(1, 'Release checklist'), src(2, 'updater-notes.md')],
    elapsedMs: 51,
    reply: 'Here is the state of the release [1].'
  })
  await ask(window, 'where is the release?')

  // Let it auto-collapse, so the remembered state is "closed".
  const collapsed = window.locator('[data-testid="trace-collapsed"]')
  const trace = window.locator('[data-testid="assistant-trace"]')
  const turns = window.locator('[data-testid="assistant-turn"]')
  await expect(collapsed).toBeVisible({ timeout: 10_000 })

  // Go to another page and come back.
  //
  // Phase 4.5 changed what this probe means, and made the claim stronger.
  //
  // It used to lock a remount: the assistant re-threaded per screen, another
  // page's conversation replaced this one, every turn (and its trace) unmounted,
  // and coming back mounted them fresh — which is what broke the disclosure
  // state this test guards. Rooms was chosen specifically because it threaded
  // under its own key, where Calendar and Home both fell through to
  // '__global__' and would have switched nothing.
  //
  // Now a conversation is never replaced by the screen (plan D4), so the turn
  // stays mounted the whole way round. The disclosure claim is unchanged and
  // still asserted immediately below; what is added here is the D4 invariant
  // itself — the turn never disappears in the first place.
  const leaveAndReturn = async (): Promise<void> => {
    await window.getByRole('button', { name: /Rooms/ }).first().click()
    await expect(turns).toHaveCount(1, { timeout: 6000 })
    await window.getByRole('button', { name: /Home/ }).first().click()
    await expect(turns).toHaveCount(1, { timeout: 8000 })
  }

  await leaveAndReturn()
  // Checked IMMEDIATELY, on a deliberately short timeout. A trace that comes
  // back expanded and then folds itself away again on its own timer would
  // satisfy a lenient wait while still replaying the whole thing in front of
  // you — which is exactly the bug, and exactly what a generous timeout here
  // would hide.
  await expect(trace).toHaveCount(0, { timeout: 700 })
  await expect(collapsed).toHaveCount(1, { timeout: 700 })

  // Now open it deliberately and leave again. The choice has to survive too, in
  // the other direction.
  await collapsed.click()
  await expect(trace).toBeVisible({ timeout: 4000 })
  await leaveAndReturn()
  await expect(trace).toHaveCount(1, { timeout: 700 })
  // …and it comes back fully revealed rather than re-running the stagger. The
  // reveal shows work happening; re-enacting it for a request that finished
  // minutes ago is theatre, and it fired on every single navigation.
  await expect(window.locator('[data-testid="trace-leaf"]')).toHaveCount(2, { timeout: 700 })
})

test('ART-9 — every retrieved source in the trace is a link, cited or not', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)

  // A real desk to land on, so the click has somewhere genuine to go.
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const node = await api.nodes.create({ parentId: null, kind: 'task', title: 'TraceLinkTarget' })
    return node.id
  })

  await openAssistant(window)
  // Two sources retrieved; the answer cites only [1]. Source 2 is the case that
  // matters: retrieved, never cited, so it appears in no chip row and the trace
  // is the only place it exists.
  await stubStream(app, {
    sources: [
      { n: 1, docId: 'doc-cited', title: 'Cited doc', docType: 'doc', snippet: 'a' },
      { n: 2, docId: taskId, title: 'TraceLinkTarget', docType: 'task', snippet: 'b' }
    ],
    elapsedMs: 44,
    reply: 'Grounded in the first one [1].'
  })
  await ask(window, 'what do you know?')

  // Only one chip, because only one source was cited…
  const chipRow = window.locator('[data-testid="chat-sources"]')
  await expect(chipRow).toBeVisible({ timeout: 8000 })
  await expect(chipRow.locator('> span, > button')).toHaveCount(1)

  // …but the trace lists both, and both are links.
  const collapsed = window.locator('[data-testid="trace-collapsed"]')
  await expect(collapsed).toBeVisible({ timeout: 10_000 })
  await collapsed.click()
  const leafLinks = window.locator('[data-testid="trace-leaf-link"]')
  await expect(leafLinks).toHaveCount(2, { timeout: 4000 })

  // Following the uncited one navigates, and the conversation comes with it.
  // Phase 4.5 removed the pinned banner that used to announce this: a
  // conversation is no longer replaced by the screen, so there is no longer a
  // special case to explain. The claim the banner stood for is asserted
  // directly instead — the turn that produced the link is still on screen.
  await leafLinks.nth(1).click()
  await expect(window.locator('[data-testid="assistant-turn"]')).toHaveCount(1, { timeout: 8000 })
  await expect(window.getByText(/Grounded in the first one/)).toBeVisible()
  await expect(window.locator('[data-testid="assistant-pinned-banner"]')).toHaveCount(0)
})

test('ART-6 — clearing the thread takes its traces with it', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await stubStream(app, {
    sources: [src(1, 'Release checklist')],
    elapsedMs: 51,
    reply: 'Here is the state of the release [1].'
  })
  await ask(window, 'where is the release?')
  // Wait for the real content, not just any trace: an error trace would also be
  // "visible", and this test must not pass on one.
  await expect(window.locator('[data-testid="assistant-trace"]')).toContainText(
    'Searched your workspace · 1 source · 51ms',
    { timeout: 8000 }
  )

  await window.getByTitle('Clear chat').click()
  await expect(window.locator('[data-testid="assistant-turn"]')).toHaveCount(0, { timeout: 4000 })
  await expect(window.locator('[data-testid="assistant-trace"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="trace-collapsed"]')).toHaveCount(0)
})
