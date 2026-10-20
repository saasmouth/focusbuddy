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
| `api.plexiidesk.com` (HTTPS + `wss://…/ws`) | Account, sync, sharing, chat, inbox, capabilities, billing checkout, privacy choices, **opt-in** usage data and crash reports | Signed in; much of it in the background | Sign out. Personal sync: **Keep this device local** in Settings > Data > Privacy. Usage data and crash reports: **off by default**, opt-in in the same place, and the server refuses them without consent |
| `focusbuddy-signal.fly.dev` | The same server under its old name, used by the main process: AI credits proxy, credit balance, credit checkout, live-desk publishing | Signed in, on AI use / live desks | Use your own key (AI source); don't publish live desks |
| `www.plexiidesk.com` | Browser sign-in, help, pricing, download page | Only when the person clicks (opens in the system browser) | Yes (user action) |
| `view.plexiidesk.com` | Share links point here; the app does not fetch it | Recipients open it | n/a |
| `dl.plexiidesk.com` | Update feed and the update zip (mac + Windows) | Packaged builds: 30 s after launch, every 6 h, on wake; "Check now" | Yes: **Check for updates automatically** (on by default, disclosed) |
| `github.com` (releases of `saasmouth/plexii`) | PlexiiOffice update feed, channel `office` | PlexiiOffice packaged builds, same cadence | Yes: same switch |
| `api.anthropic.com` | AI with your own Anthropic key; the **title backfill** at launch only with Background AI tasks on | Own key: on AI use | Remove the key / use credits. Background: **Background AI tasks** (off by default) |
| `api.openai.com` | Own OpenAI key: cloud transcription, image generation, key test; embeddings only with Background AI tasks on | On use; embeddings on save, view open, a 5-min sweep and search, **only with Background AI tasks on** | Remove the OpenAI key; **Background AI tasks** (off by default) |
| `html.duckduckgo.com` | Chat web search: the person's chat message | Each chat message of 15+ characters while the globe is on | Yes: globe toggle, **off by default**, last choice remembered |
| `huggingface.co` (+ its CDN) | Download of the local Whisper speech model (`Xenova/whisper-tiny` / `-base`) | Once, when local transcription is first used | Yes (don't choose local transcription) |
| `localhost:11434` | Ollama, if the person runs it | Probed every 5 min by the local-AI sweep | Local only; nothing leaves the computer |
| Your mail server (IMAP/SMTP) | Mail you connected | Startup, then every 90 s; on send | Disconnect the account |
| `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `login.microsoftonline.com`, `graph.microsoft.com`, ICS/webcal URLs | Calendars you connected | 20 s after launch, then every 15 min; on edit | Disconnect the calendar |
| Any site | Browser work widgets, connected apps (webviews), desk pop-ups, links you open | When opened; "notify" apps reload hidden every 5 min | Yes (per app / widget) |
| The linked site itself | Icon for a link or custom connected app: `/favicon.ico`, else the page's declared icon on the same site | First time the icon is shown, then at most monthly (cached in userData; failures retried weekly). Built-in connected apps use bundled logos and fetch nothing | Yes (don't add the link). Web search results in chat fetch nothing (cached icon or a neutral glyph) |
| `tile.openstreetmap.org`, `nominatim.openstreetmap.org` | Map work widget tiles; place search | Map with a place renders; on search | Yes (don't use map widgets) |
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
- Every `/telemetry` and `/crash` body carries `consent: true`, and from 4.3.34
  the server refuses a post without it, from an account whose stored choice is
  off, or from one with the `no_telemetry` capability (see Server side). A build
  older than 4.3.34 sends no consent field, so its reports are refused.
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
  (`src/renderer/src/stores/capabilities.ts:179`). From 4.3.34 the server stamps
  a per-day activity row only for accounts that opted in to usage data (see
  Server side).
- Privacy choices: `PUT /account/privacy` with `{ usageReporting, crashReports }`
  (`src/renderer/src/lib/privacyServer.ts`) when either switch is flipped, and
  after sign-in only if it differs from what the server last heard from this
  device (`src/renderer/src/components/TelemetryReporter.tsx:74`). The server
  starts every account at off/off, so a person who never opted in sends nothing.
- Features that need the 4.3.34 server are offered only once
  `/account/capabilities` lists them in `serverFeatures`
  (`src/renderer/src/stores/capabilities.ts`, `useServerFeature`): the privacy
  `PUT` needs `account_privacy`; the "our server refuses / deletes on opt-out"
  wording needs `consent_enforced`; Delete my account needs `account_delete`
  (otherwise the panel says to email connect@plexiidesk.com); its emailed-code
  path needs `account_delete_email`. Against an older server nothing new is
  requested, so no request 404s.
- Delete my account and data (Settings > Account,
  `src/renderer/src/components/settings/DeleteAccountPanel.tsx`):
  `POST /accounts/me/delete` with the typed confirmation and the password (plus
  2FA), or `POST /accounts/me/delete/email-code` then the emailed code. On use.
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
  tables, rows, files. On by default for every signed-in account. Encrypted in
  transit (TLS), **not end-to-end**: the server can read it.
- **Keep this device local: don't sync** (Settings > Data > Privacy, off by
  default, `src/renderer/src/lib/localOnlyMode.ts`): the personal loop returns
  before any push, pull or file-blob transfer (`workspaceSync.ts:811`), the
  documents mirror is off (`cloudDocsSync.ts:42`) and synced preferences neither
  upload nor download (`accountStateClient.ts:16,29`). Still syncing, by design
  and said so in the setting: organisation workspaces and desks shared by name
  (other people depend on them). Nothing already on the server is deleted.
  Turning it off first saves a backup of this computer
  (`src/main/db/backup.ts`, `snapshotBeforeSyncResume`, kept: newest 3), because
  on resume an item changed on both sides keeps the server's version. Per
  device; the standalone PlexiiOffice app has its own Documents sync switch.
  The older localStorage flag `fb.workspace.sync = '0'` still stops every scope.
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
- Schedule: packaged builds only, 30 s after launch, every 6 h and on wake from
  sleep (`src/main/autoUpdate.ts:337-354`), only from idle/none/error, and only
  while **Check for updates automatically** is on (Settings > Data > Privacy,
  on by default, `src/main/privacyPrefs.ts`). "Check now" in the same place (and
  the footer) works either way. Turning the switch back on checks once.
- What a check sends, verified against electron-updater 6.8.3: a GET of
  `latest-mac.yml` / `latest.yml` (PlexiiOffice: the GitHub releases feed) with
  `User-Agent: electron-builder`, `Cache-Control: no-cache` and a time-based
  `noCache` query, over electron-updater's own cookie-less session. Nothing
  identifies the account or the install: electron-updater's per-install
  `x-user-staging-id` header (a random id it keeps in `userData/.updaterId` for
  staged rollouts) is stripped (`autoUpdate.ts:219-238`,
  `hardenUpdaterRequests`; `tests/unit/updatePollCadence.test.ts` fails if the
  library moves it). The host sees the IP address, as with any download. The
  macOS one-click download (`downloadFile`) sends `User-Agent: PlexiDesk-Updater`.

## AI

- Plexii AI credits (default `auto` source while signed in): the main process uses
  `focusbuddy-signal.fly.dev/ai/anthropic` as the Anthropic base URL
  (`src/main/ai/creditMode.ts:34,398`); balance `/ai/credits` (`creditMode.ts:455`,
  refreshed on sign-in, `App.tsx:271`); checkout `/ai/credits/checkout`
  (`creditMode.ts:520`). The request content (the text the feature acts on) passes
  through our server to Anthropic; the server logs model and token counts for billing.
- Own Anthropic key: straight to `api.anthropic.com` (`creditMode.ts:36`,
  `src/main/ai/modelClient.ts`).
  - **Title backfill**: 12 s after every launch, untitled items are named from
    their own text (free, local). Only with **Background AI tasks** on (Settings >
    Data > Privacy, off by default) do the rest, up to 40 items × 400 characters,
    go to Anthropic in one request (`src/main/index.ts:834`,
    `src/main/titleBackfill.ts:279`, `src/main/backgroundAiGate.ts:48`). Skipped
    items are not marked seen, so turning the switch on names them next launch.
- Own OpenAI key: transcription (`src/main/ai/voiceNote.ts:177`), images
  (`src/main/imageGen.ts:50`), key test (`src/main/ipc/index.ts`), all on use.
- **Embeddings** (document and knowledge text on save, on opening Documents or
  PlexiiBrain, on the sweep 45 s after launch then every 5 min, and each search
  question) go through `gatedEmbedTexts` (`src/main/backgroundAiGate.ts:73`),
  used by `documentRetrieval.ts`, `semanticRetrieval.ts` and `workspace:ask`.
  With **Background AI tasks** off they use a local model (Ollama) or nothing,
  and search falls back to matching words; only with it on can text reach
  `api.openai.com/v1/embeddings` (`src/main/ai/embeddings.ts:32`).
- Chat web search: the latest chat message goes to `html.duckduckgo.com`
  (`src/main/webSearch.ts:142`, called at `src/main/ai/anthropic.ts:1650`) only
  while the conversation's globe is on. **Off by default**; the last choice
  seeds new chats (`src/renderer/src/stores/chat.ts:397`,
  `plexii.chat.webSearchDefault`). Requests that never set the flag (dashboard
  cards, field AI, Stream Deck) are made explicit at the IPC boundary
  (`src/main/webSearchOptIn.ts`, `ipc/index.ts:1798,1866`), and scheduled flows
  and reports pass `webSearch: false`. Desk agents with a browse/search step
  search the same way when the person runs them (`src/main/ai/agentBrowser.ts:84`).
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

- Icons for links and custom connected apps come from the linked site itself
  (`src/main/siteIcons.ts:215`, `fetchSiteIcon`): `GET <origin>/favicon.ico`,
  else `GET <origin>/` and the page's declared `<link rel=icon|apple-touch-icon>`,
  followed only on the same site (host, parent or subdomain); redirects likewise;
  no cookies or credentials; capped at 256 KB and checked to be an image. Cached
  in `userData/site-icons` (refreshed monthly, failures retried weekly), served to
  the renderer as `data:` URLs over `siteIcon:get` (`src/renderer/src/lib/siteIcon.ts`).
  Built-in connected apps use bundled logos (`src/renderer/src/lib/appLogos.ts`)
  and fetch nothing. Web search results in a chat answer use the cache only,
  else a neutral glyph (`RetrievalTrace.tsx`). Until 4.3.34 all of these went to
  Google's favicon service. Observed at runtime (NET-3).
- Fonts are bundled in both windows: the type stack and Material Symbols from
  `@fontsource` / `material-symbols` (`main.tsx`, `officeApp.tsx`), and the 28
  further font-picker families in `src/renderer/src/assets/fonts` (latin subset;
  SIL OFL 1.1, Permanent Marker Apache 2.0; `FONT-LICENSES.txt`). Both CSPs
  allow fonts only from `'self'` and `data:`. Until 4.3.34 PlexiiOffice loaded
  Google Fonts on every launch and the pickers fetched families on demand.
  Observed at runtime (NET-4).
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

What the server keeps, from the 4.3.34 server release (focusbuddy-signal, branch
`signal-privacy`; deploys before this app release):

- **Usage data and crash reports are enforced server-side.** `/telemetry` and
  `/crash` answer 403 `not_opted_in` and store nothing unless the body says
  `consent: true` and the account's stored choice (`PUT /account/privacy`,
  table `account_privacy`, default off) is on, and no explicit `no_telemetry`
  override is set on the account or its organisations. (`no_telemetry` itself
  defaults to true on every plan, where it means "no third-party analytics", so
  only an explicit override blocks.) A consented post turns the stored choice on
  only if the account has never sent one; after that the stored choice wins.
  Turning a stream off deletes what it had sent. Crash paths have the home-folder
  user name scrubbed; an admin Crashes page reads them.
- **Activity days** (`account_activity`) are stamped only for accounts with usage
  reporting on. Nothing functional reads them; the admin console labels its
  active-account figures as covering opted-in accounts only.
- **Retention** (sweep at boot and every 6 h): telemetry, activity and funnel
  events 13 months, `first_launch` only under consent, crash reports 30 days,
  audit IP address and user agent nulled after 90 days (the audit rows stay so
  the hash chain verifies).
- **Share-invite emails** carry plain links: no open pixel, no click redirect.
  Old `/e/o` and `/e/c` URLs in sent mail still answer and record nothing.
- **Client IP** for audit and rate limits is `Fly-Client-IP` on Fly, otherwise
  the socket address; `X-Forwarded-For` is never trusted.
- **Account deletion** (`POST /accounts/me/delete`, and the admin delete) runs
  one cascade over every account-linked table, cancels a live Stripe
  subscription first, and keeps only: Stripe's invoices and payment records,
  the address on the do-not-email list if it unsubscribed, a trial-credit-used
  marker, audit rows without IP or user agent, content added to an organisation
  that stays, content-free revoked-link stubs for 7 days, and backups rotating
  out within about 5 days.
- Request logs (`logRedact.ts`, `serializeRequest`) record the socket address,
  which behind Fly is Fly's proxy rather than the person's IP (`trustProxy` is
  off), with tokens in URLs cut to a short prefix.

## Runtime verification

`tests/e2e/_networkInventory.spec.ts` launches the built app on a throwaway
profile (`PLEXI_APP=preview3`, temporary userData, API keys stripped), never signs
in, never opens `plexii://` or `haptyx://` links, and records hosts from both
network stacks: Chromium's `--log-net-log` (renderer, webviews, images,
WebSockets) and a main-process socket/DNS recorder (`tests/e2e/_netAuditHook.cjs`,
loaded with `-r`). Results on macOS, 2026-10-20, build of this branch (4.3.34 privacy work; settings at their defaults):

| Phase | What it did | Hosts observed |
|---|---|---|
| NET-0 control | One known request from each stack | `example.com` (Node), `example.org` (Chromium): both stacks visible |
| NET-1 signed out | First-launch account gate up, idle 60 s | **none** |
| NET-2 typical use | Onboarding, new desk, sticky / note / task list / chart / map work widgets, every Settings tab, idle 100 s | **none** |
| NET-3 map + link | A map work widget with a place, a file work widget holding a web link | `tile.openstreetmap.org` (Chromium) and `en.wikipedia.org` (main process: the linked site's own icon, `siteIcons.ts`). No Google host. The renderer never loaded the linked page |
| NET-4 PlexiiOffice | Launch the office shell, new document, sheet and deck, idle 30 s | **none**. Control: the same phase on the app-names baseline (d2fcc825) saw `fonts.googleapis.com` and `fonts.gstatic.com` (`/css2`, Inter and Material Symbols) |

Not exercised at runtime, and why: update checks (packaged builds only; the
harness runs the unpackaged build), anything signed in (no sign-in allowed for
this check), AI providers (no keys), mail and calendars (nothing connected),
Windows spell-check dictionaries (macOS host). Those rows rest on the code
references above and on unit tests: the update schedule, switch and stripped
staging id (`tests/unit/updatePollCadence.test.ts`), the Background AI gate
(`backgroundAiGate.test.ts`), web search off by default
(`chatWebSearchDefault.test.ts`), the local-only sync pause
(`localOnlyMode.test.ts`) and consent on every report
(`telemetryOptIn.test.tsx`, `privacyConsentServer.test.ts`).

Run it: `npm run build && npx playwright test tests/e2e/_networkInventory.spec.ts`
(`PLEXII_NETAUDIT_KEEP=1` keeps the raw logs). Results land in
`test-results/network-inventory/<phase>.json`.
