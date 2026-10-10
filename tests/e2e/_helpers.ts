import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

  const app = await electron.launch({
    args: ['.', ...(opts?.extraArgs ?? [])],
    cwd: process.cwd(),
    env: {
      ...cleanEnv,
      FB_TEST_USER_DATA: userDataDir,
      NODE_ENV: 'test',
      // Per-test overrides (e.g. PLEXI_APP=office to boot the PlexiOffice shell).
      ...(opts?.env ?? {})
    },
    timeout: 20_000
  })
  // Forward main-process stdout/stderr to test stdout so debugging "page
  // closed" failures actually shows the real Electron error.
  app.process().stdout?.on('data', (b) => process.stdout.write(`[main] ${b}`))
  app.process().stderr?.on('data', (b) => process.stderr.write(`[main] ${b}`))
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

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
  }
  return { app, window, userDataDir, dispose }
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
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiDesk"]')
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
  // the bottom-right corner should additionally seed fb.onboarding.v2 with the
  // tours skipped before reloading (see assistantPin.spec.ts).
  const spotlight = window.locator('[data-testid="feature-spotlight-dismiss"]')
  if (await spotlight.isVisible().catch(() => false)) {
    await spotlight.click(BEST_EFFORT).catch(() => {})
  }
}

// Where each former top-level product now lives under the three-segment IA.
//   - `seg` products live inside a SegmentShell (PlexiDesk / PlexiBrain): open
//     the segment via its nav testid, then click `segment-app-<app>`.
//   - `comms` products live inside the PlexiOffice shell's Communicate menu:
//     open PlexiOffice, then click `office-comms-app-<app>`.
//   - `direct` products no longer have a segment home (Build / Form); navigate
//     straight to their view through the view store so their spec coverage
//     survives. The view renders in the global MainPane, testids unchanged.
// ── The area switcher ────────────────────────────────────────────────────────
// Desk / Office / People / Brain used to be a standing four-tile row in every
// menu. Commit c581655d folded it into the WorkspaceSwitcher dropdown, because
// an area lives inside an organisation and the two controls were answering one
// question. The `switch-<kind>` testids survived the move, but they now live
// behind a trigger, so clicking one cold waits forever on a closed menu.
//
// Use these two helpers rather than reaching for `switch-<kind>` directly:
// openAreaSwitcher is idempotent (it leaves an already-open menu alone), and
// switchArea opens the menu only when it has to.
export async function openAreaSwitcher(window: Page): Promise<void> {
  const menu = window.locator('[data-testid="workspace-switcher-menu"]')
  if (await menu.isVisible()) return
  await window.locator('[data-testid="workspace-switcher-trigger"]').first().click()
  await expect(menu).toBeVisible({ timeout: 8_000 })
}

export type AreaKind = 'plexidesk' | 'office' | 'plexipeople' | 'plexibrain'

// Switch to an area. Returns once the menu has closed behind the click, so the
// caller never races the dropdown's own teardown while hunting for the new
// surface underneath it.
export async function switchArea(window: Page, kind: AreaKind): Promise<void> {
  await openAreaSwitcher(window)
  const item = window.locator(`[data-testid="switch-${kind}"]`).first()
  // A locked area answers the click with its upgrade reason and deliberately
  // keeps the menu open, so only an entitled switch is expected to close it.
  const locked = (await item.getAttribute('data-locked')) === 'true'
  await item.click()
  if (locked) return
  await expect(window.locator('[data-testid="workspace-switcher-menu"]')).toBeHidden({
    timeout: 8_000
  })
}

// Is an area entitlement-locked? The lock lives on a menu item, so reading it
// means opening the menu; this leaves it closed again so the caller gets the
// page back the way it found it.
export async function isAreaLocked(window: Page, kind: AreaKind): Promise<boolean> {
  await openAreaSwitcher(window)
  const locked =
    (await window.locator(`[data-testid="switch-${kind}"][data-locked="true"]`).count()) > 0
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-testid="workspace-switcher-menu"]')).toBeHidden({
    timeout: 8_000
  })
  return locked
}

type ProductRoute =
  | { mode: 'seg'; switch: AreaKind; app: string }
  | { mode: 'comms'; app: string }
  | { mode: 'direct'; go: string }

const SEGMENT_OF: Record<string, ProductRoute> = {
  // Plans and Tasks are Desk-area views reachable straight from the view store.
  projects: { mode: 'direct', go: 'goProjects' },
  tasks: { mode: 'direct', go: 'goAllTasks' },
  reports: { mode: 'direct', go: 'goReports' },
  // Flow / API live in the PlexiBrain area; jump there via the always-visible
  // area switcher, then click the app tile.
  flow: { mode: 'seg', switch: 'plexibrain', app: 'flows' },
  api: { mode: 'seg', switch: 'plexibrain', app: 'api' },
  chat: { mode: 'comms', app: 'chat' },
  meet: { mode: 'comms', app: 'meet' },
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

  await switchArea(window, route.switch)
  await window.locator(`[data-testid="segment-app-${route.app}"]`).click()
}

// Navigate through the exposed view store. The object-based IA no longer has
// literal sidebar buttons for these destinations, so specs drive navigation via
// __fbView (the same approach documents.spec.ts / documentTrash.spec.ts use).
// Use this instead of getByRole('button', { name: /^Documents$/ }) and friends.
export async function gotoView(
  window: Page,
  fn:
    | 'goHome'
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
