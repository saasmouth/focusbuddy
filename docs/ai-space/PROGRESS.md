# AI Space + Connections: build progress

Branch `ai-space` in worktree `~/plexii-work/ai-space`, from focusbuddy main
342fc48c (2026-11-24). Session 19 builds; d0 (session 88) coordinates. Local
branch only: no push, no release, nothing to production.

Specs: `SPEC-AI-SPACE.md`, `SPEC-CONNECTIONS.md` (verbatim). Design decisions:
`DESIGN.md`.

## Done (unit-tested against real SQLite / local fakes)

| Layer | Files | Tests |
|---|---|---|
| Shared record types | `src/shared/aispace/model.ts`, `connections.ts` | — |
| Catalogue (honest certification) | `src/shared/aispace/catalogue.ts` | — |
| Impact engine + As of | `src/shared/aispace/impact.ts` | `aispaceStore.test.ts` (Trace a decision) |
| Return brief + bundles | `src/shared/aispace/brief.ts` | via runner tests |
| Policy (6 permission questions) | `src/shared/aispace/policy.ts` | TODO own test file |
| Egress rules | `src/shared/aispace/netPolicy.ts`, `src/main/aispace/net.ts` | via adapter tests |
| Schema (ais_*, local-only, triggers) | `src/main/aispace/schema.ts` | store tests |
| Project store | `src/main/aispace/store.ts` | `aispaceStore.test.ts` |
| Connections store | `src/main/aispace/connectionsStore.ts` | runner tests |
| Vault + broker | `vault.ts`, `broker.ts` | runner tests |
| Runner (durable, background, recovery) | `runner.ts` | `aispaceRunner.test.ts` |
| Project Manager coordination | `coordinator.ts` | `aispaceRunner.test.ts` |
| Model adapters (helper agent) | `src/main/aispace/providers/*` | `aispaceProviders.test.ts` |
| MCP client (helper agent) | `src/main/aispace/mcp/*` | `aispaceMcp.test.ts` |
| App API + Notion (helper agent) | `src/main/aispace/appapi/*` | `aispaceAppApi.test.ts` |

Mutation proofs run so far: Impact (inferred matches off; revision detection
off), coordinator (no follow-up bound; possible matches acted on), runner
(recovery skipped). Each went red and back to green.

## Renderer (built; unit-tested with a mocked window.api)

| Piece | Files | Tests |
|---|---|---|
| Shared UI (status, inspector, tabs, announcer, on-request updates) | `components/aispace/ui.tsx`, `aispace.css` | via screens |
| Navigation: views `aispace`, `airuns`, `connections`; Desk mode `ai`; sidebar rows; palette | `stores/view.ts`, `stores/deskView.ts`, `MainPane.tsx`, `ViewSelector.tsx`, `Canvas.tsx`, `Sidebar.tsx`, `nav/AreaAccordion.tsx`, `lib/areaTones.ts`, `CommandCenter.tsx` | sideMenuTones, plexiiHubNav |
| Home | `components/aispace/AiSpaceHome.tsx`, `NewProjectDialog.tsx` | `aispaceScreens.test.tsx` |
| Desk AI view (Overview, Tasks, Outputs, Impact, Manager pane, inspector, ⌘⇧K, ?) | `AiSpaceDeskView.tsx`, `Composer.tsx`, `OutputsPanel.tsx`, `ImpactView.tsx` | `aispaceScreens.test.tsx` |
| Undo (reorder, filing, match judgement) | store `unfileThread`, `reopenSuggestion` | `aispaceUndo.test.ts` |
| Connections screen (helper) | `ConnectionsView.tsx`, `connections/*`, `settings/ConnectionsSection.tsx` | `aispaceConnectionsView*.test.tsx` |
| Runs + run inspector (helper) | `RunsView.tsx`, `RunInspector.tsx`, `runs/*` | `aispaceRuns*.test.tsx` |
| E2E (written, NOT yet run: waiting for d0's window) | `tests/e2e/aiSpace.spec.ts` | 3 specs, `--list` OK |

## Commits (local branch `ai-space`, not pushed)

- `cefb05da` main-process foundation (record, Impact, policy, runner,
  coordinator, Connections, adapters, MCP, Notion, IPC).
- `832e6d9c` screens (Home, Desk AI view, Impact, Outputs, branches, Runs,
  Connections, Settings tab), NEEDS INFO requests, token rotation, undo.
- `822aea4a` automatic draft fixes opt-in, OFF by default (d0); Impact fix for
  inputs more than one version behind.

Gates at `832e6d9c`: 407 tests in 20 files green (AI Space + IPC, side-menu,
settings guards); node, web and webruntime typecheck clean; hooks lint clean.

## Next (needs d0's machine window)

1. Full `vitest` (the whole repo).
2. `npm run build`, then `npx playwright test tests/e2e/aiSpace.spec.ts`
   (headless, launchGuarded), then the affected existing e2e (desk view
   selector, sidebar, settings, palette).
3. Look at every screen in the built app (headless captures).
3b. Re-push `ai-space` WITH the pre-push hook on (no SKIP_MERGE_CHECK) so the
   branch head has passed merge-check. d0 allowed the one-time skip for
   e9d91b1c only, never for main.
4. Owner items: live provider checks (a few cents), certify one real remote MCP
   server, the privacy page wording, and "should automatic draft fixes default
   on?" (currently OFF: an explicit per-project opt-in since `822aea4a`).

## Rules from d0 for this branch

- Loopback MCP only when the person typed it ("on this Mac"); refuse
  loopback/private reached via redirects or discovered metadata.
- UI says plainly that AI Space projects stay on this Mac (no sync yet).
- Sidebar: add new lines only; 4.3.55 adds a `dot` prop to NavRow,
  CollapsedNavIcon and AreaAccordion Row (9e). Rebase after 4.3.55 ships.
- Usage + run log stay local; never sent to Plexii servers.
- Privacy wording + inventory rows are an owner-list item before release.
- ≤3 helper agents, load < 20, ask d0 before any full vitest/e2e run.
