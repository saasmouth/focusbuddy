import {
  expect,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchGuarded, type NetGuard } from './_netGuard'

/**
 * Boot the built Electron app with an isolated userData directory so each test
 * gets a fresh SQLite database. The caller is responsible for calling
 * `disposeApp` in afterEach/afterAll — otherwise we leak temp dirs.
 *
 * Returns the launched application, its first window, and a cleanup function.
 */
export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  userDataDir: string
  dispose: () => Promise<void>
  /** The e2e net guard for this launch (_netGuard.ts): what it refused. */
  netGuard: NetGuard
}

export async function launchApp(opts?: {
  env?: Record<string, string>
  // Reuse an existing userData directory instead of minting a fresh one —
  // for restart-persistence specs that need a second Electron instance to
  // see what the first one saved (e.g. confirming a server-side save
  // survives a relaunch + session revalidation, not just in-memory state).
  // The caller owns cleanup of a reused dir; `dispose()` only removes
  // directories this call itself created.
  userDataDir?: string
  // Extra Chromium/Electron command-line switches appended after the '.'
  // launch arg — e.g. ['--force-device-scale-factor=2'] for hi-dpi marketing
  // screenshot captures. Opt-in; empty by default so existing specs are
  // unaffected.
  extraArgs?: string[]
  // Arguments placed BEFORE the '.' app path. Electron only honours Node flags
  // such as `-r <module>` there (Playwright strips NODE_OPTIONS), which is how
  // _networkInventory.spec.ts preloads its main-process socket recorder.
  preArgs?: string[]
  // netGuard.spec.ts only — see launchGuarded's selfTest.
  netGuardSelfTest?: boolean
}): Promise<LaunchedApp> {
  const userDataDir = opts?.userDataDir ?? mkdtempSync(join(tmpdir(), 'plexii-e2e-'))
  const ownsDir = !opts?.userDataDir
  // ELECTRON_RUN_AS_NODE=1 makes Electron boot as a plain Node process — which
  // is what happens when these tests run from inside another Electron host
  // (e.g. Claude Code's terminal). Strip it before launching so we get a real
  // Electron browser process. The user's own dev script does the same (see
  // package.json `dev: env -u ELECTRON_RUN_AS_NODE electron-vite dev`).
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  // Keep e2e hermetic: never make real (paid, slow, non-deterministic) AI calls.
  // The mind-map / voice / wire / agent specs all assert structural plumbing and
  // the graceful no-key path, not real model output. Leaving a developer's key
  // in the env made agent/transform runs hit Sonnet for 10-30s and race the
  // Electron teardown ("Target page has been closed"). Stripping the keys forces
  // the fast, deterministic no-key path.
  delete cleanEnv.ANTHROPIC_API_KEY
  delete cleanEnv.OPENAI_API_KEY

  // launchGuarded holds the first window until the net guard's routes are in
  // place, so no request or socket from this app reaches a production host
  // (see _netGuard.ts).
  const { app, guard: netGuard } = await launchGuarded({
    args: [...(opts?.preArgs ?? []), '.', ...(opts?.extraArgs ?? [])],
    cwd: process.cwd(),
    env: {
      ...cleanEnv,
      FB_TEST_USER_DATA: userDataDir,
      NODE_ENV: 'test',
      // A tree with resources/models staged checks the bundled model's sha256
      // once (it decides whether a fresh profile starts on Local). Share that
      // result across the suite's throwaway profiles instead of re-hashing
      // 2.5 GB in every launched app; the entry is keyed by path, size, mtime
      // and the expected sha256 (localAiService.verifiedCacheFile).
      PLEXII_MODEL_VERIFY_CACHE: join(tmpdir(), 'plexii-e2e-bundle-verified.json'),
      // Per-test overrides (e.g. PLEXI_APP=preview3 for the preview-build guard).
      ...(opts?.env ?? {})
    },
    timeout: 20_000
  }, { selfTest: opts?.netGuardSelfTest })
  // Forward main-process stdout/stderr to test stdout so debugging "page
  // closed" failures actually shows the real Electron error.
  app.process().stdout?.on('data', (b) => process.stdout.write(`[main] ${b}`))
  app.process().stderr?.on('data', (b) => process.stderr.write(`[main] ${b}`))
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  // The missed-calendar triage can appear at ANY moment, not just at launch:
  // its effect awaits a store load, it is armed once per renderer load (so
  // every reload re-arms it), and any block seeded or booked in the past
  // triggers it. It is a full-screen scrim at z-[330], so it silently swallows
  // whatever the spec clicks next — TB-2 and all four calendarDragResize tests
  // were failing on it, the drags reporting a delta of exactly 0 because the
  // mouse never reached the grid.
  //
  // A one-shot check in waitForReady cannot catch something that mounts later,
  // and polling for it would cost every spec a wait it does not need. A locator
  // handler is the right shape: Playwright runs it only when this overlay is
  // actually blocking an action, and it stays armed across navigations.
  // "Later" costs nothing and returns next launch, so dismissing it changes no
  // state the specs care about.
  await window.addLocatorHandler(
    window.locator('[data-testid="missed-triage"]'),
    async (overlay) => {
      // `exact` matters: the dialog also carries a per-row icon button titled
      // "Later — nothing changes", so a loose name matches two elements and the
      // handler dies on strict mode instead of dismissing anything.
      await overlay
        .getByRole('button', { name: 'Later', exact: true })
        .click({ timeout: 4_000 })
    },
    { noWaitAfter: true }
  )

  async function dispose(): Promise<void> {
    // app.close() on Electron 37 / macOS can hang indefinitely when the
    // inspector remains attached. Race it against a 5 s timeout and fall back
    // to SIGKILL so tests don't exhaust the 30 s afterEach budget.
    try {
      await Promise.race([
        app.close(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('app.close() timed out')), 5_000)
        )
      ])
    } catch {
      // Grace period elapsed or app already gone — force-kill the process.
      try {
        app.process().kill()
      } catch {
        // Already dead
      }
    }
    if (ownsDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        // Best effort
      }
    }
    // Fails the spec if it reached for production and the failure was not
    // already reported to the running test.
    try {
      netGuard.assertClean()
    } finally {
      netGuard.finish()
    }
  }
  return { app, window, userDataDir, dispose, netGuard }
}

/**
 * Wait for the React shell to mount and dismiss any post-boot modals
 * (launch sign-in dialog, welcome prompts) that would otherwise
 * intercept pointer events.
 *
 * Single source of truth for "the app is ready to drive" so future
 * rebrands / wordmark changes only require an edit in one place. The
 * sidebar wordmark heading is the canary (its accessible name is
 * "PLEXII" after the futuristic-theme rebrand — matched via regex
 * so a future rename doesn't break every spec again).
 */
export async function waitForReady(
  window: Page,
  opts: { dismissModals?: boolean } = {}
): Promise<void> {
  const dismissModals = opts.dismissModals ?? true
  // Wait for window.api so renderer-side IPC calls inside the test are
  // safe to make immediately after this resolves.
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )

  // App-shell painted signal. The old wordmark heading only rendered on the
  // home/suite view, so a test that reloaded into a non-home view (Documents,
  // Calendar, an editor) would hang here even though the app was fully ready.
  // The global footer sync chip renders in every view as a sibling of <main>,
  // so it is the robust "shell is up" signal that survives a reload into any
  // view. (The renderer-ready gate above already confirms window.api exists.)
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 10_000 })

  if (!dismissModals) return

  // First-run onboarding — a fresh test DB triggers it, and its full-screen
  // overlay would intercept pointer events for every UI-driving spec. Click
  // through to dismiss (welcome → skip key → start blank). Best-effort; absent
  // for an existing-data DB. Specs that assert on onboarding pass
  // { dismissModals: false }.
  // Every dismissal below is best-effort, so every click is BOUNDED. An
  // unbounded click on something another modal covers does not fail — it
  // retries until the test's own timeout, with the .catch() swallowing why. That
  // is how restyleVisual "timed out": its fourth boot met the account-required
  // sign-in modal (no skip button by design), the spotlight's Dismiss sat
  // underneath it, and the click spent 30s being intercepted in silence.
  const BEST_EFFORT = { timeout: 5_000 }
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click(BEST_EFFORT).catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click(BEST_EFFORT).catch(() => {})
    // Tour step (surfaces overview) sits between the key step and the starter.
    await window.locator('[data-testid="onboarding-tour-continue"]').click(BEST_EFFORT).catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click(BEST_EFFORT).catch(() => {})
  }

  // Sign-in modal — dismiss with "Continue without account" so subsequent
  // interactions don't get pointer-intercepted by the modal overlay.
  // Best-effort: if the modal isn't there (account already signed in, or
  // already dismissed within the 7-day TTL) the call is a no-op.
  const skip = window.getByRole('button', {
    name: /continue without account|skip|not now/i
  })
  if (await skip.isVisible().catch(() => false)) {
    await skip.click(BEST_EFFORT).catch(() => {})
  }

  // Feature-tour spotlight — the corner card offered on the first boot AFTER
  // core onboarding is done, which for a spec means the boot after a seeded
  // reload. It docks bottom-right at z-[230], exactly over the assistant pill
  // and panel, and intercepts their clicks. Best-effort dismiss; it can also
  // appear a beat later (its init awaits two IPC calls), so specs that drive
  // the bottom-right corner should additionally call suppressFeatureSpotlights
  // before reloading.
  const spotlight = window.locator('[data-testid="feature-spotlight-dismiss"]')
  if (await spotlight.isVisible().catch(() => false)) {
    await spotlight.click(BEST_EFFORT).catch(() => {})
  }

  // The missed-calendar triage is handled by a locator handler armed in
  // launchApp — it can mount long after this returns, so a check here would
  // miss it.
}

// Where each former top-level product now lives under the three-segment IA.
//   - `seg` products live inside a SegmentShell (PlexiDesk / PlexiBrain): open
//     the segment via its nav testid, then click `segment-app-<app>`.
//   - `comms` products live inside the PlexiOffice shell's Communicate menu:
//     open PlexiOffice, then click `office-comms-app-<app>`.
//   - `direct` products no longer have a segment home (Build / Form); navigate
//     straight to their view through the view store so their spec coverage
//     survives. The view renders in the global MainPane, testids unchanged.
// ── Booking time on the week grid ───────────────────────────────────────────
// The inline BlockComposer was deleted by DEC-080 (34feaab1, 2026-08-30): the
// Book time dialog is now the one create / edit / proposal surface, and a plain
// click on an empty slot opens it at the pressed slot. The old testids map
// across as block-composer -> book-time-dialog, composer-create -> book-commit,
// composer-meeting-toggle -> the "Meeting" tab in the dialog header (a mode
// slider: Focus time | Meeting), and composer-invitees -> guest-input, which
// the Meeting mode reveals.
export async function openBookTimeDialog(
  window: Page,
  dayIndex = 2,
  y = 180
): Promise<Locator> {
  await window.locator(`[data-testid="day-col-${dayIndex}"]`).click({ position: { x: 20, y } })
  const dialog = window.locator('[data-testid="book-time-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 8_000 })
  return dialog
}

// Turn a booked block into a meeting, revealing the guests field.
export async function chooseMeetingMode(dialog: Locator): Promise<void> {
  const meetingTab = dialog.getByRole('tab', { name: 'Meeting' })
  await expect(meetingTab).toBeVisible()
  await meetingTab.click()
  await expect(meetingTab).toHaveAttribute('aria-selected', 'true')
}

// ── The document side panel ─────────────────────────────────────────────────
// The outline/comments panel starts MINIMISED (5d6e3afe, 2026-09-18): it used
// to open with every document, spending a slice of the width on outline and
// comments nobody asked for — worst in a document widget on a desk. The choice
// is remembered in localStorage, so a fresh e2e profile always starts collapsed
// and a spec that wants the panel has to ask for it.
export async function openDocSidePanel(window: Page): Promise<void> {
  const panel = window.locator('[data-testid="doc-side-panel"]')
  if (await panel.isVisible()) return
  await window.locator('[data-testid="doc-side-panel-expand"]').click()
  await expect(panel).toBeVisible({ timeout: 8_000 })
}

// ── Capabilities ────────────────────────────────────────────────────────────
// Grant a capability for the rest of the session. __fbCapabilities is the real
// store (stores/capabilities.ts exposes it for exactly this), so nothing about
// how the app behaves changes — this is the same path a Pro/Team snapshot takes.
// Use it for a spec whose subject is a feature's behaviour rather than its
// entitlement; a spec about gating should drive the capability endpoint instead.
export async function grantCapability(window: Page, cap: string): Promise<void> {
  const ok = await window.evaluate((c: string) => {
    const store = (
      window as unknown as {
        __fbCapabilities?: {
          getState: () => { capabilities: Record<string, unknown> }
          setState: (p: { capabilities: Record<string, unknown> }) => void
        }
      }
    ).__fbCapabilities
    if (!store) return false
    store.setState({ capabilities: { ...store.getState().capabilities, [c]: true } })
    return true
  }, cap)
  if (!ok) throw new Error(`window.__fbCapabilities not exposed — cannot grant ${cap}`)
}

/**
 * Choose the automatic CLOUD AI source, as an existing cloud user would have.
 *
 * Since 4.3.39 a fresh profile's AI source is Local, because the model ships
 * in the app. Two consequences for e2e, and the second is the one that wastes
 * an afternoon:
 *
 *   a spec exercising the cloud path with no key is now testing the LOCAL
 *   path unless it says otherwise;
 *
 *   when the model is not present, a fixed "local AI missing" notice sits at
 *   top centre on z-9997 and INTERCEPTS CLICKS. A spec then fails on
 *   `design-add-text` not being clickable, which reads as a Design bug and is
 *   not one. Switching the AI source clears the notice (d8's 1ffd31f3), so
 *   this doubles as the way to get it off the canvas.
 *
 * It also dismisses the one-time "local AI is now built in" intro card, which
 * is the SECOND fixed element in this family: bottom centre, z-225, and it too
 * intercepts clicks — it is what blocks "Add a page and continue the story" at
 * the foot of the story editor, 30 seconds of retries ending in a timeout that
 * reads as a page-layout bug. Switching the source does not clear this one, so
 * it is dismissed explicitly (localAi.dismissIntro, the same call the card's
 * own close button makes).
 *
 * Call it after waitForReady and before touching the UI. Returns silently if
 * the api is not exposed, so a spec that does not need AI is unaffected.
 */
export async function chooseCloudAiSource(window: Page, mode: 'auto' | 'byok' = 'auto'): Promise<void> {
  await window.evaluate(async (m: string) => {
    const api = (
      window as unknown as {
        api?: {
          ai?: { setMode?: (x: string) => Promise<unknown> }
          localAi?: { dismissIntro?: () => Promise<unknown> }
        }
      }
    ).api
    if (api?.ai?.setMode) await api.ai.setMode(m)
    if (api?.localAi?.dismissIntro) await api.localAi.dismissIntro()
  }, mode)
  // dismissIntro only records the dismissal; a card already on screen is
  // closed by its own control, so press it when it is there.
  //
  // With a SHORT timeout. The card can unmount between isVisible() and click()
  // (dismissIntro above, or its own fade), and a bare click() then waits the
  // default action timeout — 30s, the whole test budget — for an element that
  // is gone, with a .catch that only fires after the test has already timed
  // out. That made specs pass in ~3s or hang to exactly 30s (snippets SN-1/3/4/5
  // and SD-1 on the 4.3.41 final pass, 3 of 8 isolated repeats).
  const intro = window.locator('[data-testid="local-ai-intro-dismiss"]')
  if (await intro.isVisible().catch(() => false)) await intro.click({ timeout: 2_000 }).catch(() => undefined)
  await intro.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined)
}

// ── The area switcher ────────────────────────────────────────────────────────
// Desk / Office / People / Brain are tabs in every area's menu
// (segment/SegmentSwitcher.tsx), each carrying `switch-<kind>`.
//
// They spent 2026-10-09 to 2026-10-10 folded inside the WorkspaceSwitcher
// dropdown instead (c581655d), which is why these helpers tolerate both
// shapes: a tab that is already on screen is clicked directly, and only if it
// is not visible do we go looking for a trigger to open. That keeps every spec
// working whichever way the chrome is arranged, which is the whole reason the
// fold broke forty of them at once.
export async function openAreaSwitcher(window: Page): Promise<void> {
  // Tabs on screen: nothing to open.
  if (await window.locator('[data-testid="switch-office"]').first().isVisible().catch(() => false)) {
    return
  }
  const menu = window.locator('[data-testid="workspace-switcher-menu"]')
  if (await menu.isVisible().catch(() => false)) return
  // WAIT for the trigger rather than probing it. Probing made this a silent
  // no-op whenever the chrome had not mounted yet, and the caller then timed
  // out on switch-<area> as if the area did not exist: a 30s beforeAll failure
  // with no mention of the switcher in it. On a machine running several e2e
  // suites at once that is the difference between green and a mystery red —
  // designFootnotes failed this way three times and passed alone every time.
  const trigger = window.locator('[data-testid="workspace-switcher-trigger"]').first()
  await expect(trigger, 'the workspace switcher trigger never mounted').toBeVisible({ timeout: 20_000 })
  await trigger.click()
  // One retry: the first press can be swallowed by chrome that mounts over it
  // (the local-AI cards, the feature-spotlight card), and a dropdown that did
  // not open is indistinguishable from an area that is not there.
  if (!(await menu.isVisible().catch(() => false))) {
    await trigger.click()
  }
  await expect(menu).toBeVisible({ timeout: 8_000 })
}

export type AreaKind = 'plexidesk' | 'office' | 'plexipeople' | 'plexibrain'

// Switch to an area.
export async function switchArea(window: Page, kind: AreaKind): Promise<void> {
  await openAreaSwitcher(window)
  const item = window.locator(`[data-testid="switch-${kind}"]`).first()
  await expect(item).toBeVisible({ timeout: 8_000 })
  // A locked area answers the click with its upgrade reason and navigates
  // nowhere, so only an entitled switch is expected to change anything.
  const locked = (await item.getAttribute('data-locked')) === 'true'
  await item.click()
  if (locked) return
  // If the click came from inside the dropdown, that dropdown closes behind it.
  const menu = window.locator('[data-testid="workspace-switcher-menu"]')
  if (await menu.count()) await expect(menu).toBeHidden({ timeout: 8_000 })
}

// Is an area entitlement-locked? Leaves the chrome as it found it.
export async function isAreaLocked(window: Page, kind: AreaKind): Promise<boolean> {
  await openAreaSwitcher(window)
  const locked =
    (await window.locator(`[data-testid="switch-${kind}"][data-locked="true"]`).count()) > 0
  const menu = window.locator('[data-testid="workspace-switcher-menu"]')
  if (await menu.isVisible().catch(() => false)) {
    await window.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 8_000 })
  }
  return locked
}

type ProductRoute =
  | { mode: 'seg'; switch: AreaKind; app: string }
  | { mode: 'comms'; app: string }
  | { mode: 'officeApp'; app: string }
  | { mode: 'direct'; go: string }

const SEGMENT_OF: Record<string, ProductRoute> = {
  // Plans and Tasks are Desk-area views reachable straight from the view store.
  projects: { mode: 'direct', go: 'goProjects' },
  tasks: { mode: 'direct', go: 'goAllTasks' },
  reports: { mode: 'direct', go: 'goReports' },
  // Flow / API live in the PlexiBrain area; jump there via the always-visible
  // area switcher, then click the app's menu row.
  flow: { mode: 'seg', switch: 'plexibrain', app: 'flows' },
  api: { mode: 'seg', switch: 'plexibrain', app: 'api' },
  search: { mode: 'seg', switch: 'plexibrain', app: 'search' },
  chat: { mode: 'comms', app: 'chat' },
  inbox: { mode: 'comms', app: 'inbox' },
  // PlexiiCall is a PlexiiApps tile (office-sideapp-*), not a Tools one.
  meet: { mode: 'officeApp', app: 'meet' },
  build: { mode: 'direct', go: 'goApps' },
  form: { mode: 'direct', go: 'goForms' }
}

// Navigate to a product. The area switcher (Desk / Office / People / Brain) is
// visible on every view, so we switch area then open the app; Desk-area views are
// driven straight through the view store. The product's own view + testids render
// unchanged.
export async function openProduct(window: Page, product: keyof typeof SEGMENT_OF): Promise<void> {
  const route = SEGMENT_OF[product]

  if (route.mode === 'direct') {
    await window.evaluate((go) => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState()[go]?.()
    }, route.go)
    return
  }

  if (route.mode === 'comms') {
    await switchArea(window, 'office')
    await window.locator(`[data-testid="office-comms-app-${route.app}"]`).click()
    return
  }

  if (route.mode === 'officeApp') {
    await switchArea(window, 'office')
    await window.locator(`[data-testid="office-sideapp-${route.app}"]`).click()
    return
  }

  // The area's apps are rows in the side menu's accordion (nav-<area>-<app>)
  // since b7dae811; the segment-app-* tiles went with the per-area menus.
  await switchArea(window, route.switch)
  // The old `segment-app-${app}` was never a control: SegmentShell passes that
  // string to PageEnter as `id`, and PageEnter uses `id` only as a React key
  // (chrome/pageEnter.tsx), so the click matched nothing and waited out the
  // full 30s timeout.
  await window.locator(`[data-testid="nav-${route.switch}-${route.app}"]`).first().click()
}

// Navigate through the exposed view store. The object-based IA no longer has
// literal sidebar buttons for these destinations, so specs drive navigation via
// __fbView (the same approach documents.spec.ts / documentTrash.spec.ts use).
// Use this instead of getByRole('button', { name: /^Documents$/ }) and friends.
export async function gotoView(
  window: Page,
  fn:
    | 'goHome'
    | 'goSuite'
    | 'goSign'
    | 'goMarketplace'
    | 'goDocuments'
    | 'goCalendar'
    | 'goVault'
    | 'goAllTasks'
    | 'goProjects'
    | 'goReports'
    | 'goFiles'
    | 'goInbox'
    | 'goMeetings'
    | 'goMail'
): Promise<void> {
  await window.evaluate((f) => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()[f]?.()
  }, fn)
  await window.waitForTimeout(300)
}

// ── The assistant composer ─────────────────────────────────────────────────
// Phase 4.3 replaced the composer's <textarea> with a small TipTap editor so
// mention chips can sit inside the sentence (plan D9). A contenteditable has no
// value, and Playwright's fill() writes straight into the DOM — bypassing
// ProseMirror's transactions, which leaves the editor's own document stale and
// the message empty. Every suite goes through these two helpers instead, so the
// one fact "the composer is an editor now" lives in one place.

export function composer(window: Page): Locator {
  return window.locator('[data-testid="chat-composer"]')
}

// Reveal the widget palette. The FloatingToolbar collapses to an icon pill and
// only mounts the palette (data-testid="palette-add-button") while hovered, so any
// spec that clicks the Add-widget button must hover the toolbar first. Best-effort:
// if the toolbar isn't present (some layouts show the canvas FAB instead) this is a
// no-op and the caller falls back to palette-fab-button.
export async function hoverToolbar(window: Page): Promise<void> {
  const toolbar = window.locator('[data-testid="floating-toolbar"]').first()
  if (await toolbar.isVisible().catch(() => false)) {
    await toolbar.hover().catch(() => {})
    await window.waitForTimeout(150)
  }
}

// Reveal the zoom pill's − / + buttons. ZoomControls is a hover-expand pill:
// collapsed it mounts only the percentage, and the zoom-out / zoom-in buttons
// (title="Zoom out (⌘[)" / "Zoom in (⌘])") do not exist in the DOM at all until
// it is hovered. Any spec that drives zoom through those buttons must hover it
// first — the same shape as hoverToolbar above.
export async function hoverZoomControls(window: Page): Promise<void> {
  const pill = window.locator('[data-testid="zoom-controls"]').first()
  if (await pill.isVisible().catch(() => false)) {
    await pill.hover().catch(() => {})
    await window.waitForTimeout(220) // the reveal animation is 180ms
  }
}

// Replace the composer's contents by typing, exactly as a user would, so the
// editor's document is genuinely updated.
export async function typeInComposer(window: Page, text: string): Promise<void> {
  const box = composer(window)
  await box.waitFor({ state: 'visible', timeout: 8000 })
  await box.click()
  await window.keyboard.press('ControlOrMeta+a')
  await window.keyboard.press('Backspace')
  await window.keyboard.type(text)
  // Let the onUpdate → setDraft round trip land before the caller clicks Send;
  // the button is disabled while the draft is empty.
  await window.waitForTimeout(120)
}

// What the composer currently holds, as plain text. Mention chips serialise to
// "@Title", matching what gets sent.
export async function composerText(window: Page): Promise<string> {
  return (await composer(window).innerText()).trim()
}

// ── Adding widgets (4.3.32) ─────────────────────────────────────────────────
// The header "Add widget" button and the hover palette were removed in 4.3.32.
// Widgets are added from the side menu's Widgets section: every kind there has
// a stable `sidemenu-widget-<kind>` tile — click for a standalone widget FILE,
// drag onto a desk, or right-click → "Add to this desk". Kinds an app already
// is (doc, sheet, slides, diagram, design, draw, inbox, calendar, drive,
// browser, chat…) live under Apps instead, and their tiles carry the same
// right-click "Add … to this desk". See docs/widget-files.md.

/** The Apps tile that stands for an app-represented widget kind. */
const APP_TILE_FOR_KIND: Record<string, string> = {
  doc: 'office-sideapp-docs',
  sheet: 'office-sideapp-sheets',
  slides: 'office-sideapp-slides',
  diagram: 'office-sideapp-diagrams',
  design: 'office-sideapp-design',
  draw: 'office-sideapp-draw',
  // 4.3.32: the Mail tile places the Inbox work widget (Plexii's own mail),
  // no longer the Gmail web view ('email'), which no tile places now.
  inbox: 'office-comms-app-inbox',
  'chat-thread': 'office-comms-app-chat',
  calendar: 'office-comms-app-calendar',
  drive: 'office-comms-app-files',
  webview: 'office-comms-app-browser'
}

/** Create a desk and open it; returns its id. */
export async function openNewDesk(window: Page, title = 'Widget Desk'): Promise<string> {
  const id = await window.evaluate(async (t) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: t })).id
  }, title)
  await window.evaluate(async () => {
    const w = window as unknown as { __fbNodes?: { getState: () => { refresh: () => Promise<void> } } }
    await w.__fbNodes?.getState().refresh()
  })
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, id)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  return id
}

/**
 * The side-menu tile for a widget kind, expanding "Other widgets" if the kind
 * lives there. Throws if the kind is not in the Widgets section at all.
 */
export async function sideMenuWidget(window: Page, kind: string): Promise<Locator> {
  const tile = window.locator(`[data-testid="sidemenu-widget-${kind}"]`).first()
  if (await tile.isVisible().catch(() => false)) return tile
  const toggle = window.locator('[data-testid="sidemenu-other-widgets-toggle"]').first()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(tile).toBeVisible({ timeout: 5_000 })
  return tile
}

/**
 * Add a widget of `kind` to the OPEN desk the way a user would without
 * dragging: right-click its side-menu tile (Widgets section, or its Apps tile
 * for an app kind) → "Add to this desk". Resolves once the desk holds one
 * more widget of that kind.
 */
export async function addWidgetToDesk(window: Page, kind: string): Promise<void> {
  const before = await window.evaluate(
    (k) =>
      (
        window as unknown as { __fbWidgets?: { getState: () => { widgets: Array<{ kind: string }> } } }
      ).__fbWidgets?.getState().widgets.filter((w) => w.kind === k).length ?? 0,
    kind
  )
  const appTile = APP_TILE_FOR_KIND[kind]
  const tile = appTile
    ? window.locator(`[data-testid="${appTile}"]`).first()
    : await sideMenuWidget(window, kind)
  await tile.scrollIntoViewIfNeeded()
  await tile.click({ button: 'right' })
  // One row on every tile since the §9 menu contract: "Add to this desk"
  // (lib/navRowMenu, WidgetsSection), found by its test id rather than text.
  const item = window.locator('[data-canvas-ctx-menu] [data-testid="ctx-add-to-this-desk"]').first()
  await expect(item).toBeVisible({ timeout: 5_000 })
  await item.click()
  await expect
    .poll(
      async () =>
        window.evaluate(
          (k) =>
      (
        window as unknown as { __fbWidgets?: { getState: () => { widgets: Array<{ kind: string }> } } }
      ).__fbWidgets?.getState().widgets.filter((w) => w.kind === k).length ?? 0,
          kind
        ),
      { timeout: 8_000 }
    )
    .toBeGreaterThan(before)
}

/**
 * Arm an office-shell rail tool and place an element with it (SPEC §3.2, the
 * shared helper for armed modes in Deck, Design, Diagrams and Draw). Arms
 * `${app}-tool-${tool}`, opening its flyout first when the tool is not the
 * group's visible member, then clicks the canvas (or drags, to size it). One
 * line per call site, instead of a bespoke gesture in every spec.
 */
export async function placeElement(
  window: Page,
  app: string,
  tool: string,
  opts: { canvas: string; railTestid?: string; flyout?: string; at?: { x: number; y: number }; drag?: { dx: number; dy: number } }
): Promise<{ x: number; y: number }> {
  const armId = `${app}-tool-${tool}`
  const arm = window.locator(`[data-testid="${armId}"]`)
  if (await arm.isVisible().catch(() => false)) {
    await arm.click()
  } else {
    if (!opts.flyout) throw new Error(`placeElement: ${armId} is not on the rail and no flyout was given`)
    await window.locator(`[data-testid="${opts.railTestid ?? `${app}-rail`}-flyout-${opts.flyout}"]`).click()
    await window.locator(`[data-testid="${armId}-flyout"]`).click()
  }
  const box = await window.locator(opts.canvas).boundingBox()
  if (!box) throw new Error(`placeElement: canvas ${opts.canvas} not found`)
  const x = box.x + (opts.at?.x ?? box.width * 0.7)
  const y = box.y + (opts.at?.y ?? box.height * 0.3)
  await window.mouse.move(x, y)
  await window.mouse.down()
  if (opts.drag) await window.mouse.move(x + opts.drag.dx, y + opts.drag.dy, { steps: 8 })
  await window.mouse.up()
  return { x, y }
}

/**
 * Mark every registered onboarding tour as skipped, so the feature-spotlight
 * card (bottom-right, z-[230]) is never offered on the next boot. Call it
 * before window.reload() in specs that check or drive the bottom-right corner:
 * the card mounts ~750ms after boot, so a reactive dismiss races the check.
 * The module ids are read from the registry source, so new tours are covered
 * without editing specs.
 */
export async function suppressFeatureSpotlights(window: Page): Promise<void> {
  const src = readFileSync(join(__dirname, '../../src/renderer/src/lib/onboarding/registry.ts'), 'utf8')
  const ids = [...src.matchAll(/^\s{4}id: '([\w-]+)'/gm)].map((m) => m[1]!)
  if (!ids.length) throw new Error('suppressFeatureSpotlights: no onboarding module ids found in registry.ts')
  await window.evaluate((list: string[]) => {
    let p: { completed?: Record<string, number>; skipped?: Record<string, number> } = {}
    try {
      p = JSON.parse(localStorage.getItem('fb.onboarding.v2') ?? '{}')
    } catch {
      /* fresh profile */
    }
    p.skipped = { ...(p.skipped ?? {}), ...Object.fromEntries(list.map((id) => [id, 999])) }
    localStorage.setItem('fb.onboarding.v2', JSON.stringify(p))
  }, ids)
}

/**
 * Show one of Write's right-hand content panes (outline / comments / ai).
 *
 * `doc-comments-toggle` and `doc-outline-toggle` are TOGGLES: pressing one while
 * that pane is already showing collapses the side pane. A spec that presses it
 * blind therefore depends on whatever the pane happened to be doing — which
 * differs between a fresh document and one reopened later in the same run. This
 * makes it deterministic: open the pane if it is collapsed, then select the tab
 * if it is not already the active one.
 */
export async function showDocPane(window: Page, pane: 'outline' | 'comments' | 'ai'): Promise<void> {
  const panel = window.locator('[data-testid="doc-side-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    const expand = window.locator('[data-testid="doc-side-panel-expand"]')
    if (await expand.isVisible().catch(() => false)) await expand.click()
    else await window.locator(`[data-testid="doc-${pane}-toggle"]`).click()
    await expect(panel).toBeVisible({ timeout: 8_000 })
  }
  const tab = window.locator(`[data-testid="doc-tab-${pane}"]`)
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

/**
 * Show Write's Styles panel, whatever state it is in.
 *
 * `doc-styles-btn` toggles the panel, so pressing it blind depends on whether
 * the panel was already open — and picking a style from it does not close it,
 * so a spec that opens it, picks a row, then presses the button again to "open"
 * it is actually closing it. This opens only when it is closed.
 */
export async function showDocStyles(window: Page): Promise<void> {
  const panel = window.locator('[data-testid="doc-styles-panel"]')
  if (await panel.isVisible().catch(() => false)) return
  await window.locator('[data-testid="doc-styles-btn"]').click()
  await expect(panel).toBeVisible({ timeout: 5_000 })
}

/**
 * PlexiiDeck's wrapper for placeElement (as placeDesign is Design's). Positions
 * are FRACTIONS of the slide: the canvas is a scaled page, and an absolute
 * pixel lands outside it and places nothing, which reads exactly like a broken
 * tool. Coordinates are taken from `slide-canvas` (the shared SlideCanvas's own
 * stage, where placement and the element boxes live), not `slides-canvas`, the
 * editor's scrolling wrapper around it.
 */
export async function placeSlide(
  window: Page,
  tool: string,
  at?: { fx: number; fy: number },
  drag?: { dx: number; dy: number }
): Promise<{ x: number; y: number }> {
  const canvas = '[data-testid="slide-canvas"]'
  const box = await window.locator(canvas).boundingBox()
  if (!box) throw new Error('placeSlide: the slide canvas was not laid out')
  return placeElement(window, 'slides', tool, {
    canvas,
    flyout: 'shapes',
    ...(at ? { at: { x: box.width * at.fx, y: box.height * at.fy } } : {}),
    ...(drag ? { drag } : {})
  })
}

/**
 * placeElement for PlexiiDesign, with this app's canvas and shape flyout
 * filled in — so a spec says `placeDesign(window, 'rect')` rather than
 * repeating the same three options 27 times.
 *
 * `at` is a FRACTION of the canvas box, not pixels: the canvas is a scaled
 * page, often about 400px wide in a test window, so absolute coordinates land
 * outside it and place nothing — which reads exactly like the tool being
 * broken.
 */
export async function placeDesign(
  window: Page,
  tool: string,
  at?: { fx: number; fy: number },
  drag?: { dx: number; dy: number }
): Promise<{ x: number; y: number }> {
  const canvas = '[data-testid="slide-canvas"]'
  const box = await window.locator(canvas).boundingBox()
  if (!box) throw new Error('placeDesign: the canvas was not laid out')
  return placeElement(window, 'design', tool, {
    canvas,
    flyout: 'shapes',
    ...(at ? { at: { x: box.width * at.fx, y: box.height * at.fy } } : {}),
    ...(drag ? { drag } : {})
  })
}

/**
 * Show a ContextBar tab (office shell SPEC §2.3).
 *
 * Never clicks a tab that is already active: a second click on the active tab
 * is a double-click, which collapses Row 2 (D5) and hides the very controls
 * the caller is reaching for.
 */
export async function selectBarTab(window: Page, bar: string, tab: string): Promise<void> {
  const el = window.locator(`[data-testid="${bar}-tab-${tab}"]`)
  // Narrow windows fold trailing tabs into "More ▾" (SPEC §2.6), and which
  // tabs fold changes as the active tab's controls change the row's width.
  // A spec that assumes every tab is always on the strip passes on a wide
  // window and fails on a narrow one, which is the worst kind of flake.
  if (!(await el.isVisible().catch(() => false))) {
    const more = window.locator(`[data-testid="${bar}-tab-more"]`)
    if (await more.isVisible().catch(() => false)) await more.click()
  }
  await expect(el).toBeVisible({ timeout: 5_000 })
  if ((await el.getAttribute('aria-selected')) === 'true') return
  await el.click()
  await expect(el).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
}

// Shift+click a work widget's HEADER (react-rnd's drag handle) to toggle it in
// the multi-selection — a real Shift+mousedown/mouseup, the gesture a user makes.
//
// Most of the header is the header action row (Rewrite with AI, Rename,
// Connect, Pin, Shrink, Grow, Expand, Remove: eight 24px buttons, revealed on
// hover, laid out from the left once the title truncates). A fixed offset into
// the header lands on one of them: specs that used `left + 26` hit "Rewrite
// with AI", whose click opened a full-window dialog (fixed inset-0 z-[300])
// that swallowed the next shift-click, so the selection stopped at
// "1 selected". This hit-tests instead: it walks the header's centre line and
// clicks the first point whose topmost element is the header's own grab
// surface (the handle, its title or kind chip), never a control. It throws
// when the header has no such point, so a layout that leaves nothing to grab
// fails loudly here rather than as a misleading count further down.
export async function shiftClickWidgetHeader(window: Page, widgetId: string): Promise<void> {
  const pt = await window.evaluate((wid: string) => {
    const h = document.querySelector(`[data-widget-id="${wid}"] .widget-handle`) as HTMLElement | null
    if (!h) return { error: `no .widget-handle in widget ${wid}` }
    const b = h.getBoundingClientRect()
    const y = b.top + b.height / 2
    for (let x = Math.ceil(b.left) + 1; x < b.right - 1; x++) {
      const hit = document.elementFromPoint(x, y)
      if (!hit || hit.closest('.widget-handle') !== h) continue
      if (hit.closest('button, input, textarea, select, a, [role="button"], [contenteditable="true"]')) continue
      return { x, y }
    }
    return { error: `header of ${wid} has no grab point that is not a control (width ${b.width})` }
  }, widgetId)
  if ('error' in pt) throw new Error(`shiftClickWidgetHeader: ${pt.error}`)
  await window.keyboard.down('Shift')
  await window.mouse.click(pt.x, pt.y)
  await window.keyboard.up('Shift')
  await window.waitForTimeout(150)
}

/**
 * Press one of a work widget's header tools by its accessible name, wherever it
 * is right now.
 *
 * The header folds its lower-priority tools into a "…" menu when the widget is
 * too narrow to show them all (lib/widgetHeaderActions — e.g. a 240px sticky
 * shows AI and Expand inline and folds Rename, Link, Pin, Shrink, Grow and
 * Remove). A tool is therefore either an inline button or a menu item with the
 * same name; this clicks whichever exists, so a spec does not depend on the
 * widget's width. The tool row is opacity-gated on hover, so hover first.
 */
export async function clickWidgetTool(window: Page, widgetId: string, name: string | RegExp): Promise<void> {
  const header = await hoverWidgetHeader(window, widgetId)
  const inline = header.locator('.fb-widget-actions').getByRole('button', { name, exact: typeof name === 'string' })
  if ((await inline.count()) > 0) {
    await inline.first().click()
    return
  }
  const more = header.locator(`[data-testid="widget-overflow-${widgetId}"]`)
  await expect(more, `"${String(name)}" is neither on the header nor behind "…"`).toBeVisible({ timeout: 5_000 })
  await more.click()
  await window
    .getByRole('menu', { name: 'More work widget actions' })
    .getByRole('menuitem', { name, exact: typeof name === 'string' })
    .click()
}

/**
 * Assert a work widget offers a header tool, inline or behind "…" (see
 * clickWidgetTool). Leaves the "…" menu closed again.
 */
export async function expectWidgetTool(window: Page, widgetId: string, name: string, message?: string): Promise<void> {
  const header = await hoverWidgetHeader(window, widgetId)
  const inline = header.locator('.fb-widget-actions').getByRole('button', { name, exact: true })
  if ((await inline.count()) > 0) {
    await expect(inline.first(), message).toBeVisible({ timeout: 4_000 })
    return
  }
  const more = header.locator(`[data-testid="widget-overflow-${widgetId}"]`)
  await expect(more, message ?? `"${name}" is neither on the header nor behind "…"`).toBeVisible({ timeout: 4_000 })
  await more.click()
  const menu = window.getByRole('menu', { name: 'More work widget actions' })
  await expect(menu.getByRole('menuitem', { name, exact: true }), message).toBeVisible({ timeout: 4_000 })
  await window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
}

/**
 * Hover a work widget's header so its tool row shows, over the grab strip
 * between the title and the tools — the part of the header least likely to sit
 * under a title-bar dropdown. Dismisses the bottom-right feature spotlight
 * first: it floats at z-230 over that corner and swallows clicks on a menu
 * opened from a widget pinned there.
 */
async function hoverWidgetHeader(window: Page, widgetId: string): Promise<Locator> {
  const spotlight = window.locator('[data-testid="feature-spotlight-dismiss"]')
  if (await spotlight.isVisible().catch(() => false)) {
    await spotlight.click({ timeout: 2_000 }).catch(() => undefined)
  }
  const header = window.locator(`[data-widget-id="${widgetId}"]`).first().locator('[data-widget-header]').first()
  await expect(header).toBeVisible({ timeout: 8_000 })
  const grab = header.locator('[data-testid="widget-grab"]')
  if ((await grab.count()) > 0) await grab.first().hover()
  else await header.hover({ position: { x: 12, y: 12 } })
  return header
}

// ── Work widget menus on the §9.3 contract (WP1a, appended) ────────────────

/**
 * Click a row of the OPEN work widget menu by its exact label. The resolver
 * keeps eight rows at the top and folds the rest into "More actions"
 * (lib/contextMenu/resolve.ts), and which rows fold depends on the widget, so
 * a spec names the row and this finds it: at the top level first, otherwise
 * under More actions. `path` opens submenus on the way ("Create & link").
 */
export async function clickWidgetMenuRow(window: Page, label: string, path: string[] = []): Promise<void> {
  const root = window.locator('[data-canvas-ctx-menu]').first()
  await expect(root).toBeVisible({ timeout: 4_000 })
  const rowIn = (menu: Locator, l: string): Locator =>
    menu.locator(':scope > div > button[role^="menuitem"]').filter({ has: window.locator(`span.flex-1:text-is("${l}")`) })
  const first = path[0] ?? label
  let level = 0
  if ((await rowIn(root, first).count()) === 0) {
    await rowIn(root, 'More actions').hover()
    level = 1
    await expect(window.locator('[data-canvas-ctx-menu]').nth(level)).toBeVisible({ timeout: 3_000 })
  }
  for (const step of path) {
    await rowIn(window.locator('[data-canvas-ctx-menu]').nth(level), step).hover()
    level += 1
    await expect(window.locator('[data-canvas-ctx-menu]').nth(level)).toBeVisible({ timeout: 3_000 })
  }
  await rowIn(window.locator('[data-canvas-ctx-menu]').nth(level), label).click()
}

/** The open menu as rendered: groups of row labels split at separators, plus which rows are danger. */
export async function renderedMenuGroups(window: Page, nth = 0): Promise<{ groups: string[][]; danger: string[] }> {
  return window.locator('[data-canvas-ctx-menu]').nth(nth).evaluate((menu) => {
    const groups: string[][] = [[]]
    const danger: string[] = []
    for (const el of Array.from(menu.children)) {
      if (el.getAttribute('role') === 'separator') {
        groups.push([])
        continue
      }
      const b = el.querySelector('button')
      if (!b) continue
      const label = (b.querySelector('span.flex-1')?.firstChild?.textContent ?? '').trim()
      groups[groups.length - 1]!.push(label)
      if (b.className.includes('text-red-600')) danger.push(label)
    }
    return { groups: groups.filter((g) => g.length), danger }
  })
}
