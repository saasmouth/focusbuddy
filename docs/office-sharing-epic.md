# Epic: PlexiOffice sharing & collaboration

Date opened: 2026-06-21.

## What the user asked for

Office documents should be shareable "just like PlexiDesk", and specifically:
viewable in a browser, with local check-out, view-only invites, live
collaboration, and sharing to teams. That is the full Google-Workspace sharing
surface, and it spans all three projects plus a new concept (teams), so it is a
sequenced epic, not one change.

## What already exists (measured 2026-06-21)

Three projects cooperate, all present in this workspace:

- `plexii` (desktop): `ShareDialog` + `lib/shareSnapshot.ts` mint a snapshot
  and a token; `lib/docCollabClient.ts` already speaks the check-out collaboration
  protocol (`POST /livedocs`, `/livedocs/:id/lock`, `/release`, `/body`, `/title`,
  `/invite`). The file manager (`fb_files`) now backs the office Drive too.
- `focusbuddy-signal` (server): `/share` + `/inbox` for snapshot sharing;
  `live_docs` + `live_doc_members` (roles owner/editor) + `live_doc_locks` for
  check-out collaboration; account/session auth.
- `focusbuddy-viewer` (web SPA, view.plexii.app): `SnapshotView.tsx` renders
  share kinds `folder` / `task` / `widget`, plus an "add to workspace" path.

Gaps for office specifically: the snapshot builder and the viewer only know desk
content (nodes/tasks/widgets), not office documents; `live_docs` collaboration is
not wired to office `documents`; member roles have no `viewer`; and there is no
team entity (only a "team plan" intent flag at signup).

## The five capabilities, mapped

1. **In a browser** — extend `focusbuddy-viewer` `SnapshotView` to render an
   office `document` (and a `docfolder`) snapshot. Reuses the existing
   `/share` + `GET /share/:token` path unchanged.
2. **Invite, view-only** — reuse the share link + email invite, with a `view`
   scope for read-only. For live docs, add a `viewer` role alongside owner/editor.
3. **Local check-out** — office documents join the existing `live_docs` check-out
   system (acquire lock to edit, release when done), via `docCollabClient`.
4. **Collaborate** — same `live_docs` backbone: members with editor role take
   turns via the lock; the office editors already emit body changes to save.
5. **Share to teams** — NEW: a `teams` + `team_members` table on the signal
   server, share/invite targeting a team, and capability gating. Biggest new
   backend piece.

## Phased plan (each phase ships complete + verified)

**Phase 1 — View-only document sharing, in the browser (START HERE).**
Desktop: a "Share" action on an office document mints a `document` snapshot
(title + docType + body) and a link (reusing the token + `/share` + email invite).
Viewer: `SnapshotView` gains a `document` case that renders doc/sheet/slides/map
read-only. Server: unchanged (snapshot is opaque JSON). This delivers
"in a browser" + "view-only invite" for a single document, end to end, all in
this workspace. Verifiable: desktop e2e for the share action; viewer typecheck +
build.

**Phase 2 — Folder sharing.** Snapshot a Drive folder and its documents; viewer
renders a folder-of-documents; recipient can copy it into their own Drive
(reusing the copy scope + import).

**Phase 3 — Check-out + live collaboration for office docs.** Bridge office
`documents` to `live_docs` so a document can be "made collaborative", inviting
people as editors who take the lock to edit; surface the existing lock/takeover UI
in the office editors. Add a `viewer` role for read-only collaborators.

**Phase 4 — Teams.** Add `teams` + `team_members` on the signal server, a way to
create/join a team, and share/invite targeting a team so everyone on it gets
access. Capability-gate to the team plan.

## Sequencing + honesty

Phases 1 and 2 are snapshot-based (point-in-time copies) and are the cleanest,
fully in-repo wins. Phase 3 is real-time and rides the existing live-docs system,
but two-account live sync has historically needed a manual verification pass.
Phase 4 (teams) is the largest new backend and should come last. The web viewer
is a separate deploy (Vercel), so any browser-facing phase ships only when the
viewer is deployed, not just when the desktop side is built.
