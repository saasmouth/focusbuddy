#!/bin/bash
# Usage: scripts/e2e-screen-watch.sh <out-file> & ... run e2e ... ; kill %1
# Proves background e2e: the test app (owner "Electron") is never frontmost and
# never has a window on screen. Count lines without "electronWindowsOnScreen=0".
# Samples, until killed: the frontmost app, and on-screen windows owned by "Electron" (the test app).
out=$1; : > $out
while true; do
  front=$(lsappinfo info -only name "$(lsappinfo front)" 2>/dev/null | sed -E 's/.*="?([^"]*)"?/\1/')
  wins=$(osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); var l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))); var n = 0; for (var w of l) { if (w.kCGWindowOwnerName === "Electron" && w.kCGWindowLayer === 0 && (w.kCGWindowAlpha === undefined || w.kCGWindowAlpha > 0)) n++ } n' 2>/dev/null)
  echo "$(date +%H:%M:%S) front=$front electronWindowsOnScreen=$wins" >> $out
  sleep 0.5
done
