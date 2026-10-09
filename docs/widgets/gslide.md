# Slides, SME doc (master of destiny)

Tier: Sufficient. This widget only needs to do its one embed job cleanly and not
embarrass us next to a real deck tool. It does not have to beat best of breed to
ship, but it does have to stop pretending to be a first-class Slides feature when
it is really a browser tab pointed at Google.

## The use case

Someone is doing focused work and there is a deck in the picture. A pitch they are
rehearsing, a lecture they are following along with, a client presentation they
keep glancing at while they write the follow-up email, a course module that is
delivered as slides. They do not want the deck to own a whole monitor or a whole
browser window. They want it sitting on the canvas next to the notes they are
taking, the timer counting down their rehearsal, and the task it belongs to, so
the deck is context rather than a destination. The moment of use is "this
presentation is part of what I am working on right now, keep it in view here
without making me leave the desk to look at it."

## Current state

There is no Slides-specific component. The `gslide` kind is declared in
`src/renderer/src/shared/types.ts` (line 20) and given a catalog entry in
`src/renderer/src/lib/widgetCatalog.ts` (lines 194 to 206) with the label
"Slides", a slideshow icon, and a `urlPlaceholder` of
`https://docs.google.com/presentation/…`. That entry is marked
`hideFromPicker: true`. Canvas routing in
`src/renderer/src/components/Canvas.tsx` lists `gslide` in `WEB_KINDS` (line 123)
and the render switch sends it, alongside `gdoc`, `gsheet`, `pdf`, and `email`,
straight to `WebViewWidget` (lines 182 to 186). So a Slides widget is an Electron
`<webview>` element pointed at whatever URL is in `widget.content`, with the same
browser chrome every web widget gets.

What works today, all of it inherited from `WebViewWidget.tsx` rather than written
for slides:

- It loads a Google Slides URL in a real embedded browser, so the deck is live and
  current, not a screenshot. Edit mode, present mode, anything the Google URL
  supports works because it is genuinely Google's page.
- It carries the full browser toolbar: back, forward, reload or stop, an editable
  URL bar, and the window-size presets. It persists the live URL back to
  `widget.content` as you navigate (`persistNavUrl`), so reopening the widget
  returns you to the slide you were on rather than slide one.
- It is a first-class canvas object. It resizes, it wires to other widgets and to
  desk agents, it can be pinned to a Connected App so it shares a session and
  auto-fills credentials from the vault, and it can be dived into at 100 percent
  with a command-click.

Rough edges, and they are the honest centre of this doc:

- The catalog comment at `widgetCatalog.ts` lines 147 to 154 says the quiet part
  out loud. `gslide` was folded into the File widget because it was "redundant
  with the File widget". It is hidden from the picker and there is no path that
  auto-creates a `gslide` widget from a pasted presentation URL, so a user can no
  longer make one through normal flows. The kind survives only so existing widgets
  keep rendering. In practice the Slides widget is a legacy alias for a browser
  tab.
- There is no embed-URL handling. We load the raw URL the user pasted. We never
  rewrite a `/edit` link to the `/embed` or `/present` form, so the embedded view
  shows Google's full editor chrome inside our chrome, which is cramped and busy,
  instead of a clean slide surface.
- Nothing about the widget knows it is a deck. There is no slide thumbnail rail,
  no current-slide indicator, no next or previous slide control, no presenter
  notes, no way to drive a rehearsal. It cannot tell you the deck has twelve
  slides or which one is showing.
- The AI on the canvas cannot touch it. There is no slide content extraction, so a
  desk agent cannot read the deck, summarise it, or pull talking points. Compare
  the Table widget, which an agent can read and rewrite. Slides is opaque.
- It depends entirely on Google being reachable and the user being signed in. It
  is not local-first in any meaningful sense, which sits awkwardly against the
  rest of Plexii. A `.pptx` or `.key` file on disk has no home here at all.

## Best-of-breed landscape

Google Slides is the thing we are literally embedding, so it sets the floor. It
owns real-time multi-author editing, a deep template and theme system, speaker
notes, a present mode with a presenter view, and the share-by-link collaboration
that makes it the default for teams on a budget. Everything it does, it does
better than us, because inside our widget it is just itself with our chrome
wrapped around it.

Microsoft PowerPoint owns the enterprise and the offline file. It is the format
people actually hand each other as `.pptx`, it has the richest animation and
transition engine, and Copilot now drafts and restyles decks inside it, though
that is a paid add-on on top of Microsoft 365. The bar it sets for us is the
offline, file-on-disk deck we do not handle at all.

Canva owns visual design and templates. It has the broadest template and asset
library of any of these tools, and its conversational AI assistant will redesign a
slide, change the presentation style, or add a background on request. For anyone
who cares how the deck looks more than what it says, Canva is the comparison.

Pitch owns startup and team collaboration decks, with strong generative content
plus design and a workflow built around a team shipping a deck together. Gamma is
the AI-native leader. It generates a polished deck from a prompt in under a minute,
its decks live at a URL with viewer analytics that tell you who looked and for how
long, and its agent researches the web and restyles whole decks in conversation.
Beautiful.ai and Tome round out the AI design tier. Beautiful.ai's Smart Slides
re-flow layouts automatically to stay professional as you edit, and Tome is
narrative-first and can embed live interactive content from Figma and Miro into a
deck.

What we already do better, or uniquely could. None of these put the deck on an
infinite canvas beside the notes, the timer, and the task it belongs to. None let
you wire the deck to other widgets or to a desk agent. None keep a working surface
private and local by default. The deck-as-context job, where the presentation is
one object among many for the work in front of you rather than the whole screen,
is ours to own. Owning it well is mostly a matter of stopping the pretence that we
are a deck editor and leaning into being the best place to keep a deck in view
while you work.

## Gap analysis (ranked, each tied to a competitor + a user moment)

1. **The widget is unreachable and undeclared as a deck (Google Slides, all).**
   "I pasted my Google Slides link and got a generic browser tab, and I cannot
   even find a Slides option in the picker." The kind is hidden and never
   auto-created, so the headline gap is that the Slides widget barely exists as a
   distinct thing today. This is the launch-blocking gap.
2. **No clean embed view (Google Slides, Canva, Gamma).** "My deck is buried
   inside Google's editor chrome inside your chrome, so I am looking at toolbars,
   not slides." We never rewrite the URL to the embed or present form, so the deck
   never gets a clean surface.
3. **No deck awareness: thumbnails, current slide, next and previous (PowerPoint,
   Google Slides present mode).** "I am rehearsing and I want to step through
   slides and see where I am, not hunt inside an iframe." We treat the deck as an
   opaque page.
4. **The AI cannot read the deck (Gamma, Beautiful.ai, Tome, and our own Table
   widget).** "Summarise this deck into my notes" or "pull three talking points"
   is impossible because we extract nothing from the slides.
5. **No offline or local deck (PowerPoint, Keynote).** "My deck is a `.pptx` on my
   laptop and there is nowhere to put it here." Against our own local-first stance
   this is a real hole, though a lower priority than making the embed work.

## The supersonic plan

### Launch-blocking (must ship to clear "Sufficient")

- **Make the Slides widget real and reachable again.** Either un-hide it in the
  picker, or add presentation-URL detection so pasting a
  `docs.google.com/presentation/...` link into the File or paste flow creates a
  `gslide` widget rather than a generic web tab. Acceptance: a user who pastes a
  Google Slides link gets a widget labelled Slides, and a user browsing the picker
  can find Slides without knowing the legacy kind exists. We now beat our own
  current state, where the widget is effectively hidden.
- **Clean embed transform.** Before load, rewrite a Slides `/edit` URL to the
  `/embed?start=false&loop=false&delayms=...` form, falling back to the raw URL if
  the pattern does not match. Acceptance: a pasted edit link renders as a clean
  slide surface with Google's editor chrome gone, so the deck looks like a deck and
  not like a browser inside a browser. We now match Google Slides' own embed
  presentation for the read-only case.

### Launch-polish

- **Deck navigation chrome.** A thin footer with previous, next, and a slide
  counter that drives the embedded deck via its slide anchor, plus a present
  button that opens the `/present` URL full-bleed inside the widget. Acceptance: a
  user rehearsing can step through slides and see "4 of 12" without touching
  Google's UI, approaching PowerPoint and Google present mode for the step-through
  case.
- **Thumbnail rail.** A scrollable strip of slide thumbnails down one side, each a
  jump target. Acceptance: the user can see the shape of the whole deck and jump to
  any slide, which the bare iframe cannot do.
- **Timer wiring for rehearsal.** Let a Timer widget wire to a Slides widget so a
  rehearsal timer and the deck live as one rig on the canvas, with the timer able
  to mark slide transitions. Acceptance: a user wires a five-minute timer to a deck
  and rehearses against it, a rig no deck tool offers because none of them live on
  a canvas with a timer.

### Post-launch (pull ahead)

- **Deck extraction for the AI.** Pull slide titles and body text out of the
  embedded deck, by Google Slides API where the user is signed in or by reading the
  rendered DOM, so a desk agent can summarise the deck into a note or pull talking
  points. Acceptance: "summarise this deck into my notes" produces a real summary,
  matching what Gamma's and Beautiful.ai's agents do, but in place on our canvas.
- **Local deck support.** Render a dropped `.pptx` or `.pdf` export of a deck from
  disk, so a deck that never went to Google still has a home and stays local.
  Acceptance: a user drags a `.pptx` onto the canvas and sees the slides, taking a
  slice of the PowerPoint and Keynote offline ground while honouring local-first.
- **AI deck draft from a note.** Wire a Note or Markdown widget into a Slides
  widget and generate a first-draft Google Slides deck from its outline. Acceptance:
  an outline note becomes a draft deck on the canvas, the Gamma move, but seeded
  from work the user already has on their desk.

## The unfair advantage

Only Haptyx can keep a live deck as one object among the notes, the timer, and the
task it belongs to on an infinite canvas, wire that deck to the other widgets so a
rehearsal timer and a talking-points note become one rig, and let a desk agent read
the deck and fold it into the rest of the work in place. The deck tools win at
making decks. We do not need to win that. We win at keeping a deck in view as part
of a piece of focused work, which is a different job, and it is the one the canvas
plus wiring plus desk agents make possible and no deck editor can copy.

## Implementation log

- 2026-06-09, SME doc created; no implementation started yet.
