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

## Next

1. Service layer wiring connections management (add/test/rotate/reconnect/
   pause/disconnect), tool invocation (MCP + app API) with policy, home
   aggregation. Register schema in `migrations.ts`.
2. IPC `aispace:*` + preload `aiSpace` + derive scripts + web channel map +
   readOnly FEATURE_NAMESPACES.
3. Renderer: stores; views `aispace` (Home) and `airuns` (Runs) and
   `connections`; Desk view mode `ai` (Overview/Tasks/Outputs/Impact + PM pane
   + inspector); Settings tab; palette entries; shortcuts.
4. network-inventory.md rows; e2e spec (headless); gates.

## Rules from d0 for this branch

- Loopback MCP only when the person typed it ("on this Mac"); refuse
  loopback/private reached via redirects or discovered metadata.
- UI says plainly that AI Space projects stay on this Mac (no sync yet).
- Sidebar: add new lines only; 4.3.55 adds a `dot` prop to NavRow,
  CollapsedNavIcon and AreaAccordion Row (9e). Rebase after 4.3.55 ships.
- Usage + run log stay local; never sent to Plexii servers.
- Privacy wording + inventory rows are an owner-list item before release.
- ≤3 helper agents, load < 20, ask d0 before any full vitest/e2e run.
