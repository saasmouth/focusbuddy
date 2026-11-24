# PlexiiAi Space — product, interaction and build scope

Owner's specification, received 2026-11-24. Kept verbatim as the source of
truth for the `ai-space` branch. Design notes and progress live beside it in
`DESIGN.md` and `PROGRESS.md`; this file is not edited to match the build.

## Product promise

Open Plexii and see what changed across your AI work, what it affects and what
you can do now. Ask several AIs to work on a project, leave, and return to
usable outputs and decisions that need your attention.

## Product decision

Build this inside Plexii. A project uses a Desk and can live in an existing
Room. Tasks can contain subtasks. Chats, runs and outputs attach to the work
automatically when launched from the Desk. Personal and work projects use the
same interface with separate access. The flagship experience brings people
back to the work they already started.

## 1. Navigation and screens

| Destination | Default contents | Primary actions |
|---|---|---|
| Home | Since your last visit, work needing you, active runs across projects | Review, resume, reply, dismiss, start work |
| Project Desk | Goal, Project Manager conversation, tasks and current outputs | Ask, assign, attach sources, branch, approve |
| Impact View | Changes and the exact work affected, ordered by consequence | Inspect evidence, compare, request revisions |
| Outputs | Documents, Sheets, Slides, Images, Canvases, Sites, Code, Media and Other Files | Open, compare versions, reuse, export |
| Runs | Queued, running, waiting, succeeded, failed, cancelled and unavailable status | Inspect, pause where supported, retry, stop, continue elsewhere |
| Search | Projects, chats, tasks, outputs and decisions across permitted spaces | Open in context, filter by project, provider, person or type |
| Settings | Connections, model preferences, access, project budgets and notifications | Connect, revoke, set defaults, inspect activity |

Keep existing Plexii navigation intact. Add Home and cross-project Runs as
workspace entry points. Inside a Desk, use a compact switcher for Overview,
Tasks, Outputs and Impact. Keep the Project Manager available in a collapsible
pane with its own history. Anything opened in an inspector has a stable link
and can be expanded to fill the Desk.

### Start and capture

Start with a message, pasted link, file drop or existing Desk. The composer
shows the project, intended assistant and included sources before sending. An
informal request can stay a chat or become a task with a deliverable. For an
unfiled capture, suggest up to three matching projects and offer an inbox.
Preserve original location and capture time.

Support three connection levels. Linked opens the original chat. Imported
stores the selected messages or output and records when they were captured.
Connected can start or track a run when the provider supports it. Show these
levels where people expect a status. Carry connection capabilities explicitly,
including start, read output, watch, cancel and resume. External progress that
cannot be observed displays Status unavailable with the last known update.

### Outputs

Use one stable entry per output. Its location follows its type. Cards show a
real preview, task, branch and review state. Track separate pointers for
latest draft and approved version. Preview each without overwriting either.
Versions record author, sources and what changed. Sites show a preview,
published version and domain status where connected. Canvases preserve layout
and support references to specific output versions. Dragging a reference into
multiple places keeps it linked to one original. Offer Use approved version and
Pin this version when referencing an output.

### Tasks, runs and branches

A task defines an outcome and can have several runs. A completed run may still
leave its task awaiting review. Tasks can have explicit dependencies. New runs
get only the sources relevant to their task and within their access. Show the
source list in the run inspector.

A branch starts from a named snapshot of the project brief and relevant output
versions. It can contain multiple tasks and agents. Compare branches in a
shared review panel with actual outputs, assumptions, evidence and estimated
remaining work. Bring back selected changes with a diff. If the main version
changed meanwhile, require conflict resolution before applying the selection.

## 2. Flagship view — Impact

Read the project by consequence. Give each meaningful change a row. Keep stable
columns for What changed, What it affected and What you can do. The middle
column contains the actual outputs and runs. Expand any affected item in place
to see the relevant paragraph, image preview, task or run step. Other rows stay
anchored. The user can follow the consequence into its source and return at the
same scroll position.

Example row from a SaaSMouth project:

| What changed | What it affected | What you can do |
|---|---|---|
| Client approved a 30-day trial. Previously 14 days. Open source. | Site hero has a revision. Image 03 still says 14 days. Tomorrow's email run uses the old brief. | Compare hero · Queue image revision · Update email brief |

Give each relation a visible reason. Used this version means the input was
recorded. Possible match means the system inferred it. Show the exact evidence
before review. If a suggestion resolves a missing input, show the task that
asked for it and the finding supplied. If an agent already acted, display its
change and the source it used.

An As of control reconstructs the project at a selected point from recorded
versions and events. Use it to compare When I left with Now. Keep headings and
object positions consistent between states. When browsing history, actions
explicitly target the current project or create a new branch from that point.
On mobile, each change becomes a vertically stacked card with the same order
and controls.

When multiple changes affect the same output, group them under one proposed
revision and list the contributing changes. Default to decisions due, material
conflicts and completed work the user can use. Offer an activity tab for a full
chronology. This layout is an original design proposal for Plexii. Market-wide
novelty has not been verified.

## 3. Project Manager and agent behaviour

Every project has a Project Manager with access to its brief, decisions, tasks,
approved sources, run events and version history. The Manager prepares a
return brief from the user's last viewed position. Show up to three
consequential updates, each with an action and a source. Opening the brief
does not clear unresolved requests. Mark decisions resolved only when the user
acts or the project records a resolution.

| Event | Expected behaviour |
|---|---|
| Approved input changes | Find recorded dependants, flag possible matches and ask assigned agents for draft fixes within budget |
| Agent needs information | Record the missing input, intended recipient and what can proceed while waiting. Match later evidence and deliver it with its source |
| Agents disagree | Record where they differ. If it would change a decision and budget permits, prepare small comparable drafts or ask the user to choose |
| Output is ready | File it, capture version and provenance, notify dependent tasks and surface it for review if needed |
| Run fails or stops | Save verified progress, blockers and files. Offer retry or handover with action history |
| User returns | Explain what changed, which work is usable and what decision or parallel action would help most |

Agents can suggest changes to each other through project events. Each
suggestion includes recipient, target item, evidence and proposed action. The
recipient records whether it acted, deferred or dismissed it. Deduplicate by
event, target version and proposed action. Bound the number of automatic
follow-ups and stop on repeated disagreement, budget exhaustion or missing
permission. Allow draft revisions within the project's configured authority.
Approvals, external publishing and sending follow explicit project permissions
and approval rules. Treat imported text as source material. It cannot grant
permissions or trigger external actions by itself.

Options in a return brief may bundle several activities. One click can approve
the scope of a bundle containing, for example, a site revision, ads drafted in
parallel and a separate claim check. Preview the scope, estimated usage and
dependencies before approval. Display partial success by activity. Keep
successful work available if another activity fails.

## 4. Visual design

Use Inter, dark mode by default and a purple Plexii identity. A graphite shell
surrounds a slightly lighter work area. Use soft, narrow borders, flat surfaces
for text and full-colour previews for the actual work. Reserve purple for
selection, keyboard focus and the primary action. Use icon plus text for
status. Provide a light theme using the same hierarchy.

| Element | Design instruction |
|---|---|
| Desktop grid | 224 px navigation, flexible workspace, optional 360 px inspector. Inspector overlays at narrower widths and docks on wide screens |
| Type | 28 px project titles, 18 px section titles, 14–15 px body, 12 px metadata. Use tabular numerals for timings |
| Density | 8 px spacing grid, 16–24 px within cards, 24–32 px between sections. Keep one main action per row |
| Preview | Images use their real aspect ratio. Sites use a live or clearly dated preview. Document cards show the relevant excerpt when opened from Impact |
| Empty states | Give one meaningful action. A new Desk offers to start a chat or bring in existing work |
| Focus | Expand a deliverable to fill the Desk. Keep project, branch and current version visible. Restore the previous view on exit |

Avoid persistent glow and large decorative gradients. Let the work supply
visual variety. At the Desk level, give the current deliverable more space than
its status controls.

## 5. Interaction and motion

| Interaction | Behaviour | Equivalent control |
|---|---|---|
| Drag an output into chat or task | Preview the reference and version before drop. Preserve original. Confirm if it crosses an access boundary | Attach or Link menu |
| Drag a task | Show valid destinations and placement. Reorder tasks or propose a move. Changes to project access or task dependencies require confirmation | Move menu |
| Expand & collapse | Open details inline for one change, or open full width for comparison. Retain focus and scroll on close | Enter to open, Escape to close |
| Slide | Slide the inspector from the right on desktop and up as a sheet on touch. Save its width per device | Toggle inspector control |
| Swipe | Swipe between output versions inside comparison mode. Reveal secondary actions on a task row. Neither gesture commits a destructive action | Previous, Next and More buttons |
| Compare | Pin two versions or branches. Keep document scroll aligned when headings match. Offer independent scroll for uneven content | Compare menu |
| Undo | Offer undo after reordering, filing or dismissing. Represent external actions as recorded events with any available reversal shown separately | Undo button or shortcut |

### Motion that explains state

120–160 ms for selection and small feedback. 180–220 ms for inline expansion
and inspector movement. 240–300 ms for the transition between an output card
and its full preview.

When an action creates a revision, briefly highlight the version row that
changed. When a new event arrives during reading, show New updates above the
list. Apply updates on request so content does not move under the pointer.

During drag, keep a placeholder in the source list and label valid targets
Link, Move or Add as input. Maintain hover previews without committing changes.

Render measured progress when available. For uncertain duration, display the
last confirmed step and time. Completion has one brief visual change and an
accessible announcement.

Respect reduced motion with instant layout changes or a short fade. Support
keyboard-only use, visible focus, screen-reader announcements, 44 px touch
targets and status conveyed by text as well as colour.

### Shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+K | Search and commands |
| Cmd/Ctrl+Shift+K | Find or switch project |
| Cmd/Ctrl+Enter | Send the focused draft in chat |
| Enter | Open the focused item |
| Escape | Close the topmost view and return focus |
| Cmd/Ctrl+Z | Undo the last reversible workspace action where the workspace owns focus |
| ? | Show shortcuts outside text fields |

Expose shortcuts in menus and provide remapping where operating-system or
browser conflicts arise. Preserve normal text editing when fields are focused.

## 6. Build instructions

Implement the shared project record. Define workspaces, projects, tasks,
threads, runs, outputs, immutable output versions, decisions, branches,
suggestions and activity events. Link them by stable IDs. Record which versions
a run consumed and emitted. Store actor, timestamps, scope and visibility on
events. Keep permissions consistent across search, previews, agent inputs and
notifications.

Build normal entry points. Start and resume work from chat, Desk, output and
Home. Ship two model providers through a shared adapter and one trackable
background agent. Use durable job state for work expected to continue after
the desktop closes. Show local execution limits where applicable. Ensure
reconnects and duplicate events do not duplicate runs or outputs.

Build output browsing and review. File outputs by type, render previews,
separate draft from approved, support links and exports, and make selection and
comparison work from the Impact View.

Implement project coordination. Start with recorded dependencies and
event-driven draft revisions. Add evidence-backed suggested links. Check
authority and budget before each invocation. Reject stale writes against
changed versions and surface a diff when review is needed. For any external
action with an uncertain outcome, reconcile before retry.

Build Home and Impact together. Generate return updates from events with
explicit references. Deep-link from the summary into the affected work and
back. Implement the current and historical views using the same underlying
records.

Add branches, recoverable handovers and higher-capability connections. Track
the source snapshot and permit selective merge. Test provider capability and
permission individually before enabling live external status or cancellation.

### Release cut

| Release | User can complete |
|---|---|
| First working release | Launch AI work from a Desk, capture outside chat links and selected outputs, browse standard output homes, open a brief and trace a verified change to the affected work |
| Coordination release | Receive targeted suggestions across agents, review a batch of draft fixes, run parallel tasks, compare branches and reuse selected changes |
| Expanded release | Track more external runs through supported connections, use historical comparison, switch agents with a verified handover and share selected context between permitted projects |

## 7. Acceptance tests

- **Return to work.** After a day away, a tester can identify the current
  deliverable, the reason for a change and their next decision within 30
  seconds of opening Home.
- **Trace a decision.** Change a mock offer from 14 to 30 days. Surface an
  affected site, image and scheduled run with the right evidence and status.
  Present an inferred match as a possibility. Preserve approved and published
  versions until explicitly changed.
- **Prove cooperation.** An agent asks for evidence. A second agent adds a
  source later. The first agent receives it once, proposes a draft revision and
  records what the source supports.
- **Restore work after failure.** Disconnect an active provider, reopen Plexii
  and resume or hand over verified work. Never claim a completion or repeat an
  external action whose result is uncertain.
- **Exercise branches.** Start two draft directions, apply one part to the main
  output and detect a version conflict if the main output changed during the
  review.
- **Verify privacy.** A personal project is absent from work search,
  suggestions and notifications when that context lacks permission. Share one
  authorised reference and confirm that only the intended content is visible.
- **Verify interaction.** Complete the same review and filing flow with a
  mouse, keyboard and touch. Repeat with reduced motion and a screen reader.
  Confirm that failures preserve inputs and restore focus.
- **Measure repeat use.** Run one real SaaSMouth project for a week. Record
  return time, useful changes caught, agent contributions kept, missed impacts
  and irrelevant suggestions. Check whether the user opens Plexii first without
  a reminder.

The first product decision to revisit after testing is automatic action. If
people trust recorded handoffs but routinely reject inferred ones, keep
automatic changes limited to known dependencies and improve the evidence shown
for suggestions before increasing autonomy.
