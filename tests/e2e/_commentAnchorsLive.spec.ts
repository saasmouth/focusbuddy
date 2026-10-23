/**
 * ONE-OFF live verification of comment anchors and the share-time comment copy,
 * through the REAL app against a REAL signal server (the deployed v125 code).
 * Asked for by 9d after v125 went out; this is the "report what you saw" spec.
 *
 * HARNESS CONSTRAINT, inherited from deskShareTwoWindowLive.spec.ts: the built
 * app's CSP (`connect-src 'self' ws: wss: https:`) refuses a plain-http fetch()
 * from the renderer, so the local signal server must sit behind the repo's
 * TLS-terminating proxy and the app must be BUILT pointing at that proxy. This
 * spec will NOT pass against a bundle from a plain `npm run build`, which
 * points at production. Run it:
 *
 *   # the DEPLOYED code, built from the tag so it is not "my branch, probably"
 *   cd ../signal-fix && git checkout signal-v125 && cd focusbuddy-signal
 *   npm run build && PORT=8799 DB_PATH=./data-test/v125.db node dist/server.js &
 *   node tests/e2e/support/tls-proxy.js 8798 8799 &
 *   VITE_USE_REMOTE_SIGNAL=true \
 *   VITE_SIGNAL_HTTP_URL=https://localhost:8798 \
 *   VITE_SIGNAL_WS_URL=wss://localhost:8798/ws \
 *   npm run build
 *   COMMENT_LIVE_BASE=https://localhost:8798 COMMENT_LIVE_API=http://localhost:8799 \
 *   npx playwright test tests/e2e/_commentAnchorsLive.spec.ts
 *
 *
 * ONE AT A TIME. Signup is rate-limited per IP (five a minute), and the live
 * specs share that budget — running this back-to-back with the other one
 * exhausts it and fails in a way that looks like a product fault: the sign-up
 * response never arrives and the modal is simply gone from the page snapshot.
 * Leave a minute between them.
 * NEVER against production: it creates accounts. Self-skips without
 * COMMENT_LIVE_BASE so it cannot run by accident, and `_`-prefixed so
 * `npm run test:e2e` excludes it.
 *
 * WHAT IS DRIVEN BY WHAT, labelled honestly throughout:
 *   - sign-up: REAL UI (the sign-in dialog), with the real server-assigned
 *     account read off the real /accounts/signup response.
 *   - the document and its comment: REAL UI. Selecting text by triple-click and
 *     using the comment panel, because "an owner comments and it comes back
 *     anchored" is the claim under test, so the anchor must be made by the app
 *     rather than handed to it.
 *   - sharing: REAL UI (the share dialog, its checkbox, the people picker).
 *   - what the SERVER stored: asserted over the API with the owner's own token.
 *     The app cannot show a stored anchor, and the point is what persisted.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp } from './_helpers'

// What the APP talks to: the TLS proxy, because the renderer's CSP refuses
// plain http. Its certificate is self-signed, which Electron accepts via
// --ignore-certificate-errors.
const BASE = process.env.COMMENT_LIVE_BASE
// What THIS PROCESS talks to: the signal server directly. The proxy exists only
// for the renderer's CSP; Node has no such restriction, so going direct avoids
// teaching the test process to accept a self-signed certificate — which would
// mean turning TLS verification off in a file that also knows account tokens.
// Same server either way.
const API = process.env.COMMENT_LIVE_API ?? 'http://localhost:8799'
const SHOTS = 'tests/e2e/__screenshots__/comment-anchors-live'

/** The phrase the owner will comment on, so the anchor's quote is predictable. */
const PHRASE = 'the contentious clause'
const BODY_TEXT = `Minutes of the meeting. We discussed ${PHRASE} at length and deferred it.`

let A: LaunchedApp | null = null
let B: LaunchedApp | null = null

test.afterEach(async () => {
  for (const w of [A, B]) if (w) await w.dispose()
  A = null
  B = null
})

/**
 * Get past first-run onboarding WITHOUT dismissing the sign-in modal.
 *
 * `waitForReady` dismisses both by default — including clicking "Continue
 * without account" — so a spec that wants to SIGN IN must not use it. Lifted
 * from deskShareTwoWindowLive.spec.ts, which solved this first; using
 * waitForReady cost me a run where all three tests failed on "element not
 * found" for a dialog that had been helpfully closed.
 */
async function dismissOnboardingOnly(window: Page): Promise<void> {
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 15_000
  })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 15_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

/**
 * Leave a comment on the current selection, through the real comment panel.
 *
 * The side panel opens on PlexiiAssist when a global assistant is present, so
 * the Comments TAB has to be selected first — `doc-comments-add` does not
 * exist until it is, and the failure reads as a missing button rather than a
 * closed tab.
 */
async function addCommentInApp(w: Page, text: string): Promise<void> {
  // The side panel is MINIMISED by default (useMinimizable defaultMinimized:
  // true), so neither the Comments tab nor its Add button exists yet. View ›
  // Show comments is the real control, and it opens the panel AND selects the
  // tab in one go — which is why the failure before this read as a missing
  // button rather than a closed panel.
  if (!(await w.locator('[data-testid="doc-comments-tab"]').isVisible().catch(() => false))) {
    await w.locator('[data-testid="doc-menu-view"]').click()
    await w.locator('[data-testid="doc-menu-view-list"]').getByText('Show comments', { exact: true }).click()
  }
  await expect(w.locator('[data-testid="doc-comments-tab"]')).toBeVisible({ timeout: 10_000 })
  await w.locator('[data-testid="doc-comments-add"]').click()
  await expect(w.locator('[data-testid="prompt-dialog"]')).toBeVisible({ timeout: 10_000 })
  await w.locator('[data-testid="prompt-dialog-input"]').fill(text)
  await w.locator('[data-testid="prompt-dialog-confirm"]').click()
  await expect(w.locator('[data-testid="prompt-dialog"]')).toBeHidden({ timeout: 10_000 })
}

/**
 * Leave a comment in a LIVE document, which has its own composer.
 *
 * Not the same controls as the local editor: LiveDocEditorView puts an
 * add-comment button in its header and an inline input beneath, rather than
 * the side panel's button and the prompt dialog. Reusing the local helper here
 * clicked a button that does not exist and waited for a dialog that never
 * opens.
 */
async function addLiveCommentInApp(w: Page, text: string): Promise<void> {
  const add = w.locator('[data-testid="livedoc-comment-add"]')
  await expect(add, 'the add-comment control is offered (canComment)').toBeVisible({ timeout: 15_000 })
  await add.click()
  const input = w.locator('[data-testid="livedoc-comment-input"]')
  await expect(input, 'the composer opened, so the selection was accepted').toBeVisible({ timeout: 10_000 })
  await input.fill(text)
  await w.locator('[data-testid="livedoc-comment-submit"]').click()
  await expect(input).toBeHidden({ timeout: 15_000 })
}

/** Everything this spec learns about an account it signed up. */
interface Who {
  email: string
  token: string
  id: string
  handle: string | null
}

/** Sign up through the REAL sign-in dialog, reading the real response. */
async function signUpInApp(app: LaunchedApp, email: string): Promise<Who> {
  const w = app.window
  const dialog = w.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await w.getByRole('button', { name: 'Sign up' }).click()
  await w.getByPlaceholder('you@example.com').fill(email)
  await w.getByPlaceholder('at least 8 characters').fill('password12345')
  // A first and last name are required to hold an account (4.3.41), so the
  // Create account button stays disabled without them. Derived from the email
  // so each account in a run is distinguishable in a screenshot.
  await w.locator('[data-testid="signup-first-name"]').fill('Test')
  await w.locator('[data-testid="signup-last-name"]').fill(email.split('@')[0]!.replace(/[^a-z]/gi, '') || 'Person')
  // Signup is rate-limited to 5 a minute per IP (RL_SIGNUP on the server), and
  // this file creates five accounts across three tests. That limit is real
  // production behaviour and not something to weaken for a test, so the spec
  // waits it out instead: one retry, past the one-minute window.
  type SignupJson = { ok?: boolean; sessionToken?: string; account?: { id?: string; handle?: string | null } }
  const submit = async (): Promise<{ status: number; json: SignupJson }> => {
    const res = w.waitForResponse((r) => r.url().includes('/accounts/signup'))
    await w.getByRole('button', { name: 'Create account' }).click()
    const r = await res
    return { status: r.status(), json: (await r.json()) as SignupJson }
  }
  let out = await submit()
  if (out.status === 429) {
    await w.waitForTimeout(65_000)
    out = await submit()
  }
  const json = out.json
  expect(json.ok, `signup for ${email} succeeded: ${JSON.stringify(json)}`).toBe(true)
  expect(json.sessionToken, 'a real session token came back').toBeTruthy()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  // A fresh account is offered "Verify your email" immediately, and its scrim
  // covers the whole window — every later click is intercepted in silence
  // until it goes. "Later" is the real control a person would use; verifying
  // needs a code from an email this test cannot read.
  const verify = w.locator('[role="dialog"]').filter({ hasText: 'Verify your email' })
  if (await verify.isVisible().catch(() => false)) {
    await verify.getByRole('button', { name: 'Later' }).click()
    await expect(verify).toBeHidden({ timeout: 10_000 })
  }
  // Nothing modal may remain, or the next click fails for a reason the error
  // will not name.
  await expect(w.locator('.fb-scrim')).toHaveCount(0, { timeout: 10_000 })
  return { email, token: json.sessionToken!, id: json.account!.id!, handle: json.account?.handle ?? null }
}

/** Read the live document's comments straight off the server. */
async function serverComments(token: string, docId: string): Promise<
  Array<{ id: string; body: string; parentId: string | null; anchor: string | null; resolved: boolean; createdAt: number }>
> {
  const res = await fetch(`${API}/livedocs/${docId}/comments`, { headers: { Authorization: `Bearer ${token}` } })
  const json = (await res.json()) as { ok?: boolean; comments?: never[] }
  expect(json.ok, 'the comments list came back').toBe(true)
  return (json.comments ?? []) as never
}

async function liveDocIds(token: string): Promise<string[]> {
  const res = await fetch(`${API}/livedocs`, { headers: { Authorization: `Bearer ${token}` } })
  const json = (await res.json()) as { docs?: Array<{ id: string }> }
  return (json.docs ?? []).map((d) => d.id)
}

/** Make a local document and open it. IPC-driven: not the contract under test. */
async function openNewDoc(app: LaunchedApp, title: string): Promise<string> {
  const docId = await app.window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: { documents: { create: (i: unknown) => Promise<{ id: string }> } } }).api
    const body = {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Minutes of the meeting. We discussed the contentious clause at length and deferred it.'
              }
            ]
          }
        ]
      },
      headingStyles: {}
    }
    const d = await api.documents.create({ docType: 'doc', title: t, body } as never)
    return d.id
  }, title)
  await app.window.evaluate(
    (i: string) =>
      (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView
        .getState()
        .goDocument(i),
    docId
  )
  await expect(app.window.locator('[data-testid="doc-share-button"]')).toBeVisible({ timeout: 15_000 })
  return docId
}

test.describe(BASE ? 'comment anchors, live against v125' : 'comment anchors, live (skipped)', () => {
  test.skip(!BASE, 'set COMMENT_LIVE_BASE to a local signal proxy to run this')
  test.setTimeout(240_000)

  test('an owner comments, it anchors, and sharing carries it with its real date', async () => {
    const stamp = Date.now().toString(36)
    const viewerEmail = `viewer_${stamp}@example.com`

    // B signs up FIRST, and that order is load-bearing: the email invite
    // resolves an EXISTING account (accounts.getByEmail) and only then can its
    // role be set. Invite an address with no account and the server records a
    // pending invite instead, there is no member to downgrade, and the share
    // lands as an editor — which is exactly what happened on my first run, and
    // what the screenshot caught while the test said "viewer".
    B = await launchApp({ extraArgs: ['--ignore-certificate-errors'] })
    await dismissOnboardingOnly(B.window)
    const viewer = await signUpInApp(B, viewerEmail)
    expect(viewer.id, 'the viewer account really exists before the invite').toBeTruthy()

    A = await launchApp({ extraArgs: ['--ignore-certificate-errors'] })
    await dismissOnboardingOnly(A.window)
    const owner = await signUpInApp(A, `owner_${stamp}@example.com`)
    await A.window.screenshot({ path: `${SHOTS}/01-owner-signed-in.png` })

    // ── The comment, through the real UI ────────────────────────────────────
    const docId = await openNewDoc(A, `Minutes ${stamp}`)

    // A real text selection: triple-click selects the paragraph, which is how a
    // person gets a selection, and addComment refuses an empty one.
    const para = A.window.locator('.ProseMirror p').first()
    await expect(para).toContainText(PHRASE)
    await para.click({ clickCount: 3 })

    await addCommentInApp(A.window, 'Fix this before anyone else reads it')

    // The thread is in the panel, and the passage is highlighted in the body.
    const threads = A.window.locator('[data-testid^="doc-comment-thread-"]')
    await expect(threads).toHaveCount(1, { timeout: 10_000 })
    await expect(A.window.locator('.ProseMirror .fb-comment')).toHaveCount(1, { timeout: 10_000 })
    await expect(A.window.locator('.ProseMirror .fb-comment')).toContainText(PHRASE)
    await A.window.screenshot({ path: `${SHOTS}/02-comment-anchored-locally.png` })

    // The LOCAL anchor really is stored with the comment (not a mark in the
    // body): read it back through the documents IPC.
    const localAnchor = await A.window.evaluate(async (id: string) => {
      const api = (window as unknown as {
        api: { documents: { listComments: (d: string) => Promise<Array<{ anchor: string | null }>> } }
      }).api
      const rows = await api.documents.listComments(id)
      return rows[0]?.anchor ?? null
    }, docId)
    expect(localAnchor, 'the comment carries its own anchor').toBeTruthy()
    const parsedLocal = JSON.parse(localAnchor!) as { kind: string; quote?: { text: string } }
    expect(parsedLocal.kind).toBe('local')
    expect(parsedLocal.quote?.text, 'with a quote of the text it is on').toContain(PHRASE)

    // ── Share, with the box TICKED, through the real UI ─────────────────────
    await A.window.locator('[data-testid="doc-share-button"]').click()
    const box = A.window.locator('[data-testid="share-include-comments"]')
    await expect(box, 'the checkbox is offered because the document has a comment').toBeVisible({ timeout: 10_000 })
    await expect(box).toContainText('Include my comments (1)')
    const checkbox = box.locator('input[type="checkbox"]')
    await expect(checkbox, 'UNTICKED by default').not.toBeChecked()
    await A.window.screenshot({ path: `${SHOTS}/03-share-dialog-unticked.png` })
    await checkbox.check()
    await expect(checkbox).toBeChecked()

    // Share with B as a VIEWER. The permission is a <select>, and my first
    // attempt clicked text inside a .catch(() => {}) — which silently did
    // nothing and invited them as an EDITOR. The screenshot showed "Can edit"
    // while the test claimed "viewer", which is why the select is now driven
    // properly AND asserted.
    const permSelect = A.window.locator('[title="What the people you add can do"]')
    await permSelect.selectOption('view')
    await expect(permSelect).toHaveValue('view')
    const search = A.window.locator('[data-testid="share-picker-search"]')
    await search.fill(viewerEmail)
    await A.window.locator('[data-testid="share-picker-invite-email"]').click()
    await A.window.screenshot({ path: `${SHOTS}/04-share-dialog-ticked.png` })
    await A.window.locator('[data-testid="share-picker-submit"]').click()

    // ── What the SERVER stored (API-asserted) ──────────────────────────────
    await expect
      .poll(async () => (await liveDocIds(owner.token)).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
    const liveId = (await liveDocIds(owner.token))[0]!
    await expect.poll(async () => (await serverComments(owner.token, liveId)).length, { timeout: 30_000 }).toBe(1)

    // The invitee really is a VIEWER on the server, not an editor — the thing
    // the screenshot caught the first time round.
    const members = await (
      await fetch(`${API}/livedocs/${liveId}`, { headers: { Authorization: `Bearer ${owner.token}` } })
    ).json()
    const invited = (members.doc?.members ?? []).find(
      (m: { accountId: string }) => m.accountId !== owner.id
    ) as { role?: string } | undefined
    expect(invited?.role, 'invited as a viewer').toBe('viewer')
    const rows = await serverComments(owner.token, liveId)
    expect(rows[0]!.body).toBe('Fix this before anyone else reads it')
    expect(rows[0]!.anchor, 'the copied comment carries an anchor').toBeTruthy()
    const liveAnchor = JSON.parse(rows[0]!.anchor!) as { kind: string; quote?: { text: string } }
    expect(liveAnchor.kind, 'converted local -> live').toBe('yjs')
    expect(liveAnchor.quote?.text, 'with its quote intact').toContain(PHRASE)
    // The copy carries the comment's OWN creation time. In this spec the
    // comment really was made moments ago, so this shows the field is accepted
    // and sane, not that an OLD date survives — the app offers no way to
    // backdate a local comment, and a test block that pretended to do so would
    // be miming the work. The old-date claim is proven against this same v125
    // server by tests/unit/commentShareLive.test.ts, which can set arbitrary
    // dates through the client functions directly; it reads back a month-old
    // date unchanged.
    expect(rows[0]!.createdAt).toBeGreaterThan(Date.now() - 180_000)
    expect(rows[0]!.createdAt, 'and not in the future').toBeLessThanOrEqual(Date.now() + 2000)

    await A.window.screenshot({ path: `${SHOTS}/05-after-share-live-doc.png` })

    // ── The VIEWER's side: reads, sees the highlight, and may comment ──────
    // Needs ec's canComment flip (98ae08e4). Navigation is store-driven — the
    // "Shared with me" route is not what is under test — everything after it
    // is the real UI.
    await B!.window.evaluate(
      (i: string) =>
        (window as unknown as { __fbView: { getState: () => { goLiveDoc: (x: string) => void } } }).__fbView
          .getState()
          .goLiveDoc(i),
      liveId
    )
    const bEditor = B!.window.locator('.ProseMirror').first()
    await expect(bEditor).toContainText(PHRASE, { timeout: 30_000 })

    // THE WHOLE CHAIN, in one assertion: a comment anchored locally, converted
    // at share time against a Y.Doc that did not exist yet, resolved here by a
    // different person in a different process out of the room's own content.
    const bHighlight = B!.window.locator('.ProseMirror .fb-comment')
    await expect(bHighlight).toHaveCount(1, { timeout: 30_000 })
    await expect(bHighlight).toContainText(PHRASE)

    // Read-only for the BODY: the flip opened commenting, not editing.
    await expect(bEditor).toHaveAttribute('contenteditable', 'false', { timeout: 10_000 })

    // And the viewer can leave a comment of their own — which needs a
    // selection of their own first, exactly as the owner did.
    await B!.window.locator('.ProseMirror p').first().click({ clickCount: 3 })
    await addLiveCommentInApp(B!.window, 'A viewer may say this now')
    await B!.window.screenshot({ path: `${SHOTS}/08-viewer-sees-highlight-and-comments.png` })
    await expect
      .poll(async () => (await serverComments(viewer.token, liveId)).length, { timeout: 30_000 })
      .toBe(2)
    const after = await serverComments(viewer.token, liveId)
    const theirs = after.find((c) => c.body === 'A viewer may say this now')
    expect(theirs, "the viewer's comment is on the server").toBeTruthy()
    expect(theirs!.anchor, 'anchored, because the anchor is no longer a body write').toBeTruthy()
    expect(JSON.parse(theirs!.anchor!).kind).toBe('yjs')
  })

  test('UNTICKED copies nothing, against the real server', async () => {
    const stamp = Date.now().toString(36)
    A = await launchApp({ extraArgs: ['--ignore-certificate-errors'] })
    await dismissOnboardingOnly(A.window)
    const owner = await signUpInApp(A, `plain_${stamp}@example.com`)
    const docId = await openNewDoc(A, `Unticked ${stamp}`)

    const para = A.window.locator('.ProseMirror p').first()
    await para.click({ clickCount: 3 })
    await addCommentInApp(A.window, 'a private note')
    await expect(A.window.locator('[data-testid^="doc-comment-thread-"]')).toHaveCount(1, { timeout: 10_000 })
    void docId

    await A.window.locator('[data-testid="doc-share-button"]').click()
    const checkbox = A.window.locator('[data-testid="share-include-comments"] input[type="checkbox"]')
    await expect(checkbox).toBeVisible({ timeout: 10_000 })
    await expect(checkbox, 'left alone').not.toBeChecked()
    await A.window.locator('[data-testid="share-picker-search"]').fill(`nobody_${stamp}@example.com`)
    await A.window.locator('[data-testid="share-picker-invite-email"]').click()
    await A.window.locator('[data-testid="share-picker-submit"]').click()

    await expect
      .poll(async () => (await liveDocIds(owner.token)).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
    const liveId = (await liveDocIds(owner.token))[0]!
    // Give the copy a chance to happen wrongly before concluding it did not.
    await A.window.waitForTimeout(3000)
    expect(await serverComments(owner.token, liveId), 'the private note stayed private').toEqual([])
    await A.window.screenshot({ path: `${SHOTS}/06-unticked-nothing-copied.png` })
  })

  test('a non-member is refused the document and its comments', async () => {
    const stamp = Date.now().toString(36)
    A = await launchApp({ extraArgs: ['--ignore-certificate-errors'] })
    await dismissOnboardingOnly(A.window)
    const owner = await signUpInApp(A, `owner2_${stamp}@example.com`)
    const docId = await openNewDoc(A, `Private ${stamp}`)
    void docId
    await A.window.locator('[data-testid="doc-share-button"]').click()
    await A.window.locator('[data-testid="share-picker-search"]').fill(`friend_${stamp}@example.com`)
    await A.window.locator('[data-testid="share-picker-invite-email"]').click()
    await A.window.locator('[data-testid="share-picker-submit"]').click()
    await expect.poll(async () => (await liveDocIds(owner.token)).length, { timeout: 30_000 }).toBeGreaterThan(0)
    const liveId = (await liveDocIds(owner.token))[0]!

    // A real second account that was never invited. API-asserted: the app has
    // no UI path to open a document you are not a member of, which is itself
    // the client-side half of the answer.
    B = await launchApp({ extraArgs: ['--ignore-certificate-errors'] })
    await dismissOnboardingOnly(B.window)
    const stranger = await signUpInApp(B, `stranger_${stamp}@example.com`)

    for (const path of [`/livedocs/${liveId}`, `/livedocs/${liveId}/comments`]) {
      const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${stranger.token}` } })
      expect(res.status, `${path} refuses a non-member`).toBe(403)
    }
    // And posting a comment is refused too, which is the one that matters now
    // that viewers are allowed to comment.
    const post = await fetch(`${API}/livedocs/${liveId}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stranger.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'I should not be able to say this' })
    })
    expect(post.status, 'a non-member cannot comment').toBe(403)
    expect(await serverComments(owner.token, liveId), 'and nothing was written').toEqual([])
    await B.window.screenshot({ path: `${SHOTS}/07-stranger-signed-in.png` })
  })
})
