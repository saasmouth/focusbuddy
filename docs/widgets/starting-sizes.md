# Starting sizes and best placement

Where a work widget starts, and where it goes when nobody chose a spot. This is
the owner's "Plexii starting sizes" standard (2026-11-09), held in two tables.

| Question | Table | Used by |
|---|---|---|
| How big does it start? | `src/shared/widgetStartSizes.ts` | the widget catalog, `createWidget` in main, every add path |
| Where does it go? | `src/shared/widgetPlacement.ts` | `spawnPositionFor`, `createWidget` in main, Build with AI |

To change a size or a zone, change the table and the test that pins it
(`tests/unit/widgetStartSizes.test.ts`, `tests/unit/widgetPlacement.test.ts`).
Do not write a size into a creation path: that is how sizes drift apart.

## Sizes

- Every number is a multiple of the canvas's 20 px grid, and lands on the
  Workcentre's columns at the default window.
- A size is only where a widget starts. Nothing changes a widget already on a desk.
- A widget moved to another desk takes the standard only if it is still at the
  size it started with before the standard (`sizeWhenMoved`). A size somebody
  chose moves with the widget.
- A new widget is capped to 3/4 of the canvas surface, rounded down to the grid.
  The surface runs under the floating side menu, so every standard size opens
  uncapped on the default window (1600 x 891).

## Placement

Placement applies only when nobody chose a spot: "Add to this desk", a side-menu
click, quick-add keys, an agent, MCP, Build with AI. A drag or right-click never
comes here.

| Zone | What goes there | How it fills |
|---|---|---|
| `main` | editors, Browser, Table, Mind map | from the top left, along the row, then down |
| `second` | notes, pages, charts, reference | right after the main item on screen, or from the middle |
| `right` | Mail, Calendar, Chat, Tasks, Focus, Agent | against the right edge, top to bottom |
| `left` | Files, Contacts | against the left edge, top to bottom |
| `top` | Metrics, Stat card, SpeedDeck | along the top |
| `corner` | small tools | top-right corner, stacked |
| `around` | Section | centre of the view |

Every position is on the grid, inside the part of the canvas you can see (the
side menu, an open Files flyout and a docked PlexiiAssist float over it), and
clear of what is there. If a zone has no room, `placeInZone` returns null and the older rule runs: beside the
active widget, or the nearest free spot to the centre.

The renderer places into the camera's view. Main may be adding to a desk that is
not open, so it uses `REFERENCE_VIEW`, the default window's workspace.

## Build with AI

`planZoneLayout` lays out a whole batch. Everything is made first, because a table
can come back wider than the catalog says, then big things claim the main stage
and small things fill in around them. What does not fit goes below, and the area
grows so later items can sit beside it.

## Outside the two tables

- Vault, Call and Sign have no desk form, so they are not listed. The standard
  gives them 620x420, 420x300 and 960x660 for when they can be placed.
- Meeting records are not in the standard. They keep 420x440, in the size table.
- Desk templates and persona demos carry their own designed layouts.
