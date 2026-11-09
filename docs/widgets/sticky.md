# Sticky, SME doc (master of destiny)

Tier: Strong. A Strong widget does not have to redefine its category, but it has
to feel obviously good at the one thing people open it for, so the sticky has to
beat a desktop Stickies note at fast capture on the canvas without making the
user wish they had reached for a real note app.

## The use case

Someone is in the middle of work on the canvas and a small thought arrives that
should not interrupt the flow. A phone number to call back, a one-line reminder,
a label for the cluster of widgets next to it, a quick "don't forget the staging
deploy". They want to drop a coloured square, type a few words, and get back to
what they were doing. The sticky is the lowest-ceremony capture surface on the
desk. It is the thing you reach for when a note widget or a table feels like too
much structure for what is really just a Post-it. The moment of use is "I have a
short thought and I want it parked visibly right here, in one gesture, without
deciding anything."

## Current state

Rendered by `src/renderer/src/components/widgets/StickyWidget.tsx`. The widget
kind is declared in `src/shared/types.ts` (line 13) and catalogued in
`src/renderer/src/lib/widgetCatalog.ts` with a 200x200 default and an empty
default content. The content model is a single plain-text string stored in the
widget's shared `content` field, the same field notes and markdown widgets use,
so there is no sticky-specific table or store.

What works today:
- Fast capture into a free-resize textarea with a handwriting font, which sets
  the right "this is a Post-it, not a document" tone.
- Five pastel colours chosen from a row of swatches at the top of the note
  (`COLORS` in `StickyWidget.tsx`), persisted via `update(widget.id, { color })`.
- Debounced autosave at 600ms, with a careful unmount-flush effect so the
  un-debounced tail of what you just typed is not lost when the canvas remounts
  every widget on a layout-version bump (pin, unpin, group, auto-arrange, AI
  accept). This is a real correctness fix, not a default.
- Theme-aware rendering. The chosen pastel is the fill in light, dark, and
  atelier modes, and in futuristic mode it is preserved as a top accent strip so
  notes stay distinguishable without breaking the theme.
- Right-click "Create + connect" over the body opens `ConnectedToolMenu` seeded
  with the current text selection, so a sticky can spawn and wire a new tool from
  a phrase. Shift-right-click falls back to the native menu.
- First-class canvas object: resizable, wireable, shareable, and AI-spawnable
  (the build pipeline writes its text into the common `content` field, per
  `src/shared/types.ts` around line 917, and `actionExecutor.ts` defaults a new
  sticky to `#fef08a`).

Rough edges, honestly:
- It is plain text only. No bold, no bullet, no checkbox, no link. The moment a
  user wants a two-item to-do on a sticky, they are stuck or they leave for a
  note widget.
- No checklist mode, which is the single most common thing people actually do on
  a small note (a short list they tick off).
- No reminder or due time, so a sticky that says "call back at 3" never tells you
  at 3.
- The textarea does not auto-grow to fit the text, so a sticky is only as useful
  as the box the user happened to drag.
- Five fixed colours and nothing else. No custom colour, no label or tag, no
  pin-to-top, no way to find a sticky again except by looking at the canvas.
- No images or file drop, so a photographed whiteboard or a screenshot cannot
  live on a sticky the way it can on Apple Stickies or Keep.
- No search across stickies and no OCR, so text on a sticky is only findable by
  eye.

## Best-of-breed landscape

Apple Stickies owns the always-visible desktop note on macOS. It resizes freely,
offers several colours, goes translucent so it does not block what is underneath,
supports basic rich text, and lets you drag an image or a PDF straight onto the
note. It is the bar for "a coloured note that just sits there and behaves".

Microsoft Sticky Notes owns the Windows desktop equivalent and adds the things
people quietly rely on: basic formatting like bold and underline, a real
checklist, multiple notes open at once, and sync across devices through a
Microsoft account.

Google Keep owns rapid capture and findability. It does free-form notes and
checklists, colour plus labels as two separate organising axes, image notes with
OCR so the text inside a photo becomes searchable, voice notes with automatic
transcription, and time-based reminders. Keep is the reason "a sticky you can
actually find later" is an expectation, not a luxury.

FigJam and Miro own the sticky note as a collaboration primitive on a board.
They do bulk colour coding, grouping, AI-assisted clustering of many notes by
theme, and lightweight voting on stickies (Miro's dot voting, FigJam's stamps).
This is the multi-sticky-as-data direction, where a wall of notes becomes
something you can sort and tally rather than just read.

Milanote sits between a sticky and a moodboard, where a note is one of several
visual cards you arrange on a board alongside images and links.

What we already do better or uniquely could: our sticky is one object on an
infinite canvas next to the live browser tab, the timer, and the table for the
same piece of work, it can spawn and wire another tool from a selected phrase
through the ghost-line system, it can be created and filled by an AI from a
sentence in place, and every byte stays on the user's machine with no account and
no sync round-trip. No desktop Stickies app has the canvas or the wiring, and no
board tool is local-first.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **No checklist mode (Microsoft Sticky Notes, Google Keep).** "Three things
   before I leave, let me tick them off." This is the most common real use of a
   small note and we cannot do it at all. Biggest everyday gap.
2. **No basic rich text (Apple Stickies, Microsoft Sticky Notes).** "Make the
   deadline bold so I see it." A sticky that cannot emphasise one word feels
   thinner than the OS note the user already has.
3. **No reminder or due time (Google Keep).** "Remind me to call back at 3." A
   sticky that says 3 but never tells you at 3 is just decoration for a
   time-sensitive thought.
4. **Textarea does not auto-grow (Apple Stickies).** "I wrote four lines and now
   half is hidden behind the box edge." The note should fit its content, not the
   other way round.
5. **No labels, search, or OCR (Google Keep).** "Where did I put that sticky with
   the wifi password." On a big canvas a sticky you cannot search is a sticky you
   have lost.
6. **No image or file drop (Apple Stickies, Milanote).** "Drop the screenshot of
   the error onto a note." Today the sticky is text-only.
7. **No multi-sticky operations (FigJam, Miro).** "Cluster these twenty notes by
   theme and tally the votes." We have no bulk colour, grouping, or clustering of
   stickies as a set.

## The supersonic plan

### Launch-blocking (must ship to clear "Strong")
- **Checklist mode on a sticky.** A toggle that turns the body into tickable
  lines, each line a checkbox plus text, with state stored in the same content
  string in a simple parseable form so nothing new is needed in the schema.
  Acceptance: a user types three lines, ticks two, reloads, and the two stay
  ticked. We now match Microsoft Sticky Notes and Google Keep at the most common
  small-note job.
- **Auto-grow the note to its text.** The sticky height grows to fit the content
  up to a sensible cap, then scrolls, so short notes are small and longer ones
  are readable without manual resizing. Acceptance: typing a fifth line grows the
  note instead of hiding the line. We now match Apple Stickies at fitting content.
- **Minimal rich text: bold and a bullet.** Inline bold plus a bullet line,
  stored in the content string, rendered in the body. Acceptance: a user bolds
  the deadline word and it stays bold across reload. We now match the OS sticky's
  basic formatting.

### Launch-polish
- **Reminder on a sticky.** An optional due time on the note that fires a local
  notification and visibly marks the sticky as due. Acceptance: a sticky set to
  fire in two minutes raises a notification and shows a due badge. We now match
  Google Keep's time reminder, kept fully local.
- **Custom colour plus a one-word label.** Beyond the five pastels, a free colour
  pick and a short label that shows on the note. Acceptance: a user sets a custom
  teal and labels it "wifi", and the label is visible on the note. We move past
  the five fixed swatches toward Keep's colour-plus-label organising.
- **Find a sticky.** Wire stickies into the existing canvas search so their text
  is matched and the canvas pans to the hit. Acceptance: searching "wifi" pans to
  the wifi sticky. We close the "I lost my note" gap versus Keep, minus OCR.

### Post-launch (pull ahead)
- **AI cluster the stickies.** Select a wall of stickies and have a desk agent
  group them by theme and recolour by cluster, in place, on the canvas.
  Acceptance: twenty mixed notes resolve into four coloured clusters with a label
  per cluster. This takes the FigJam and Miro clustering ground using our
  in-place AI, with no board service in the loop.
- **Image and file drop on a sticky**, with on-device OCR so the text in a
  dropped screenshot becomes searchable through the same canvas search.
  Acceptance: a dropped screenshot of an error is found by searching a word from
  it. We match Apple Stickies on drop and Google Keep on OCR while staying local.
- **Sticky to task or to table.** A sticky checklist promotes into a real task or
  table row through the existing wiring, so a quick capture graduates into
  structure without retyping. Acceptance: a three-item sticky checklist becomes
  three table rows by a single wire action. Nobody else turns a Post-it into a
  typed row on the same surface.

## The unfair advantage

Only Haptyx can put a quick coloured note on the same surface as the live browser
tab, the timer, and the table for the same piece of work, let the user right-click
a phrase on that note to spawn and wire a new tool through the ghost-line system,
have a desk agent cluster a wall of stickies or graduate a sticky checklist into a
real table row in place, and keep every byte on the machine with no account and no
sync. The plan above closes the checklist, rich-text, reminder, and findability
gaps that a desktop Stickies user expects. The wiring, the in-place AI, and
local-first are why, once at parity, our sticky is part of a working surface
rather than a lonelier copy of an OS note.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
- 2026-06-10, Shipped auto-grow: the sticky grows by its text overflow (grow-only, capped at 640px) so a longer note stays readable without scrolling. Checklist mode and minimal rich text (bold + bullet) remain open from the launch-blocking tier.
- 2026-06-10, Launch-blocking tier complete. The sticky now has a rendered view and an edit view: clicking the note drops into a raw textarea, clicking away renders it. The rendered view shows inline **bold**, "- " bullets, and "[ ] / [x]" lines as tickable checkboxes. Ticking a box rewrites that line in the same content string, so the state is just text and survives reload (covered by tests/unit/stickyText.test.ts: tick two of three, the two stay ticked). A small toolbar adds Bold (wraps the selection in **), Bullet (prefixes the line), and a Checklist toggle (converts the body to or from checkboxes). Auto-grow now measures whichever view is showing. This clears the Strong tier for sticky.
