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
