#!/bin/bash
# Cleanup: the trashed legacy task-item rows stuck at needs_sync=1 (409-loop suspects).
# Two-phase: (1) confirm they persist dirty across two sync cycles, (2) JSON-backup then
# hard-delete them locally (they are already user-trashed demo residue; widgets cascade).
# The other dirty nodes are REPORTED, not touched. Log + backup land next to this script.
set -u
DB="$HOME/Library/Application Support/plexii/focusbuddy.db"
DIR="$HOME/focusbuddy-plexi/planning/plexii-task-command-center/analysis"
LOG="$DIR/cleanup-stuck-rows.log"
exec > >(tee "$LOG") 2>&1
say() { echo "[$(date +%H:%M:%S)] $*"; }

say "=== STUCK-ROW CLEANUP ==="
pgrep -f "electron-vite dev" >/dev/null && say "dev app running (fine)" || say "dev app not running (also fine)"

Q="SELECT id FROM nodes WHERE kind='task-item' AND trashed_at IS NOT NULL AND needs_sync=1"
N1=$(sqlite3 "$DB" "SELECT COUNT(*) FROM ($Q);")
say "phase 1 — candidates now: $N1 trashed+dirty task-item rows"
if [ "$N1" = "0" ]; then say "nothing stuck; done."; exit 0; fi

say "waiting 45s (two sync cycles) to confirm they are stuck, not in-flight…"
sleep 45
N2=$(sqlite3 "$DB" "SELECT COUNT(*) FROM ($Q);")
say "phase 1 — candidates after two cycles: $N2"
[ "$N2" = "0" ] && { say "they cleared on their own — the wake-coalescing fix may already be helping. Done."; exit 0; }

say "phase 2 — backing up the rows"
sqlite3 -json "$DB" "SELECT * FROM nodes WHERE kind='task-item' AND trashed_at IS NOT NULL AND needs_sync=1;" > "$DIR/stuck-rows-backup.json"
say "backup: $DIR/stuck-rows-backup.json ($(wc -c < "$DIR/stuck-rows-backup.json") bytes)"

sqlite3 "$DB" "DELETE FROM nodes WHERE kind='task-item' AND trashed_at IS NOT NULL AND needs_sync=1;"
say "deleted $N2 stuck rows (their widgets cascade via FK)"

say "=== post-cleanup dirty census ==="
for t in nodes widgets time_blocks documents fb_tables fb_rows fb_files; do
  echo -n "  $t: "; sqlite3 "$DB" "SELECT COUNT(*) FROM $t WHERE needs_sync=1;"
done
say "note: documents/fb_files dirt is permanent-by-design (analysis/15 §5) — ignore"
say "remaining dirty NODES (observation only, not touched):"
sqlite3 "$DB" "SELECT '  ' || kind || ' | ' || substr(title,1,32) || ' | rev ' || sync_rev FROM nodes WHERE needs_sync=1;"
say "note: server-side copies of the deleted demo rows remain as inert zombies in your"
say "personal scope; the P1 409-loop fix (analysis/15 §6 #4) is the proper janitor for those."
say "=== DONE — log: $LOG ==="
