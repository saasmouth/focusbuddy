# Diagram, SME doc (master of destiny)

Tier: Strong. This is not a widget people pick Haptyx for on its own, but when
someone reaches for it on the desk it has to feel competent and modern, not like
a toy, so it must hold its own against the free diagram tools its users already
know.

## The use case

Someone is thinking through structure and wants to see it as boxes and arrows
rather than prose: a flowchart for an onboarding flow, a quick system-design
sketch of services talking to a database, an org or entity hierarchy, a mind-map
branching out from one idea, or a Venn of two overlapping concerns. They are
already on their desk with the notes, the browser tabs, and the table for the
same piece of work, and they do not want to break flow by opening Lucidchart or
Excalidraw in another tab and then screenshotting it back. They want to drop a
few shapes, connect them, label them, and have the picture live next to the rest
of the thinking. The moment of use is "I can explain this faster with shapes than
with sentences, and I want the picture right here on the canvas, not in some
other app."

## Current state

Implemented in `src/renderer/src/components/widgets/DiagramWidget.tsx` as a
React Flow (`@xyflow/react`) node and edge canvas wrapped in its own
`ReactFlowProvider` so each diagram is an isolated flow instance. The kind is
registered in `src/shared/types.ts`, listed in
`src/renderer/src/lib/widgetCatalog.ts` (icon `schema`, default 740x520), and
gated to Pro and Team in `src/renderer/src/lib/capabilityDefaults.ts` and
`src/renderer/src/lib/gating.ts` under the `widget_diagram` capability. The whole
graph serialises to `widget.content` as a single JSON blob of `{ nodes, edges }`,
persisted debounced at 500ms and flushed on unmount.

What works today:
- Four node shapes from a toolbar. A box, a circle whose translucent fill is
  meant to read as a Venn when circles overlap, a transparent text label, and an
  uploaded image or icon node from a local file (capped at 1.5MB to keep the JSON
  sane).
- Connectors between nodes by dragging from the source handles on the right and
  bottom to target handles on the top and left, drawn with a closed arrowhead.
- Inline rename by double-clicking a node, committed back through a custom DOM
  event so the node component stays free of store wiring.
- A small palette of seven preset colours that apply to newly added nodes.
- Backspace and Delete remove the selected node or edge, fitView frames the graph
  on load, and the React Flow attribution is hidden.
- Lives as a first-class canvas object inside `WidgetFrame`, so it is resizable
  and movable like every other widget, and it has an inline mode for embedding.

Rough edges, honestly:
- There is no AI build path at all. The table widget has `lib/tableAiBuild.ts`
  that scaffolds a table from a sentence; the diagram has no equivalent, so you
  cannot say "draw the auth flow" and get nodes. Confirmed by the absence of any
  diagram builder in `src/renderer/src/lib/`.
- It is not wired into desk agents. `lib/widgetContentFormat.ts` explicitly lists
  `diagram` among the kinds whose typed config must never be clobbered by a
  delivery, which means an agent or a wire cannot push content into it and it
  cannot be a meaningful target on the canvas.
- The colour palette only applies to new nodes. You cannot recolour or restyle an
  existing node, change its shape, or resize it after creation.
- Edges are plain. No labels on connectors, no choice of line style or routing
  (straight versus orthogonal versus curved), no dashed or dotted, no arrowhead
  options, no bidirectional arrows.
- No automatic layout. Everything is placed by a small offset formula and then
  dragged by hand, so a ten-node flowchart is manual cleanup. There is no
  hierarchical or tree auto-arrange.
- No text or Mermaid import and no export. You cannot paste Mermaid or
  PlantUML-style syntax and get shapes, and you cannot export to PNG, SVG, or
  Mermaid to drop the picture into a README or a doc.
- No templates and no shape library beyond the four primitives. No swimlanes, no
  containers or groups, no UML or ERD or cloud-architecture stencils.
- The Venn story is thin. Overlapping translucent circles look right, but there
  is no real set-region labelling, so the overlap area cannot hold its own text.

## Best-of-breed landscape

Lucidchart owns the professional and enterprise end. It generates flowcharts,
UML, ERDs, and org charts from a text prompt, from pasted Excel or CSV, from code
snippets, or from a database schema, and it carries deep stencil libraries, smart
auto-layout, conditional formatting, and team collaboration. It is the tool a
serious diagram leaves Haptyx for, and the reason a bare box-and-arrow canvas
reads as a sketch pad until proven otherwise.

Excalidraw owns the fast, low-friction sketch. The hand-drawn look, zero account,
end-to-end encrypted collaboration, and a clean infinite canvas make it the thing
people open when they just want to think out loud in shapes. It is the closest
philosophical neighbour to our own quick-drop intent, and it is free.

tldraw owns the modern infinite-canvas-plus-AI frontier and is the most
instructive competitor for us. Its make-real feature turns a sketch into working
output, and its Mermaid package parses Mermaid text into native editable shapes,
arrows, and groups on the canvas, so you can paste a diagram as code and then move
the real shapes around. That is exactly the trick our in-place AI should be doing
and currently does not.

Mermaid owns documentation-embedded diagrams. It is text-to-diagram as a
standard, lives inside Markdown and READMEs and PR comments, and is the format AI
models already emit fluently. Any serious diagram widget in 2026 is measured on
whether it speaks Mermaid in and out.

draw.io and FigJam round out the field. draw.io is the free general-purpose
workhorse with huge stencil coverage and Mermaid import, and FigJam wins on
fluid, lightweight flows and mind-maps that sit next to design work. Miro is the
collaboration-first whiteboard with prompt-to-chart, relevant once we add
multiplayer.

What we already do better or uniquely could: the diagram is one object on an
infinite canvas next to the notes, the live browser tab, the table, and the timer
for the same task, so the picture and the work it explains share a surface. It is
local-first, so a private architecture sketch never leaves the machine, which
matters for anyone diagramming systems they cannot paste into a cloud tool. And
it sits inside a canvas that already has ghost-line wires and desk agents, which
means the path to AI-built and wire-fed diagrams is shorter for us than bolting
collaboration onto a single-purpose tool would be for the incumbents.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **No AI build (Lucidchart, tldraw).** "Draw the login flow: user, auth
   service, database, with a retry branch." Today you place and connect every
   node by hand. This is the single biggest gap, because in-place AI is the whole
   Haptyx premise and the table widget already proves we can do it for one widget
   but not this one.
2. **No Mermaid in or out (tldraw, draw.io, Mermaid).** "I have the flow as
   Mermaid in my notes, paste it and make it shapes," and the reverse, "export
   this to Mermaid for the README." Without this we are an island that cannot
   trade diagrams with the documentation world AI already lives in.
3. **No auto-layout (Lucidchart, draw.io).** "I added eight nodes, now untangle
   them." A flowchart past five nodes becomes manual cleanup, which kills the
   speed advantage the widget is supposed to have.
4. **Cannot edit a node after creation (everyone).** "This box should be a
   circle, and red, and bigger." Shape, colour, and size are fixed at creation,
   so a wrong choice means delete and redo.
5. **Plain, unconfigurable edges (Lucidchart, draw.io).** "Label this arrow
   'on failure' and make it dashed." Connectors carry no label and no style, so
   the diagram cannot express the conditions that make a flowchart a flowchart.
6. **No export to image (Excalidraw, everyone).** "Drop this picture into the
   doc I am writing." You cannot get a PNG or SVG out, so the diagram is trapped
   on the desk.
7. **No templates or stencils (Lucidchart, draw.io, EdrawMax).** "Start me from
   an org chart" or "give me AWS icons." Four primitives is a blank page every
   time.

## The supersonic plan

### Launch-blocking (must ship to clear "Strong")
- **Edit an existing node.** Select a node and change its shape, colour, and
  label from a small inspector, and let it resize by drag. Acceptance: a user can
  turn a blue box into a red circle and resize it without deleting and recreating
  it, which is table stakes that every competitor meets and we currently fail.
- **Edge labels and basic edge styles.** A connector can carry a short label and
  can be set straight, curved, or orthogonal, solid or dashed. Acceptance: a
  two-branch flowchart shows "yes" and "no" on its arrows, matching the minimum
  draw.io and Lucidchart bar for a real flowchart.
- **Auto-layout button.** One click runs a hierarchical or tree layout (dagre or
  elk) over the current nodes and edges. Acceptance: an eight-node flow that was
  dragged in by hand becomes readable top-to-bottom in one click, closing the
  speed gap with Lucidchart and draw.io for the common case.

### Launch-polish
- **AI build from a sentence.** A `lib/diagramAiBuild.ts` that mirrors
  `tableAiBuild.ts`: describe a flow or hierarchy in the command bar and it emits
  nodes and edges, then runs auto-layout. Acceptance: "draw the onboarding flow
  with a verification step" produces a labelled, laid-out diagram with no manual
  placement, which is the Lucidchart and tldraw headline and the proof that the
  Haptyx in-place-AI promise extends past the table.
- **Mermaid import and export.** Paste Mermaid syntax to create real editable
  nodes and edges, and export the current graph back to Mermaid. Acceptance: a
  Mermaid flowchart pasted from notes becomes movable shapes, and the same
  diagram round-trips back out as Mermaid, matching tldraw's Mermaid package and
  draw.io's import.
- **Image export.** Export the graph to PNG and SVG. Acceptance: a user drops the
  diagram into an external doc as an image, closing the basic export gap with
  every competitor.
- **A small template gallery.** Flowchart, org chart, mind-map, and system-design
  starters, plus a Venn with labelled overlap regions. Acceptance: a new diagram
  can start from a template instead of a blank canvas, matching the draw.io and
  Lucidchart starting experience for the handful of shapes people actually draw.

### Post-launch (pull ahead)
- **Wire-fed diagrams.** Remove `diagram` from the do-not-clobber list in
  `widgetContentFormat.ts` for an explicit diagram-delivery path, so a wire from
  an agent or a table can add or update nodes. Acceptance: a desk agent that maps
  a system can stream nodes and edges into a diagram on the canvas, something no
  incumbent can do because they have no canvas wiring.
- **AI edit in place.** "Add a caching layer between the service and the
  database" mutates the existing graph rather than redrawing it. Acceptance: an
  existing diagram gains a correctly placed and connected node from one sentence,
  the in-place equivalent of tldraw's annotate-and-make-real loop.
- **Live diagram from a table or notes.** A diagram that re-derives itself from a
  linked table of nodes and edges, so editing the data updates the picture.
  Acceptance: changing a row in a linked table moves or relabels a node, using
  our unique on-canvas wiring.
- **Stencil libraries.** UML, ERD, and cloud-architecture icon sets for the
  technical-design crowd, the ground Lucidchart and EdrawMax hold.

## The unfair advantage

Only Haptyx can put the diagram on the same surface as the notes it explains, the
table it summarises, and the live browser tab it was researched from, then let an
agent or a wire build and update it in place from the work already on the desk,
while every byte stays on the machine. The incumbents are single-purpose tools
that have to bolt on collaboration and AI from the outside; we already have the
canvas, the ghost-line wires, and the desk agents, so an AI-built, wire-fed
diagram that re-derives from a linked table is a natural extension of the surface
rather than a feature graft. The local-first stance is the second edge: a private
system-architecture sketch that never leaves the machine is something a cloud
diagram tool structurally cannot offer.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
