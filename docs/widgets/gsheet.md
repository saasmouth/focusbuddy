# Sheet, SME doc (master of destiny)

Tier: Sufficient. The Sheet widget has to do its one job, putting a live cloud
spreadsheet on the canvas next to the work, reliably and without surprises. It
does not have to beat Google Sheets at being a spreadsheet, but it must be a
calm, trustworthy window onto one.

## The use case

Someone is working on a task that already lives in a spreadsheet somewhere, a
budget, a tracker, a list of figures a teammate maintains, and they want it in
view while they do the rest of the work on the canvas. They are not authoring a
spreadsheet from scratch in Haptyx and they do not expect to. They have a
`docs.google.com/spreadsheets/...` URL, or an Excel-for-the-web link, and they
want it pinned beside the notes, the browser tab, and the timer for the same
piece of work so they can glance at it, edit a cell, and keep going without
tabbing away to another window. The moment of use is "my numbers live over there
and I want them here, in this one cell of attention, while I work."

## Current state

There is no dedicated GoogleSheet component. The `gsheet` kind is one of the
web-based kinds and is rendered by the shared browser widget at
`src/renderer/src/components/widgets/WebViewWidget.tsx`, dispatched from the
`WEB_KINDS` list in `src/renderer/src/components/Canvas.tsx` (line 123, alongside
`webview`, `pdf`, `gdoc`, `gslide`, `email`). The catalog entry lives in
`src/renderer/src/lib/widgetCatalog.ts` (line 182): label "Sheet", icon
`table_chart`, default size 620x480, URL placeholder
`https://docs.google.com/spreadsheets/...`. It is marked `hideFromPicker: true`,
so the picker no longer offers a "Sheet" entry directly. The comment block at
line 147 explains why: the separate cloud-doc kinds were folded into the File
widget, which auto-detects a Google hostname on URL paste, so a user reaches a
sheet today by dropping a File or Browser widget and pasting the link rather than
by choosing "Sheet". The `gsheet` kind stays valid so existing widgets keep
rendering.

What works today comes entirely from WebViewWidget, an Electron `<webview>`
embed with real browser chrome. That is a genuine strength and worth being
honest about. The widget has back, forward, reload, and stop controls plus an
editable URL bar (WebViewWidget.tsx around lines 539 to 560), it persists the
post-navigation URL back to the widget so reopening returns to where you were
(`persistNavUrl`, line 171), and it shares a session partition so Google OAuth
and sign-in flows actually complete instead of looping. Target=_blank link
clicks are forwarded from the main process and spawned as sibling widgets rather
than swallowed (lines 187 onward). Sites can be pinned to Connected Apps to share
a session and auto-fill vault credentials (line 700). It is a resizable,
wireable, first-class canvas object, and the cognitive-load meter weights it at
1.3 in `src/renderer/src/components/LoadMeter.tsx` so a live sheet registers as
real attention cost.

Honest about what is missing or thin:

- It is a generic browser frame, not a spreadsheet-aware widget. It has no
  knowledge that the page is a sheet. It cannot read a cell, a range, a tab name,
  or a header row, and it cannot show a value back on the canvas.
- Nothing flows out of it. A wire from the Sheet to another widget or a desk
  agent carries only the URL and a content preview that is just the URL string
  (`canvasSnapshot.ts` line 62 returns `w.content.slice(...)`, the raw URL, for
  the `gsheet` case). The actual grid data is invisible to the rest of the
  system.
- The in-place AI cannot touch the spreadsheet. It can move, resize, or relabel
  the widget, but it cannot answer "what is the total in column C" because the
  values never leave the embedded page.
- It depends entirely on the provider allowing itself to be framed. A sheet that
  is not shared, or set to no-embed, shows a Google sign-in wall or a refusal
  rather than the grid, and the widget has no friendlier fallback for that case.
- It is hidden from the picker, so discovery is poor. A user who thinks "I want a
  sheet here" has to know to use File or Browser and paste a URL.
- It is online-only. Offline, or if the link rots, there is nothing local to fall
  back on, which sits awkwardly against the rest of Haptyx being local-first.

## Best-of-breed landscape

The named products that own this widget's job, embedding and editing a live
spreadsheet, are these.

**Google Sheets** is the thing most users will be pointing at. It is real-time
multiplayer with comments, version history, 400-plus functions, pivot tables,
and now Gemini in the sidebar that detects patterns and drafts formulas from a
prompt. When we embed a sheet, we are embedding Google Sheets, so the editing
experience inside the frame is theirs and it is excellent. What we cannot match
is anything that needs to read the data, because to us it is an opaque web page.

**Microsoft Excel for the web** brings the calculation engine, pivot tables,
conditional formatting, and macros into the browser, and is the strongest of the
embeddable options at heavy data analysis. Many corporate sheets live in
OneDrive, not Drive, and a user with an Excel link expects the same in-canvas
treatment a Google link gets.

**Airtable** is not a spreadsheet but is the tool people leave Sheets for when a
flat grid stops being enough. It is a relational database with linked records,
lookups, rollups, rich field types, and Omni, an AI that builds tables and
automations from prompts. It matters here because Airtable's headline pitch is
"your spreadsheet, but the app understands the data", which is exactly the
understanding our embed lacks.

**Rows** is the AI-native grid where every column can pull from a live source
such as HubSpot, Stripe, Google Analytics, or SQL, with an AI Analyst in the
sidebar answering questions about the data. It is the clearest example of a sheet
that is also a data pipeline, the opposite of our read-only window.

**Equals and Sourcetable** are the newer AI-from-the-ground-up grids, connecting
directly to databases and warehouses and letting you query and model with natural
language. They show where the spreadsheet category is heading, toward the grid as
a queryable, AI-addressable object rather than a static page.

What we already do better or uniquely could. The sheet sits as one object on an
infinite canvas next to the notes, the live browser tab, the voice note, and the
timer for the same task, instead of owning a whole tab. Sign-in and OAuth work
because we share a real session, so it is a true live sheet, not a screenshot.
It is wireable in principle, and the desk agents and in-place AI give us a path
to make the grid addressable that none of the incumbents have in this exact
shape, a spreadsheet that an agent on the same desk could read from and write to
in place. None of that is built yet, but the surface is ours to build it on.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **The widget is invisible in the picker (no competitor needed, pure
   discovery).** "I want a sheet here." The user opens the picker, finds no Sheet
   entry, and either gives up or learns the File-paste workaround by accident.
   This is the cheapest and highest-leverage gap to close.
2. **The embed reads nothing back (Rows, Equals, Airtable).** "Show the total
   from column C on a card next to the sheet." Today impossible, because the grid
   is an opaque page and the only thing a wire carries is the URL.
3. **The in-place AI cannot answer questions about the sheet (Rows AI Analyst,
   Sheets Gemini).** "What is the biggest line item in this budget." The AI that
   can reshape a Table from a sentence is blind to the Sheet on the same desk.
4. **No graceful fallback when framing is refused (Google Sheets sharing
   model).** "I pasted a sheet and got a sign-in wall." The widget shows Google's
   refusal page with no in-app explanation or one-click "open shared link"
   guidance.
5. **Excel and OneDrive links are second-class (Excel for the web).** "My sheet
   is in OneDrive." It still works as a generic webview, but there is no Excel
   affordance, icon, or sizing tuned for it the way the Google path is.
6. **Online-only, no local trace (the local-first stance of Haptyx itself).** "I
   am on a plane and want last week's figures." There is no cached snapshot of
   the grid, so the widget is dead without a connection.

## The supersonic plan

### Launch-blocking (must ship to clear "Sufficient")

- **Restore a real path to a Sheet.** Either unhide the catalog entry or make the
  File/Browser URL detection promote a recognised spreadsheets URL to the
  `gsheet` kind with the Sheet label and icon, so the cognitive-load weight and
  display name are correct. Acceptance: pasting a `docs.google.com/spreadsheets`
  or Excel-for-the-web URL produces a widget that names itself "Sheet" and a user
  who wants a sheet can reach one in one obvious step. This is the floor for
  calling the kind real rather than vestigial.
- **Graceful no-embed fallback.** Detect the refusal or sign-in-wall state and
  render a small in-app card that explains the sheet must be shared or opened
  signed-in, with a one-click "open the link" and a hint about Connected Apps for
  session sharing. Acceptance: a user who pastes a private sheet sees a Haptyx
  explanation and a working next step, not a bare Google error, matching the
  basic robustness any of the incumbents show on a permission failure.
- **Correct provider identity.** Give Excel-for-the-web links the same first-class
  treatment as Google, with the right label, icon, and default sizing.
  Acceptance: a OneDrive Excel link is recognised as a Sheet, not an anonymous
  webview, so the Excel crowd is not second-class.

### Launch-polish

- **Read one value out.** Let the user mark a cell or named range and surface its
  current value on the canvas, via the Google Sheets published-CSV or API path
  for sheets the user owns, refreshed on an interval. Acceptance: a wire from the
  Sheet to a Card or Field shows the live total from a chosen cell, the first
  thing that makes us better than a plain embed and a step toward Rows-style
  live-source columns, scoped to one value.
- **Cached last-seen snapshot.** Store the last rendered grid as a lightweight
  local snapshot so the widget shows last-known figures offline with a clear
  "as of" timestamp. Acceptance: opening the desk with no connection shows last
  week's numbers greyed with a timestamp instead of a blank frame, honouring the
  local-first promise that no incumbent embed keeps.
- **Sheet-aware content preview.** Replace the raw-URL snapshot in
  `canvasSnapshot.ts` with the sheet title and tab names where the API allows it,
  so a wire and the AI see "Q3 Budget, tabs: Summary, Detail" instead of a URL.
  Acceptance: a desk agent reading the canvas can name the sheet and its tabs.

### Post-launch (pull ahead)

- **Agent-readable, agent-writable sheet.** For sheets the user owns, let a desk
  agent read a range and write a value back through the Sheets API, so "log
  today's total into the tracker" runs from the canvas. Acceptance: a desk agent
  appends a row to a real Google Sheet from a plain-language instruction,
  something no incumbent embed offers because none of them sit next to an agent
  on a shared canvas.
- **Ask-the-sheet in place.** The command bar answers "what is the largest line
  item" by querying the read path and replying on the canvas, our answer to the
  Sheets Gemini and Rows AI Analyst sidebars, except the answer lands beside the
  rest of the work rather than inside the spreadsheet tab.
- **Wire-fed cells.** A wire from another widget or an agent writes a computed
  value into a chosen cell, so a result on the canvas flows into the user's own
  spreadsheet. Uses the canvas wiring no spreadsheet tool has.

## The unfair advantage

Only Haptyx can put a live, signed-in spreadsheet on the same surface as the
browser tab, the voice note, and the timer for one task, and then aim a desk
agent at that exact sheet to read a figure or write one back in place. Every
competitor owns the inside of the grid better than we ever will, but none of them
sits the grid next to an agent and the rest of the work on one canvas. The second
advantage is the local-first instinct, a cached last-seen snapshot so the figures
survive a dead connection, which a pure cloud embed structurally cannot offer.
The realistic destiny of this widget is not to out-spreadsheet Google. It is to
be the calmest place to keep someone else's spreadsheet in view, and the only
place where an agent on the same desk can actually use it.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
