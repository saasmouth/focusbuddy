# Plexii v1 beta — session handoff

> **UPDATE 2026-09-07, revised 2026-09-08 (DEC-138…141).** The first hour of §9 is done.
> Pre-flight reported: `main` still `8579cbaf`, nobody else has pushed;
> suite green (3,898 / 356). The §5 inventory has been REBUILT from the code
> — 168 surfaces in ten families, each with reach, health, tests, data,
> coupling, authorship, gating and a first-guess ruling — and published as a
> ruling sheet the operator marks Keep / Hide / Remove / Defer on:
> **https://claude.ai/code/artifact/b3b5ad7c-318a-48be-90ce-27789500d41b**
> (rulings persist to the artifact's own store; this session reads them
> back). Full audits are in the session scratchpad; the summary, the
> corrections to §5 (45 widget kinds not 44; 27 suite products not 32) and
> the 21 verified findings are in DEC-140.
>
> One defect was found on sight and fixed here (DEC-139): `widgets:delete`
> threw `ReferenceError: origin is not defined` in main on EVERY widget delete
> since v4.2.0 — the row was trashed, then the handler died, so no CRDT
> tombstone, no store prune, no undo toast, no `WidgetDeleted` event.
> **Michael landed the same fix independently on main the next day
> (`c86111fa`), so ours was dropped on Ryan's word and this branch was rebased
> onto the new main.** DEC-139 is marked SUPERSEDED and kept for the
> crash-row evidence.
>
> Nothing has been removed. The next round starts with the rulings.

Written 2026-09-07 at the close of the DEC-138 session, for the session that
starts the refinement. Everything a fresh session needs is here or linked;
the paste-able opening prompt is at the end (§9).

## 1. The mission, in Ryan's words

> "Refining the app, getting rid of all the noise and unnecessary features
> to get this thing production ready for v1 launch in beta."

Branch: **`ryan-v1-beta`** (from `main` `8579cbaf`, on both remotes).
Nothing has been removed yet. The first job is to agree with Ryan what
counts as noise — nothing gets deleted on a guess.

**Definition of done (proposed — confirm with Ryan before adopting):** a
Plexii a first beta user can open, understand and use for its core loop
without a dead end: capture attention → route it → plan the day → work on a
desk → meet, record, and turn the meeting into actions → message people →
keep files. Everything on screen works end to end, has honest empty and
error states, and is covered by tests. Everything outside the core is gone
or behind a flag. Michael can cut the beta build from `main`.

## 2. Facts

| | |
|---|---|
| Repo | `~/focusbuddy-plexi` (product name Plexii — two i's; fused legacy compounds like PlexiMeet stay single-i) |
| Active branch | `ryan-v1-beta`, rebased 2026-09-08 onto `origin/main` (Michael's 26 commits: live desk publishing, the assistant/retrieval pass, the widget-delete fix) |
| `main` | moved to `3af4ce37` on 2026-09-08 — Michael pushed 26 commits directly (no PR). **CI is red on main**: `npm ci` fails because package.json and package-lock.json disagree (he added `@electron/fuses` and two scripts). Still version 4.2.2; no new release cut |
| Frozen branches | `ryan-next`, `ryan-assistant` (landed); Caleb's `Caleb-4.3-ui` (in main), `Caleb-4.1-brain` (13 old commits) — paused |
| Closed | PR #5 `fix/platform-stability` — superseded (its DEC-056…061 reached main via ryan-command-center) |
| Remotes | `origin` = github.com/saasmouth/focusbuddy (push as **ryanswan313**); `fork` = github.com/ryan-swan/focusbuddy (push as **ryan-swan**) |
| Push ritual | `git push fork <branch>` → `gh auth switch -u ryanswan313` → `git push origin <branch>` → `gh auth switch -u ryan-swan` |
| Landing rule | `main` only via a PR, only on Ryan's explicit go; never a direct push. Before any landing: check GitHub (main's last commit, other branches, PR reviews, the event stream) and REPORT who changed what — Ryan confirms, then it moves. Michael cuts releases; landing is not a release |
| Suite at handoff | `npm run typecheck` clean (node + web); `npx vitest run` → 3,898 tests / 356 files; 414 Playwright specs in `tests/e2e` (heavy — run targeted specs, `npm run test:e2e` builds first) |
| Planning | `planning/plexii-task-command-center/DECISIONS-LOG.md` (append-only; **next entry is DEC-142**), `…/NEXT-SESSION-PROMPT.md` (resume prompt, top note points here), this file |
| Review packages | `analysis/28` (the Meet plan, SPEC-003), `analysis/29` (PR #6 review package) |
| Commit trailer | `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `.claude/` is never committed |
| Live app | Electron dev instance with `--remote-debugging-port=9223` (last session: PID 97113, log `/tmp/plexii-dev33.log`); `npm run dev` runs electron-vite WITHOUT `--watch` — main/preload edits need a manual restart (renderer hot-swaps) |

## 3. Rules that are easy to break

- **Ryan's data is real.** Never modify or dismiss his Attention items,
  meetings or desks without an explicit go. Read the DB read-only:
  `sqlite3 "file:$DB?mode=ro"`.
- **Scratch data** is tagged `test-seed`, titled `[TEST] …`, created and
  removed through the SAME store path (never raw IPC — the sync substrate
  echoes it back). Purging the Trash is destructive and happens only on
  Ryan's word.
- **Tests are pins.** Source-string pins live in `tests/unit/*.test.ts`
  (`// @vitest-environment node`). A pin superseded by a CHANGE is
  rewritten with a history comment, never deleted. A feature REMOVED takes
  its tests with it — say which in the DEC entry.
- **Design is direction, not canon.** Ryan rejected a pasted design canon;
  references guide, house material decides, real screenshots judge. House
  material: `fb-card` (raised card), `fb-btn-surface`, `icon-btn` (a fixed
  24px square — never with text), `fb-widget-tile`, `paper-texture`,
  `RailCard` (`fill` pins the header and scrolls the body), the sunken
  surface for fills inside a card (`RecordSectionTitle`'s band).
- **Layout rule (DEC-132…134):** "either it stops before something is cut
  off mid-row, or it scrolls" — no `calc(100vh - N)` caps; a page is a flex
  window (root `h-full flex flex-col`, header `shrink-0`, regions `flex-1
  min-h-0 overflow-y-auto`, hugging cards `max-h-full min-h-0`).
- **Claim nothing unverified.** Every round ends with a live probe on the
  running app and a green suite, or it says so.

## 4. How to verify on the running app (the CDP harness)

Scratch probes from the last session are in the session scratchpad
(`pages_scroll_verify.mjs`, `record_bands_verify.mjs`, …); the pattern is
in every one of them:

1. `GET http://127.0.0.1:9223/json/list` → the `page` target that is not
   devtools → open its `webSocketDebuggerUrl` with `ws` from the repo's
   `node_modules`; `Page.bringToFront`; `Runtime.evaluate` with
   `awaitPromise` + `returnByValue`.
2. **Read the DOM and press real buttons.** After any hot-swap, a probe's
   `import('/src/stores/x.ts')` is a STALE instance (`open:false` while the
   overlay is on screen); `import('/src/lib/x.ts?t=' + Date.now())` gets
   live code for pure libs.
3. **Restore the WHOLE view object** in the finally block: capture
   `useViewStore.getState().view` first; restore with the matching door
   (`goOffice(app)`, `goTask(id)`, …) or `useViewStore.setState({ view })`.
   The last session once dumped Ryan on Home from the Office view.
4. Screenshots: two rAFs (bounded — an occluded window never fires rAF),
   then the damage nudge (`root.style.display='none'; void offsetHeight;
   display=''`), then `Page.captureScreenshot` with
   `captureBeyondViewport` + a clip of the viewport.
5. Short windows: `Emulation.setDeviceMetricsOverride({width, height,
   deviceScaleFactor:0, mobile:false})`, measure, `clearDeviceMetricsOverride`.
   Measure against the view root's rect bottom (the footer bar sits below).
6. Hover in an occluded window: `CSS.forcePseudoState` (mouse events do not
   register `:hover`). React state set from native listeners flushes on a
   microtask — sleep before reading.
7. A page-wide clip sweep = every element with `scrollHeight >
   clientHeight + 3` must have `overflowY` auto/scroll.
8. **Microphone:** the dev app launched from Claude Code inherits the
   launcher's macOS TCC identity and gets a DIGITALLY SILENT mic (peak 0,
   RMS 0). Ryan launches from the Dock for a real mic. DEC-130's guards
   (`micHealth.ts`, `MicLevelPill`, `transcriptSanity.ts`, the derail net
   in `transcribeRecording.ts`) make the app say so itself; the
   `media:micStatus` / `media:askMic` bridge needs an app restart to be
   live. A real-mic end-to-end run of Record notes has NOT yet happened in
   a Dock-launched app — it is on the checklist (§7).

## 5. What the app exposes today — the inventory to classify

Pulled from the code on 2026-09-07. This is the map; the rulings are
Ryan's. The "first guess" column is a starting proposal only — confirm every
row before acting. Nothing below has been audited for completeness or
end-to-end health yet; that audit is the first task (§8).

**Sidebar doors** (`components/Sidebar.tsx`): Home, Attention, Calendar,
Plexii (assistant threads), Rooms (All desks, Shared, Trash), Files, Vault,
Connected Apps, PlexiDesk Pro; segment switch Desk / Office / People / Brain.

**Segments** (`components/segment/segments.tsx`):

| Segment | Entries | First guess |
|---|---|---|
| Desk | Home, My Desk, Workspaces, Plans, Agentic Ops, Desks, Calendar, Files, Recent | Home/Desks/Calendar/Files core; Plans, Agentic Ops, Recent, Workspaces to rule on |
| Office (`office/PlexiOfficeShell.tsx`) | PlexiDocs, PlexiSheets, PlexiSlides, PlexiDraw, PlexiDesign, Mail, Inbox, Chat, Meet, Sign | Meet and Chat core; Docs maybe; Sheets/Slides/Draw/Design/Sign/Mail/Inbox to rule on |
| People | People Home, Directory, Organisation, Organisation Map | Directory maybe; the rest to rule on |
| Brain | Ask Brain, Search, Brain Map, Decisions, Assemble a desk, Flows, Agents, Connect, APIs, Insights | Mostly long tail; Search maybe |

**MainPane view kinds** (`components/MainPane.tsx`, 41): home, all-tasks,
rooms, desks, shared, trash, attention, project-dashboard, task,
connected-app, vault, calendar, messages, inbox, mail, documents, design,
document, livedoc, livefolder, collaborations, insights, files,
organization, people-map, suite, product, knowledge, meetings, apps, forms,
sign, search, projects, reports, flows, api, marketplace, mdext, plexii.
First guess for the core: home, attention, calendar, rooms, desks, task,
project-dashboard, shared, trash, meetings, messages, files, documents,
document, connected-app, plexii, organization (minimal). To rule on: the
other 24.

**PlexiSuite catalogue** (`shared/plexiSuite.ts`, 32 products): Plans,
PlexiAI, PlexiAPI, PlexiAgents, PlexiBrain, PlexiBuild, PlexiCalendar,
PlexiChat, PlexiConnect, PlexiDash, PlexiData, PlexiDesk, PlexiDocs,
PlexiDraw, PlexiFiles, PlexiFlow, PlexiForms, PlexiMail, PlexiMarketplace,
PlexiMeet, PlexiOffice, PlexiOps, PlexiReports, PlexiSearch, PlexiSheets,
PlexiSign, PlexiSlides, PlexiTables, PlexiTasks, PlexiVault, PlexiWidgets,
PlexiWork. The suite home and product homes are the most visible "noise"
surface — expect this list to shrink to what v1 actually ships.

**Widget kinds** (`shared/types.ts` `WidgetKind`, 44): sticky, note,
markdown, webview, pdf, gdoc, gsheet, gslide, email, chat-thread,
calculator, color, image, video, timer, section, task-link,
local-app-launcher, file, drive, field, page, table, doc, sheet, slides,
map, design, meeting-record, streamdeck, minimap, attention,
voice-recorder, mindmap, diagram, scratchpad, shape, card, chart,
custom-block, agent, portal, living-doc, webhook, inbound-hook. Rule on
these with care: existing desks (Ryan's, Caleb's) may carry a kind; a
retired kind must render a quiet placeholder, never crash a desk.

**Standard connected apps** (`lib/standardApps.ts`, 20 launchers): Gmail,
Google Calendar, Google Drive, Notion, Trello, Todoist, Slack, Discord,
WhatsApp, GitHub, Linear, Jira, Claude, ChatGPT, Gemini, Spotify, YouTube
Music, YouTube, Figma, Miro. Keep the ones that do something real
(calendar/mail integrations that read data) — launchers that only open a
URL are cheap but noisy.

**Assistant overlay** (`assistant/AssistantOverlay.tsx`): tabs Plexii AI
chat, Attention, Calendar, Message, Agents. The first four were refined
this week (DEC-120…131); Agents is a candidate to rule on.

**Recording doors** (PlexiMeet hero): Record notes, Record external,
Message (voice/video note to a teammate), Add a meeting from notes, Start
or schedule a meeting (the live Stage). All audited in DEC-130.

Size: 1,036 TS/TSX files, ~255k lines under `src/`; the schema lives in
`src/main/db/database.ts` (56 `CREATE TABLE`s) plus upcasts.

## 6. The method — remove without breaking the product

1. **Audit each candidate** before proposing: what it does, whether it
   works end to end, its tests, the data it stores, and who references it
   (grep the view kind, segment entry, suite entry, widget kind, IPC
   channel, preload surface, DB table).
2. **Ryan rules per item:** Keep · Hide (a flag turns it off, code stays —
   for things that may return) · Remove (delete code, tests, docs, doors,
   IPC, preload surface) · Defer. Put the rulings in the DEC entry.
3. **Remove from the outside in:** nav door → view → store → IPC handler →
   preload API → main handler → shared types. Grep for the last reference
   before deleting a module.
4. **Never drop a DB table or an upcast.** Users' data outlives features;
   keep read paths (or migrate) so an old database opens cleanly. A retired
   widget kind renders a placeholder; a retired view kind routes Home.
5. **Tests:** the removed feature's unit pins and e2e specs go with it (say
   which); pins on CHANGED behaviour are rewritten with history. The suite
   and both typechecks stay green at every commit.
6. **Every batch:** live verification that the door is gone and nothing
   else moved (a screenshot of the nav, a clip sweep of the touched pages),
   a DEC entry, a commit, the dual push. Land small increments on `main`
   via PR on Ryan's go — Michael's cadence.
7. **Copy and naming** pass as you go: Plexii with two i's, product names
   that survive, honest empty states ("an honest zero, not a failure").

## 7. Production-readiness checklist (after the cull)

- First run and onboarding: an empty database opens to something
  understandable; every core page has an empty state that says what to do.
- Error states: the app never shows a blank pane; failures name the cause
  and the door (the DEC-130 microphone pattern).
- Recording on a REAL microphone: Dock-launched app, Record notes end to
  end, on-device and cloud engines; Record external with system audio.
- Sync and auth: session token lives in main-process storage; a real
  reload replays ~1,644 CRDT events — measure startup and the replay.
- Permissions: microphone, camera, screen recording (ScreenCaptureKit) —
  prompts and denials handled on a packaged build.
- Packaging: `npm run dist:release` (Michael's lane, notarised), Windows
  lane `dist:win` if v1 ships there — ask.
- Logs and crash reporting; the dev log's noise (certificate-parsing
  errors from `trust_store_mac.cc`) is harmless.
- Privacy statements match behaviour (meeting audio is local-only, expiring
  by the retention setting).
- Dark mode pass, keyboard shortcuts audit, accessibility basics.
- What's new / version copy for the beta.
- Ryan's own database residue, on his word only: 18 `test-seed` Attention
  items; 8 dismissed "Meeting brief — [TEST] DEC-130…" work items (no hard
  delete exists by design); his silent "Notes" meeting `ded4a88d`.

## 8. Open threads carried in

- The assistant pill overlaps content at the bottom-right on short windows
  (seen in DEC-134's 640px screenshots; not fixed).
- The Attention page's rail still uses the older sticky layout; the
  scroll-window rule was applied to Home, widgets, Calendar and Meet only.
- The `media:micStatus` / `media:askMic` bridge is inactive until the dev
  app restarts (main/preload edit).
- `Caleb-4.1-brain` holds 13 unmerged commits from August — his call.
- The MEMORY notes that back these rules live outside the repo (Claude's
  memory for this workspace): `plexii-repo-ownership-and-push-rules`,
  `focusbuddy-live-verification-via-cdp`,
  `plexii-dev-app-microphone-is-silent`, `plexii-design-direction-not-canon`,
  `plexii-name-spelling`.

## 9. First hour of the new session

1. Read this file, the top note of `NEXT-SESSION-PROMPT.md`, and the tail
   of `DECISIONS-LOG.md` (DEC-130…138).
2. `git branch --show-current` → `ryan-v1-beta`; fetch both remotes; confirm
   `main` is still `8579cbaf`. If it moved, report who and what before
   doing anything else.
3. Is the app running? `lsof -nP -iTCP:9223 -sTCP:LISTEN`. If not, ask Ryan
   to launch it (from the Dock if the mic matters today) or start
   `npm run dev` (silent mic).
4. `npm run typecheck && npx vitest run` — expect 3,898 tests / 356 files.
5. Rebuild the inventory of §5 from the code (the greps are one-liners on
   the files named there) and put it in front of Ryan as a Keep / Hide /
   Remove / Defer table with a first-guess column. Get rulings.
6. Start with the ruled removals, outside in, one DEC per batch, each one
   verified live and landed small.

### Paste-able opening prompt

> We are starting the Plexii v1 beta refinement on branch `ryan-v1-beta`
> in `~/focusbuddy-plexi`. Read `planning/plexii-v1-beta/HANDOFF.md` first,
> then the top of `planning/plexii-task-command-center/NEXT-SESSION-PROMPT.md`
> and the last entries of `DECISIONS-LOG.md`. Follow the handoff's first
> hour: confirm the branch and main, confirm the app is running on CDP
> 9223, run the suite, then build the inventory table and ask me to rule
> Keep / Hide / Remove / Defer before deleting anything. Nothing is pushed
> to main without my go, and never directly.

## 10. The scope sheet: where the rulings live, and what a Hide rides on

Source: Claude memory, moved 2026-09-17.

- **Rulings live in the sheet's own store, not in chat:** collection `rulings`, one document per row id,
  shaped `{ruling, note, name, at}`. A later session reads them back from the artifact's data store
  (`read_db` with `db_op: "list"`, `collection: "rulings"`) instead of asking Ryan again.
- **Row ids carry their family:** `s.` shell, `d.` desk, `o.` office, `b.` brain, `p.` people,
  `x.` assistant, `a.` apps, `l.` legacy, `w.` widgets, `bg.` background.
- **The sheet was generated, not hand-written:** `build-sheet.mjs` with `rows-*.json` and `meta.json`,
  in that session's scratchpad. Those files are gone (checked 2026-09-17). To change the sheet, rebuild
  the rows from the code and republish to the same URL, never a second artifact, so the stored rulings
  stay attached to their rows.
- **What a Hide rides on:** `VIEW_CAPABILITY` in `src/renderer/src/lib/viewCapability.ts` is the one map
  in the tree that hides a nav door and locks its surface in one place. As found on 2026-09-07 it did
  not cover three things, and every Hide had to handle them itself: the four segment shells took over
  the pane without mounting `MainPane` (the `segmentTakeover` branch in `App.tsx`), so no capability
  reached them; the ⌘K palette gated only three entries; and no main-process background loop was gated
  by anything except the activity tracker, the updater and the API server. Since 2026-09-08
  `segments.tsx` and `PlexiOfficeShell.tsx` call `useViewKindEnabled`, so re-check each gap against the
  code before relying on it.
- **The memory notes §8 lists as living outside the repo are all in it now.** The name rule was already
  at the top of `CLAUDE.md`; the push rules are in `CLAUDE.md` ("Ship policy"); the CDP procedure is
  `docs/LIVE-VERIFICATION-CDP.md`; the silent microphone is in `CONTRIBUTING.md`; direction-not-canon is
  in `DESIGN_SYSTEM.md`; and the DRM finding is in `docs/BROWSER-ADR-001-in-canvas-browser.md`.
