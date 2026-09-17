# ADR-001 — The In-Canvas Browser: engine, OAuth, and Chrome extensions

**Status:** Phase 1 shipped (2026-06-05) · Phases 2-4 proposed
**Decision owners:** `widget-link-owner`-adjacent (browser widget), main-process
**Supersedes:** the implicit "`<webview>` forever" assumption

---

## The question (verbatim)

> *"browsers … are all not working because most apps don't support it … logging in, clicking logins, redirects and pop ups don't fire, it's terrible. Can we embed a chromium browser instead of this bespoke crap, so we can also allow use of chrome plugins?"*

## The short answer

**Yes — partly, in sequence:**

1. **The browser is already real Chromium**, not "bespoke." It's Electron's `<webview>`. The login failures are **not** because it's fake — they're a handful of fixable defects, the biggest of which is a **missing User-Agent**.
2. **Most logins are fixed this week** by the four Phase-1 changes already shipped (UA, click-overlay, origin-gated autofill, permissions). Verified GREEN by `plexidesk-tester`.
3. **A few providers** (some Google/Microsoft enterprise SSO) block *embedded* browsers regardless of UA, by policy. Those need an **external-browser OAuth handoff** (Phase 2).
4. **Chrome extensions are possible but only on a native `WebContentsView`** (not on `<webview>`), and Electron supports only a **subset** of the extensions API — realistically ad-block + Dark Reader, marketed as a *vetted shelf*, **never Web-Store parity** (Phases 3-4).

There is no single switch that delivers "real browser + all Chrome plugins." There is a credible **4-phase path** that delivers the experience the brief is reaching for, lowest-risk first.

---

## Context: how the browser works today, and why it felt broken

Each browser widget is an Electron `<webview>` with:
- a per-app **session partition** (`persist:connectedapp-*` / `persist:webview-default`) so cookies survive restarts;
- **popup/OAuth routing** in main (`setWindowOpenHandler` → `popupRouter.decidePopup`): real popups open as native windows *sharing the parent session*; `target=_blank` links spawn a new canvas widget;
- **vault autofill** injected via `executeJavaScript`;
- a back/forward/reload/URL toolbar.

This is a sophisticated, real-Chromium browser. The reported "it's terrible" experience traced to **five concrete defects**, all verified against the code:

| # | Root cause | Verdict | Status |
|---|---|---|---|
| R1 | **No `setUserAgent` anywhere** — the webview advertised `…focusbuddy/2.4.3 … Electron/33.x …`. Identity providers fingerprint that and return `disallowed_useragent` / "this browser may not be secure," **hard-blocking sign-in**. | CONFIRMED (no-UA fact); consequence is well-known industry behaviour | ✅ **Fixed** |
| R2 | **Click-to-interact overlay ate the first click *and* yanked the camera** — `showOverlay` rendered a full-bleed overlay whose `onClick` called `focusOn` (which pans), so the first click never reached the page and the canvas jumped. | CONFIRMED | ✅ **Fixed** (`setActive`) |
| R3 | **Vault autofill had no origin check** — decrypted credentials were injected into *whatever* page the webview showed, including a redirect/link to a hostile origin. | CONFIRMED (0.93) | ✅ **Fixed** (origin-gated) |
| R4 | **Popups inherited the broken UA** — `popupRouter` shares the parent session but never set a UA. | CONFIRMED | ✅ **Fixed transitively** (UA is set on the shared *session*, so popups inherit it) |
| R5 | **Built on the deprecated `<webview>` tag** (`webviewTag:true`), which Electron actively discourages and which cannot host extensions. | CONFIRMED | ⏳ Strategic — Phases 3-4 |

R1-R4 were the felt pain. They are shipped and proven. R5 is the strategic decision this ADR exists to make.

---

## The core architectural tension (read this before judging the options)

There are three ways to put a web page in an Electron app, and they trade off on a single axis that **defines** this product:

> **Does the browser surface transform with the CSS canvas (pan/zoom/clip/round-corners/z-index), or is it a native OS-level overlay that does not?**

| Engine | Composited with the DOM canvas? | Real-browser fidelity | Chrome extensions |
|---|---|---|---|
| **`<webview>`** (today) | ✅ **Yes** — it's a DOM element; it pans, zooms, clips, rounds corners, and layers under modals/menus *for free* | High (real Chromium) but the tag is deprecated/buggy | ❌ No |
| **`BrowserView`** | ❌ No — native overlay, ignores CSS transform/clip/z-index | High | ⚠️ Limited; also deprecated in favour of ↓ |
| **`WebContentsView`** (modern) | ❌ No — native overlay; you must *manually* track the widget's screen-space rect every frame and it **cannot** be clipped by the canvas, covered by a DOM modal, or rounded | Highest | ⚠️ **Subset** via `session.loadExtension` |

**This is the whole problem.** A `<webview>` rides the panning/zooming canvas effortlessly — which is exactly why the current product *feels* integrated. A native `WebContentsView` is a "real browser" with extensions, but it floats *above* the canvas in screen space: it won't pan smoothly with 60fps inertia, can't be partially clipped by a section, and can't be covered by the upgrade modal or a right-click menu without extra compositing tricks. The team already learned this the hard way — `index.ts:71-77` documents abandoning a `mix-blend-mode` punch-through because it "couldn't escape the canvas's CSS-transform stacking context," settling on a **screenshot-at-rest, expand-to-native** pattern for live-mirror widgets. That hard-won lesson is the seed of the recommended end-state.

So: **`<webview>` is not "bespoke crap" — it is the right default for an infinite canvas.** The migration question is not "replace it" but "where do we *add* a native surface to unlock OAuth-hard-cases and extensions, without losing canvas fluidity?"

---

## Options considered

**Option A — Keep `<webview>`, harden it.** *(Phase 1 — DONE)*
Set a clean UA, fix the overlay, origin-gate autofill, add a permission policy. Cheap, zero architectural risk, keeps canvas fluidity, fixes the felt pain for the majority of sites.
*Limits:* can't host extensions; can't fix providers that block *all* embedded browsers by policy.

**Option B — Migrate the whole browser to native `WebContentsView` overlays.** *(REJECTED)*
Every browser widget becomes a native view synced to its canvas rect. Gains: extensions, top-tier fidelity, no deprecated tag. Loses: smooth pan/zoom (you're repositioning native views every frame), clipping by sections, layering under modals/menus/minimap, rounded corners. High risk, high effort, and it degrades the product's signature feel. **Three independent analyses agreed: do not do a wholesale migration.**

**Option C — External-browser OAuth handoff.** *(Phase 2 — PROPOSED)*
For sign-in specifically, open the provider in the user's **real default browser** via `shell.openExternal`, complete auth there, and capture the result back via the existing `haptyx://` custom-protocol deep link (generalise `authProtocol.parseHaptyxUrl`), then write the session cookies into the widget's partition (`session.cookies.set`) / PKCE. This is what robust desktop apps (Slack, Linear, GitHub Desktop) do. It is the *only* thing that fixes providers that refuse embedded browsers categorically.
*Limits:* a context switch out of the app for login; per-provider cookie/redirect plumbing; pilot with Google first.

**Option D — Hybrid: screenshot-at-rest + expand-to-native.** *(Phases 3-4 — PROPOSED, spike-gated)*
The end-state that resolves the tension:
- **At rest on the canvas:** keep the DOM-composited `<webview>` (or a cheap `capturePage` bitmap) so the board stays fluid and the widget pans/zooms/clips normally.
- **On activate / "expand":** mount **one pooled native `WebContentsView`** positioned over the active widget (a flat, unclipped, `z-50` surface — the same shape as `WidgetFocusMode`), where extensions are loaded and fidelity is highest. Snapshot back to the canvas on blur.
This gives "real browser + extensions for the widget you're actually using" **and** keeps the canvas smooth for the other 49 widgets. It mirrors the pattern the team already chose for live-mirror windows (`index.ts:71-77`).

---

## Chrome extensions — the honest verdict

**PARTLY, and only on a native `WebContentsView`, never on `<webview>` (which has zero extension support).**

Electron 33's `session.loadExtension(path)` supports an **unpacked-extension subset** of the Chrome API:
- ✅ `declarativeNetRequest` / `webRequest` (ad-block, request rewriting), `scripting` + content scripts, `storage`, `runtime` messaging, `tabs` (partial).
- ❌ **Not** the `identity` API, **not** native messaging, **not** browser-action toolbar popups, **no** Chrome Web Store, and MV3 service-worker support is partial.

**What this means in practice:**
- **Realistic, valuable:** a uBlock-style ad/tracker blocker and Dark Reader — load on a **curated, vetted shelf**, not "install anything from the Web Store."
- **Better than generic extensions for some needs:** the product already has a credential vault — a built-in, origin-gated autofill (now hardened) is *safer* than a third-party password-manager extension. Ship capabilities (ad-block, autofill) **built-in** where you can, and reserve `loadExtension` for the 2-3 extensions users actually ask for.
- **Marketing discipline:** promise "a vetted extension shelf (ad-block, Dark Reader) for your focused browser," **never** "use any Chrome plugin." The latter is a support-and-security trap the platform cannot honour.

---

## Decision

Adopt the **phased hybrid**:

| Phase | Goal | Work | Effort | Status |
|---|---|---|---|---|
| **1** | Hard-fail → works-for-most | Clean UA on each webview session; overlay `setActive` not `focusOn`; origin-gate autofill; permission denylist; *(next:)* wire `did-navigate-in-page` autofill for multi-step logins + a `did-fail-load` retry UI | M (mostly done) | ✅ **Shipped + proven** |
| **2** | Policy-blocked providers always work | Generalise `authProtocol.parseHaptyxUrl`; `shell.openExternal` the auth URL; capture via `haptyx://` + `session.cookies.set`/PKCE; pilot Google, then Microsoft | L (1-2w) | Proposed |
| **3** | Prove native + extensions, zero canvas risk | A `WebContentsView` manager scoped to the **focus-mode / "expand" surface** (flat, `z-50`, like `WidgetFocusMode`); `session.loadExtension` for uBlock-Lite + Dark Reader; validate on Electron 33.4.x | L (3-4w) | Proposed |
| **4** | Canvas fluidity **and** real Chromium for the active widget | `capturePage` bitmap rides the transform at rest; one pooled `WebContentsView` mounts on activate, snapshots on blur; **gate behind a spike** that proves the pan/zoom-sync is acceptable | XL (4-6w) | Proposed — spike first |

**Rejected:** Option B (wholesale native migration) — it trades the product's signature canvas feel for fidelity nobody asked for at rest.

---

## Risks & mitigations

- **UA regex mangling the version string** → unit-tested (`tests/unit/userAgent.test.ts`) with a real Electron 33 UA; idempotent; preserves Chrome/AppleWebKit/Safari tokens. ✅
- **Some enterprise SSO blocks embedded browsers regardless of UA** → only Phase 2 (external handoff) fixes those; Phase 1 narrows the failure set, it doesn't claim to eliminate it.
- **Phase 4 native-view ↔ CSS-transform sync is make-or-break** → do not build it without a spike that proves 60fps pan/zoom tracking and acceptable clipping. If the spike fails, stop at Phase 3 (native only in the expand surface) — which already delivers extensions.
- **Origin-gate too strict for an edge-case login domain** → fails *closed* (autofill simply doesn't fire — a safe, non-security failure), with a subdomain rule that covers the common `accounts.google.com` case.
- **Extension security** → vetted shelf only; load specific reviewed builds, never arbitrary user-supplied extensions; document the supported-API subset so expectations are set.

---

## What shipped in Phase 1 (this session)

- `src/main/userAgent.ts` — pure `cleanWebviewUserAgent`, unit-tested (6 tests).
- `src/main/index.ts` — applies the clean UA + permission policy to every webview session (and the default session).
- `WebViewWidget.tsx` — overlay `setActive`; autofill passes the bound host.
- `vaultAutofill.ts` + `views/ConnectedAppView.tsx` — `autofillWebview(webview, entry, expectedHost)` with renderer-side origin check + in-page guard; `hostMatches` unit-tested.
- `tests/e2e/securityQuickWins.spec.ts` — permanent regression guard.

Proven: 66/66 unit + 18/18 e2e, GREEN (`plexidesk-tester`). The one un-automated check is the live OAuth round-trip — worth a 60-second manual confirmation against a Google login.

---

## Addendum, 2026-09-07: DRM streaming does not play, and why

Source: Claude memory, moved 2026-09-17. Measured both ways on Ryan's machine.

Netflix, Prime Video, Disney+, Max, Hulu and nearly every paid live-sports service do not play in the
browser widget. The cause is not Plexii's code: plain Electron ships **no Widevine content decryption
module**, and those services require Widevine on desktop Chromium.

| | plain `electron@37.10.3` (what Plexii ships) | castLabs `v37.10.3+wvcus` |
|---|---|---|
| `com.widevine.alpha` | **NotSupportedError** | **supported**, `createMediaKeys` ok |
| robustness | none | `SW_SECURE_CRYPTO` and `SW_SECURE_DECODE` ok; `HW_SECURE_ALL` not (no L1, so a 720p cap) |
| `mediaCapabilities.decodingInfo` with Widevine | `supported: false` | `supported: true, smooth: true` |
| `org.w3.clearkey` | supported (no commercial service uses it) | supported |
| CDM version | none | 4.10.3050.0, fetched at runtime by `components.whenReady()` |

**Probe trap:** run the probe on a `file://` or `https` page. A `data:` URL is not a secure context; it
hides the EME API entirely and produces a false "API missing" reading.

**Everything else in the path is fine, and was checked.** Every codec passes (H.264, AAC, VP9, HEVC,
AV1; MSE `true`, `canPlayType` "probably"); the permission denylist (`DENIED_PERMISSIONS` in
`src/main/index.ts`) does not deny `protectedMediaIdentifier`; and the webview presents a clean desktop
Chrome user agent (`src/main/userAgent.ts`). Clear (non-DRM) video already works: YouTube, Vimeo,
Twitch-style HLS.

**The fix is proven but not applied; it is Ryan's and Michael's call.** Swap the dependency to castLabs'
Electron for Content Security (an exact version match exists, `v37.10.3+wvcus`) and call
`components.whenReady()` before creating any window. Beyond that it is not a drop-in:

1. **VMP signing** is required for production playback. It needs a castLabs EVS account and acceptance
   of castLabs' and Google's Widevine terms; nobody creates that account or accepts those terms on
   Ryan's behalf.
2. It changes **Michael's notarised release lane**: the VMP signature is applied after code signing and
   before notarisation.
3. The GitHub tarball install **lost the macOS framework symlinks** on Ryan's machine (dyld: "Library
   not loaded: @rpath/Electron Framework"). Recreate `Versions/Current` and the top-level links in every
   `*.framework`, or the app will not boot after install.
4. Even signed, desktop Widevine is L3, so Netflix caps at **720p**.

The request on Ryan's list is in-browser video streaming for multiple concurrent streams. The concurrent
half is a separate question: each webview is a full renderer, so several simultaneous DRM streams is a
performance problem, not a DRM one.
