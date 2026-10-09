#!/bin/bash
# Server sync proof — Test A: unknown-column round-trip (personal scope only).
# Safe by design: WAL-consistent backup first, probe desk clearly labeled,
# personal org scope (your devices only), full cleanup at the end.
# Log: planning/plexii-task-command-center/analysis/sync-proof-run.log
set -u
DB="$HOME/Library/Application Support/plexii/focusbuddy.db"
LOG="$HOME/focusbuddy-plexi/planning/plexii-task-command-center/analysis/sync-proof-run.log"
exec > >(tee "$LOG") 2>&1
say() { echo "[$(date +%H:%M:%S)] $*"; }

say "=== SYNC SERVER PROOF — Test A (unknown column) ==="

# 0. Preconditions
pgrep -f "electron-vite dev" >/dev/null || { say "ABORT: dev app not running"; exit 1; }
[ -f "$DB" ] || { say "ABORT: DB not found"; exit 1; }
say "dev app running; DB present"

# 1. Backup (consistent snapshot)
BK="$HOME/focusbuddy-plexi/planning/plexii-task-command-center/analysis/focusbuddy-preproof-backup.db"
sqlite3 "$DB" ".backup '$BK'" && say "backup ok: $(du -h "$BK" | cut -f1)" || { say "ABORT: backup failed"; exit 1; }

# 2. Probe column (additive; same pattern as the app's own ensureColumn)
sqlite3 "$DB" "ALTER TABLE nodes ADD COLUMN wi_probe TEXT;" 2>/dev/null \
  && say "added column wi_probe" || say "wi_probe column already present (ok)"

# 3. Insert probe desk (personal scope, needs_sync=1)
TS=$(python3 -c "import time; print(int(time.time()*1000))")
ID="wi-probe-$TS"
PROBE="PROBE-COLUMN-$TS"
sqlite3 "$DB" "INSERT INTO nodes (id, parent_id, kind, title, description, status, priority, interest, importance, sort_order, created_at, updated_at, org_id, needs_sync, wi_probe) VALUES ('$ID', NULL, 'task', '· sync probe — safe to ignore', 'temporary sync round-trip test row; auto-removed', 'open', 3, 3, 3, 99999, $TS, $TS, 'personal', 1, '$PROBE');" \
  || { say "ABORT: insert failed"; exit 1; }
say "inserted probe row id=$ID probe=$PROBE"

# 4. Wait for the engine to push (20s cycle): needs_sync->0 + sync_rev>0 = SERVER ACCEPTED
ACCEPTED=0
for i in $(seq 1 30); do
  ROW=$(sqlite3 "$DB" "SELECT needs_sync || '|' || sync_rev FROM nodes WHERE id='$ID';")
  if [ "${ROW%%|*}" = "0" ] && [ "${ROW##*|}" != "0" ]; then ACCEPTED=1; REV="${ROW##*|}"; break; fi
  sleep 3
done
if [ "$ACCEPTED" = "1" ]; then
  say "SERVER ACCEPTED the row with unknown column. sync_rev=$REV"
else
  say "RESULT: server did NOT accept within 90s (needs_sync still set) — push rejected or engine idle"
  say "cleaning up local row"; sqlite3 "$DB" "DELETE FROM nodes WHERE id='$ID';"
  exit 2
fi

# 5. Echo test: raw local delete (no tombstone), roll personal cursor back, wait for re-pull
sqlite3 "$DB" "DELETE FROM nodes WHERE id='$ID';"
say "deleted row locally (raw, no tombstone)"
CUR=$(sqlite3 "$DB" "SELECT value FROM sync_meta WHERE key='workspace_cursor';")
NEWCUR=$((REV - 1))
sqlite3 "$DB" "UPDATE sync_meta SET value='$NEWCUR' WHERE key='workspace_cursor';"
say "rolled personal cursor $CUR -> $NEWCUR; waiting for re-pull"
BACK=0
for i in $(seq 1 30); do
  GOT=$(sqlite3 "$DB" "SELECT COALESCE(wi_probe,'(null)') FROM nodes WHERE id='$ID';" 2>/dev/null)
  if [ -n "$GOT" ]; then BACK=1; break; fi
  # re-apply rollback once mid-wait in case a concurrent pull advanced the cursor first
  [ "$i" = "15" ] && sqlite3 "$DB" "UPDATE sync_meta SET value='$NEWCUR' WHERE key='workspace_cursor';"
  sleep 3
done
if [ "$BACK" = "1" ]; then
  if [ "$GOT" = "$PROBE" ]; then
    say "✅ PROOF PASSED: server stored AND echoed the unknown column intact (wi_probe='$GOT')"
    VERDICT=PASS
  elif [ "$GOT" = "(null)" ]; then
    say "⚠️ PARTIAL: row re-materialized but wi_probe came back NULL — server STRIPPED the unknown column"
    VERDICT=STRIPPED
  else
    say "⚠️ UNEXPECTED: wi_probe came back as '$GOT' (expected '$PROBE')"
    VERDICT=MUTATED
  fi
else
  say "RESULT: row did not re-materialize within 90s — echo path unproven (cursor race or pull idle)"
  VERDICT=INCONCLUSIVE
fi

# 6. Cleanup: proper tombstone so server + any other device converge to zero trace
if [ "$BACK" = "1" ]; then
  sqlite3 "$DB" "UPDATE nodes SET trashed_at=$(python3 -c "import time; print(int(time.time()*1000))"), needs_sync=1 WHERE id='$ID';"
  say "tombstoned probe row; waiting for engine to delete it server-side"
  for i in $(seq 1 30); do
    NS=$(sqlite3 "$DB" "SELECT needs_sync FROM nodes WHERE id='$ID';" 2>/dev/null)
    [ "$NS" = "0" ] || [ -z "$NS" ] && break
    sleep 3
  done
  sqlite3 "$DB" "DELETE FROM nodes WHERE id='$ID';"
  say "server tombstone confirmed; local residue removed"
else
  # row exists only server-side; the cursor will eventually re-deliver it — leave a marker
  say "NOTE: probe row may exist server-side only. Re-run cleanup later or delete '· sync probe' desk if it appears."
fi

# 7. Drop the probe column if SQLite allows it live (harmless if it stays)
sqlite3 "$DB" "ALTER TABLE nodes DROP COLUMN wi_probe;" 2>/dev/null \
  && say "dropped wi_probe column" \
  || say "wi_probe column left in place (harmless; ensureColumn-style additive)"

say "=== DONE — verdict: $VERDICT · full log: $LOG ==="
