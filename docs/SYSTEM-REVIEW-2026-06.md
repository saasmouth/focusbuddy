# Plexii — Complete System Review

**Date:** 2026-06-05  ·  **Version reviewed:** plexii `2.4.3`  ·  **Reviewer:** Operator (Claude) + 28 specialist sub-agents

> Commissioned brief (verbatim): *"a complete system review. Functionality, widgets, browsers … navigation, toolbars, click-and-drag canvas navigation, and anything else that will make Plexii more elite and ready for market. I need epic, perfect, industry-leading work. No second chances."*

This document is the honest answer. It is paired with two companions:
- **[BROWSER-ADR-001](./BROWSER-ADR-001-in-canvas-browser.md)** — the in-canvas browser engine decision (the headline ask).
- **[MARKET-READINESS-ROADMAP](./MARKET-READINESS-ROADMAP.md)** — the sequenced path from here to a paid public launch.

---

## How this review was produced (so you can trust it)

| Phase | What ran | Output |
|---|---|---|
| **Survey** | 11 specialist agents, one per subsystem, each reading the real code and citing `file:line` | 110 issues (12 critical / 38 high / 42 medium / 18 low), strengths, market gaps |
| **Browser deep-dive** | 3 independent Electron-architect agents (auth / native-compositing / extensions lenses) → 1 synthesis | [BROWSER-ADR-001](./BROWSER-ADR-001-in-canvas-browser.md) |
| **Adversarial verification** | 8 hostile skeptics, each told to *refute* a load-bearing "critical" claim, default-to-REFUTED unless code-proven | Every claim below is marked CONFIRMED / PARTIAL with proof |
| **Market-readiness critic** | 1 strategist over all findings | Score **38/100**, 13 sequenced priorities |
| **Fix & prove** | 6 quick-wins implemented, then `plexidesk-tester` ran 66 unit + 18 e2e | **GREEN** — see §0 |

**Discipline:** no claim of "broken" appears here without a code citation. Where verification downgraded or corrected the survey, the correction is shown — flattery and alarmism are both failures of a "no second chances" review.

A note surfaced during verification, not in the original brief: **the working tree did not pass `npm run typecheck`** — 18 pre-existing errors across 8 files (`voiceNote.ts`, `ipc/index.ts`, `workspaceResolver.ts`, `preload/index.ts`, `VoiceCommandFAB.tsx`, `MindMapWidget.tsx`, `Canvas.tsx`, `CanvasAIAssistantRail.tsx`) — unrelated WIP. `electron-vite build` transpiles without typechecking, so the app still built and booted, but "it typechecks" was not true on `main`. **Resolved 2026-06-05:** all 18 fixed (unused imports, a too-narrow error-reason union, a `Uint8Array`/`BlobPart` strictness issue, an `interface extends` over a discriminated union, a missing `'diarised'` IPC mode, and an un-narrowed file-import union). `npm run typecheck` is now green (node + web), verified by 66 unit + 32 targeted e2e.

---

## §0 — What was fixed and proven in this session

Six high-leverage, low-risk fixes were implemented and **proven** (`plexidesk-tester` → GREEN, 66/66 unit + 18/18 e2e, new permanent guard `tests/e2e/securityQuickWins.spec.ts`). These are shipped in the working tree now:

| # | Fix | Files | Closes |
|---|---|---|---|
| 1 | **Clean desktop-Chrome User-Agent** on every webview session (strips `Electron/`, `plexii/`, `Haptyx/` tokens) | `src/main/userAgent.ts` (new, unit-tested), `src/main/index.ts` | The #1 root cause of "logins don't work" — `disallowed_useragent` blocks |
| 2 | **Origin-gated vault autofill** — credentials only inject on the bound host (or a subdomain), with an in-page `location.hostname` guard as defence-in-depth, failing closed | `vaultAutofill.ts`, `WebViewWidget.tsx`, `views/ConnectedAppView.tsx` | **CONFIRMED credential-exfiltration vulnerability** (CVE-class) |
| 3 | **Overlay first-click no longer yanks the camera** — `setActive` instead of `focusOn` | `WebViewWidget.tsx` | "clicking the login button does nothing / the canvas jumps" |
| 4 | **Permission denylist** on default + webview sessions — denies geolocation/HID/serial/USB/MIDI-sysex/idle-detection; media (voice) stays granted | `src/main/index.ts` | Embedded sites silently auto-granted device/location access |
| 5 | **Command-injection fix** — `defaults`/`sips`/`rm` converted from interpolated `exec` to `execFile`(arg-array)/`fs.rmSync` | `src/main/localApps.ts` | **CONFIRMED command injection** via maliciously-named `.app` paths |
| 6 | **Sticky/Note unmount-flush** — pending debounced text is flushed when the canvas remounts widgets | `StickyWidget.tsx`, `NoteWidget.tsx` | **CONFIRMED deterministic data loss** on pin/group/auto-arrange |

New tests added: `tests/unit/userAgent.test.ts` (6), origin-gate cases in `tests/unit/vaultAutofill.test.ts` (+8), `tests/e2e/securityQuickWins.spec.ts` (7).

> One honest caveat: the *live* webview UA round-trip (proving "Google sign-in literally succeeds") needs a fixture HTTP server to fully automate. The pure UA function and its wiring are proven; a 60-second manual spot-check (open a browser widget → a Google login page → confirm it is no longer blocked) closes the loop.

Everything below §0 is the diagnosis. Most of it is **not yet fixed** — it is the map for the roadmap.

---

## §1 — Executive verdict

**Market-readiness: 38/100. Not shippable as a paid product today — but a high-ceiling product on an unsound base.**

Plexii is genuinely differentiated and shows real craft per-surface: a mathematically-correct zoom-to-cursor canvas, a well-engineered edge-pan system, engagement-gated focus timers, a clean capability matrix, a production-grade Stripe scaffold on the server. The ideas are good and, in places, unique.

But three independent classes of problem each *alone* block a paid public launch:

1. **Security** — two arbitrary-code/command paths reachable from the renderer, credential autofill with no origin check (now fixed, §0/#2), and an unsigned auto-update channel that auto-installs.
2. **Data trust** — the user's entire workspace is one un-versioned SQLite file with no backup, export, sync, or schema versioning, and a vault that cannot be re-keyed.
3. **Monetization** — every paid feature is enforced only in renderer JS, the trial is infinitely farmable, and the desktop has no in-app way to pay.

On top of those, the two **headline** features are broken: the in-canvas browser (root-caused and partially fixed in §0) and the flagship "AI as the OS" command bar (its routing prompt is silently discarded). None of this is fatal — the differentiation is real and the browser headline is mostly a one-week fix — but the foundation must be made sound before the ceiling matters.

---

## §2 — Critical issues (the 12), with verification verdicts

> "Critical" = data loss, security hole, revenue model failure, or a core advertised flow that does not work.

### Security

**C-SEC-1 · Renderer-reachable arbitrary shell execution** — `streamdeckActions.ts:366` `runShell()` runs `execAsync(action.command)` with **no main-process gate**. Verdict: **PARTIAL** — the *code path* is real (verified), but the original "only a renderer confirm guards it" was wrong: *there is no confirm in the code at all*. Realistic exploit needs renderer script-execution (XSS in embedded content) or any feature that can persist a `run-shell` action (templates / shared decks / AI) — so the gate belongs in **main**, not the renderer. → Roadmap #1.

**C-SEC-2 · Command injection in `localApps.ts`** — `defaults read "${plist}"`, `sips … "${candidate}"`, `rm "${tmp}"` interpolate renderer-supplied paths into shell strings; `$()`/backticks execute inside the double quotes. Verdict: **CONFIRMED**. → **Fixed this session (§0/#5).**

**C-SEC-3 · Unsigned, auto-installing auto-update** — `electron-builder.yml` ad-hoc signs only (`identity: null`, `hardenedRuntime: false`); `autoUpdate.ts:72-73` sets `autoDownload = true` + `autoInstallOnAppQuit = true`, polling GitHub every 4h. Verdict: **CONFIRMED (critical)**. electron-updater on macOS performs **zero** code-signature checks (only a SHA-512 read from the same `latest-mac.yml` an attacker who controls the release also rewrites). Anyone who can push to `saasmouth/focusbuddy` releases gets code-execution on every install within ~4h. *Correction to the raw survey:* the build is not "totally unsigned" — it ad-hoc signs via `build/adhoc-sign.cjs`, so the real gaps are **no Developer ID / notarization** (Gatekeeper "unidentified developer") and **no publisher-identity pinning on updates**. → Roadmap #2.

**C-SEC-4 · Vault autofill, no origin check** — Verdict: **CONFIRMED (0.93)**. → **Fixed this session (§0/#2).**

### Data

**C-DATA-1 · No backup / export / snapshot** — `database.ts:243` opens one `userData/focusbuddy.db`; grep for `backup|VACUUM|export|user_version` across `src` is empty. A single corrupt write or disk failure is total, unrecoverable loss. Verdict: **CONFIRMED**. → Roadmap #4.

**C-DATA-2 · Vault cannot be re-keyed** — Verdict: **PARTIAL → severity medium** *(corrected down from critical)*. The catastrophic "forgotten password = unrecoverable" part is **intentional and disclosed** (`VaultView.tsx:109/156`, `changelog.ts:122` — the price of zero-knowledge local-first). The genuine defects are narrower: a **dead JSDoc reference** to a `changeMasterPassword` that was never implemented (`vault.ts:107`), and **no password-rotation path even for a user who knows their current password** — table stakes for a credential vault. → Roadmap #5.

### Monetization

**C-MON-1 · All gating is client-side advisory** — `src/main` has zero capability imports; the right-click "Add object" menu (`Canvas.tsx:872-884`) creates gated widgets with no check (while `WidgetPalette.tsx:121` gates the same kinds); the server computes capabilities but never *enforces* them (`/share` and `/inbox/add` take paid actions with no capability check; `/share` needs no session at all). Verdict: **CONFIRMED**. *Architectural truth:* widgets persist to **local** SQLite and never round-trip the server, so widget-kind gating is unenforceable server-side without a new surface — the monetizable wedge must be a **server-mediated feature** (hosted AI, cloud sync), not local widgets. → Roadmap #6, #7.

**C-MON-2 · Trial infinitely farmable** — `accounts.ts:171` grants every signup a 14-day full-`team` trial; `accounts.ts:13-20` documents no email verification and no rate-limit; signup validates only `@` + length≥8. Verdict: **CONFIRMED**. → Roadmap #6.

### Headline features

**C-AI-1 · The AI command bar is silently broken** — `AICommandBar.tsx:115` sends the `ROUTER_SYSTEM` routing contract as a `system`-role message, but `anthropic.ts:502-503` filters messages to `user|assistant` only and prepends its own generic chat system prompt — so `ROUTER_SYSTEM` never reaches the model. The `add-objects` path then builds suggestions and discards them with a `window.alert` (`AICommandBar.tsx:211`). Verdict: **CONFIRMED**. → Roadmap #8.

**C-AI-2 · One-click irreversible AI delete** — `actionExecutor.ts:218-223` `applyDeleteWidget` calls `remove()` (DB cascade dropping `widget_links`) with no confirm and no undo; proposal-Apply and voice "delete" are single-tap, and there is no command history anywhere. Verdict: **CONFIRMED** (by direct read; the skeptic agent failed to emit structured output, so this was operator-verified). → Roadmap #8, #9.

**C-BROWSER-1 · No User-Agent set** — Verdict: **CONFIRMED** (the no-UA fact; the "providers block it" consequence is well-established industry behaviour, worth the live spot-check). → **Fixed this session (§0/#1).**

**C-BRAND-1 · Split brand identity** — the app is "Plexii" (package.json, window title, sidebar) but ~20 user-facing strings say "Haptyx" (`Footer.tsx:32/38`, `ApiKeysSection`, `MindMapWidget`, `VoiceRecorderWidget`, `UpdaterBanner`), the version badge is hardcoded `2.0` (`App.tsx:250`) against a real `2.4.3`, and two trust surfaces make **contradictory privacy claims** (`LaunchSignInModal` "only shared items touch our server" vs `TermsModal` "there are no Plexii servers"). Verdict: **CONFIRMED**. Trust is undermined in the first 60 seconds. → Roadmap #11.

---

## §3 — Per-subsystem audit

Each subsystem: how it works · what's genuinely good · the issues that matter · what an elite version would have.

### 3.1 Canvas, camera & click-drag navigation  *(confidence 0.87)*

**How it works.** One CSS-transformed container (`translate(panX,panY) scale(zoom)`, `Canvas.tsx:1604`) with camera state in the Zustand store. Wheel/trackpad pans; ⌘-wheel zooms-to-cursor (`zoomTowardPoint`, `widgets.ts:114-125`); an rAF edge-pan loop scrolls when the cursor nears an edge. A real interactive minimap auto-mounts per task.

**Strengths.** Zoom-to-cursor is mathematically correct (same approach as Figma/tldraw). Single GPU-composited transform with `will-change:transform` — panning is cheap. Edge-pan is genuinely well-engineered (dt-clamped rAF, quadratic ramp, ResizeObserver-cached bounds, drag-mode detection). The minimap inflates the bbox by the viewport so off-cluster panning still maps.

**Issues that matter.**
- 🔴 **No click-drag-to-pan and no space-drag** — *the operator's explicit ask*. The canvas surface (`Canvas.tsx:1579-1590`) has no `onMouseDown`/`onPointerDown`; the ZoomControls "pan tool" button is an admitted placebo (`ZoomControls.tsx:49-56`). Mouse-only users (most of Windows) cannot pan except via the slow edge-hover. The UI even ships a hand button that does nothing — reads as broken.
- 🔴 **No marquee / multi-select** — the store tracks one `activeWidgetId` (`widgets.ts:11`); no `selectedIds`/marquee anywhere. Cannot rubber-band, group-move, align, or distribute. The single biggest functional gap vs any spatial competitor; blocks boards of 20-50+ objects.
- 🟠 **No viewport culling / per-zoom re-render** — every `WidgetFrame` subscribes to `zoom` and passes it to react-rnd; no memo, no culling, off-screen webviews stay mounted. Fine at 5 widgets, janky at 50.
- 🟡 No momentum/inertia on pan; the dot-grid lives on the static viewport so it does **not** pan/zoom with content (`globals.css` `.desk-paper`).

**Elite version:** drag/space/middle-mouse pan + momentum, marquee multi-select with group move/align/distribute, snap-to-grid + alignment guides, viewport culling, zoom-to-selection, and a camera-synced grid. *The hard math is already done — closing the navigation/selection gap is what flips "capable" to "Figma-class."*

### 3.2 Widget system, frame, drag/resize, lifecycle  *(confidence ~0.85)*

**How it works.** `WidgetFrame` wraps each of 21 widget kinds in react-rnd (drag/resize, zoom-as-scale), with a generic header context menu. Focus Mode mounts a fresh sibling instance for one widget.

**Strengths.** Clean frame abstraction; symmetric +/− resize with min/max clamps (e2e-tested); webview-safe interaction overlay; a broad, genuinely useful widget catalogue (sticky, note, markdown/tiptap, table, mindmap, timer, calculator, image, file, video, voice, stream-deck, …).

**Issues that matter.**
- 🔴 **No multi-select** (shared with canvas) — every op is single-widget.
- 🔴 **`layoutVersion` remounts *every* widget** on any section drop/eject/group/auto-arrange (`Canvas.tsx:1614/1625` key on `${w.id}-${layoutVersion}`) — expensive and the cause of the next item.
- 🔴 **Debounced Sticky/Note text lost on that remount** — **fixed this session (§0/#6).**
- 🟠 **Focus Mode renders nothing for StreamDeck / Section / Task-link** (`WidgetFocusMode.tsx:25-72` has no case) — expanding those is a dead click.

**Elite version:** stable widget identity across layout changes (don't remount the world), multi-select group ops, copy/paste/duplicate parity across kinds, and a maturity pass on the half-built kinds.

### 3.3 In-canvas browser / webview  *(the headline — see [BROWSER-ADR-001](./BROWSER-ADR-001-in-canvas-browser.md))*

**How it works.** Electron `<webview>` per widget, with per-app session partitions, popup/OAuth routing via `setWindowOpenHandler` (`popupRouter.ts`), `target=_blank` → spawn-a-canvas-widget, vault autofill, and a back/forward/reload/URL toolbar. It is **real Chromium**, not "bespoke."

**Issues that matter.** No User-Agent (🔴 — **fixed §0/#1**); click-overlay eats the first click + yanks the camera (🟠 — **fixed §0/#3**); autofill no origin check (🔴 — **fixed §0/#2**); built on the deprecated `<webview>` tag rather than `WebContentsView` (🟠 — strategic, see ADR); popups inherit the same UA (now fixed, since the clean UA is set on the shared session).

**Elite version:** see the ADR. In short: keep DOM-composited webview for canvas fluidity, add per-host UA presets + find-in-page + zoom + download capture + crash/recovery UI, an OAuth external-handoff for policy-blocked providers, and a native `WebContentsView` "expand" surface with `session.loadExtension` for a *vetted* Chrome-extension subset (ad-block, Dark Reader) — never Web-Store parity.

### 3.4 Toolbars, docks, palettes, discoverability  *(confidence ~0.8)*

**How it works.** Widgets are created via a palette, a right-click "Add object" menu, AI, and drag-drop; a `CommandCenter` (⌘K) offers ~6 static actions; shortcuts live in 4+ disconnected handlers.

**Issues that matter.**
- 🔴 **Right-click "Add object" bypasses gating** (`Canvas.tsx:872-884`) — a paid-feature bypass and a coherence bug vs `WidgetPalette`. → Roadmap #6.
- 🟠 **No keyboard-shortcut discoverability** — shortcuts are scattered (`Canvas.tsx:682-707`, etc.) with no cheatsheet.
- 🟠 **Command palette omits almost everything** — `CommandCenter.tsx:189-320` registers ~6 actions, not widget creation / settings / theme / arrange / AI.

**Elite version:** one Raycast/Linear-class ⌘K registering *every* action, a `?` shortcut cheatsheet, and a single coherent creation surface. The product already has the surfaces — consolidation is pure leverage.

### 3.5 Sections & widget links  *(confidence ~0.82)*

**How it works.** Sections are container widgets with free/grid/stack/list/icons layouts; widget links are ghost-line connections with click-to-arm.

**Issues that matter.**
- 🟠 **Eject from a computed layout drops the child at the section's top-left** (`SectionWidget.tsx:396-397`, `WidgetFrame.tsx:595-596`) — uses stale `c.x/c.y`.
- 🟠 **Section nesting is impossible** (`findHoveredSection` returns null for a dragged section) — contradicts the mental model of containers.
- 🟠 **Click-to-arm linking silently cancels** on the most common mis-clicks (`Canvas.tsx:396-430`) with no discoverability.

**Elite version:** eject-to-cursor, true nesting, and a link affordance that is visible and forgiving.

### 3.6 AI subsystem  *(confidence ~0.83)*

**How it works.** A chat path + ActionProposal apply chain + AI Builder + voice commands + model routing, all BYO-Anthropic-key, using "return ONLY JSON" prompts with hand-rolled regex parsers.

**Issues that matter.**
- 🔴 **Command-bar router prompt silently dropped** (C-AI-1) — flagship surface dead.
- 🔴 **One-click irreversible AI delete** (C-AI-2).
- 🟠 **Raw `{reply,actions}` JSON shown to the user** in the assistant rail (`CanvasAIAssistantRail.tsx:172`).
- 🟠 **`add-objects` builds then discards suggestions with an alert** (`AICommandBar.tsx:182-211`).
- 🟠 **No cost controls** on the BYO key (zero `usage`/token reads); Body Double loops ~10 min, living pages regenerate on every meaningful canvas change.
- 🟠 **`stop_reason:'max_tokens'` never handled** — silent proposal corruption.
- 🟠 **Zero tests** on the entire AI subsystem (every hand-rolled parser).

**Elite version:** native Anthropic **tool-use** (strict `input_schema` + `tool_choice`) replacing the regex parsers, **prompt caching** on the big static system prompts (~80-90% cost cut on hot paths), streaming, `max_tokens` handling, a usage/budget meter, and an apply-history/undo ledger with risk badges on destructive proposals.

### 3.7 Electron main process & security posture  *(confidence ~0.88)*

**How it works.** A privileged renderer (`sandbox:false`, `index.ts:90`) over a ~130-handler IPC surface, three custom protocols (`fb-file`/`fb-dev`/`haptyx`), and an auto-updater.

**Issues that matter.** C-SEC-1/2/3 above, plus: 🟠 **no runtime IPC input validation** (TypeScript types are erased — handlers forward renderer args straight into db/ai); 🟠 **`haptyx://` auth token accepted with no origin/signature validation** (`authProtocol.ts:39-55`); 🟠 **no `will-navigate` guard**; 🟠 **`sandbox:false`** on the main window; **no `@electron/fuses`**.

**Elite version:** a central hardening module — zod IPC validation, `setPermissionRequestHandler` allowlist (a denylist shipped this session, §0/#4), `will-navigate` pinning, `@electron/fuses` (disable `RUN_AS_NODE`, ASAR integrity), signed+notarized distribution, and a justified removal of `sandbox:false`.

### 3.8 Data layer  *(confidence 0.9)*

**How it works.** One local `better-sqlite3` DB (WAL, FKs on), ad-hoc `ensureColumn` migrations, with a separate signal server holding only share/inbox/account tables.

**Issues that matter.** C-DATA-1/2 above, plus: 🟠 **`acceptShare` INSERTs into `UNIQUE(token)` with no `ON CONFLICT`** while the inbox poller re-delivers (`shares.ts:146`) — will throw; 🟠 **no `PRAGMA user_version`** migration framework; 🟠 **file blobs/rows can orphan** both directions with no GC; 🟠 **zero cloud sync** of the actual workspace (multi-device impossible).

**Elite version:** automatic versioned local backups (`db.backup()` on launch, rolling retention) + one-click restore + full JSON export/import + a `user_version` migration framework with a downgrade guard + end-to-end-encrypted cloud sync (also the second monetizable server gate).

### 3.9 Capability gating & billing  *(confidence ~0.85)*

**How it works.** A clean capability matrix (3 synced snapshots) resolved server-side into a map the renderer fetches and enforces.

**Issues that matter.** C-MON-1/2 above, plus 🟠 **no in-app purchase path** (`accountClient.ts:88-92` signup omits `plan`; "upgrade" just `window.open`s the website). The matrix design is genuinely good; the enforcement and the pay-path are missing.

**Elite version:** server-enforced gates on everything that touches infra, a metered hosted-AI proxy as the Pro/Team wedge, in-app billing self-service (checkout/portal/invoices/seats/annual), and trial-abuse resistance.

### 3.10 ADHD / focus differentiation — the moat  *(confidence ~0.8)*

**How it works.** Engagement-gated focus timers, Hyperfocus Guardian, Bring-Me-Back, Pre-Task Bridge, energy/affinity math, Habit Garden, peer body-doubling.

**Issues that matter.** 🟠 **Pre-Task Bridge's "low interest" path can never fire** (`PreTaskBridge.tsx:17` logic bug). 🟠 **The in-app changelog advertises removed features** (Energy chip, Habit Garden) that a recent "two-axis" simplification orphaned (`changelog.ts:104-106`) — dead code *and* false promises. The captured engagement/energy data is real and unique but is **never reflected back to the user**.

**Elite version:** resurrect the captured data into a post-session insight loop ("here's when your brain actually showed up") and a "what should I do right now given my state" suggestion; adaptive personalization (learn each user's focus-run/drift cadence vs hard-coded 90/5/3-min constants); reliability primitives for peer body-double (scheduled slots, no-show handling). *This is the durable differentiation — the infrastructure exists; the loop is just never closed.*

### 3.11 Onboarding, first-run & polish  *(confidence ~0.82)*

**Issues that matter.** C-BRAND-1 above, plus: 🟠 **no first-run onboarding at all** (`App.tsx` renders the same shell unconditionally — a new user lands on empty cards with no guided first action, and the marketed AI "wow" is dead without a pasted key); 🟠 **Terms never presented/accepted** (footer link only); 🟠 **AI resume content near-invisible in dark mode** (hardcoded light colors, `ResumeModal.tsx:24`).

**Elite version:** a first-run spine (welcome → interactive tour/coachmarks → pre-populated sample workspace → API-key step → bespoke empty states), a single brand source-of-truth with a CI guard against "Haptyx" leaks, a real version badge, consistent privacy copy, and a Terms acceptance gate.

---

## §4 — Cross-cutting themes

1. **Security posture is the deepest debt.** A product that embeds arbitrary websites *and* stores credentials is one giant trust boundary, currently with `sandbox:false`, no IPC validation, no permission allowlist (denylist now shipped), no `will-navigate` guard, no fuses, ad-hoc-only signing, and two code/command paths. Nothing else matters until this is closed.
2. **Data is not safe.** No backup, export, schema versioning, vault re-key, or sync; hard deletes with no tombstones; debounced text was lost on remount (now fixed). The product holds months of irreplaceable work with none of the durability primitives a paid tool requires.
3. **The business model doesn't close.** Gating is client-side and bypassable; the trial is farmable; the costliest feature (AI) is free to all tiers and can't be server-enforced as built; there is no in-app pay path.
4. **Polish/coherence debt from rapid iteration.** Orphaned dead code, a changelog advertising removed features, a split Plexii/Haptyx brand, a hardcoded version badge, contradictory privacy copy. Real craft per-surface; the surfaces don't agree with each other.
5. **Performance won't scale.** Remount-everything-on-layout-bump, every widget subscribing to zoom, no culling, off-screen webviews mounted, `backgroundThrottling` left on (degrading the very focus timers that are the point).
6. **Zero tests on the differentiators and the risky paths.** The AI subsystem, every signature focus feature, and the security-sensitive IPC have no automated coverage — exactly where a "no second chances" launch will regress.

---

## §5 — Bottom line

The ceiling is high and the differentiation is real. The base is not sound. **The sequence matters more than any single fix** — close the security and data holes first (so the product is safe to trust), then the monetization spine (so it's a business), then the headline browser + canvas + AI experience (so it's elite), then deepen the moat (so it's the next big thing). That sequence is **[MARKET-READINESS-ROADMAP.md](./MARKET-READINESS-ROADMAP.md)**.

Six of those fixes are already done and proven (§0). The path from 38 to market-ready is mapped, evidence-backed, and ordered by leverage.
