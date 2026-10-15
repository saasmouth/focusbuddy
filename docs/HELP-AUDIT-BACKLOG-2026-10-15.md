# Help-centre audit backlog — raised 2026-10-15

Defects and label/behaviour mismatches found while writing 379 help articles against
the app code at `v4.3.26` (tag `0bac3dae`), with some checks at `96e575fa` (4.3.28).
Each article's writer recorded claim → `file:line` evidence under
`/private/tmp/claude-501/help-evidence/<help-slug>.md`; the account/billing/shortcuts
research is in `.../help-evidence/w4-raw/`.

**Nothing here is fixed yet.** This file is the worklist. Paths are relative to
`focusbuddy/src/renderer/src/` unless they begin with `src/`, `focusbuddy-signal/`,
`haptyx-shared/` or `node_modules/`. Line numbers are from the commits above —
re-locate before editing.

## How to close an item

1. Read the help article named in the item. It documents **today's (broken)**
   behaviour and cites the evidence file.
2. Fix the code. Add a unit or e2e test. (The e2e harness uses a throwaway
   profile — never the live one.)
3. Tell the website session which help slugs changed, so it can rewrite the
   articles and redeploy through the gated deploy
   (`/private/tmp/claude-501/deploy/deploy.sh`).
4. Tick the box here and name the commit.

Every article describing a broken behaviour must be updated when its item lands,
or the help centre starts lying in the other direction.

---

## Already addressed elsewhere

Not from this audit, but overlapping with it — recorded so the same ground is
not re-walked:

- **Connected apps were not org-scoped** (4.3.28). The listing was; every
  by-id mutation was not, and hostname dedupe scanned all orgs — so connecting
  an app you already had in another org silently reused that org's row *and its
  vault binding*. Fixed in `src/main/db/connectedApps.ts`.
- **Unread badges counted conversations, not messages** (4.3.28). Page titles
  count threads; the per-thread counts now come from the page's accessible
  labels. `src/renderer/src/stores/appNotifications.ts`.
- **The embedded browser was seven majors out of support** (4.3.28). Electron
  37 → 44. Slack would have blocked the Slack webview from 2026-11-09.

---

## P0 — revenue and trust

- [ ] **1. Paid plan features are not enforced.**
  `haptyx-shared/src/capabilities.ts` marks these Pro or Team, but 4.3.26 never
  checks the flags, so Free accounts get them: Plexii web search, memory,
  Autonomous agent and browsing; Mail AI reply drafts and Suggested tidy-up
  (`lib/capabilityDefaults.ts:146,168`); Plan my day / `day_planning`
  (`lib/capabilityDefaults.ts:171`); Custom widget; and the rest of the Pro list
  in `plan-features`. Only Sign (`lib/viewCapability.ts:32`) and body doubling
  (app + `focusbuddy-signal` agreeing) really gate.
  **Fix:** route every capability through one gate the way `viewCapability` does
  for Sign, with an upgrade prompt modelled on body doubling's "Body double is
  not on your plan".
  *Help:* `plan-features`, `plexii-web-search`, `plexii-memory`,
  `plexii-autonomous-agent`, `plexii-browse`, `mail-ai-reply-drafts`,
  `mail-suggested-tidy-up`, `calendar-plan-my-day`.

- [ ] **2. Pricing lists features that do not exist.** `haptyx-shared/src/plans.ts`
  and `capabilities.ts` (`vault_backup`) sell "Vault backup and restore"; there is
  no vault backup, no way to edit a vault entry, and no password generator. Also
  unbuilt: workspace version history, marketplace credits. The device limit is not
  enforced. `plans.ts` bullets that do not match the app: "unlimited desks" (Free
  allows 3 top-level rooms) and "PlexiBrain on your own key" vs "Managed
  PlexiBrain" (AI credits work on every plan).
  **Fix:** build them or remove them from `plans.ts`, `capabilities.ts` and the
  pricing page.
  *Help:* `vault`, `plan-features`, `plans-and-pricing`.

- [ ] **3. No self-service billing or account management.**
  - No "Manage billing", change or cancel, in the app or on the web.
  - No way to upgrade an existing account to Team (sign-up only).
  - Members invited to an org do not inherit Team; the plan is per account
    (`focusbuddy-signal/src/billing.ts:432`).
  - Yearly Team subscriptions can be relabelled Pro
    (`focusbuddy-signal/src/billing.ts:469-477`).
  - No account deletion anywhere; the help article tells people to email connect@.
  - Web sign-in has no two-factor code field.
  *Help:* `billing-change-or-cancel`, `billing-upgrade`, `account-delete`,
  `account-two-factor`.

---

## P1 — data loss or broken core actions

- [ ] **4.** Stopping a meeting recording early discards the transcript and wrap-up
  — `stores/meetingRoom.ts:614-619`. *Help:* `meet-recording-and-consent`
- [ ] **5.** Deleting a calendar block never deletes its Google/Outlook copy; the
  remove function is never called — `src/main/calendar/push.ts:159`.
  *Help:* `calendar-google-microsoft`
- [ ] **6.** Plan my day ignores mirrored Google/Outlook meetings, so it can
  double-book — Plan my day planner (calendar store). *Help:* `calendar-plan-my-day`
- [ ] **7.** "Bring me back" on the Welcome back pill cannot be clicked: the pill
  closes on the same mousedown/keydown. *Help:* `focus-welcome-back`
- [ ] **8.** Messages the app writes to the assistant itself never appear in the
  Plexii panel — they are stored under the desk id while the panel shows only the
  open conversation's thread. Affects Body double check-ins, "suggest the first
  step", the Bring me back recap, and probably "What was I doing?" —
  `stores/chat.ts` plus the writers. *Help:* `focus-hard-to-start`,
  `plexii-what-was-i-doing`, `ai-assistant`
- [ ] **9.** "Body double me" cannot be turned off once on, and persists across
  restarts. *Help:* `focus-hard-to-start`
- [ ] **10.** Diagrams have no undo; Templates and AI map replace the canvas
  without asking — `components/documents/MapEditor.tsx`. *Help:* `diagrams-*`
- [ ] **11.** Design: AI design and templates replace a multi-page design with one
  page; Print PDF exports only the current page —
  `components/documents/DesignEditor.tsx`. *Help:* `design-*`
- [ ] **12.** Files view has no Trash; deletions are recoverable only via Undo and
  are purged after 7 days. *Help:* `files-organise-and-file-documents`
- [ ] **13.** Sign: Delete has no confirmation, signers cannot change after
  creation, Void only works while out for signature (`features.json` claims drafts
  too). *Help:* `sign-overview`
- [ ] **14.** Office Trash "Delete forever" has no confirmation (the Documents page
  does ask). *Help:* `office-trash-and-restore`
- [ ] **15.** Brain-imported desks, documents and notes are overwritten at the next
  sync, losing edits. *Help:* `brain-assemble`
- [ ] **16.** A share link removed from your list keeps working until revoked.
  *Help:* `share-public-desk-link`
- [ ] **17.** The app signs the user out on every launch —
  `src/main/index.ts:134-153`. *Help:* `account-sign-in`, `accounts-and-sync`

---

## P2 — features that do not work as labelled

### Office keyboard shortcuts

- [ ] **⌘/ never opens an editor's own shortcut list** — always the global panel
  (`App.tsx:476-488`). The comment there and the footnote at
  `components/ShortcutsOverlay.tsx:184` both claim the editors bind ⌘/; none does.
- [ ] **Docs** (`components/documents/editor/DocMenuBar.tsx:455-466`, items
  `:174-285`): "Insert link ⌘K" opens the command palette
  (`CommandCenter.tsx:204`); "Find and replace ⌘⇧H" toggles highlight (Tiptap
  `node_modules/@tiptap/extension-highlight/src/highlight.ts:162`) while find is
  really ⌘F (`DocEditor.tsx:364-369`); ⌘\ (clear formatting), ⌘⇧C (word count) and
  ⌘P (print) have no handler.
- [ ] **Sheets** (`editor/SheetMenuBar.tsx:115-224`; handler
  `SheetEditor.tsx:752-896`): B, I, U, ⌘\ and ⌘Y do nothing; redo is ⌘⇧Z only;
  ⇧Tab moves right instead of left (`:876`); the toolbar B/I/U turn a style on but
  not off.
- [ ] **Slides**: the menu says Redo ⌘Y (`SlidesMenuBar.tsx:115`) but only ⌘⇧Z
  works (`SlidesEditor.tsx:179`). Presenting does not clear the selection, so arrow
  keys can nudge objects during a show (`SlidesEditor.tsx:826`).
- [ ] **Design**: no arrow-key nudge and no group shortcut although both functions
  exist (`DesignEditor.tsx:405-412`); ⌘Z inside a text frame probably does nothing
  (`design/FrameTextEditor.tsx:107-110` vs `DesignEditor.tsx:423`).
- [ ] **Diagrams and Draw**: no "Keyboard shortcuts" menu item at all.

  **Fix for the group:** make each sheet list only the keys really bound, bind ⌘/
  per editor, and fix or remove the dead accelerators.
  *Help:* `office-keyboard-shortcuts`, `keyboard-shortcuts` (the latter currently
  repeats the false ⌘/ claim).

### Sheets and data

- [ ] Format › Number › Date uses `yyyy-MM-dd`, which the formatter does not
  recognise, so the letters are displayed.
- [ ] "Text, not empty" validation never flags anything.
- [ ] CSV export writes formula text (`=SUM(B1:B2)`), not the computed value.
- [ ] "Refresh from sheet" in Queries re-applies the steps to already-transformed
  data, so skip, remove-column and promote-headers run twice.
- [ ] Sorting moves values but leaves cell formatting behind.
- [ ] After filling from one number the status says "Filled as series" although it
  copied.
- [ ] The Sheet assistant reads formulas rather than results, and only the first
  50 rows.

### Charts, metrics and live views (also used in templates)

- [ ] A chart grouped by a Date column labels bars with raw timestamps.
- [ ] A Stat card or Metrics filter on a Single select column never matches.
- [ ] A chart grouped by a checkbox shows "true" and "false".
- [ ] Charts render no data on a live view.
- [ ] Living Doc does not regenerate when its source table or document changes;
  only **Regenerate now** works.

### Templates

- [ ] "Save as template" copies widgets as they are, so a Table, Chart, Document,
  Slides or Drive widget on a new desk still points at — and edits — the original
  desk's record. Templates should clone the data or create fresh records.
  *Help:* `desk-templates` (a warning has been added there)

### Attention

- [ ] Turning Attention off does not stop deadline and closure notifications; the
  notification code does not check the switch.
- [ ] After it is off the page still opens, desk tasks still flow into To Do, and
  "Add to Attention…" on chat text still shows but errors.
- [ ] The header bell counts snoozed items, and Select all includes hidden snoozed
  items, so Complete all closes them.
- [ ] "Mute all of these" says "until you clear mutes", but nothing clears mutes.
- [ ] The side-menu "Closed 7d" filter shows an empty "Nothing needs you" page.
- [ ] Side-menu counts disagree with the Analytics tiles: Due today includes
  overdue, Waiting includes delegated / in-review / needs-approval, Open counts
  snoozed.
- [ ] The empty-state hint names "Capture a work item", which no longer exists (now
  "Attention — open Capture").
- [ ] Capture is refused inside an organisation workspace.
- [ ] The first Enter on the check step may not file.
- [ ] Calendar reminder text "Starts in N minutes" is computed when scheduled, not
  when shown.

### Plans and tasks

- [ ] A new plan does not appear on the Plans page until it has a task; the
  empty-state text is outdated.
- [ ] The Grid Total row renders cost under Slack, and the Cost column cannot be
  sorted.
- [ ] The Files view invites drops but has no drop handler; clicking a folder row
  does nothing.
- [ ] The Calendar view shows tasks a day late (finish counted as the next working
  day).
- [ ] The Export dialog, tooltip and file filter name a third-party product.
- [ ] Opening a plan from All rooms shows the room dashboard, not the timeline.
- [ ] All Tasks includes archived desks, and parked tasks match no filter.

### Focus

- [ ] The end-of-session timer always says "5 minutes done", whatever the length.
- [ ] The desk-edit dialog is unreachable, so Importance can only be set at
  creation and the interest score cannot be set anywhere.

### Body doubling

- [ ] The command palette lists "Find a body double" twice on paid plans; one copy
  has no plan check.
- [ ] The app says partners are matched "at random", but `focusbuddy-signal` pairs
  the longest-waiting person with the same mode first.
- [ ] A code comment says ⌘⇧K opens body doubling; that key opens the Plexii hub.

### Plexii assistant and Brain

- [ ] The Agents list shows custom and library roles as "Generalist".
- [ ] Clicking a table citation in an answer does nothing.
- [ ] "Ask Plexii" from the palette may not show its answer when a conversation is
  already open.
- [ ] "Just this once" browsing consent approves one step, so it asks again on
  every click.
- [ ] Turn into desk drops its cards onto the current desk if you are on another.
- [ ] The model picker shows older model names ("Sonnet 4.6", "Opus 4.7") than the
  models actually called.
- [ ] Local transcription is labelled "small Whisper model, about 80 MB", but a
  larger model loads.
- [ ] Calls ignore the local-transcription choice.
- [ ] Flows "Send an email" sends immediately with no review, and the webhook
  trigger has no token (the flow id is the only key).

### Mail, chat, calendar and meetings

- [ ] Most ways into Chat open a stream view, not the conversation clicked; "Chat
  about this…" never switches to Chat.
- [ ] The Meeting Record widget never shows your own notes.
- [ ] The `.ics` join link still uses `haptyx://` — `src/main/ipc/index.ts:1839`.
- [ ] Plexii calendars cannot be renamed; new ones are always "New calendar".

### Widgets

- [ ] The Image widget is not wrapped in the widget frame, so it has no title bar
  and may lose its position.
- [ ] Receive from a URL never shows what it received, and only receives while the
  app is open, signed in and on that desk, with nothing queued. Transform wires and
  agents wired to it read its address, not the message. Signed out it says "not
  available on your server yet".
- [ ] Widget AI setup saves results the Send to URL, Receive from URL and Image
  widgets cannot read.
- [ ] Task link: dragging a desk from the sidebar no longer creates one, though the
  hint still says so.
- [ ] The File menu inside Flowchart, Design and Artwork acts on the "active"
  Office document, not the widget's own file.
- [ ] Design and Artwork listen for keys window-wide, which can clash with desk
  shortcuts.
- [ ] Design's "Publication" template group is empty.
- [ ] Accent colours Ruby and Sapphire are not saved (`lib/theme.ts` `loadTheme`),
  so they revert to Violet after a restart.
- [ ] Presence never sets "Away".

### Office, other

- [ ] Format › Number › Date is broken (see Sheets).
- [ ] The accessibility check flags missing image alt text, but images have no
  alt-text field.
- [ ] The Recent list's Mail and Meet tabs are always empty.
- [ ] "Shared with me" says document sharing is unavailable, yet the editor has a
  Share button.
- [ ] Draw PDF export uses 96 px per inch, so the 150 dpi print presets give
  oversized pages.
- [ ] Slides Morph cannot work: there is no duplicate-slide command to put the same
  object on two slides.
- [ ] Document PDF export omits the header, footer and page numbers; Word export
  includes them.

### Naming consistency

- [ ] On-screen labels say PlexiDocs, PlexiSlides, PlexiDraw, PlexiDesign,
  PlexiMeet, PlexiSign, PlexiInbox, while marketing and help say PlexiiDocs and so
  on. Pick one spelling.
  (Note: the app identity cannot move — see the legacy-identity constraints around
  `appId`. This is about display labels only.)
