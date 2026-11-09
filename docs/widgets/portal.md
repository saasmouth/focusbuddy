# Portal, SME doc (master of destiny)

Tier: Sufficient. The portal does not need to win a category outright at launch.
It needs to do its one job, a trustworthy live window into another desk, cleanly
enough that nobody feels it is half-built, and it needs to carry its weight as the
quiet backbone of the control-room idea.

## The use case

Someone is running more than one thing at once and is tired of context-switching
to check on each. They have a desk per project, client, or area, and they want a
single overview desk that watches the others, a control room. They drop a portal,
point it at another task's desk, and now they can see at a glance what is on that
desk without leaving the one they are on. When something looks like it needs them,
they click and dive straight in. The second, quieter job is feeding agents. A
portal is also a live data source, so wiring portals into an agent or a rollup
lets one desk stand in for several when the AI reasons about the whole portfolio.
The moment of use is "I have several things in flight and I want one place that
keeps an eye on all of them, right here, without juggling tabs or windows."

## Current state

Rendered by `src/renderer/src/components/widgets/PortalWidget.tsx`, with the
miniature drawing in `src/renderer/src/components/DeskMiniature.tsx`, the
agent-facing aggregation in `src/main/ai/portalAggregate.ts`, and the agent input
wiring in `src/main/ai/agentInputs.ts`. The widget is registered in
`src/renderer/src/lib/widgetCatalog.ts` (kind `portal`, category Layout, default
420x300) and dispatched in `src/renderer/src/components/Canvas.tsx`.

What works today:

- Pick a target desk from a list of the other live tasks and the portal shows a
  scaled, content-aware miniature of that desk via `DeskMiniature`, which lays the
  target's top-level widgets out spatially and draws each as a real scaled
  `WidgetPreview` rather than a generic icon.
- The view refreshes on a slow loop and on window focus. The miniature reloads the
  target's widgets every four seconds and again whenever the window regains focus
  (`PortalWidget.tsx` lines 89 to 109), with a breathing "live" dot so it reads as
  a window, not a frozen snapshot.
- Click anywhere on the miniature, or the title, or the login button, to jump into
  the target desk via `setActive`. The diving-in path is the strong part.
- Control-room rollup. A portal with no target of its own but with other widgets
  wired into it switches to a Rollup mode that lists its inherited sources, and a
  wired-in portal contributes its whole desk. The aggregator in
  `portalAggregate.ts` walks this recursively with a depth cap of 3, a visited set
  keyed by both widget id and task id so portal-to-portal cycles terminate, and a
  9000-character budget, then hands the combined text to an agent through
  `agentInputs.ts`.
- It is a first-class canvas object, so it is resizable, wireable, and movable like
  any other widget.

Rough edges, honestly:

- The miniature is read-only and non-interactive. You cannot pan, zoom, or touch
  anything inside it. It is a thumbnail you click to enter, not a live pane you can
  work in. Miro's view-only embed lets you pan and zoom in place; we do not.
- The refresh is a four-second poll, not a real live feed. Changes on the target
  desk appear with up to four seconds of lag, and the poll runs on every mounted
  portal independently, so a control room with many portals does N polls every four
  seconds with no shared fetch or backoff.
- No status, no signal, no glanceable health. The portal shows what is on the desk
  but says nothing about whether that desk is on track, stalled, overdue, or needs
  attention. The whole point of a portfolio glance is "what needs me now," and we
  do not answer that yet.
- The rollup and the window are the same widget wearing two hats, and the seam
  shows. Whether you get a desk miniature or a text rollup list depends on whether
  a target is set and whether anything is wired in, which is implicit and easy to
  trip over.
- No alerts or notifications. Nothing pulls your eye to a portal when its target
  changes. You have to be looking at it.
- The picker is a flat list of task titles with no search, grouping, or recent
  ordering, which gets unwieldy once you have many tasks.
- Empty and error states are thin. A target that becomes empty or archived shows an
  "Empty desk" placeholder rather than telling you the desk is gone.

## Best-of-breed landscape

The portal's job, a live window into another workspace so you can watch several at
a glance and dive in, is split across a few different products, because nobody else
has the exact canvas-of-desks shape we have.

Notion owns the linked-and-synced-view ground. A linked database or a synced block
shows the same content live in another place, with each view carrying its own
filters, sorts, and layout, and edits propagating instantly in both directions.
Notion also has rich link previews that fetch live content from a pasted URL. The
lesson is that their mirror is editable in place and genuinely two-way, where ours
is a read-only thumbnail you click to leave.

Asana Portfolios and Monday own the portfolio-glance ground. Asana portfolios give
a bird's-eye view of every initiative with at-a-glance status showing what is on
track and what is at risk, and custom dashboards that roll up budget, time, and
task status. Monday goes further with real-time dashboards that combine data from
many boards and Portfolio Risk Insights that proactively flag scope creep, resource
conflicts, and timeline slippage before they bite. The lesson is that a portfolio
view is judged on "what needs me now," and both of them answer that with status and
risk, which our portal does not surface at all.

Trello owns the card-mirror ground. A mirrored card appears on several boards and
any edit reflects everywhere in real time, a true two-way live object rather than a
preview. The lesson is the same as Notion's, the incumbent's mirror is the live
thing itself, not a picture of it.

Miro owns the live-embed-on-a-canvas ground, which is the closest spatial neighbour
to us. You can embed another board or a single frame and the live embed lets the
viewer pan, zoom, and navigate inside the iframe, including a view-only mode with a
minimal distraction-free UI. The lesson is that their in-canvas window is
interactive where ours is a static thumbnail.

macOS Stage Manager and Mission Control own the OS-level live-glance ground.
Stage Manager keeps your other windows visible at the edge and they update live, so
you see what changed without switching, and Mission Control gives named spaces you
flick between. The lesson is that a live glance of several workspaces is a familiar,
loved interaction, and the bar for "feels live" is a real continuous update, not a
four-second poll.

What we already do better or uniquely could. None of these put a live window into
another full working surface, with notes and a browser tab and a timer and a table
all in their real spatial positions, onto the same infinite canvas as everything
else. None of them turn that window into an AI data source, so that wiring a portal
into an agent lets the AI reason about another whole desk, or several, through one
widget. And none of them keep every byte of it on the user's machine. The canvas
plus in-place AI plus widget wiring plus local-first combination is ours alone, and
the portal is the piece that makes a desk-of-desks control room possible at all.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. No status or risk signal (Asana, Monday). "I have eight portals in my control
   room and I want the two that need me to stand out." Today every portal looks the
   same regardless of whether its desk is thriving or stalled. This is the single
   biggest gap, because the portfolio glance is the portal's reason to exist and we
   answer the wrong half of it, showing what is there but not what needs attention.
2. Not interactive in place (Miro, Notion, Trello). "I can see the note on that
   desk but I want to read it or tick it without leaving this desk." Every incumbent
   mirror is either editable in place or at least pannable and zoomable. Ours is a
   thumbnail you must click through, which forces a full context switch for the
   smallest interaction.
3. Poll, not live (Stage Manager, Trello, Notion). "I just changed something on the
   other desk and the portal still shows the old state." A four-second poll per
   mounted portal feels laggy next to a true live mirror and scales badly in a busy
   control room.
4. No alerts when a watched desk changes (Monday, Asana). "Tell me when the client
   desk gets a new note, do not make me stare at it." A glance tool earns its keep
   by pulling your eye to what moved. Ours never does.
5. The two modes are confusing (everyone, by contrast). "Why did my portal turn
   into a list?" The window and the rollup are one widget with implicit
   mode-switching. A user expecting a desk view can get a text rollup with no clear
   explanation of why.
6. Thin picker and weak empty or error states (Notion link picker). "I have forty
   tasks and I am scrolling a flat list to find one, and when its desk is archived
   the portal just says empty." Selection and failure handling are both unpolished.

## The supersonic plan

### Launch-blocking (must ship to clear "Sufficient")

- Glanceable status badge on every portal. Derive a simple signal from the target
  desk, for example last-activity recency, an open timer, unchecked items, or an
  overdue date on a table, and show it as a coloured dot or chip with a one-line
  reason. Acceptance: in a control room of several portals, the desk that has not
  been touched in days and the desk with a running timer are visually distinct at a
  glance without clicking, which is the at-a-glance status promise we currently lose
  to Asana and Monday.
- Make the two modes explicit and legible. Give the portal a clear visual identity
  for window mode versus rollup mode, with a one-line header that states what you
  are looking at and why, and a deliberate control to switch rather than implicit
  behaviour driven by wiring. Acceptance: a first-time user always understands
  whether they are seeing a desk window or an aggregated feed, and never gets a
  rollup by surprise.
- Tighten the refresh into a shared, sensible loop. Replace the per-portal
  four-second poll with a single shared scheduler that refreshes visible portals,
  backs off when the window is unfocused, and refreshes immediately on focus and on
  known mutations to the target desk. Acceptance: a control room with ten portals
  does not fire ten independent timers, and a change made on a target desk shows up
  within about a second when its portal is visible, closing most of the gap to a
  true live feel.
- Honest empty, archived, and error states. Distinguish an empty desk, an archived
  or deleted target, and a load failure, each with a clear message and a path to fix
  it. Acceptance: pointing a portal at a desk that is later archived shows "this
  desk was archived" with a re-pick action, not a bare "Empty desk."

### Launch-polish

- Searchable, grouped, recency-ordered picker. Add a filter box and put recently
  visited tasks first. Acceptance: choosing a target among forty tasks takes one
  type-and-click, matching the ease of Notion's link picker.
- Light in-place interaction for read-friendly widgets. Let a portal pass through
  scroll for a note or a table preview so you can read more of it without diving in,
  while keeping editing behind the dive. Acceptance: you can read a long note on
  another desk from the portal without a full context switch, narrowing Miro's
  in-place-navigation lead.
- Pin a sub-region of the target. Let the portal frame a single section or widget
  of the target desk rather than the whole thing, like Miro embedding one frame.
  Acceptance: a portal can watch just the "Blockers" section of another desk and
  ignore the rest.
- Change pulse. When the target desk changes, briefly highlight the portal so the
  eye is drawn to it. Acceptance: a new note appearing on a watched desk makes its
  portal flash once, the first step toward the alerting Monday and Asana have.

### Post-launch (pull ahead)

- AI desk digest in the portal. Instead of, or alongside, the miniature, show a
  one-line AI summary of the target desk's current state, "timer running on draft,
  two blockers open, last touched 10 minutes ago," generated in place. No incumbent
  does this because none has our in-place AI sitting on the data. This is how the
  portal answers "what needs me now" better than a status chip ever could.
- True live wiring instead of polling. Push target-desk mutations to mounted
  portals over the existing store so the window updates the instant the source
  changes, matching Stage Manager and Trello on liveness while staying local.
- Agent-driven control room. Let a desk agent watch a set of portals and act,
  surfacing the overdue desk or drafting a nudge, using the aggregation in
  `portalAggregate.ts` that already feeds agents. This turns the control room from a
  passive glance into something that works for you, which is past where Monday's
  risk insights stop because it can also take the next action locally.
- Cross-window portals. Open a portal in its own always-on-top mini window so a
  control room can sit beside other apps, the Stage Manager edge-of-screen glance,
  but for desks.

## The unfair advantage

Only Haptyx can put a live window into another entire working surface, with the
notes and the browser tab and the timer and the table all in their real positions,
onto the same infinite canvas as the desk you are working on, and then let you wire
that window into an AI so the agent can reason about another whole desk, or a stack
of them, through a single widget. The mirror incumbents copy one record or one
board. The portfolio incumbents roll up status across projects but live in a
separate reporting plane, not on your working surface. We are the only one where the
glance, the dive-in, and the AI data source are the same object on the same canvas,
and where all of it stays on the user's machine. The plan above closes the status,
liveness, and interaction gaps; the canvas plus in-place AI plus local-first trio is
why a Haptyx control room, once at parity, is a different and better kind of thing
rather than a thinner clone of a dashboard.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
