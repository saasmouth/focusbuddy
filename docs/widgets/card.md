# Card, SME doc (master of destiny)

Tier: Sufficient. This widget does not have to beat best of breed at launch. It
has to be clean, fast, and obviously useful for its one job, so that nobody on
the canvas feels they downgraded by using ours instead of a sticky or a Notion
callout.

## The use case

Someone is on the canvas and wants to pin a single structured thought that
deserves more weight than a sticky but less ceremony than a page. A definition,
a decision, a "remember this", a callout that frames a cluster of other widgets,
a labelled milestone. They want a title that reads as a heading, a short body
underneath, and a colour they can set so the card carries meaning at a glance
when they zoom out. The moment of use is "this one idea matters, give it a frame
and a colour and let me drop it next to the work it belongs to." It is the
in-place equivalent of the Notion callout block or the index card you tack to a
board, except it lives on the same infinite surface as everything else.

## Current state

Implemented in `src/renderer/src/components/widgets/CardWidget.tsx`. The card is
a single JSON object persisted in the widget's `content` field with three keys,
`title`, `body`, and `accent`. The component parses that JSON on mount, falls
back to treating legacy plain text as the body, and debounces saves at 300ms
through `useWidgetStore.update`. It renders a coloured accent bar across the top,
an editable title input, a multi-line body textarea, and a hover-revealed swatch
picker offering seven preset accent colours. It honours dark mode and supports
an `inline` render path used by previews and focus mode.

What genuinely works today is solid for the tier. The card round-trips through
the share and live-sync pipeline, and there is an explicit effect that adopts
content pushed in from a synced sibling so a linked copy updates without a
remount. It has a catalog entry in `widgetCatalog.ts` (Notes category, default
300x200), a display name in `widgetDisplayName.ts`, a canvas case in
`Canvas.tsx`, a preview in `WidgetPreview.tsx`, and a focus-mode case in
`WidgetFocusMode.tsx`. The AI layer can read and write it. `widgetSummary.ts`
flattens the card to "title\nbody" so an agent sees its meaning, and
`widgetContentFormat.ts` maps free text into the card shape by taking the first
non-empty line as the title and the rest as the body, which means an AI proposal
or a paste can populate a card sensibly. Being a first-class widget, it is
resizable, wireable, and shareable for free.

The honest weaknesses. The body is a plain textarea, so there is no rich text,
no bold or links or lists, no markdown rendering. There is no image, icon, or
emoji on the card, which is the first thing people expect from a Milanote or
Notion callout card. The accent is a fixed palette of seven swatches with no
custom colour and no full background fill, only the top bar is coloured. There
is no icon or label to give the card a type or category. There is no AI affordance
on the card itself, populating it depends on the global command bar rather than a
local "rewrite" or "summarise" action. The card cannot pull its title or body
from a wire, so it is a static callout rather than a live one. None of these
block the tier, but they are the visible ceiling.

## Best-of-breed landscape

Notion's callout block is the closest analogue to what our card is for. It sits
inside a document, carries an icon or emoji, a coloured background fill, and full
rich text including links, lists, and nested blocks. It is the reference for "a
single framed idea with personality", and next to it our flat title-plus-body
with a thin top bar reads as the stripped-down version.

Miro Cards are the canvas-native competitor. A Miro card carries a title, a rich
text description, custom structured fields that appear consistently on every
card, a checklist, attachments and links, an assignee, a due date, and tags, and
it can be converted into a Jira issue. That is far more than a callout, it is a
work item, and it is the bar for "card as a unit of work on a board."

FigJam stickies and Milanote cards own the lightweight visual end. FigJam lets
you recolour many stickies at once, attach author names, link cards with
connectors, and run AI to sort and summarise a wall of them. Milanote treats a
card as a drag-and-drop scrap that can hold an image, a link preview, or a note,
and the whole point is the visual collage. Both beat us on images and on bulk
visual operations.

Trello is the card archetype most people picture. A Trello card has a cover
image, labels, checklists, due dates, members, attachments, and a description,
and Trello AI now drafts descriptions and extracts due dates and priorities from
typed text. It defines the expectation that a card is clickable into a detail
view with structured metadata.

What we already do better or uniquely could. Our card is one object on an
infinite canvas sitting next to the live browser tab, the timer, the notes, and
the table for the same piece of work, not a row trapped inside one app's board.
An AI can create and rewrite it in place from a sentence through the existing
proposal pipeline, it can be wired to other widgets and to desk agents, it can be
live-synced as a linked copy across desks, and every byte stays on the user's
machine. No incumbent combines canvas placement, in-place AI, widget wiring, and
local-first privacy on a single card.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. No rich text or links in the body (Notion callout, Trello, Miro). "Paste a
   link and a bolded key phrase into the card." Today the body is plain text, so
   the link is dead and the emphasis is lost. This is the most common thing a
   user tries on a card and the most visible miss.
2. No icon, emoji, or image (Notion callout, Milanote, Trello cover). "Give this
   card a lightning bolt so it reads as a warning at a glance." Today the only
   visual signal is the accent bar colour, which is weak when zoomed out.
3. No full background fill, only a thin top bar (Notion callout, FigJam). "Make
   the whole card amber so it stands out across the canvas." Today the colour is
   a 6px stripe, easy to miss at canvas zoom.
4. No local AI action on the card itself (Trello AI, FigJam AI). "Summarise this
   into a one-line callout" or "tidy this up" from a button on the card. Today
   the only path is the global command bar, which loses the local intent.
5. No live body from a wire (unique opportunity, nobody does it). "Wire the
   agent's latest result into this card so it always shows the current status."
   Today the card is static, which wastes our wiring advantage.
6. No structured fields or detail expand (Miro Cards, Trello). "Click the card,
   see a due date and a tag." This is out of scope for the tier and arguably
   belongs to the table widget, but it is why a Miro user sees ours as lighter.

## The supersonic plan

### Launch-blocking (must ship to clear "Sufficient")
- Rich body with links and basic formatting. Render the body as lightweight
  markdown or a minimal rich text editor so bold, italic, lists, and clickable
  links work. Acceptance: a user pastes a URL and a bolded phrase into the body
  and both render and the link opens, matching the Notion callout baseline.
- Full background fill option alongside the accent bar. Let the chosen colour
  optionally tint the whole card, not just the top stripe, with a readable text
  contrast. Acceptance: a card set to amber is unmistakable at 40 percent canvas
  zoom, beating FigJam's single-tone sticky for legibility in a mixed canvas.
- An emoji or icon slot on the title row. A single optional icon picked from a
  small set or the system emoji picker, shown left of the title. Acceptance: a
  user adds a warning icon and the card reads as a warning at a glance, reaching
  Notion callout parity for the "type at a glance" job.

### Launch-polish
- A local AI action on the card. A hover button that offers rewrite, summarise,
  and expand on the body through the existing proposal pipeline, scoped to this
  card. Acceptance: a user clicks summarise and the body collapses to one tight
  line without opening the global command bar, matching Trello AI's draft-in-place
  feel.
- Image support. Allow an image at the top of the card, pasted or dropped, with
  the body underneath. Acceptance: a user drops a screenshot onto a card and it
  shows as a cover above the title, reaching Milanote and Trello cover parity.
- Custom accent colour. A free colour input in addition to the seven presets.
  Acceptance: a user enters a brand hex and the card uses it.

### Post-launch (pull ahead)
- Live body from a wire. A wire from an agent or browser widget streams its
  latest output into the card body, with a small "live" indicator and the last
  update time. Acceptance: an agent's result lands in the card automatically and
  refreshes when the agent runs again, something no incumbent card can do because
  none sit on a wired canvas.
- Card-to-table promotion. A right-click action that turns a cluster of cards
  into rows of a table, lifting the canvas notes into structure. Acceptance: a
  user selects five cards and promotes them into a typed table without retyping.
- AI auto-grouping of cards. Select a wall of cards and let the AI cluster and
  recolour them by theme, the in-place answer to FigJam's sort-and-summarise.

## The unfair advantage

Only Haptyx can let a card live on the same surface as the live browser tab, the
timer, and the running agent for the same task, and only Haptyx can wire that
agent's output straight into the card body so a callout becomes a live readout
that refreshes itself, all while the text never leaves the machine. The
launch-blocking work simply earns parity with the Notion callout for the
everyday framed-idea job. The live-from-a-wire body and the card-to-table
promotion are where the card stops being a nicer sticky and becomes something no
incumbent card can be, because none of them sit on a wired, AI-native, local
canvas.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
- 2026-06-10, Shipped full-background fill (a soft accent-tint toggle in the colour popover) and an optional emoji icon on the title row. Rich body with links and basic formatting remains open from the launch-blocking tier.
- 2026-06-10, Launch-blocking tier complete. The card body now renders markdown-lite: inline **bold**, *italic*, "- " bullets, and links, both [text](url) and bare URLs, which render as clickable links that open in the user's browser. Clicking the body enters a raw textarea for editing and clicking away renders it again. The parsing lives in lib/inlineMarkdown.ts with unit coverage (tests/unit/inlineMarkdown.test.ts), including the acceptance of a pasted URL plus a bold phrase both rendering. With the earlier full-fill and icon work this clears the Sufficient tier for card.
