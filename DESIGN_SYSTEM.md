# Plexi Design System — aligning the suite to the aspirational vision

This is the single north star for making every Plexi surface (PlexiDesk, PlexiOffice,
PlexiMail, PlexiTasks, PlexiFlows, PlexiBrain, PlexiMeet, PlexiDraw, PlexiSlides,
PlexiSheets, PlexiDocs, the People Map, the Plexi Home) read as one product. It maps
the aspirational dashboards to what already exists in the codebase, names the shared
component layer, and sets the order we converge.

## The vision in one paragraph

A deep, calm canvas with a single confident indigo/violet accent and per‑product
accent colours. A colourful product wordmark over a sectioned sidebar (nav →
workspaces → tools/views) with a gradient upgrade card and a storage meter pinned
to the bottom. A top bar built around one ⌘K search, with help, settings,
notifications and the user avatar to the right. Pages open with a "Good morning,
Sarah 👋" greeting, then a row of stat tiles with trend deltas, then dense rounded
panels — boards, tables with status pills, charts and sparklines — with a persistent
right rail of Upcoming / Recent Activity / AI Insights. Everything is rounded and its
edges come from light, not outlines; glass is reserved for the one floating layer
that content moves behind (see "Edges and glass" below).

## What already exists (do not rebuild)

The foundation is in `src/renderer/src/styles/tokens.css` and `globals.css`, and it is
strong. Use it; do not invent parallel colours.

- **Colour** is OKLCH ink / surface / edge ramps with light, `.dark`, `.futuristic`
  and `.atelier` overrides. Text is `--ink-100..--ink-10`; backgrounds are
  `--surface-base/raised/sunken/veil`; borders are `--edge-soft/firm/glow`. The accent
  is `--accent` (an `R G B` triple, set at runtime by `lib/theme.ts`) — use it as
  `rgb(var(--accent) / <alpha>)` or the Tailwind `accent` colour (`text-accent`,
  `bg-accent`).
- **Surfaces / glass**: `.fb-glass-chrome | -panel | -pillow | -soft` for the three
  glass tiers plus the soft dashboard‑card highlight; `fb-card / fb-tile /
  fb-btn-surface / fb-field` for opaque material (depth from light, no outline);
  `fb-tile-lit / fb-chip-lit` for a lit tile INSIDE a card (a raised luminance
  step up, where `fb-tile` steps down) and its toned icon chip (wash from
  currentColor at the themed `--fb-chip-wash` alpha — pass the tone as a text
  colour class on the chip).
- **Shape / motion**: `--radius-xs..2xl`, the `--ease-spring-*` curves and
  `--dur-*` durations, surfaced as `.fb-spring-*`, `.fb-lift`, `.fb-breathing`.
- **Type**: Inter everywhere, with `.fb-display`, `.fb-display-hero`, `.fb-tabular`
  (use for any number that must not jitter), `.fb-mono`.

Status colours (consistent across the suite): online/success = emerald, away/warn =
amber, focus/AI = violet, busy/error = rose, info = sky, accent = brand.

## Edges and glass (the law, 2026-08-23)

Ratified with Caleb for the Edges + Glass mission; the Apple research behind it is
`APPLE-DOCTRINE.md` in the product node (R1.1 to R1.6, R2.2, R5.4, R6.3, R6.4).

- **Borders are the last resort.** Separate surfaces with whitespace first, then a
  luminance step (`--surface-raised` on `--surface-base`, `--surface-sunken` inside
  a panel), and only then a hairline. The material card (`fb-card`) already does this:
  a `--edge-hairline` ring in the box-shadow, `--shadow-soft`, and the inset top
  highlight. A `border border-[var(--edge-soft)]` box on a filled surface is debt.
- **Hairlines are alpha.** `--edge-soft` and `--edge-firm` are translucent (light:
  black at 10% / 20%; dark: white at 10% / 19%; atelier 13% / 24%), so one line reads
  the same weight on a panel and quieter on the floor. Never an opaque grey stroke.
- **Two layers, one of them glass at most.** Content (cards, widgets, documents,
  rows, anything read for more than a moment) is opaque. The floating layer may be
  glass, and only where meaningful content moves behind it: `fb-glass-chrome` for the
  titlebar and the toolbars and pills floating over the canvas, `fb-glass-panel` for
  popovers, menus and sheets, `fb-glass-pillow` for modal dialogs. The side menus are
  opaque material while the dock column reserves their width. Never glass on glass;
  ad-hoc `backdrop-blur` outside the tiers is a defect.
- **Corners rhyme.** Cards 16, rows and fields 10, chips 8 (`--radius-card / -row /
  -chip / -field`); a nested element takes `outer minus padding`, never a fourth value.
- **Feedback on every control, on nothing else.** Hover highlights or lifts, press
  dips (`fb-press`), keyboard focus is the global concentric ring: restyle it, never
  `outline-none` it away.

Phase 4 (2026-08-23) closed the long tail and settled three more points:

- **`fb-field` is `width: 100%` by design** — right for form fields, wrong for a
  select in a toolbar row. A field in a row context carries its own width utility
  (`w-auto`, `w-12`, `flex-1`); the element's utility wins the cascade. Both stroke
  tokens are the same debt: the codemod treats `--edge-firm` exactly like
  `--edge-soft` in every rewrite rule.
- **Toasts are chrome, colour is state.** A toast capsule is
  `fb-glass-chrome rounded-full border border-[color:var(--glass-chrome-border)]
  shadow-md`; its semantics live in a `ring-1 ring-<tone>/25` and the text/icon
  tint — never in a tinted surface (HyperfocusGuardian, WidgetSetupAffordance and
  BringMeBack are the references).
- **When a literal colour is lawful, its comment says why.** The taxonomy that
  survived the sweep: forced-dark stages (video, presenter, onboarding, the
  signature pad, Tooltip, the undo HUD capsule, MetricsOverlay's debug chrome),
  paper materials (note / sticky / calculator faces and their table rules),
  swatch-containment hairlines around arbitrary colours, and handle contrast
  rings over arbitrary content. Everything else literal is debt.

## The missing layer — shared dashboard primitives

The gap between the mockups and the app was never the tokens; it was that every
surface re‑styled its own cards. That layer now lives in
`src/renderer/src/components/plexi/index.tsx` and every product should compose it:

- `DashboardHeader` — the greeting + title + actions row that opens a page.
- `StatTile` — the icon‑chip + big tabular value + label + trend delta tile.
- `RailCard` — a titled, optionally‑actioned panel for the main column or right rail.
- `StatusPill` — the dot + label pill, keyed by the status tones above.
- `PLEXI_CARD` — the canonical card className (rounded‑xl, hairline, glassy).

They are built entirely on the tokens, so they adapt to every theme automatically.
The People Map view (`components/views/PeopleMapView.tsx` + `peopleMap.css`) is the
first reference implementation — its chrome is now token‑driven (theme‑aware) and its
header/stat strip use the primitives.

## How to align a surface (the checklist)

1. Replace bespoke page headers with `DashboardHeader` (greeting on home‑like views,
   plain title elsewhere).
2. Replace hand‑rolled metric cards with a `StatTile` row.
3. Wrap panels in `RailCard` / `PLEXI_CARD`; delete local card CSS.
4. Replace status text/badges with `StatusPill`.
5. Delete hardcoded hex. Chrome uses `--ink-*/--surface-*/--edge-*`; the accent uses
   `--accent`. The only place a fixed colour is acceptable is a "well" that is dark by
   convention (a world map, a video stage) — keep those few and obvious.
6. Numbers use `.fb-tabular`; headings use `.fb-display`.

## Phased rollout (and who owns what)

A second workstream is actively building PlexiOffice, desk, meet, chat, mail and forms.
To converge without collisions:

- **Phase 0 (done)**: ship the primitives kit + this doc + realign the People Map as
  the reference. No other surface touched.
- **Phase 1**: new surfaces adopt the primitives from day one (PlexiSign, and any
  not‑yet‑built product). Cheapest possible alignment — born on‑system.
- **Phase 2**: each owner aligns their live surface to the primitives on their own
  cadence (home, office home, the product dashboards). Whoever owns a component aligns
  it; nobody rewrites someone else's live component underneath them.
- **Phase 3**: fold the per‑product accent colours into the suite catalog
  (`src/shared/plexiSuite.ts` already carries an `accent` per family) so each product
  page can theme its accent from one source.

The rule that keeps this safe: shared primitives and tokens are the contract; surfaces
converge onto them incrementally. Coordinate before committing shared routing or the
catalog, per the concurrent‑work norms.

## References are direction, not canon (Ryan, 2026-09-01 and 2026-09-06)

Source: Claude memory, moved 2026-09-17.

On 2026-09-01 Ryan had a pasted design-canon document tested on the PlexiMeet page before adopting it
anywhere, then rejected it: "it did not translate well… some nice additions but very minimal… just
ignore it as any sort of canon or guidelines going forward", and it was not to be applied to Mail. On
2026-09-06 he gave three mock-page screenshots as direction for the meeting Record, with the rule "this
is not the trump card; this is just a design direction" (DEC-115).

He judges design by how it lands on the real page, not by the document. Adopting a pasted system
wholesale produced a weak result; extracting its principles and building them in the house material
did not. For any UI round:

- Extract the principles from the reference (organisation, tagging, linking, honest empty states).
- Build them in the house material: `desk-paper`, `fb-card`, `fb-btn-surface`, `fb-press`, eyebrow
  labels, the accent-versus-ink doctrine, and the plexi kit's tiles and pills.
- Never cite or reuse the rejected canon.
- Judge on real screenshots of the running app (`docs/LIVE-VERIFICATION-CDP.md`), and fix what reads
  wrong (duplicates, busy pills, misleading icons) before calling it done.
