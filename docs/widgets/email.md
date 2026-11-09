# Email, SME doc (master of destiny)

Tier: Sufficient. This widget only has to get the user to their real inbox inside
their canvas without friction, so the bar is "the email I need is one click away
next to the work", not "we out-feature Superhuman".

## The use case

Someone is deep in a piece of work on their desk, the notes and the table and the
timer all open, and a thread is part of that work. The reply they owe a client,
the invoice they are waiting on, the brief that lives in their inbox. They do not
want to alt-tab into a separate Gmail window, lose the canvas, and come back ten
unread emails later having forgotten what they were doing. They want their inbox,
or one specific thread, parked on the canvas beside everything else for this task,
so they can glance at it, fire off a reply, and stay in the flow. The moment of
use is "this thread is part of this task, keep it here with the rest of it."

## Current state

There is no email-specific component. The Email widget is the generic
`WebViewWidget` (`src/renderer/src/components/widgets/WebViewWidget.tsx`) loading a
mail URL inside an Electron `<webview>`. It is registered as a kind in
`shared/types.ts`, catalogued in `src/renderer/src/lib/widgetCatalog.ts` (kind
`email`, category Comms, default content `https://mail.google.com/`, default size
620x500, `hideFromPicker: true`), routed to `WebViewWidget` in
`src/renderer/src/components/Canvas.tsx` and `WidgetFocusMode.tsx`, and listed in
`WEB_KINDS` so it behaves as a browser. The AI command pipeline knows it as a kind
(`src/main/ai/anthropic.ts` describes it as "Gmail/Outlook URL" and
`src/main/ai/voiceCommand.ts` lists it), and right-click create-and-connect can
spawn one seeded to `https://mail.google.com` (`src/renderer/src/lib/createConnectedTool.ts`).

What works today, all inherited from the webview, not built for email:
- It loads a real Gmail or Outlook web inbox, fully interactive once you click in,
  so the user genuinely reads and sends mail from the canvas.
- A browser toolbar with back, forward, reload, stop, and an editable URL bar.
- Session persistence and Connected Apps binding, so the inbox stays signed in and
  can share a session partition plus vault auto-fill
  (`src/renderer/src/lib/vaultAutofill.ts`).
- Navigation is remembered. The last URL is persisted back to `widget.content`, so
  reopening returns you to the thread you were on, and `target=_blank` links spawn
  new canvas widgets rather than dead-ending.
- It can be wired, shared, focus-moded, and resized to device presets like any web
  widget.

Honest rough edges, which are most of the story here:
- It is a browser pointed at mail, nothing more. There is no compose action, no
  thread model, no concept of an unread count, no "reply" the canvas understands.
- The in-place AI cannot see or act on the inbox. The webview content is opaque to
  Haptyx, so the command bar and desk agents cannot read a thread, draft a reply,
  summarise, or triage. Everything the AI knows about email is "here is a URL".
- No deep-linking convenience. The user pastes a raw Gmail or Outlook URL. There is
  no "open the thread about X" and no provider account picker.
- Wiring is one-directional and dumb. Nothing flows out of the inbox into other
  widgets (no "this thread became a task", no "attachment landed as a file").
- `hideFromPicker: true` means it is not even in the normal widget picker, so most
  users meet it only through AI or create-and-connect, and it presents as a generic
  browser tab rather than a first-class comms tool.

## Best-of-breed landscape

Superhuman is the speed-and-polish leader. It built around keyboard shortcuts and
low-latency UX, then layered AI on top. It does Split Inbox with custom AI auto
labels, Auto Drafts that write follow-ups in your voice, one-line auto-summaries
above long threads, Instant Reply, reusable snippets, and an MCP so you can drive
the inbox from Claude or ChatGPT. It works against both Gmail and Outlook.

Shortwave is the AI-first leader. It was designed around AI from day one. Its
Ghostwriter learns your writing from sent mail so drafts sound like you, it does
natural-language search ("what did Sarah say about the Q3 budget") that finds and
summarises the answer, instant summaries on 20-plus-reply threads, and plain-English
automation scripts that label, star, and archive. It can create calendar invites
and scheduling emails, and it has team features like shared live threads and
assignees. It is Gmail-only.

Gmail with Gemini is the default most users already have. Gemini summary cards
auto-summarise long emails, it extracts action items from a thread, and "refine my
draft" rewrites a message shorter, more formal, or more detailed in one click, all
native across Workspace.

Outlook with Microsoft 365 Copilot is the enterprise default. It summarises threads
with clickable citations, drafts inside Outlook, can summarise attached Word, PDF,
and PowerPoint files in the reading pane, and Microsoft is rolling out agent-like
email and calendar automation through 2026.

What we already do better, or uniquely could. None of these four live next to the
rest of the work. They are a destination you go to. Our inbox sits on the same
infinite canvas as the notes, the table, the browser tab, and the timer for the
same task, it can be wired to other widgets and to desk agents, and the session
stays on the user's machine. The opportunity is not to rebuild Superhuman. It is to
make the inbox a participant on the canvas, where a thread can become a task, an
attachment can become a file widget, and a desk agent can watch for the reply you
are waiting on, none of which a standalone client can do because it has no canvas to
spill onto.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **The AI is blind to the inbox (Superhuman, Shortwave, Gemini, Copilot).** "Summarise
   this thread" or "draft a reply in my voice" is the table-stakes move every
   competitor makes, and ours cannot, because the webview is opaque to our command
   bar and desk agents. This is the gap that makes Email feel like a bookmark, not a
   tool.
2. **No compose or quick reply from the canvas (everyone).** "I need to fire off a
   two-line reply without leaving my desk." Today you click into the webview and use
   the provider's own UI, which is fine but means the canvas adds nothing.
3. **No thread-to-task or attachment-to-widget flow (no competitor does this either,
   but it is our reason to exist).** "This email is now a task on my desk" or "save
   that attached PDF onto the canvas." This is the canvas-native move nobody else can
   make, and we do not make it yet.
4. **No natural-language open (Shortwave search, Superhuman command).** "Open the
   thread from Maria about the contract." Today the user pastes a URL. The AI knows
   the kind exists but cannot target a specific message.
5. **Presents as a generic browser, hidden from the picker (Superhuman, Shortwave
   polish).** The widget has no mail chrome, no unread glance, and `hideFromPicker`
   keeps it out of the normal discovery path, so it reads as "a tab that happens to
   show Gmail."
6. **No provider account picker or deep-link helper (Gmail, Outlook).** "Use my work
   Outlook, not my personal Gmail." Today it is whatever URL you paste, with one
   default.

## The supersonic plan

### Launch-blocking (must ship to clear "Sufficient")
- **Make the inbox discoverable and legible.** Drop `hideFromPicker` for Email so it
  appears in the picker as a Comms tool, give the create form a one-click choice
  between Gmail and Outlook that seeds the right URL, and label the header "Email ·
  inbox" rather than a bare hostname. Acceptance: a new user can add Email from the
  picker, pick their provider, and land in their inbox without ever typing a URL,
  which closes the discovery gap against every competitor's "just open the app".
- **One-click compose from the canvas.** A compose button on the widget header that
  deep-links the provider's compose view (Gmail `?view=cm`, Outlook deeplink), so a
  reply is one click from the desk. Acceptance: from a fresh Email widget the user
  reaches a blank compose window in one click, matching the "write fast" promise
  Superhuman and Shortwave lead with for the common case.

### Launch-polish
- **Thread-to-task and attachment-to-canvas via the context menu.** Right-click the
  Email widget to "Make this thread a task" (captures the current URL and title into
  a task-link) and, where the page exposes them, pull `target=_blank` attachment
  links onto the canvas as file widgets, reusing the existing link-spawn path in
  `WebViewWidget`. Acceptance: a user turns a live thread into a desk task in one
  right-click, a move no standalone client can make because it has no canvas to put
  the task on.
- **Natural-language open through the command bar.** Teach the AI to map "open my
  email about X" to a provider search URL (Gmail `#search/X`, Outlook search query)
  loaded into a new or focused Email widget. Acceptance: "open the thread about the
  invoice" lands the user on the filtered inbox, approaching Shortwave's
  natural-language reach without us indexing a single message.

### Post-launch (pull ahead)
- **A desk agent that watches the inbox.** A standing desk agent that, on a schedule,
  loads the inbox in a headless partition, reads the unread subjects via injected
  script, and drops a summary note on the canvas or pings when the awaited reply
  arrives. Acceptance: the user wires "tell me when Maria replies" and gets a canvas
  notification, an agentic move that uses our desk agents and stays local, which no
  webview-bookmark competitor can claim.
- **Read-and-draft via an explicit, consented script bridge.** With the user's
  permission, inject a content script that extracts the open thread's visible text so
  the command bar can summarise it and draft a reply the user pastes back. Acceptance:
  "summarise this thread" returns a real summary of the on-screen email, reaching the
  Gemini and Copilot table stakes while keeping the body on the user's machine and
  out of any third-party model unless they opt in.
- **Provider-aware vault and multi-account.** Bind an Email widget to a named
  Connected App per account so work and personal inboxes are distinct, signed-in,
  auto-filled tools on the desk. Acceptance: a user keeps a work Outlook and a
  personal Gmail as two labelled Email widgets that stay signed in independently.

## The unfair advantage

Only Haptyx can put the live inbox on the same surface as the task it belongs to and
let the desk act on it. A thread can become a task widget, an attachment can land as
a file beside the work, and a desk agent can sit watching for the reply you are
waiting on and tell you on the canvas when it comes, all while the session and any
extracted text stay on the user's own machine rather than being shipped to a vendor's
model. Superhuman and Shortwave are faster inboxes you travel to. Ours is the only
inbox that lives inside the work and can hand pieces of itself to the rest of the
desk, and once the read-and-draft bridge is consented and local, that combination of
canvas, wiring, desk agents, and privacy is something a standalone client structurally
cannot copy.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
