# e2e baseline — the full suite against pristine 4.3.32

**Run:** all 488 spec files at `widget-files` 93b5ef1a, serial (`workers: 1`),
no code changes. 3.0 hours.

| | |
| --- | --- |
| Passed | **1,284** |
| Failed | **382** |
| Skipped / did not run | 56 |
| Distinct error signatures | **38** |
| Spec files containing a failure | 158 of 488 |

## Why this was worth three hours

A suite that is 23% red cannot answer the only question a suite exists to
answer: *did I just break something?* Every change in this codebase currently
begins with archaeology — proving a failure is pre-existing before you may
ignore it. That tax is paid on every future change, and it compounds.

**382 failures, 38 signatures.** They are not 382 problems. The suite fails in
clusters, and a handful of root causes account for most of it.

## The clusters

| Count | Signature |
| --- | --- |
| 143 | Test timeout exceeded |
| 103 | `expect(locator).toBeVisible()` failed |
| 46 | `Execution context was destroyed, most likely because of a navigation` |
| 17 | `locator.click` timeout |
| 16 | `expect(received).toBe(expected)` |
| 57 | the remaining 33 signatures |

### What they are waiting for

| Waited on | Failures | In `src`? |
| --- | --- | --- |
| `plexisearch-view` | 52 | **yes** |
| `office-folder-New folder` | 24 | — |
| `assistant-question-card` | 16 | yes |
| `canvas-task-header` | 12 | **gone** |
| `map-add-process` | 12 | **gone** |
| `upgrade-prompt-modal` | 8 | **gone** |

## The three findings that matter

**1. The largest cluster is a removed route, not a broken feature.** 52
failures wait for `plexisearch-view`. That view exists and is live — `MainPane`
routes to it. What the tests navigate *through* is gone:
`product-tile-plexisearch`, `product-home-plexisearch` and `open-plexisearch`
are all absent from `src`. The product-tiles surface was removed; the tests
still walk through it. These are stale paths, and fixing the helper they share
should retire most of the cluster at once.

**2. A cluster of 46 is one stray navigation.** "Execution context was
destroyed" concentrates in `webhookOutbound` (9), `automationsPanel` (7),
`sectionChildLinkArming` (6), `uniformBodyText` (6), `wireTrustLayer` (6) —
the wire/automation family. Something in that flow navigates mid-test. Worth
noting a real instance of exactly this bug was found and fixed by hand this
week: the widget-file store's `create()` navigated to the new file full-pane,
which broke dropping onto a dashboard. The same shape, elsewhere.

**3. Only one failure is unambiguously the app being wrong**
(`contextEngineLiveWire` — a real error thrown). That is a good sign about the
product and a bad one about the suite: 381 of 382 failures are telling you
about the tests, not the software.

## Orphans found on the way

- **`OrgSwitcher` is imported nowhere.** The component, its four testids and
  its spec all exist; nothing mounts it. Its spec fails because the feature is
  gone, not because it regressed.
- **`index.html` is a tracked build artefact.** Every build rewrites its asset
  hashes and dirties the tree, adding noise to the same "is this mine?"
  question. Cheap to gitignore.

## The order to fix in

1. **The shared navigation helpers** — the plexisearch route and the
   office-folder path. Highest ratio of failures retired to work done.
2. **The stray navigation** in the wire/automation family — one cause, 46
   failures, and it is the kind of bug that is real for users too.
3. **The dead testids** (`canvas-task-header`, `map-add-process`,
   `upgrade-prompt-modal`) — decide per surface whether the feature was removed
   deliberately. Where it was, delete the test; where it was not, that is a
   genuine regression hiding in the red.
4. **`contextEngineLiveWire`** — the one real error.
5. Re-run, and hold the line at zero.

Only then is the suite able to protect a data-model change, which is what
multi-device sync is.

## Method

`PLAYWRIGHT_JSON_OUTPUT_NAME` + `--reporter=list,json`, classified by
`/private/tmp/claude-501/baseline/classify.mjs`. Testid existence was checked
against `src` rather than assumed, because the opposite assumption — that a
test failing on a missing selector means the selector is gone — is wrong in
most of these cases: the selector exists and the route to it does not.
Failures are deliberately bucketed into three, not two: anything the evidence
could not place is marked for a human rather than guessed into "stale", since
a test wrongly called stale gets edited to pass and locks a real bug behind a
green tick.
