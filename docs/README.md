# Plexii — Review & Roadmap (2026-06)

A complete, evidence-backed system review commissioned for a "no second chances" market-readiness assessment. Produced by 28 specialist agents (11 subsystem surveys + 3 browser-architecture analyses + 8 adversarial verifications + market critic), with the load-bearing claims independently verified against the real code, and six fixes implemented and proven (66 unit + 18 e2e GREEN).

## Read in this order

1. **[SYSTEM-REVIEW-2026-06.md](./SYSTEM-REVIEW-2026-06.md)** — the full audit. Headline verdict (38/100), the 12 critical issues with verification verdicts, a per-subsystem breakdown of all 11 areas, cross-cutting themes, and **§0: what was fixed & proven this session.**
2. **[BROWSER-ADR-001-in-canvas-browser.md](./BROWSER-ADR-001-in-canvas-browser.md)** — the headline decision: *"can we embed real Chromium and use Chrome plugins?"* Root causes (verified), the canvas-compositing tension, options analysis, the honest Chrome-extension verdict, and a 4-phase plan (Phase 1 shipped).
3. **[MARKET-READINESS-ROADMAP.md](./MARKET-READINESS-ROADMAP.md)** — the sequenced path from 38/100 to a paid launch: Safe → Sellable → Elite → Moat, with effort, dependencies, and a clear cut-line for "can charge money."

## TL;DR

- The product is genuinely differentiated with real craft, but sits on an **unsound base**: security, data-durability, and monetization each independently block a paid launch.
- The **browser headline is mostly a one-week fix** — and four of those fixes already shipped (clean UA, origin-gated autofill, click-overlay, permissions).
- It's **already real Chromium**, not "bespoke." Chrome extensions are possible but only on a native `WebContentsView` and only a *vetted subset* — never Web-Store parity.
- **Sequence beats heroics:** make it safe, then sellable, then elite, then the next big thing.
