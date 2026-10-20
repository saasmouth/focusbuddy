# Performance and Memory Analysis — Widgets and Browsers

Grounded in the current code. Numbers are engineering estimates from the
architecture, not measured profiles; the last section says how to measure them
for real. The headline: browsers dominate memory, the canvas has no offscreen
culling, and live wires are the main CPU hot path during interaction.

## 1. The model that decides everything

Three architectural facts drive every number below.

Only the active desk is mounted. `loadForTask` wipes the widget store and loads
just the open task's widgets, so widgets on other desks cost nothing while you
are not on them. Portals are the exception and they are cheap (see below). So
"how many widgets hurt" is really "how many on ONE desk."

No viewport culling. `Canvas.tsx` renders `widgets.map((w) => renderWidget(w))`
with no check for whether a widget is in view. Every widget on the active desk
is fully mounted and live whether it is on screen, panned far away, or hidden
behind another widget. Section children render too. There is no virtualization.

Each browser is a real Chromium process that never sleeps. `webviewTag: true`,
`sandbox: false`, each `<webview>` gets its own session partition, and there is
no `backgroundThrottling`, no `visibilitychange` handling, and no
IntersectionObserver in `WebViewWidget`. So an offscreen or hidden browser still
runs its timers, animations, video, and JavaScript at full cost. This is the
single biggest stability lever in the app.

## 2. Per-widget cost

Memory is per live widget on the active desk. CPU-at-rest is the steady cost when
you are not touching it.

| Widget | Est. RAM each | CPU at rest | Why |
|---|---|---|---|
| webview (browser) | 80 MB light page, 150-400 MB for SPAs (Gmail, Notion, Figma, image-heavy marketing) | Medium-High; full when offscreen | Separate Chromium renderer process + the live page. No throttling. |
| local-app-launcher (mirror mode) | Native app + a capture/composite cost | Medium | Punch-through of a real native window. |
| diagram | 10-30 MB | Low-Medium | React Flow (`@xyflow/react`) is a heavy graph runtime. |
| page / markdown | 5-15 MB | Low | Full Tiptap / ProseMirror editor instance each. |
| scratchpad | 5-20 MB (grows with strokes) | Low | Canvas + perfect-freehand stroke buffers. |
| streamdeck | 3-8 MB | Low | 10x3 button grid + media/app bindings. |
| table | 2-10 MB (rows) | Low | Rows + per-cell field editors. |
| mindmap | 2-8 MB | Low | Node tree + SVG. |
| voice-recorder | small idle, large while recording | High while recording | MediaRecorder + audio buffers. |
| video / image / file | size of the media | Low-Medium | Decoded media in memory; video keeps decoding. |
| agent | 1-3 MB | Low; spikes on run | Config + run log; AI cost on each run, browser-driving cost if wired to a browser. |
| portal | 1-2 MB | Low (4s poll) | Renders a static `DeskMiniature` of another desk from a `listByTask` poll every 4s. It does NOT mount that desk's live webviews, so a control room of portals is cheap. |
| minimap | small RAM, notable CPU on re-render | Medium on change | Auto-created per desk; renders EVERY widget as a scaled live `WidgetPreview` in a foreignObject, so its re-render cost scales with widget count. |
| sticky / note / card / shape / field / calculator / color / timer / task-link | 0.2-1 MB | Negligible | DOM + React only. |

Baseline before any widgets: the main process, the GPU process, and the React
renderer window together are roughly 250-450 MB.

## 3. The CPU hot paths (scale with count, not just memory)

Live wires overlay. `LinkOverlay` rebuilds its segments by calling
`getBoundingClientRect` (via `querySelector` on `data-widget-id`) for BOTH
endpoints of EVERY wire on every render, and it runs a `requestAnimationFrame`
loop that re-renders every frame while the mouse is held. So during a drag the
cost is O(wires) DOM reads per frame. With a few wires this is invisible; with
30-50+ wires and an active drag it starts dropping frames. Firing wires add SMIL
animations on top, which are cheap individually but add up.

Minimap re-render. The minimap subscribes to widget/pan/zoom/layout changes and
re-renders every widget as a live preview. On a desk with many widgets, every
layout change re-runs that whole render. It is the second hot path after wires.

No culling means mount cost is total, not visible. Panning a huge desk keeps all
editors, canvases, and especially browsers alive and compositing. The compositor
has to manage every webview layer even when off screen, which is where pan/zoom
jank comes from on browser-heavy desks.

Background timers (app-wide, independent of widget count): body-double presence
~30s, time-of-day tint ~1 min, plus the inbox poller, drift detector, hyperfocus
guardian, focus-session ticker, and the sync indicator. None are per-widget;
together they are a small, constant background load. Per-widget timers exist for
interval-trigger agents and the 4s portal poll.

## 4. Risk thresholds

Browsers are the cliff; everything else is a gentle slope.

Browsers on one desk:
- 1-3: comfortable. Roughly 0.5-1.2 GB total. Fine everywhere.
- 4-8: 1.2-3 GB. Fine on 16 GB Macs; noticeable on 8 GB, some swap.
- 9-15: 3-6 GB, real swap pressure on 8-16 GB machines, pan/zoom jank as the
  compositor juggles many webview layers. Heavy SPAs (Gmail, Figma, Notion) hit
  the top of this range fast.
- 16+: high risk. Multi-GB swap, beachballs, and on lower-RAM machines the OS can
  start killing renderer processes (a browser widget goes blank). This is the
  most likely path to instability today.

Non-browser widgets on one desk:
- up to ~30: no perceptible cost.
- 30-60: fine at rest; drag/pan with many wires begins to show frame drops, and
  minimap re-renders get heavier.
- 60-120: input latency on pan/drag becomes noticeable, especially with editors
  (page/markdown), a diagram, or 40+ wires in play.
- 120+: sluggish even at rest from React reconciliation and the no-cull mount
  cost; this is well beyond normal use but reachable on a "dump everything" desk.

Wires specifically: under ~20 are free; 30-50 start to matter during drag; 80+
make dragging visibly choppy because of the per-frame O(wires) bound reads.

Live agents: not a memory cliff but a CPU and cost one. Several interval agents,
or an agent driving a browser in a tool loop, add steady CPU and real API spend.
The risk is runaway cost and a busy browser, not RAM.

## 5. Stability risks, ranked

1. Browser-process memory exhaustion. The clearest failure mode. Many webviews,
   especially heavy SPAs, can exhaust RAM and trigger OS-level renderer kills
   (blank browser widgets) or heavy swap. No suspension of offscreen browsers
   makes this worse than it needs to be.
2. Compositor jank on browser-heavy desks. Even within memory limits, many live
   webview layers make pan/zoom stutter because nothing is culled.
3. Drag-time wire cost. O(wires) bound reads per animation frame during drags on
   wire-dense desks.
4. Agent browser-driving and intervals. CPU and API cost, plus an agent
   navigating a shared browser the user is also using.
5. Minimap re-render cost on very dense desks.

## 6. Recommendations, prioritized

The first two remove most of the risk for the least work.

P1. Suspend offscreen and hidden browsers. Add an IntersectionObserver (or a
pan/zoom-driven visibility check) in `WebViewWidget`; when a browser is fully off
screen or fully occluded, stop it doing work: mute audio, and ideally detach or
freeze it. Electron can `webContents.setBackgroundThrottling`, and a stronger
move is to unload the `<webview>` when far offscreen and reload its URL when it
returns. This directly attacks risk 1 and 2.

P2. Viewport-cull the canvas. In `Canvas.tsx`, skip mounting widgets whose
bounds are well outside the viewport (with a margin), so a giant desk only mounts
what is near view. Browsers benefit most. This attacks risk 2 and 5 and the
no-cull mount cost generally.

P3. Soft-cap and warn on browsers per desk. Track live webview count and, past a
threshold (say 8), surface a gentle "this desk has many browsers, performance may
drop" hint rather than a hard limit. Cheap, prevents the worst surprises.

P4. Throttle the wire overlay. Cap the `LinkOverlay` rAF to ~30fps during drag,
cache bound reads within a frame, and skip wires whose endpoints are offscreen.

P5. Throttle the minimap. Debounce its re-render and render simple rectangles
instead of full `WidgetPreview` previews above a widget-count threshold.

P6. Lazy-mount heavy widgets. Defer mounting Tiptap/React Flow/scratchpad until
the widget is near the viewport (a lighter version of P2 scoped to editors).

P7. A dev performance overlay. Surface `app.getAppMetrics()` (per-process memory
and CPU) and a live widget/webview/wire count so this analysis can be replaced
with real numbers and regressions caught.

## 7. How to measure for real

- `app.getAppMetrics()` in main returns per-process type, PID, CPU, and memory.
  Log it on an interval, or expose it in the dev overlay (P7). This is the single
  most useful instrument; it shows exactly how much each browser process costs.
- macOS Activity Monitor, filter for the app: you will see one row per webview
  renderer process. Open desks with 1, then 5, then 10 browsers and watch the
  total.
- Chrome DevTools Performance panel on the renderer window during a pan/drag on a
  wire-dense desk shows the `LinkOverlay` and minimap costs directly.
- `chrome://tracing` style frame profiling confirms compositor jank on
  browser-heavy desks.

Replace the estimates in sections 2-4 with measured values once P7 exists.
