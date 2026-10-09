# SpeedDeck, SME doc (master of destiny)

Tier: Power. This is a widget the keyboard-and-macro crowd will judge on whether
it actually fires reliably and configures fast, so it has to feel like a real
macro pad rather than a pretty grid that sometimes no-ops.

## The use case

Someone has a handful of things they do over and over while working, and they
want them one click away without leaving the desk. Copy and paste a snippet,
jump to Spotify and hit play, fire a Cmd+Shift+4 screenshot, type a canned
email reply, mute the mic, open the three apps a piece of work needs. They don't
want to buy a $150 piece of hardware or memorise a wall of shortcuts. They want
a backlit button grid sitting on the same canvas as the notes and timer for the
task in front of them, and they want it to just fire into whatever app they were
last using. The moment of use is "I keep reaching for the same six actions, put
them on buttons right here so I stop breaking flow."

## Current state

The deck data model lives in `src/shared/streamdeck.ts` as a tree of pages, each
page a sparse 10x3 grid of 30 slots, with buttons that are either actions or
folders that open a child page with no depth limit. The widget renderer is
`src/renderer/src/components/widgets/StreamDeckWidget.tsx`, with the AI macro
generator in `src/renderer/src/components/widgets/streamdeck/StreamDeckAI.tsx`,
the per-button editor in `StreamDeckButtonConfig.tsx`, and the action editor in
`StreamDeckActionEditor.tsx`. The actual execution happens in main via
`src/main/streamdeckActions.ts`, called over the `streamdeck:execute` IPC.

What works today:
- A real macro pad with nine action types: open-app, open-url, key-combo,
  type-text, media-key, set-volume, run-shell, delay, and multi-step sequences
  that run their steps left to right. Key combos and typed text are sent through
  AppleScript via `osascript`.
- The hard part is solved. `streamdeckActions.ts` tracks the previously
  frontmost macOS app and hands focus back to it before sending a keystroke, so
  Cmd+C actually copies in the user's editor rather than no-opping inside
  Plexii. Most cheap macro tools get this wrong.
- Two scopes per widget. A "Task" deck stored in `widget.content` that lives
  with the canvas, and a "Universal" deck in `userData` via the Zustand store in
  `src/renderer/src/stores/speeddeck.ts` that the same buttons follow across
  every task and folder.
- Full edit mode: drag to reorder and swap, drag onto a folder to file a button
  inside it, drag onto the Back chip to move it up a level, right-click for
  copy, cut, paste, duplicate, make folder, and remove, with a cross-deck
  clipboard so a button copied in a task deck pastes into the universal deck.
- AI macro generation. Describe "media controls" in plain language and the model
  returns one to three alternatives, a single button or a whole folder, that you
  preview and add. A second mode reads the local activity log and suggests
  macros from the apps you actually switch between, all on-device.
- Conflict awareness. `src/shared/macroConflicts.ts` flags when a proposed combo
  collides with a reserved macOS shortcut, a recognised standard one, or a
  duplicate already on the deck.
- Deck portability and a careful accessibility flow. Export to JSON, copy JSON to
  paste-share, import from a file, reset, plus a four-strategy
  `openAccessibilitySettings` that fights through the macOS permission maze that
  keeps changing pane IDs across releases.

Rough edges (honest):
- It is macOS-only in practice. `streamdeckActions.ts` says so plainly. Key
  combos, typed text, media keys, and volume all go through AppleScript, and the
  Windows and Linux paths are stubs that fail gracefully. On those platforms the
  widget is mostly open-app and open-url.
- Buttons are static. There is no live feedback on a button face. A mute button
  cannot show muted versus unmuted, a play button cannot flip to pause, and
  nothing reflects the state of the thing it controls. This is the single
  biggest gap against the incumbents.
- One action per press. There is no single-press versus double-press versus
  long-press, so a slot does exactly one thing.
- No app-aware profile switching. The Task and Universal scopes are manual. The
  deck does not change its face automatically when you switch to a different app
  the way Elgato's Smart Profiles do.
- Media keys are coarse. `mediaKey` in `streamdeckActions.ts` scripts Spotify
  and Apple Music by name and ignores browser players, so a button labelled
  next-track silently does nothing if you are playing in Chrome.
- run-shell is powerful but thin on guardrails. The header comments describe a
  one-time confirm before saving a shell button, and the executor just runs the
  command with a timeout. There is no per-run confirmation and no sandbox.
- No plugin or integration surface. Every incumbent has a marketplace of
  app-specific actions (OBS scene switch, Discord mute, Hue lights). We have
  generic key and shell actions only.
- Sharing is manual JSON. There is no library of ready-made decks, no
  one-click install of someone else's profile.

## Best-of-breed landscape

- **Elgato Stream Deck** is the category king and the thing people picture when
  they hear the word. Its software gives you Multi Actions, Smart Profiles that
  auto-swap the button layout based on the focused app, Key Logic that puts a
  single, double, and long-press action on one key, live button feedback from
  plugins, and a built-in Marketplace of integrations. In 2026 it even speaks
  the Model Context Protocol so AI tools and voice can trigger actions. It
  assumes you bought hardware, which is exactly the cost we avoid.
- **Touch Portal** turns a phone or tablet into a software deck and is the
  closest software-only competitor. It wins on a real logic layer, events that
  fire conditionally, reusable Flows, custom states that hold more than a
  boolean, dynamic button text that updates itself from a variable, and a deep
  plugin catalogue with strong OBS control. That conditional-logic-plus-dynamic-
  text combo is well ahead of our static buttons.
- **Bitfocus Companion** is the open-source control surface built for live
  production. It wins on feedbacks, where a button changes colour, text, or icon
  from the real-time state of a connected device, a proper variables and
  expression engine for arithmetic and string logic, triggers for event-driven
  automation, and patchable connections so one layout drives many rooms. It is
  the high-water mark for "the button reflects the state of the world."
- **Macro Deck** is the free, unlimited-button option on Android and Windows and
  is the budget answer for someone who refuses to pay. Its pull is simply that
  it costs nothing and has no button cap.
- **AutoHotkey** is the scripting powerhouse for Windows power users who want
  arbitrary automation without any deck metaphor at all. It is the ceiling for
  raw capability and the reason "macro" can mean something far deeper than a
  grid of buttons.

What we already do better or uniquely could: the deck is one object on an
infinite canvas next to the notes, tabs, timer, and table for the same task, not
a separate window or a second screen. It can be built and reshaped by an AI from
a sentence in place, and it can suggest macros from the apps you actually use, on
your machine, with nothing uploaded. It needs no hardware. No incumbent has the
canvas plus in-place AI plus local-first combination, and none of them sit
inside the same workspace as the rest of your work.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **No live button feedback (Companion, Elgato).** "Is my mic actually muted
   right now?" The button cannot tell you. A toggle button that does not show
   its own state is the clearest tell that we are a macro launcher, not a
   control surface. This is the single biggest perceived gap.
2. **No multi-action-per-press / press variants (Elgato Key Logic).** "Single
   tap plays, double tap skips, hold opens the folder." Today a slot does one
   thing, so users burn three slots on what Elgato fits in one.
3. **No app-aware profile switching (Elgato Smart Profiles).** "When I switch to
   my editor, show me my editor buttons." Our Task and Universal scopes are
   manual, so the deck never adapts to what is in front of you.
4. **macOS-only in practice (everyone except AutoHotkey on Windows).** "I'm on
   Windows and key combos just don't fire." The model and UI are
   cross-platform, but the executor is AppleScript, so the promise breaks the
   moment a non-Mac user presses a keystroke button.
5. **No conditional logic or variables (Touch Portal, Companion).** "Only run
   this if OBS is recording." We have linear multi-step sequences and nothing
   conditional, so the deck cannot make decisions.
6. **No integration or plugin surface (Elgato Marketplace, Touch Portal).**
   "Switch my OBS scene from a button." We expose generic key and shell actions,
   so app-specific control means the user reverse-engineers a shortcut.
7. **Media keys miss browser players (vs anything using real media-key
   injection).** "Skip track" silently fails when the music is a browser tab,
   because `mediaKey` only scripts Spotify and Apple Music by name.
8. **Sharing is manual JSON, no library (Elgato Marketplace).** "Give me a
   ready-made dev-tools deck." Import exists, but there is no gallery to import
   from.

## The supersonic plan

### Launch-blocking (must ship to clear "Power")
- **Live button feedback for the actions we own.** A toggle action type that
  reads and shows its state on the face, starting with mute and play/pause where
  AppleScript can already query the system. Acceptance: the mute button renders
  muted versus unmuted and flips when you press it, so we match Companion's core
  feedback idea for the handful of states we can read natively.
- **Press variants on one slot.** Single-press, double-press, and long-press
  each map to an action on the same button. Acceptance: one slot plays on tap
  and skips on double-tap with no extra slot used, reaching parity with Elgato's
  Key Logic for the common case.
- **Honest cross-platform story.** Either fill the Windows path in
  `streamdeckActions.ts` with a real keystroke backend, or have the button
  editor clearly mark which action types work on the current OS and hide or warn
  on the ones that do not. Acceptance: a Windows user is never handed a button
  that silently no-ops, so we stop quietly failing item 4.
- **Browser-aware media keys.** Send the real system media-key event rather than
  scripting two apps by name, so a track in any player responds. Acceptance:
  next-track works while music plays in a browser tab, closing gap 7.

### Launch-polish
- **App-aware profile switching.** Reuse the activity tracker that already
  watches app switches to auto-show a deck page when a chosen app comes to the
  front. Acceptance: switching to the editor swaps the deck to its page without a
  click, matching Elgato Smart Profiles.
- **Conditional steps in multi-step.** A run-if guard on a step keyed off a
  readable state such as "is muted" or "app X is frontmost". Acceptance: a macro
  that only fires its second step when a condition holds, taking the first slice
  of Touch Portal and Companion's logic ground.
- **A starter deck gallery.** Built-in ready-made decks (dev tools, media,
  meetings, writing) installable in one click, plus paste-share already in
  place. Acceptance: a new user gets a useful deck in one click instead of
  building from empty, answering the Marketplace pull at gap 8.
- **run-shell hardening.** A genuine confirm-on-save and an optional
  confirm-on-run for shell buttons, with the command shown. Acceptance: a shell
  button cannot be created or fired without the user seeing exactly what runs.

### Post-launch (pull ahead)
- **AI feedback wiring.** Describe "show me when I'm muted" and the AI builds a
  feedback toggle, not just a fire-and-forget button, something no incumbent does
  because they lack our in-place generation.
- **Wire-driven buttons.** A ghost-line wire from another widget or a desk agent
  fires a deck button, or a button state reflects a wired widget, using our
  unique canvas wiring so the deck becomes a control surface for the rest of the
  desk.
- **A small plugin shape** for app-specific actions, starting with the apps our
  users actually live in, so OBS or Discord control stops meaning hand-rolled
  shortcuts.
- **Cross-device universal deck** so the same Universal deck rides along when the
  cross-user sync work lands, making the phone-or-second-machine story Touch
  Portal owns into ours.

## The unfair advantage

Only Haptyx can put a macro pad on the same surface as the live browser tab, the
notes, the timer, and the typed database for the same piece of work, with no
hardware to buy and no second screen to glance at. The AI builds and reshapes the
deck from a sentence in place and can read the apps you actually use, on your
machine, to suggest the buttons worth having, none of it leaving the device. Once
the wiring lands, a ghost-line from a desk agent or another widget can fire a
button or drive its state, which turns the deck from a launcher into a control
surface stitched into the rest of the desk. The plan above closes the feedback,
press-variant, and profile gaps that Elgato and Companion hold; the canvas plus
in-place AI plus local-first trio is why, once at parity, ours is better in kind
rather than a cheaper clone of a thing you plug in.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
