# Plexi / focusbuddy — working context

Electron + React 18 + zustand + TipTap desktop app. `better-sqlite3` in main;
`node:sqlite` in tests. Dev via electron-vite.

## Gates — run before every commit, no exceptions

```bash
npm run typecheck && npm run test:unit
```

`typecheck` is both projects (node + web). `test:unit` is `vitest run` over
`tests/unit/**/*.test.ts`. A pre-push hook also runs `scripts/merge-check.mjs`
(up-to-date with base → typecheck → unit tests); `SKIP_MERGE_CHECK=1 git push`
bypasses it for a WIP push and should stay rare.

E2E (`npm run test:e2e`) builds first and is slow — run it when you touched
something it covers, not reflexively.

## Restart rules that cost real debugging time

- **Renderer edits hot-reload.** Main-process edits do **not** — you must
  restart Electron or you will read a stale build and conclude your fix failed.
  This has produced false "still broken" readings more than once.
- Native module changes need `npm run rebuild`.

## The live database is sacred

The operator's real database holds real history. Read it **read-only**:

```bash
sqlite3 "file:$DB?mode=ro" "SELECT ..."
```

Back up before anything destructive. Several defects in this codebase were
invisible to a green test suite and only appeared by measuring live data — so
measuring it is encouraged; writing to it casually is not.

## The event store is append-only and cannot be made otherwise

`events` is protected by four independent mechanisms that agree deliberately:
PLX-EVT-030 (no interface may delete an Event), PLX-EVT-031 (replay any Desk at
any point), the `events_no_delete` BEFORE DELETE trigger, and
`assertRetentionTarget()`'s `PROTECTED_TARGETS`. Do not write a `pruneEvents()`.
It would BE the interface PLX-EVT-030 forbids.

Retention has exactly one caller: `runRetentionSweep()` in
`src/main/db/retention.ts`. A new prune function belongs there or it does not
exist — every cap in this repo was once declared and never called, which is a
comment, not a cap.

## Work items — the column manifest is the source of truth

`WORK_ITEM_COLUMNS` in `src/shared/workItems.ts` drives DDL, CRDT allowlists,
emit, patch permissions and `rowToNode`. **Derive from it; never hand-list it.**
Two hand-written copies once left `source_url` write-only for weeks — it had
DDL, sync and emit, and no way in or out.

Naming trap: `NodeKind` is `'folder' | 'task' | 'task-item'`, but `task` means
**Desk** and every `taskId` in main/IPC/preload means *desk id*. Real to-dos
live in `work_items`. Do not add a field called `taskId` for a to-do.

## Verify by measurement, not by screenshot

The queue re-renders and scrolls between positioning and capture, so clipped
screenshots land on the wrong rows — this has twice produced a confidently
wrong conclusion. Use `getBoundingClientRect` / `getComputedStyle` over CDP
(port 9223). Full-viewport shots are fine; clips drift.

---

## Branch-specific: `ryan-command-center` (Attention layer + Calendar)

Start every session here:
[`planning/plexii-task-command-center/NEXT-SESSION-PROMPT.md`](planning/plexii-task-command-center/NEXT-SESSION-PROMPT.md)
→ then `ACTIVE-MISSION.md` (live state) → `DECISIONS-LOG.md` (DEC-001…071,
append-only) → `GAP-REGISTER.md`.

**Dual remotes.** `fork` = ryan-swan, `origin` = saasmouth. Push to both:

```bash
git push fork ryan-command-center && gh auth switch -u ryanswan313 && git push origin ryan-command-center && gh auth switch -u ryan-swan
```

**Append-only planning docs.** DECISIONS-LOG is never rewritten; superseded
rulings stay, marked SUPERSEDED, because they carry the reason the current
design has its shape. A test pin broken by a legitimate change gets **rewritten
to the superseding truth with its history in the comment**, never deleted.
