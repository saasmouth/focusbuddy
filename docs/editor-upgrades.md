# Editor gap analysis: what each one needs to be competitive

What is in each editor today, what the leading app has that we do not, and what
to build. Written for the people who will build it.

**How this was produced, and its limit.** Everything in the "today" columns was
read out of this repository on 2026-10-20: `widgetCatalog.ts`, `package.json`,
`src/main/*Io.ts`, and the editor components. Nothing here is from memory or
from the marketing copy. The limit worth stating plainly: this is code reading,
not use. A feature can be present in source and still be rough, gated, or
broken in the running app. Treat every "has" below as "has, verify depth".

Competitor capabilities are not quoted as specifics, because they drift and
none were re-verified. Where a leader is named it is for a structural fact that
does not move year to year.

---

## The finding that should change a roadmap

**Real-time co-editing is already built, client and server.**

- `src/renderer/src/lib/yjsDocSync.ts` is the client half of a CRDT protocol.
- The server half is the `yjsJoin` / `yjsSync` / `yjsUpdate` / `yjsAwareness`
  relay in `focusbuddy-signal/src/protocol.ts`, with update-log replay on join.
- `components/documents/editor/extensions.ts` wires TipTap's `Collaboration`
  and `CollaborationCaret`, so live cursors with per-user identity are in.
- `DocEditor.tsx` passes a Yjs doc as `collab` and turns StarterKit history off
  in favour of CRDT-aware undo.

Meanwhile `marketing/PRODUCT-GUIDE.md` positions collaboration as a check-out
model, one editor at a time, and §14 bans the words "real-time" and
"simultaneous editing" outright.

**Settled, 2026-10-20: it ships.** `DocumentOpen.tsx` is the resolver every
navigation to a document goes through, and it routes on scope:

- a **personal** document opens `DocumentEditorView`, last-write-wins;
- an **org-shared** document calls `ensureOrgLiveDoc` (idempotent room creation)
  and opens `LiveDocEditorView`, which is the CRDT path with live cursors;
- if the room cannot be ensured (offline, not a member) it falls back to the
  plain editor so the document still opens.

Its own header says why every navigation is routed through it: so a member "can
never accidentally open an org doc in the clobber-prone editor". The scope field
documents the same rule on `FbDocument.orgId`.

So there is nothing to wire. Personal documents are last-write-wins **by
design**, and that is the right design: joining a relay room for a private
local document would push its contents to a server for no benefit, which is the
opposite of what this product is.

**What is actually wrong is the documentation.** `marketing/PRODUCT-GUIDE.md`
§14 bans the words "real-time" and "simultaneous editing", and its limitations
table says collaboration is "check-out model, one editor at a time". That
understates a shipped capability, and it understates the single most common
reason this category loses a deal.

**One caveat before marketing claims it.** The two-account and two-window
convergence specs exist (`crdtSharedDeskConvergeTwoAccountLive.spec.ts`,
`crdtMultiTypeConvergeTwoWindowLive.spec.ts`) but self-skip unless
`CRDT_LIVE_PROXY_BASE` is set, which needs a local signal server, a TLS proxy
and a purpose-built app. So this is confirmed by reading the routing and by the
unit suites (`yjsDocSync`, `yjsSeed`, `collaboration`), not by a run of the live
harness. Run that harness once before putting the claim in front of a buyer.

---

## Documents

**Today.** TipTap / ProseMirror. Tables, task lists, text align, colour, font
family, highlight, sub/superscript, code blocks with syntax highlighting,
links, resizable images, character count, markdown. Import `.docx` through
`mammoth`; export `.docx` through `@turbodocx/html-to-docx`; export PDF.

**The ceiling, and it is the library pair.** `mammoth` converts docx to
*semantic HTML* by design: it deliberately discards what does not map. The
export side then goes HTML back to docx. So the round trip is
docx → HTML → docx, and everything that is not expressible in HTML is gone on
the way through. That is why "pixel-perfect" is un-claimable, and no amount of
editor work fixes it while this pair is in place.

Lost in that round trip: headers and footers, page size and margins, sections,
columns, footnotes and endnotes, comments, tracked changes, numbering
definitions, styles as styles rather than inline formatting, fields, and
anything anchored to a page rather than to text.

**To be competitive**

| Priority | Work |
|---|---|
| 1 | Replace the round trip. Parse OOXML into our own document model and write OOXML back out, instead of going through HTML. This is the whole ballgame for fidelity and it is a large piece of work |
| 2 | Headers, footers, page setup and sections in the model, so imported documents survive a save |
| 3 | Comments and tracked changes. These are table stakes for any document that goes to another person |
| 4 | Styles as first-class named styles, not inline marks |
| 5 | Footnotes, cross-references, table of contents |

## Spreadsheets

**Today, and this is the strongest editor we have.** 133 functions in
`lib/sheetFormula.ts`, including the modern dynamic-array set: `XLOOKUP`,
`XMATCH`, `LET`, `MAP`, `REDUCE`, `SCAN`, `MAKEARRAY`, `SEQUENCE`, `FILTER`,
`SORT`, `UNIQUE`, `VSTACK`/`HSTACK`, `TOCOL`/`TOROW`, `TEXTSPLIT`, `REGEX*`.
Real pivot tables (`SheetPivot.tsx`, `PivotDialog.tsx`), conditional formatting
(`CondFormatDialog.tsx`), data validation (`ValidationDialog.tsx`), charts
(`SheetChart.tsx`), multiple tabs, AI fill and an AI panel. `exceljs` and
`xlsx` for interop.

I scored this 1 to 2 out of 5 in an earlier comparison. That was wrong, and the
source is the correction: on the function set alone this is closer to
mainstream-competitive than anything else here.

**To be competitive**

| Priority | Work |
|---|---|
| 1 | `xlsx@0.18.5` is the last npm build of SheetJS before the project left npm, and it carries known advisories. Pin, replace, or vendor it deliberately. This is a maintenance and security decision, not a feature |
| 2 | Named ranges as a real concept (there are only traces today) |
| 3 | Cell comments and notes: none found |
| 4 | Structured tables with styles and structured references |
| 5 | Broader chart types and chart formatting |
| — | Deliberately not chasing: macros, Power Query, external data connections. Those are an Excel moat and the wrong fight |

## Slides

**Today.** 14 files, transitions, animations, speaker notes, masters, themes,
templates. Export `.pptx` through `pptxgenjs`; export PDF by rendering each
slide offscreen and printing.

**Correction, 2026-10-20.** An earlier draft of this section said the importer
"extracts text only: no shapes, images, positions or layouts". That was taken
from the stale comment at the top of `slidesIo.ts` and was wrong. Reading the
implementation, it already imports positioned images (EMU mapped to our logical
space, media inlined as data URIs), tables with header-row detection, charts
with their cached series, and speaker notes with placeholder filtering.

**What was actually missing, and what is now done.** Autoshapes: every `<p:sp>`
carrying `<a:prstGeom>` was dropped, so a deck of boxes and arrows opened as a
deck of bullet points. `slideShapes()` now imports them with fill, gradient and
border, and deliberately does **not** map geometry it cannot represent: a star
or an arrow is skipped and counted in `skippedShapes` rather than squared off
into a rectangle, because a flowchart whose arrows silently became boxes is
worse than one honestly missing them. Covered by `tests/unit/pptxShapeImport.test.ts`.

**Still missing.** Run-level text formatting (`a:rPr`: bold, italic, colour,
size) is not read, so imported text arrives unstyled. Theme colours
(`<a:schemeClr>`) are not resolved because `theme1.xml` is never opened, which
is why only explicit `srgbClr` values survive. Layout and master inheritance is
not resolved, so a shape with no transform of its own is skipped rather than
positioned by guesswork.

**To be competitive**

| Priority | Work |
|---|---|
| ~~1~~ | ~~Import autoshapes with fill and border~~ Done 2026-10-20, with tests |
| 1 | Run-level text formatting: read `a:rPr` so bold, italic, colour and size survive |
| 1 | Resolve `theme1.xml` so `<a:schemeClr>` colours are real instead of dropped |
| 2 | Resolve `slideLayouts` and `slideMasters` so placeholder-positioned shapes keep their place |
| 2 | Round-trip the theme so an imported deck keeps its look on export |
| 3 | Presenter view with notes and next-slide, and timing |
| 4 | Slide-level comments |

## Diagrams

**Today.** Three overlapping implementations: `map` (labelled Flowchart, the
PlexiDiagrams surface), `diagram` (boxes, circles, text and image nodes with
connectors), and `mindmap` (2605 lines, AI-suggested branches and tasks).

**The first problem is ours, not a competitor's.** Three widgets covering one
job is confusing in the picker and triples the maintenance. Decide which is the
surface and fold the others into it.

**To be competitive**

| Priority | Work |
|---|---|
| 1 | Consolidate the three into one diagramming surface |
| 2 | Connector routing that avoids shapes, with anchor points that survive a move |
| 3 | Shape libraries and templates. This is most of what a specialist sells |
| 4 | Auto-layout for hierarchies and flows |
| 5 | Swimlanes, and import/export of a standard format |

## Draw

**Today.** Layers, brushes, gradients, blend modes, pathfinder booleans, undo.
1575 lines across 5 files, which is small for a vector editor.

**To be competitive**

| Priority | Work |
|---|---|
| 1 | SVG import and export. Without it the artwork cannot leave, and this is the cheapest credibility win here |
| 2 | Text on a path, and text as editable vector |
| 3 | Symbols and reusable components |
| 4 | Precision: snapping, alignment, numeric transforms, rulers |
| 5 | Pattern fills and mesh or freeform gradients |

## Design

**Today.** Master pages, text frames, guides, columns, some print awareness.
1564 lines across 7 files.

**The gap is the output, not the canvas.** Nothing found for colour management,
bleed and slug, or PDF/X export. A layout tool that cannot produce a file a
printer accepts is a layout tool for screens, which is a reasonable thing to be
but is not what "brochures, posters, print-ready" implies.

**To be competitive**

| Priority | Work |
|---|---|
| 1 | Decide the honest scope: print-capable, or screen-only. The copy currently implies the first |
| 2 | If print: CMYK, bleed and slug, PDF/X export, preflight |
| 3 | Threaded text that reflows across frames, properly |
| 4 | Linked rather than embedded assets, with an update-on-change check |
| 5 | Paragraph and character styles, table styles |

## Browser

**Today.** 4 files, 1277 lines. Tabs, some history, session handling. A focused
webview for one task, which is what the catalogue calls it.

**Nothing found for:** bookmarks, find in page, downloads UI, zoom controls,
devtools, extensions, content blocking, reader mode, or per-widget profiles.

The honest framing is that this is not competing with a browser and should not
try. It needs to be good enough that a task's web pages live comfortably on the
desk.

**To be competitive**

| Priority | Work |
|---|---|
| 1 | Find in page, zoom, downloads. The three people notice immediately |
| 2 | Per-widget persistent session and cookie isolation, so two widgets can hold two logins to the same site |
| 3 | Content blocking, which is also a performance fix for a canvas full of pages |
| 4 | Reader mode, feeding text to Cmd-K so a page on the desk is searchable |
| 5 | Bookmarks scoped to a desk rather than globally |

---

## Cross-cutting, and these outrank most of the above

| Item | Why it outranks features |
|---|---|
| Settle the co-editing question | See the top of this document |
| No web or mobile client | Disqualifies us from most team evaluations before any feature is compared |
| Mail is single-account, password-only IMAP, no OAuth | The Gmail and Outlook majority cannot realistically connect |
| Not notarized, no certifications | Blocks managed and security-conscious buyers regardless of quality |
| Cmd-K does not index mail or chat | The search story is the strongest thing we have and it has a visible hole |

## What I could not verify

- Whether co-editing is enabled, partial, or behind a flag in the running app.
- Whether the features found by reading components work well, or at all.
- Any competitor's current capabilities. Nothing here should be quoted at one
  without re-verifying it first.
