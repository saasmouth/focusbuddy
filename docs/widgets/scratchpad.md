# Scratchpad, SME doc (master of destiny)

Tier: Strong. This is not a widget people pick Haptyx for, but when they reach for
it the experience has to feel native and uncramped, good enough that nobody wishes
they had opened a real sketch app instead.

## The use case

Someone is mid-task on the canvas and a thought is spatial, not verbal. They want
to sketch the box-and-arrow shape of an idea, mark up a screenshot, circle the bit
of a plan that matters, or just doodle while they think on a call. They don't want
to leave the desk, find Excalidraw in another tab, and lose the notes and timer and
browser already arranged around the work. They want a pressure-sensitive ink
surface sitting right there, that persists like everything else, that they can wire
and place next to the thing they're annotating. The moment of use is "this is
easier to draw than to describe, give me a pad right here."

## Current state

Implemented entirely in the renderer at
`src/renderer/src/components/widgets/ScratchpadWidget.tsx`. It is a freeform ink
surface built on `perfect-freehand` (a small MIT library that turns raw
`[x, y, pressure]` points into a smooth, pressure-tapered outline). Strokes are
rendered as SVG paths and the whole sketch serialises to `widget.content` as JSON,
so it persists like any other widget. The catalog entry lives in
`src/renderer/src/lib/widgetCatalog.ts` (kind `scratchpad`, category Tools, default
620x420), the kind is declared in `src/shared/types.ts`, and it is free on every
plan per `src/renderer/src/lib/capabilityDefaults.ts` and
`src/renderer/src/lib/gating.ts`.

What works today:
- Pressure-sensitive pen with `perfect-freehand` tapering, seven preset colours,
  and three brush sizes, all in a compact toolbar.
- A proximity eraser that drops any stroke passing within roughly 14px of the
  cursor, plus a clear-all button.
- Correct coordinate mapping under canvas zoom: `toLocal` divides the rendered rect
  by the intrinsic element size so ink lands under the cursor at any zoom level.
- Persistence that is careful about lifecycle. It re-seeds when a different widget
  instance mounts, only writes when the JSON actually changed, and flushes on
  unmount so an in-progress sketch is not lost on a layout remount.
- The active-widget gate so the first click selects and subsequent strokes draw,
  matching the rest of the app, with an always-interactive path in focus/inline
  mode.

Rough edges (honest):
- There is no undo or redo. The only way back from a wrong stroke is the eraser or
  clear-all, which is the single most painful gap for a drawing tool.
- The eraser deletes whole strokes by proximity. There is no pixel eraser and no
  way to erase part of a long line.
- It is ink only. No shapes, no arrows, no text, no straight-line tool, no fill,
  so it cannot make the box-and-arrow diagrams people actually reach for.
- No image import, so you cannot drop a screenshot and annotate it, which is one of
  the most common reasons to open a sketch surface.
- The AI cannot see or touch it. `src/renderer/src/lib/widgetContentFormat.ts`
  explicitly lists `scratchpad` among the kinds whose typed content must never be
  overwritten by an AI text delivery, and ink is opaque to the model, so there is
  no text-to-sketch and no "describe this drawing" path.
- It is not a wire source or target in any meaningful way. Nothing reads its
  strokes, so it cannot feed a diagram, an agent, or a note.
- No selection, move, scale, or rotate of existing strokes, no layers, no
  per-stroke editing after the fact.
- No pan or internal zoom inside the pad, so the drawable area is fixed to the
  widget rectangle. The canvas is infinite but the pad is not.
- Export is only whatever the widget-snapshot/share path captures. There is no
  dedicated PNG or SVG export of the sketch itself.

## Best-of-breed landscape

**Excalidraw** owns the hand-drawn whiteboard category. It gives shapes, arrows,
text, freedraw, a large library, multi-element selection and editing, PNG and SVG
export, real-time end-to-end-encrypted collaboration, and an AI text-to-diagram
feature that turns a prompt into editable sketch elements. It is the thing people
mean when they say "I'll just sketch it," and it is the bar a casual user
unconsciously holds our pad against.

**tldraw** is the polished, fast infinite-canvas tool and SDK, the same minimal
spirit as Excalidraw with a stronger design-tool feel. Its "Make Real" feature
takes a drawn wireframe and uses a vision model to turn it into working HTML and
CSS, and the SDK exposes the canvas programmatically so AI agents can read and
write shapes. tldraw is the clearest example of ink that an AI can actually
understand and act on, which is exactly the path our pad cannot take today.

**Apple Freeform** is the zero-cost, beautifully polished Apple-native option, with
Apple Pencil pressure, fill, shapes, sticky notes, and tight ecosystem
integration. On a Mac, which is our primary platform, it is the free sketch app
sitting one click away, so it is our most direct "why not just use that" rival.

**Concepts** is the deep, flexible vector-sketch app for people who actually draw,
with infinite canvas, precise vector ink, layers, and serious brush and tool
control. It owns the high end that we make no attempt to reach, and it is the
reference for what real per-stroke editing and layering feel like.

**Microsoft Whiteboard** owns the meeting and team-ideation surface, with a large
shape and template library, ink-to-shape and ink-to-text conversion, pressure
pens, and collaboration baked into the Microsoft stack. Its ink-to-shape cleanup is
the specific feature a rough sketcher most wishes we had.

What we already do better or uniquely could: the pad is one object on an infinite
canvas, sitting next to the notes, the live browser tab, and the timer for the same
piece of work, with no tab switch and no account. The ink persists locally and
never leaves the machine, which none of the cloud whiteboards can claim. And it is
the only sketch surface that lives inside a system with ghost-line wires and desk
agents, which is a path to in-place AI on ink that the standalone tools reach only
by bolting on a separate feature.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **No undo/redo (everyone, baseline).** "I drew one bad stroke and I want it
   back the way it was." Every sketch tool has this. Its absence makes the pad feel
   broken the first time someone fumbles a line, and it is the fastest credibility
   loss we have.
2. **No shapes, arrows, or text (Excalidraw, Apple Freeform, Microsoft
   Whiteboard).** "I want a labelled box-and-arrow diagram, not a doodle." This is
   the single most common reason people open a sketch app, and pure freehand cannot
   serve it cleanly.
3. **No image import / annotate (Excalidraw, Freeform).** "Drop this screenshot and
   let me circle the broken button." Annotating an image is a top reason to reach
   for a pad, and we cannot do it at all.
4. **Ink is invisible to the AI (tldraw, Excalidraw).** "Describe what I sketched"
   or "turn this rough wireframe into a diagram." tldraw's Make Real and
   Excalidraw's text-to-diagram both cross this line. We list scratchpad as
   AI-opaque on purpose, so we cross it in neither direction.
5. **Whole-stroke eraser only, no per-stroke editing (Concepts, Freeform).** "Erase
   just this corner" or "move that shape I drew." Today a stroke is immutable once
   placed except by deleting it entirely.
6. **No dedicated export (Excalidraw, tldraw).** "Send this sketch to someone as a
   PNG." We rely on the generic snapshot path and offer no first-class PNG or SVG
   of the ink.
7. **Fixed drawable area, no pan/zoom inside the pad (Concepts, Freeform).** "I
   filled the pad and need more room." The pad cannot grow with the drawing the way
   a real infinite-canvas sketch surface does.

## The supersonic plan

### Launch-blocking (must ship to clear "Strong")
- **Undo and redo.** A bounded stroke-history stack with keyboard shortcuts while
  the pad is active, surviving the persist cycle. Acceptance: drawing then pressing
  undo restores the exact prior state and redo reapplies it, and we match the
  baseline every named competitor already meets.
- **Image drop and annotate.** Accept an image dropped onto the pad, render it as a
  background layer under the ink, and persist it inside `widget.content`.
  Acceptance: a user drops a screenshot, circles part of it in red, reloads, and
  both the image and the ink are intact, so we beat "open another app to mark up a
  screenshot."
- **Straight-line and arrow tool, plus a basic rectangle and ellipse.** A modifier
  or tool toggle that constrains a stroke to a straight segment or a simple shape.
  Acceptance: a user draws a clean box-and-arrow with three connectors without it
  looking like a wobble, closing the most common gap against Freeform and
  Excalidraw for quick diagrams.

### Launch-polish
- **Text labels on the pad.** A click-to-place text element so a diagram can be
  named, persisted alongside strokes. Acceptance: a boxes-and-arrows sketch carries
  readable labels and survives reload, reaching casual parity with Excalidraw and
  Freeform for a labelled diagram.
- **PNG and SVG export.** A toolbar action that renders the current ink (and any
  image layer) to a downloadable PNG and SVG. Acceptance: the exported PNG matches
  what is on the pad pixel for pixel and opens cleanly elsewhere, matching
  Excalidraw and tldraw on getting a sketch out.
- **Per-stroke selection and delete.** Click a stroke to select it, then move or
  delete it, as a step beyond proximity-erase. Acceptance: a user repositions one
  arrow without redrawing the rest, narrowing the gap to Concepts and Freeform on
  editing what is already drawn.
- **Pinch/scroll zoom and pan inside the pad** so the drawable surface is no longer
  capped at the widget rectangle. Acceptance: a user keeps drawing past the visible
  edge and pans back to earlier work, removing the fixed-area limitation.

### Post-launch (pull ahead)
- **AI reads the ink.** Rasterise the pad and let a desk agent or the command bar
  describe it, extract the text in it, or turn a rough wireframe into a real
  diagram widget, which means lifting scratchpad out of the AI-opaque list in
  `widgetContentFormat.ts` for a read path. Acceptance: "what did I draw here"
  returns an accurate description and "make this real" emits a structured diagram,
  matching tldraw Make Real and Excalidraw text-to-diagram on our own canvas.
- **AI writes the ink.** A text-to-sketch path where a prompt generates editable
  strokes or shapes on the pad in place. Acceptance: "sketch a three-box pipeline"
  draws it, something no local-first sketch app on a Mac offers.
- **Wire the pad to other widgets.** A ghost-line wire from the pad delivers its
  export or its AI-extracted content into a note, a diagram, or an agent, and a
  wire into the pad drops an upstream image onto it to annotate. Acceptance: a wire
  from a browser screenshot lands on the pad ready to mark up, using our unique
  canvas wiring that no standalone tool has.
- **Ink-to-shape cleanup.** Recognise a rough drawn rectangle, circle, or arrow and
  snap it to a clean one, the feature that makes Microsoft Whiteboard feel tidy.

## The unfair advantage

Only Haptyx can put a pressure-sensitive ink pad on the same surface as the live
browser tab, the voice note, and the timer for the same piece of work, with the ink
kept entirely on the user's machine. The two moves nobody else can match are wiring
and in-place agents. A ghost-line wire can carry a screenshot from a browser widget
straight onto the pad to annotate, then carry the marked-up result onward to a note
or an agent, all without leaving the canvas or touching the network. And a desk
agent can read the ink in place and turn a rough wireframe into a real diagram
widget next to it, the Make Real idea, but native to the desk and local-first
rather than a separate site. The plan above first earns the baseline that makes the
pad trustworthy, then the wiring and the in-place AI are what make ours better in
kind rather than a thinner clone.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
