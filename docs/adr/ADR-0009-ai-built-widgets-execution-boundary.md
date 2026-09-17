# ADR-0009 — AI-built widgets: where generated code executes

Status: ACCEPTED, implemented 2026-09-15. Covers the `custom` widget kind, the `fb-widget:` scheme, and `src/shared/customWidgetSandbox.ts`.

## Context

The Custom widget lets a user describe a tool in plain language and have the model write it, on the desk, in seconds. The request that produced it asked for a widget builder "without limitations".

That phrase has two readings and they pull in opposite directions. Unlimited in *what a widget can be* — any layout, any interaction, any logic — is the point of the feature and is worth building. Unlimited in *what a widget can reach* would mean running unreviewed, machine-written JavaScript with the privileges of an Electron renderer that holds the user's entire workspace, their API keys and a preload bridge to the filesystem. Nobody asked for the second thing; it is just what you get by default if you do not decide otherwise.

So the boundary is not a compromise on the feature. It is what makes the feature shippable.

## The constraint that decided the design

The obvious implementation is `<iframe srcdoc="...">` holding the generated document. It does not work, and it fails in the worst available way: silently and half-way.

`about:srcdoc` is a *local scheme*, and local schemes inherit the embedding document's Content-Security-Policy. This renderer ships `script-src 'self'`. A generated widget therefore rendered its markup perfectly and had every line of its JavaScript refused. A calculator would draw its buttons and do nothing when clicked, and nothing in the app would say why.

This was found by measurement, not review. It is recorded here because the failure is invisible in code reading — the markup is there, the script tag is there, and the only evidence is a console refusal inside a frame nobody is looking at.

## Options considered

**A — `<iframe srcdoc>`.** Rejected: inherits the renderer CSP, so generated code never executes. Not a trade-off; simply broken.

**B — relax the renderer's CSP to allow inline script.** Rejected outright. It would weaken the policy protecting the entire application in order to accommodate the least trusted code in it — exactly backwards.

**C — a `blob:` URL.** Rejected: `blob:` is also a local scheme and inherits CSP identically. Same failure, more indirection.

**D — an Electron `<webview>`.** Viable and gives process isolation, but it is heavier, Electron discourages it, and it brings a guest-page lifecycle the desk does not otherwise need.

**E (chosen) — serve each widget from its own `fb-widget:` scheme.** A document fetched from a real scheme has its own origin and carries its own policy; the embedder's CSP is not inherited. Main owns the handler, so the document is always built from the widget row as it stands, and the widget's saved state is inlined at compose time with no round-trip.

## Decision

A Custom widget's document is served by `protocol.handle('fb-widget')` in the main process, from a scheme registered `standard: true, secure: true, bypassCSP: true`, and is loaded into an `<iframe sandbox="allow-scripts">` — deliberately **without** `allow-same-origin`.

The scheme changes *where the document comes from*. The sandbox attribute still governs *what it may touch*. Those are separate mechanisms and both are required: the scheme alone would give generated code a normal origin with storage and cookies; the sandbox alone left it unable to run.

Three further rules:

1. **The handler serves only `kind = 'custom'`.** Without that check the protocol would render any widget's content as a live document, turning a sticky note into an execution surface. This is asserted by an e2e test, not left to the handler's shape.
2. **The security preamble is injected by the host, never requested from the model.** CSP, theme variables and the `plexi` bridge are spliced ahead of the model's markup by `composeCustomWidgetDocument`. A control the model has to remember to include is not a control.
3. **Network egress is off by default.** `connect-src 'none'` unless the user opts a specific widget in. A widget holds what the user typed into it; being able to fetch is also being able to post.

## What this actually buys

Measured in the booted application (`tests/e2e/customWidgetSandbox.spec.ts`), from inside a generated widget:

| Attempt | Result |
| --- | --- |
| generated script executes | **yes** — the thing srcdoc could not do |
| `parent.document` | `SecurityError` |
| `parent.api` (preload bridge) | `SecurityError` |
| `localStorage` | `SecurityError` |
| `document.cookie` | `SecurityError` |
| `top.location.href` | `SecurityError` |
| `fetch()` with network off | blocked by CSP |

## Consequences

- Generated widgets cannot use `localStorage`. They persist through `plexi.setState()`, which the host writes into `widget.content` — so their data syncs, backs up and exports like every other widget's, which is better than browser storage would have been anyway. The system prompt tells the model this explicitly, because a model that reaches for `localStorage` produces a widget that throws on load.
- Web Workers, plugins and nested frames are unavailable (`default-src 'none'`). No widget has wanted one yet; revisit if that changes rather than pre-emptively widening.
- `custom` is deliberately **absent** from `PUBLIC_CAPTURE_ALLOWED`. Capture publishes rendered markup to a viewer rendered by code outside this repository, and unreviewed script is not something to publish on the assumption that someone else's renderer will re-sandbox it. It projects as `'text'` instead, which discloses the user's description and entered values and executes nothing.
- `allow-same-origin` must never be added to `SANDBOX_ATTR`. That single token collapses everything above, so `sandboxAttrIsSafe()` exists purely to fail a test if anyone tries.

## Amendment — 2026-09-17: reading wired sources, and asking the host to act

A widget that can only hold what the user typed into it is a notepad with a
calculator in it. The request that prompted this asked for widgets that take
information from elsewhere on the desk and do something with it.

**Nothing above changed.** Same `fb-widget:` scheme, same `allow-scripts`
without `allow-same-origin`, same `default-src 'none'`, same network-off
default. `SANDBOX_ATTR` is untouched and `sandboxAttrIsSafe()` still fails a
test if anyone widens it. What widened is the **bridge** — the `postMessage`
channel the host already owned — so every new capability is something the host
performs and the frame merely requests.

### Reading: `plexi.getInputs()` / `plexi.onInput(fn)`

A widget sees the widgets the user has **wired into it**, and nothing else.
There is deliberately no query interface: the access grant is the wire, drawn by
the user, visible on the canvas as a line, and revoked by deleting it. Inputs are
resolved in main (`db/widgetInputs.ts`) and inlined at compose time, so a widget
renders real data on its first frame; a change to a wired source pushes a fresh
snapshot in.

Tables arrive **structured** — columns and rows with cells keyed by column id —
rather than flattened to text. A widget that receives rows can total a column; one
that receives a rendering of a table can only scrape it.

### Acting: `plexi.act(action)`

Three rules, and the second is the one that matters:

1. **A closed verb list** (`customWidgetActions.ts`): `add-table-row`,
   `set-cell`, `create-knowledge-entry`, `open-url`. An unknown verb is refused,
   not queued for later support.
2. **Scoped to its wires.** A widget may only act on a source wired into it.
   Without this, granting one widget write access would grant it every table in
   the workspace. It is enforced host-side against the database, and asserted in
   `customWidgetBridge.spec.ts` rather than left to the policy function's shape.
3. **Consent once, not never and not constantly.** Writes are off by default
   (`acts`, the same shape as `net`). Off, every write is put to the user. On,
   writes inside the widget's own scope run directly — because a tool that asks
   permission on every row is a tool nobody keeps. Turning it on widens how often
   a widget asks, never what it can reach.

Actions execute through `applyProposal` — the same executor the assistant's
proposals use — so a widget can do nothing the assistant could not, and inherits
the same validation and the same audit trail.

### What this buys, measured

`tests/e2e/customWidgetBridge.spec.ts`, in the booted app: a widget reads its
wired table's real columns and rows; a widget whose wire is cut sees `[]`; a table
on the same desk but not wired in is absent from the widget's action scope. The
same run re-asserts that `parent.document`, `parent.api` and `localStorage` are
still `SecurityError` — because "we widened the bridge, not the sandbox" is a
claim until the application says otherwise.
