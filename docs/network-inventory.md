# What the desktop app contacts: network inventory

Every network destination PlexiiDesk (and the PlexiiOffice shell) can contact:
the host, what goes there, when, and whether the person can turn it off. Built
for the 4.3.34 release, from the source at that point and from a runtime capture
(see [Runtime verification](#runtime-verification)).

**This file is the source of truth for every privacy sentence.** Settings > Data >
Privacy (`src/renderer/src/components/settings/PrivacyHelpSection.tsx`), the
sign-in screen, the Terms, and the website's privacy copy must agree with it. A new
destination goes in here first; `tests/e2e/_networkInventory.spec.ts` fails on any
host it observes that this file does not list.

References are `file:line` from the repository root. "Signed in" means a session
token is held. A packaged build cannot be used signed out past the first-launch
account gate (`src/main/db/account.ts:314`, `anonymousLaunchAllowed`), so "signed
out" in practice means the gate itself, or after signing out.

## Summary

| Host | Purpose | When | Can the person turn it off? |
|---|---|---|---|
| `api.plexiidesk.com` (HTTPS + `wss://…/ws`) | Account, sync, sharing, chat, inbox, capabilities, billing checkout, **opt-in** usage data and crash reports | Signed in; much of it in the background | Sign out. Sync: no switch in Settings (localStorage flag only). Usage data and crash reports: **off by default**, opt-in in Settings > Data > Privacy |
| `focusbuddy-signal.fly.dev` | The same server under its old name, used by the main process: AI credits proxy, credit balance, credit checkout, live-desk publishing | Signed in, on AI use / live desks | Use your own key (AI source); don't publish live desks |
| `www.plexiidesk.com` | Browser sign-in, help, pricing, download page | Only when the person clicks (opens in the system browser) | Yes (user action) |
| `view.plexiidesk.com` | Share links point here; the app does not fetch it | Recipients open it | n/a |
| `dl.plexiidesk.com` | Update feed and the update zip (mac + Windows) | Packaged builds: 30 s after launch, then every 5 min, signed in or not | **No switch** |
| `github.com` (releases of `saasmouth/plexii`) | PlexiiOffice update feed, channel `office` | PlexiiOffice packaged builds, same cadence | **No switch** |
| `api.anthropic.com` | AI with your own Anthropic key, including the **title backfill** 12 s after launch | Own key: on AI use, and at launch if untitled items exist | Remove the key / use credits |
| `api.openai.com` | Own OpenAI key: cloud transcription, image generation, embeddings (**background sweep**), key test | On use; embeddings 45 s after launch then every 5 min | Remove the OpenAI key, or install a local embedding model |
| `html.duckduckgo.com` | Chat web search: the person's chat message | Each chat message of 15+ characters while the globe is on | Yes: globe toggle (on by default) |
| `huggingface.co` (+ its CDN) | Download of the local Whisper speech model (`Xenova/whisper-tiny` / `-base`) | Once, when local transcription is first used | Yes (don't choose local transcription) |
| `localhost:11434` | Ollama, if the person runs it | Probed every 5 min by the local-AI sweep | Local only; nothing leaves the computer |
| Your mail server (IMAP/SMTP) | Mail you connected | Startup, then every 90 s; on send | Disconnect the account |
| `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `login.microsoftonline.com`, `graph.microsoft.com`, ICS/webcal URLs | Calendars you connected | 20 s after launch, then every 15 min; on edit | Disconnect the calendar |
| Any site | Browser work widgets, connected apps (webviews), desk pop-ups, links you open | When opened; "notify" apps reload hidden every 5 min | Yes (per app / widget) |
| `www.google.com/s2/favicons` → `t*.gstatic.com` | Icons for links and connected apps. **Google receives each site's hostname** | Whenever such an icon renders | **No switch** |
| `tile.openstreetmap.org`, `nominatim.openstreetmap.org` | Map work widget tiles; place search | Map with a place renders; on search | Yes (don't use map widgets) |
| `fonts.googleapis.com`, `fonts.gstatic.com` | Web fonts in the PlexiiOffice window | Every PlexiiOffice launch | **No switch** |
| `tenor.googleapis.com`, `api.pexels.com`, `api.remove.bg` | GIFs, stock photos, background removal with your key | On use | Yes (user action, own key) |
| User-specified URLs | Webhooks (flows, webhook widget), agent URL inputs, files from a URL, custom work widgets with network on | On use / on a schedule you set | Yes |
| Stripe Checkout / Billing Portal | Opened in the system browser from a URL our server returns | When the person upgrades or buys credits | Yes (user action). No Stripe code in the app |
| `redirector.gvt1.com` (Windows) | Spell-check dictionaries, Electron's default on Windows/Linux | When an editable field first spell-checks | Not verified at runtime (tested on macOS, which uses the system checker) |

Not found anywhere in the app: Sentry, Electron `crashReporter.start`, Google
Analytics, Mixpanel, Segment, Amplitude, PostHog, Plausible, Stripe.js, any ad or
remarketing SDK. The app has no `/growth`, `/lifecycle` or `/events` endpoint
calls; the growth funnel's `first_launch` is recorded by the server from the
first `/telemetry` post (opt-in, below).

## Usage data and crash reports (opt-in, off by default)

Until 4.3.34 usage data was **on by default** (opt-out) and crash reports rode
along under the same switch. From 4.3.34 both are opt-in and separate:

- Preference: `src/renderer/src/lib/telemetryPrefs.ts`. Only a stored `'on'`
  enables a switch; never choosing means off. People who had explicitly turned
  usage data on keep it; crash reports start off for everyone.
- **Usage data** → `POST {api}/telemetry` (`src/renderer/src/lib/telemetryReport.ts:43`),
  8 s after sign-in, every 6 h and on window focus (at most every 10 min)
  (`src/renderer/src/components/TelemetryReporter.tsx`), plus once immediately on
  an account's first run on a device (`src/renderer/src/lib/firstLaunch.ts:40`,
  wired in `src/renderer/src/components/GrowthEffects.tsx`). The snapshot
  (`src/main/db/telemetry.ts`, `collectTelemetry`): `appVersion`, `platform`,
  `widgetTotal`, `widgetsByKind` (kind → count), `taskCount`, `folderCount`,
  `focusSessions`, `focusMinutes`, `aiCalls`, `aiInputTokens`, `aiOutputTokens`,
  `aiEstCostUsd`, `onboardingCoreCompleted`, `onboardingModules`. Counts only.
- **Crash reports** → `POST {api}/crash` (`src/renderer/src/lib/crashReport.ts:67`),
  same cadence: up to 50 locally recorded errors with `ts`, `source`, `kind`,
  `message`, `stack`, `componentStack`, `appVersion`, `context`. An error message
  or stack can contain text from the screen or a file path. Crashes are always
  recorded **locally** (`crash:report` IPC); only sending is opt-in.
- Each transport checks consent itself, at every attempt.
  `tests/unit/telemetryOptIn.test.tsx` fails if any send can happen while a
  preference is unset or off, and if a `/telemetry` or `/crash` URL appears
  anywhere else in `src/`.
- Onboarding progress (`src/renderer/src/lib/onboardingTelemetry.ts`) is written
  to the local database only; it leaves the computer inside the usage snapshot,
  so it follows the usage switch.

## Account and sign-in (`api.plexiidesk.com`)

Base URL: `ACTIVE.api` (`src/shared/productDomains.ts:28`, read by
`src/renderer/src/lib/signalConfig.ts:44`).

- Sign-up / log-in: email, password, name, handle, and an **install id**
  (`deviceId`, `src/renderer/src/stores/account.ts:144,170`) the server keeps to
  refuse self-referral rewards (`src/renderer/src/lib/accountClient.ts:107,147`).
- Every launch with a cached session: `GET /accounts/me`
  (`src/renderer/src/lib/accountClient.ts:239`), then `GET /account/pending-build`
  once (`accountClient.ts:486`, from `GrowthEffects.tsx`).
- On every auth change and **every window focus**: `GET /account/capabilities`
  (`src/renderer/src/stores/capabilities.ts:179`). The server stamps a per-day
  activity row on this call (see Server side).
- Profile, 2FA, email verification, referrals, credit-bank, feature votes,
  account state (`/account/state/:key`): on use.
- Browser sign-in opens `www.plexiidesk.com/account/login` and returns via a
  `plexii://` link (`src/main/authProtocol.ts`).
- Off switch: sign out. A packaged build requires an account to get past first
  launch.

## Sync and messaging (`api.plexiidesk.com`)

- WebSocket `wss://api.plexiidesk.com/ws` (`src/renderer/src/lib/messagingSocket.ts:252`),
  opened on sign-in (`src/renderer/src/App.tsx:267`), ping every 25 s
  (`messagingSocket.ts:269`): messages, presence, CRDT/Yjs updates, calls.
- Workspace sync every 20 s and on edits (`src/renderer/src/lib/workspaceSync.ts:37,953`):
  rooms/desks, work widgets, time blocks, documents (while Documents sync is on),
  tables, rows, files. On by default for every signed-in account; the only off
  switch is the localStorage flag `fb.workspace.sync = '0'`, not a setting.
  Encrypted in transit (TLS), **not end-to-end**: the server can read it.
- Inbox poll on sign-in, then every 30 s, paused while the window is hidden (`src/renderer/src/lib/inboxPoller.ts:21,74-80`).
- PlexiiChat, translate/summary/recall, org, teams, live docs: on use.

## Sharing and the viewer

- `/share*`, `/shares/ephemeral*`, `/workspace/desk/share|access|invite` on
  `api.plexiidesk.com` (`src/renderer/src/lib/shareService.ts`): on use.
- Live desks: the main process publishes to `focusbuddy-signal.fly.dev`
  (`src/main/livePublisher.ts:57,100`) and keeps publishing until paused.
- Links point at `view.plexiidesk.com` (`src/shared/productDomains.ts:29`); the app
  itself does not load the viewer.

## Updates

- PlexiiDesk: generic feed at `ACTIVE.downloads` = `dl.plexiidesk.com`
  (`electron-builder.cjs:98`; `latest-mac.yml`, `latest.yml`). macOS downloads the
  release zip itself (`src/main/updaterInstall.ts:26`, `macAssetUrl`).
- PlexiiOffice: GitHub provider, `saasmouth/plexii`, channel `office`
  (`electron-builder.plexioffice.cjs:68-72`).
- Schedule: packaged builds only (`src/main/autoUpdate.ts:227`), first check 30 s
  after launch, then every 5 min while idle (`autoUpdate.ts:302-309`). Signed in
  or not. **No setting turns it off.** Sends: a GET for the feed file (IP address,
  user agent with the Electron version).

## AI

- Plexii AI credits (default `auto` source while signed in): the main process uses
  `focusbuddy-signal.fly.dev/ai/anthropic` as the Anthropic base URL
  (`src/main/ai/creditMode.ts:34,398`); balance `/ai/credits` (`creditMode.ts:455`,
  refreshed on sign-in, `App.tsx:271`); checkout `/ai/credits/checkout`
  (`creditMode.ts:520`). The request content (the text the feature acts on) passes
  through our server to Anthropic; the server logs model and token counts for billing.
- Own Anthropic key: straight to `api.anthropic.com` (`creditMode.ts:36`,
  `src/main/ai/modelClient.ts`).
  - **Title backfill**: 12 s after every launch, if untitled items exist and an
    Anthropic key is stored, up to 40 items × 400 characters of their content go
    to Anthropic in one request (`src/main/index.ts:830`, `src/main/titleBackfill.ts:45,47,274,290`).
    No separate switch.
- Own OpenAI key: transcription (`src/main/ai/voiceNote.ts:177`), images
  (`src/main/imageGen.ts:50`), key test (`src/main/ipc/index.ts:4576`), and
  **embeddings**: a background sweep 45 s after launch then every 5 min
  (`src/main/index.ts:1007-1009`) sends document and knowledge text to
  `api.openai.com/v1/embeddings` when no local Ollama embedding model is present
  (`src/main/ai/embeddings.ts:32`). No separate switch.
- Chat web search: the latest chat message goes to `html.duckduckgo.com`
  (`src/main/webSearch.ts:142`, called at `src/main/ai/anthropic.ts:1650`), on by
  default per conversation (`src/renderer/src/components/ChatPanel.tsx:159`);
  the globe turns it off. Desk agents search the same way
  (`src/main/ai/agentBrowser.ts:84`).
- Ollama at `localhost:11434` (`src/main/ai/localModel.ts:12`): local.
- A bundled local model is being built on branch `local-ai`; it is not in this
  inventory until it merges. If it downloads weights at runtime, that host goes here.

## Model downloads

- Local Whisper: `@huggingface/transformers` with `allowRemoteModels = true`
  (`src/main/ai/localWhisper.ts:60`) fetches `Xenova/whisper-tiny` or
  `Xenova/whisper-base` (`src/main/ai/whisperCore.ts:21-22`) from `huggingface.co`
  the first time local transcription runs, then caches it in userData.
- OCR (Tesseract) uses bundled data; no download.
- No embedding model is downloaded by the app; local embeddings need an
  Ollama model the person installs.

## Mail (the person's own servers)

- IMAP via `imapflow` (`src/main/mail/imap.ts:79`): at startup if an account is
  connected, a sweep 45 s after launch then every 90 s
  (`src/main/mail/mailSync.ts:42,44,125`). SMTP via `nodemailer` on send
  (`src/main/mail/smtp.ts:90`). Credentials stay on the computer (encrypted with
  the OS keychain). Remote images in mail are blocked.

## Calendars and connected apps

- OAuth: `accounts.google.com`, `oauth2.googleapis.com`,
  `login.microsoftonline.com` (`src/main/calendar/oauth.ts:49-63`), loopback
  redirect on `127.0.0.1`. Then `www.googleapis.com/calendar/v3` and
  `graph.microsoft.com`. Sync 20 s after launch, then every 15 min
  (`src/main/calendar/sync.ts:480-481`); pushes on edit (`src/main/calendar/push.ts`).
- Connected apps / browser work widgets are webviews of the sites the person adds
  (`src/renderer/src/lib/standardApps.ts`). Apps set to notify are reloaded hidden
  every 5 min to read badge counts (`src/renderer/src/components/AppNotificationHost.tsx:49`).
  PlexiiOffice's browser home is `duckduckgo.com`.
- Unpacked browser extensions the person installed are re-loaded at launch
  (`src/main/index.ts:794`) and make their own requests.

## Icons, fonts, maps, images

- Favicons: `https://www.google.com/s2/favicons?domain=<host>`
  (`src/renderer/src/components/AppLogo.tsx:32`, `src/renderer/src/components/WidgetPreview.tsx:19`,
  `src/renderer/src/components/assistant/RetrievalTrace.tsx:69`,
  `src/renderer/src/components/views/homeShortcutTargets.ts:89`,
  `src/renderer/src/components/widgets/FileWidget.tsx:225`). Google sees the hostname
  of every linked site and connected app whose icon is shown. Observed at runtime
  (NET-3).
- Fonts: the PlexiiDesk window self-hosts its fonts (its CSP blocks Google Fonts).
  The PlexiiOffice window loads `fonts.googleapis.com` / `fonts.gstatic.com` on
  every launch (`plexioffice.html:5-10`).
- Maps: `tile.openstreetmap.org` (`src/renderer/src/lib/slippyMap.ts:125`,
  `src/shared/customWidgetHelpers.ts:66`) when a map work widget with a place
  renders (observed, NET-3); `nominatim.openstreetmap.org` on place search
  (`src/renderer/src/components/widgets/LocationMapWidget.tsx:72`).
- Keyed services on use: Tenor (`src/main/gifSearch.ts:61`), Pexels
  (`src/main/stockMedia.ts:32`), remove.bg (`src/main/stockMedia.ts:77`).
- Arbitrary URLs on use: files from a URL (`src/main/db/filesFromUrl.ts`), agent
  URL inputs (`src/main/ai/agentInputs.ts:38,99`), flow and widget webhooks
  (`src/main/db/flows.ts:231`, `src/main/ipc/index.ts:1524`), custom work widgets
  allowed network access.
- The main window's CSP (`src/renderer/index.html:10`) allows `connect-src https: wss:`
  and `img-src https:`, so it does not by itself restrict destinations.

## Billing

No Stripe code in the app. `POST /billing/checkout` (`src/renderer/src/lib/accountClient.ts:206`)
and `/ai/credits/checkout` return a Stripe URL that opens in the system browser.

## Local only (no outbound traffic)

`localhost:11434` (Ollama), `localhost:8765` (agentic ops health check,
`src/main/mdExternal.ts:15`), the local API/MCP server listening on `127.0.0.1`
(inbound, off by default).

## Server side (focusbuddy-signal), for context

What the server records beyond what features need is listed in the 4.3.34
privacy review: per-account `telemetry` rows (from opt-in posts), `crash_reports`
(stored, read by no route), `funnel_events` (never deleted, survive account
deletion), `account_activity` (a per-day row stamped by `/account/capabilities`,
inbox, share invites and the WebSocket, **independent of the usage switch**),
`email_events` with IP and user agent from open pixels and click redirects in
share-invite emails, IP and user agent in `audit_events` for sign-ins, and
request logs with the remote address. The server also accepts `/telemetry` even
when an account's `no_telemetry` capability is set; the opt-in lives only in the
app.

## Runtime verification

`tests/e2e/_networkInventory.spec.ts` launches the built app on a throwaway
profile (`PLEXI_APP=preview3`, temporary userData, API keys stripped), never signs
in, never opens `plexii://` or `haptyx://` links, and records hosts from both
network stacks: Chromium's `--log-net-log` (renderer, webviews, images,
WebSockets) and a main-process socket/DNS recorder (`tests/e2e/_netAuditHook.cjs`,
loaded with `-r`). Results on macOS, 2026-10-20, build of this branch:

| Phase | What it did | Hosts observed |
|---|---|---|
| NET-0 control | One known request from each stack | `example.com` (Node), `example.org` (Chromium): both stacks visible |
| NET-1 signed out | First-launch account gate up, idle 60 s | **none** |
| NET-2 typical use | Onboarding, new desk, sticky / note / task list / chart / map work widgets, every Settings tab, idle 100 s | **none** |
| NET-3 map + link | A map work widget with a place, a file work widget holding a web link | `tile.openstreetmap.org`, `www.google.com` (`/s2/favicons`), `t0.gstatic.com` (its redirect). The linked site itself was **not** contacted |

Not exercised at runtime, and why: update checks (packaged builds only; the
harness runs the unpackaged build), anything signed in (no sign-in allowed for
this check), AI providers (no keys), mail and calendars (nothing connected),
Windows spell-check dictionaries (macOS host). Those rows rest on the code
references above.

Run it: `npm run build && npx playwright test tests/e2e/_networkInventory.spec.ts`
(`PLEXII_NETAUDIT_KEEP=1` keeps the raw logs). Results land in
`test-results/network-inventory/<phase>.json`.
