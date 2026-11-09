# Open This Room in Plexii: the room handoff, version 1

This file is the contract between PlexiiLite (the writer) and Plexii (the reader).
It is kept, word for word, in both repos: `docs/PLEXIILITE-ROOM-HANDOFF.md`, with
the same example in `tests/fixtures/plexiilite-room-v1.json`. Change both together,
and bump `version` for anything an older reader would misread.

## What happens

1. In PlexiiLite the person chooses **Open This Room in Plexii** for a room (a
   folder). PlexiiLite offers it only when the app macOS opens `plexii://` links
   with is Plexii (`app.haptyx.desktop`) and its Info.plist says
   `PlexiiTakesLiteRooms` is 1 or more (the highest handoff version it reads).
2. PlexiiLite writes one JSON file into ITS OWN data folder, never the person's
   folders: `~/Library/Application Support/PlexiiLite/handoff/<id>.json`, where
   `<id>` is a random UUID (lower case, version 4), mode 0600. It removes its own
   handoff files older than a day.
3. PlexiiLite opens `plexii://lite-room?id=<id>`. Nothing else travels in the link.
4. Plexii keeps the id until someone is signed in, then reads that one file
   (Plexii never writes or deletes in PlexiiLite's folder), checks it, and ASKS:
   the folder, how many files and how much, that Plexii keeps its own copy and the
   folder isn't changed, and what is left out and why. A link alone never brings
   anything in: a web page can open a `plexii://` link too.
5. On yes, Plexii copies the files into its own store, the way a file dropped from
   Finder is copied, makes a new desk named after the folder holding them, lays
   them out as they were, opens the desk and says what came in and what didn't.

## The file

```json
{
  "format": "plexiilite.room",
  "version": 1,
  "createdAt": "2026-11-09T09:30:00.000Z",
  "app": "PlexiiLite 0.6.0",
  "folder": "/Users/someone/Projects/Launch",
  "name": "Launch",
  "view": "desk",
  "cols": 12,
  "tiles": [
    {
      "name": "plan.md",
      "relPath": "plan.md",
      "kind": "markdown",
      "size": 26,
      "inCloud": false,
      "desk": { "x": 40, "y": 40, "w": 440, "h": 440, "z": 2 },
      "workcentre": { "x": 0, "y": 0, "w": 4, "h": 12 }
    }
  ],
  "folders": [{ "name": "Ideas", "relPath": "Ideas" }],
  "pages": [
    {
      "url": "https://plexiidesk.com/",
      "title": "Plexii",
      "desk": { "x": 520, "y": 40, "w": 560, "h": 400, "z": 1 },
      "workcentre": { "x": 4, "y": 0, "w": 6, "h": 11 }
    }
  ],
  "more": { "files": 0, "folders": 0 }
}
```

| Field | Rule |
|---|---|
| `format` | Exactly `"plexiilite.room"`. |
| `version` | The integer 1. A reader refuses a version it doesn't know and says a newer PlexiiLite sent it. |
| `createdAt` | ISO 8601 time the file was written. A reader refuses a file more than a day old (expired) or more than five minutes in the future. |
| `app` | Who wrote it, for people reading the file. Up to 100 characters. |
| `folder` | The room's folder: an absolute, normalised path (no `.` or `..` parts, no `//`, no trailing `/`), not `/`, up to 4,096 characters. |
| `name` | The folder's own name: exactly the last part of `folder`. The new desk is named this. |
| `view` | The view the room was shown in: `desk`, `workcentre`, `list` or `focus`. |
| `cols` | The Workcentre's column count (an integer 1 to 48), or `null` when the room was never arranged in the Workcentre. |
| `tiles` | The files directly in the room, in the room's own order (its sort, else folders first and by name), at most 2,000. Hidden files only when PlexiiLite shows them. |
| `tiles[].name` | The file's name: 1 to 255 characters, no `/`, no NUL, not `.` or `..`. Unique among `tiles` and `folders`. |
| `tiles[].relPath` | Its path inside `folder`. In version 1 always equal to `name`: only files directly in the room are listed. |
| `tiles[].kind` | PlexiiLite's viewer for it (`image`, `pdf`, `markdown`, `code`, `video`, `docx`, `sheet`, `slides`…): lower-case letters and `-`, up to 32. For people; a reader chooses its own viewer from the file. |
| `tiles[].size` | Its size in bytes as PlexiiLite listed it: a whole number, 0 or more. |
| `tiles[].inCloud` | `true` when the file is only in iCloud (or another cloud drive): its contents are not on this Mac, and reading one byte makes macOS download all of it. Neither app reads such a file for a handoff; the reader leaves it out and says so. |
| `tiles[].desk` | Where it is on the Desk, in world pixels (unscaled): `x`, `y` (any finite number up to 10,000,000 either way), `w`, `h` (more than 0, up to 100,000) and `z` (stacking order, higher on top). `null` when it was never placed there. |
| `tiles[].workcentre` | Its Workcentre tile in grid units of `cols`: `x`, `y` (whole numbers, 0 or more), `w`, `h` (whole numbers, 1 to 200), and optional `fixW`, `fixH` (sized by hand). `null` when it has none. |
| `folders` | The folders directly in the room (and packages are files, not folders), at most 2,000: `name` and `relPath` (equal), the same rules as a tile's. Version 1 does not carry what is inside them: a reader lists them as left out. |
| `pages` | The room's PlexiiBrowser windows, at most 100: `url` (http or https, up to 8,192 characters), `title` (up to 300 characters, or `null`), `desk` and `workcentre` as for a tile. |
| `more` | How many files and folders the room has beyond those listed (`files`, `folders`: whole numbers, 0 or more). A reader says they were left out. |

A reader ignores fields it doesn't know (a later version 1 writer may add one),
and refuses the whole file when a field it knows breaks a rule: nothing is brought
in from a file it can't trust in full. The file is at most 1 MiB.

## What the reader checks before reading any of the person's files

- The id is a lower-case version 4 UUID.
- The handoff file is exactly `<PlexiiLite data>/handoff/<id>.json` once every
  link is resolved (its real path), is a regular file and not a link, and is at
  most 1 MiB.
- The schema above, in full.

## What it checks for each file, after the person said yes

- The folder's real path is a folder.
- The file, `folder` + `relPath`, is a regular file whose real path is inside the
  folder's real path (a link to somewhere outside is left out).
- It is not only in iCloud (checked again, from the file's flags, without reading it).
- The reader's own limits: Plexii brings in at most 200 files and 1 GB from one
  room, in the room's order; the rest are left out and named.

## Where things go in Plexii

- Each file becomes a file on the desk, as if dropped from Finder: Plexii's own
  copy in its file store, in a Files folder named after the room.
- Each page becomes a browser window on the desk.
- The Desk's positions map one to one onto Plexii's canvas (both are world
  pixels), moved together so the arrangement starts near the canvas's top left,
  sizes kept (never below what Plexii can show), in the same stacking order.
  Tiles never placed on the Desk are laid out in rows after the placed ones.
- The Workcentre's tiles map one to one onto Plexii's Workcentre (the same grid:
  24 px rows, 12 px gaps), keyed by the new desk objects.
- The desk opens in the matching view: Desk → canvas, Workcentre → Workcentre,
  List → list, Focus → canvas.
