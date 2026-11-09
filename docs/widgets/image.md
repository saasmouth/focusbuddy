# Image, SME doc (master of destiny)

Tier: Strong. A Strong widget does not have to redefine its category, but it does
have to feel finished and obvious in the one or two things people put an image on
a canvas to do, with no embarrassing dead ends.

## The use case

Someone is working on a task and an image belongs next to it. A screenshot of an
error they are debugging, a design reference for the thing they are building, a
chart someone pasted in chat, a photo of a whiteboard, a moodboard of three
inspiration shots. They do not want to open a separate viewer or a markup app and
lose the notes, the browser tab, and the timer that are already on the desk. They
want the picture pinned right here, big enough to read, croppable to the part
that matters, and ideally something they can scribble an arrow on and point at.
The moment of use is "I need to see this image while I work on this, and maybe
mark it up, without leaving my desk."

## Current state

Rendered by `src/renderer/src/components/widgets/ImageWidget.tsx`. The widget is
deliberately thin. It stores a single URL string in the widget's `content` field
(the standard SQLite-backed widget record, no separate asset table), and it has
two states. When `content` is empty it shows a one-field form that takes an image
URL and, on submit, sets `content` to the trimmed URL and `title` to the URL's
hostname (`hostnameOf` in the same file). Otherwise it shows the image with
`object-contain` and a small "edit" button in the corner to go back to the URL
form. That is the entire widget.

Where it shows up. The image kind is registered in `widgetCatalog.ts` with
`hideFromPicker: true`, so users do not add it from the widget picker directly.
It is created two ways. A right-click "Save image to canvas" on any image inside
a webview routes through `saveImageToCanvas` in `Canvas.tsx` (wired from
`src/main/index.ts`) and drops an image widget at its starting size with the source URL. And
`widgetContentFormat.ts` lets a wire or an agent deliver a URL into an image
widget, but only if the delivered text actually looks like a URL. It renders a
small preview in `WidgetPreview.tsx` and has an inline form in
`WidgetFocusMode.tsx`. For AI summaries it reports as `File/link: <url>`
(`widgetSummary.ts`), the same line the file widget uses.

Honest rough edges, and there are many because the widget is minimal.

- It is URL-only. There is no upload, no drag-and-drop of a local file, and no
  paste-an-image-from-the-clipboard. If the picture is on your machine or on your
  clipboard, this widget cannot take it. The heavier `FileWidget.tsx` does handle
  uploaded image files (with a real `fb_files` asset and intrinsic-size scaling),
  which means the product has two overlapping image paths and the better one is
  not the widget literally called Image.
- No editing of any kind. No crop, no rotate, no arrow, no box, no blur, no text
  callout. You cannot point at part of the image, which is most of why people
  annotate a screenshot in the first place.
- No zoom or pan inside the frame. You see the whole image scaled to fit, and to
  look closer you have to resize the whole widget on the canvas.
- A broken or expired URL fails silently to a blank stone box. There is no error
  state, no retry, no "this link no longer works" message, and no `alt` text
  (it is hardcoded empty).
- The hostname becomes the title, which is meaningless for a CDN URL like
  `i.imgur.com`. There is no caption field and no way to name the image.
- Nothing about the image is available to AI beyond the raw URL string. The
  desk agent cannot see what is in the picture, describe it, or extract text
  from it, even though the rest of the product leans heavily on in-place AI.

## Best-of-breed landscape

PureRef owns the reference-board job for artists and designers, the exact "pin
images next to my work and look at them" use case. It does non-destructive crop
with an aspect-lock gizmo, free pan and zoom across a whole board of images, text
notes, and as of the 2.1 release in early 2026 it added straight lines and shapes
to its drawing tools plus adjustable opacity for drawings and notes. It is the
bar for treating images as first-class objects you arrange and mark up.

CleanShot X owns macOS screenshot annotation, which is the other half of our use
case. Its markup set is deep: crop with aspect ratios, four arrow styles
including curved, rectangles and ellipses filled or outlined, a pixelation and
blur tool you drag and then resize, a spotlight, numbered step badges, and a
pencil with auto-smoothing. When a Mac user wants to draw an arrow on a
screenshot, this is what they reach for, and we currently offer none of it.

Apple Preview and Markup ship on every Mac and set the floor. Basic shapes, text,
a highlighter, and signatures are one keystroke away in any image, for free, with
no app to install. We have to clear at least this bar or the built-in tool is
strictly better than us for marking up a picture.

FigJam and Miro own images-on-a-shared-canvas for teams. You upload from the
toolbar, the image becomes a movable resizable object among sticky notes and
shapes, and everyone sees it live. Their strength is collaboration and the
surrounding toolset, not deep per-image editing.

tldraw and Excalidraw are the open-source canvases closest to our technical
shape. tldraw includes image cropping, paste interop with Excalidraw, and a line
of work on AI agents that read and modify canvas content and let a user sketch,
annotate, and mark up images alongside a chat. Excalidraw wins on instant
usability and a permissive MIT license. These two show that crop, paste, and
canvas-native AI markup are now table stakes for a credible infinite canvas.

What we already do better, or uniquely could. The image sits on the same infinite
desk as the live browser tab it came from, the notes about it, and the timer for
the task, so the picture lives in the context of the work rather than in a
separate viewer. The right-click "save image to canvas" path means an image you
find while browsing lands on the desk in one click. A desk agent could be wired
to the image to describe it, OCR it, or answer questions about it in place. And
nothing ever leaves the machine, which matters for screenshots of private work
in a way it does not for a cloud whiteboard. No incumbent has the canvas plus
in-place AI plus local-first combination.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. No upload or paste (CleanShot X, FigJam, Miro, tldraw, Excalidraw, and our
   own FileWidget). "I just took a screenshot, let me paste it here." Today
   impossible in the Image widget, which is the single most common way an image
   reaches a canvas. This is the biggest gap and it is embarrassing because the
   product already solves it in a different widget.
2. No crop (PureRef, CleanShot X, tldraw). "I only care about this corner of the
   screenshot." A user cannot trim the image to the part that matters without
   editing it in another app first.
3. No annotation (CleanShot X, PureRef, Apple Preview). "Let me draw an arrow at
   the bug." Pointing at part of an image is most of why people put a screenshot
   in front of a teammate or their future self, and we cannot do it at all,
   which means we lose even to the free Preview app.
4. No zoom or pan inside the frame (PureRef). "Let me look closer at this detail
   without resizing the whole widget." Reading fine print in a chart means
   blowing up the entire object on the canvas today.
5. No error or empty state (everyone). "This image link is dead and I have no
   idea why the box is blank." A failed URL gives a silent grey rectangle with
   no message and no retry.
6. No caption, no AI sight (tldraw, and our own in-place AI promise). "Name this
   reference" and "agent, what does this diagram say." The image is opaque to
   the rest of the product, just a URL string, which wastes our one structural
   advantage.

## The supersonic plan

### Launch-blocking (must ship to clear "Strong")

- Paste and drop a local image. Accept an image from the clipboard and from a
  file drop onto the widget or the canvas, store it as a real asset on the
  `fb_files` path the FileWidget already uses, and converge the two image paths
  so the Image widget is the better one rather than the thinner one. Acceptance:
  a user pastes a fresh screenshot and it appears in the widget with no URL
  typing, matching FigJam and CleanShot X for getting an image onto the surface,
  and matching our own FileWidget.
- Error and empty states. When a URL fails to load, show a clear "this image
  could not be loaded" message with the URL and a retry, and give every image a
  real `alt` value. Acceptance: a dead link never shows a silent grey box again,
  clearing the floor that even Apple Preview sets.
- Zoom and pan inside the frame. Scroll to zoom and drag to pan within the
  widget without resizing the canvas object, with a reset-to-fit control.
  Acceptance: a user reads fine print in a chart without resizing the widget,
  matching PureRef's basic image navigation.
- Caption field. A short editable caption under or over the image that also
  becomes the title and the AI summary line, instead of a meaningless hostname.
  Acceptance: an image titled "login error, prod" reads usefully in the canvas,
  the picker, and the agent summary.

### Launch-polish

- Non-destructive crop. A crop gizmo that trims what the widget shows without
  altering the stored asset, with an aspect lock. Acceptance: a user crops a
  screenshot to one panel and can undo back to the full image, matching
  PureRef's non-destructive crop and CleanShot X's aspect-ratio crop.
- Core annotation set. Arrow, rectangle, ellipse, freehand pen, a text callout,
  and a blur or pixelate region, drawn as an overlay stored with the widget so
  it stays editable. Acceptance: a user drags an arrow onto a screenshot and a
  blur over a password, reaching parity with Apple Preview and taking the first
  real step toward CleanShot X.
- Agent can see the image. Wire a desk agent to an image so it can describe it,
  OCR the text in it, or answer a question about it, using the model's vision
  capability in place. Acceptance: "agent, what error does this screenshot show"
  returns the text from the image, something no whiteboard incumbent does.

### Post-launch (pull ahead)

- AI markup. "Circle the anomaly in this chart" or "blur every email address in
  this screenshot" runs as an in-place command and draws the annotation for the
  user, combining our vision and our annotation layer in a way CleanShot X and
  PureRef cannot because they have no in-place AI.
- Wire-driven images. A wire from a browser or agent widget streams an image in,
  so a chart an agent generates or a screenshot a tool captures lands as an
  image widget automatically, using our unique canvas wiring.
- Moodboard grouping. Let several images snap into an aligned grid the way
  PureRef arranges a reference board, so a set of inspiration shots reads as one
  tidy board on the desk rather than scattered rectangles.

## The unfair advantage

Only Haptyx can put an image on the same surface as the live browser tab it came
from, the notes about it, and the timer for the task, then let a desk agent
actually see inside the picture and act on it in place. A teammate's screenshot
is not a dead rectangle here. It is something the agent can read, OCR, describe,
or mark up on command, all while every byte of a private screenshot stays on the
user's machine instead of uploading to a cloud whiteboard. CleanShot X can draw
the arrow but cannot reason about the image, PureRef can arrange the board but
has no AI, and FigJam and Miro have the AI ambition but not local-first privacy.
The plan above first clears the floor we currently sit below on upload, crop, and
annotation, and the vision-plus-canvas-plus-local-first trio is why, once at
parity, an image on a Haptyx desk is better in kind rather than a weaker copy of
a markup app.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
