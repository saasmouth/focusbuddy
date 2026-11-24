# Plexii Connections — product and implementation specification

Owner's specification, received 2026-11-24 as the companion to
`SPEC-AI-SPACE.md`. Kept verbatim; design notes live in `DESIGN.md`.

## Summary (owner's short form)

One Connections screen manages AI accounts, model APIs, external agents, MCP
servers and direct app APIs. Users authorise each service through its
supported method, choose which Desks can use it, and see what it can do, who
pays and what ran.

The spec covers the setup screens, credential storage, project and agent
permissions, usage limits, and what happens when a connection expires or a run
fails. It also defines the controls for testing, reconnecting, rotating keys
and disconnecting.

| Connection | What it enables in Plexii |
|---|---|
| AI web account | Open original chats and bring in selected content. Live sync depends on an official integration. |
| Model API | Run models from a Desk under the selected API account and budget. |
| External agent | Start, track, cancel or resume runs where the provider supports each action. |
| MCP server | Discover tools and grant access to specific projects and agents. |
| Direct app API | Authorise individual operations, such as reading a brief or creating a draft. |

A provider can appear once in the interface while showing which capabilities
each connection enables. For example, opening ChatGPT uses the browser
account, while running an OpenAI model through Plexii uses a separate API
credential and billing setup.

The first release proves the full workflow with OpenAI and Anthropic API
access, external chat links and selected imports, one remote MCP integration,
and one direct app API. From a single Desk, a user should be able to run a
model, call a tool, inspect the result and see which account authorised each
step. Broader provider support follows as each integration is verified.

---

Plexii gives people one place to see which AI accounts, models, agents and
tools they can use, which projects can use them, who pays and what ran. Sign in
to Plexii once. Authorise each outside service through its supported
connection method. Set project defaults so people can start work without
repeating setup.

This is a companion to the Plexii product and design scope. It uses Desks,
projects, the Project Manager, the global Runs view and Impact View.

## 1. What users can connect

| Connection | What the user adds | What Plexii can do |
|---|---|---|
| AI web account | Official account authorisation where offered, or an account link plus a supported capture method | Open original chats, import selected material, and sync only data covered by an official integration |
| Model API | Provider API key, delegated API authorisation or approved workload identity | Run supported models from Plexii and capture outputs and usage |
| External agent | Provider account authorisation or API credential with run access | Start, observe, cancel or resume according to the adapter's declared capabilities |
| MCP server | Trusted catalogue entry or server configuration, followed by authorisation where required | Discover and invoke approved tools and read permitted resources |
| Direct app API | Official connector, scoped token or service account | Perform individually approved operations such as finding a document or creating a draft |
| Local AI | Local runtime on a named device | Run compatible models on that device and record only the metadata allowed by workspace settings |

The same provider may appear under several cards. Group them visually under
the provider, but give each credential, identity, capability and billing
account its own state. A ChatGPT web login and an OpenAI API credential are
separate. OpenAI documents separate API billing. Claude API credentials come
from the Claude Console. Open web chat links in the user's selected browser
profile, with sign-in handled by that browser. Plexii excludes passwords, MFA
codes and browser session cookies from connection setup. Capture external work
through authorised APIs, supported exports, or content the user explicitly
selects. Import creates a dated snapshot with provenance and a link to the
original when available.

### Provider catalogue and certification

Start with dedicated adapters for OpenAI and Anthropic API access. Add Google
Gemini, Microsoft Azure OpenAI, AWS Bedrock, Google Vertex AI, Mistral, xAI,
Perplexity, OpenRouter, and local runtimes as separate adapters after
certification. Treat this list as planned coverage. Add consumer account and
external agent connectors independently of model support. Where an adapter
offers an OpenAI-compatible endpoint, treat compatibility as a transport
detail and verify actual capabilities before enabling them.

Each catalogue entry publishes supported authentication, account discovery,
models and modalities, streaming, task duration, usage reporting, run
features, endpoint regions, and data destination. A connection card uses
capability labels Open source, Import, Run model, Track run, Cancel run, and
Resume run. Only show a label when the corresponding capability has passed
testing. Test each adapter against account mismatch, expired credentials,
insufficient scopes and unsupported features before release.

## 2. Connections screen

Add Connections to workspace settings and a Manage connections shortcut in the
project composer, command palette and run inspector. Provide filters for AI
accounts, Models, Agents, MCP, App APIs and Local. Each card shows account
alias, provider organisation where known, credential owner, status, billed
account where known, last checked time, and eligible projects. Support
multiple identities per provider, for example Personal Claude and SaaSMouth
Claude.

Open a side panel with Overview, Access, Usage and Activity. Put Test
connection, Reconnect, Rotate key, Pause and Disconnect behind clear verb
labels. Show affected projects, agents and schedules before changing access.
Use the current Plexii design system. Reveal permissions when the user expands
a project, with keyboard access and reduced-motion support. Never move a
connection between spaces via an accidental drag. Project assignment uses an
explicit role and scope picker.

### Connect flow

1. Select a provider or enter a supported custom endpoint. Choose what you
   want to do, such as run models, capture chats or connect a tool.
2. Pick a personal or work workspace. Choose the intended provider account or
   project if discovery is supported.
3. Complete the offered authorisation. Open OAuth consent in the system
   browser. Return to the same draft setup after success, denial or timeout.
   For API keys, use a dedicated masked field with a link to the provider's
   key settings. Keep keys out of chat and support logs.
4. Verify with a read-only identity or capability check if available. Label
   any billable model test and obtain confirmation first. Show exactly what was
   confirmed.
5. Choose which projects can use the connection. Grant the minimum scopes
   needed. Preserve distinct grants for tools that read data and tools that
   take action.
6. Show the result with available capabilities, account and payer. Offer Set
   project default or Done. Support setup recovery when a user closes the
   provider tab halfway through.

### Status and repair

| State | What Plexii shows |
|---|---|
| Ready | Last verification and usable capabilities |
| Limited | Working capabilities and the action needed to enable others |
| Reconnect required | Expired or revoked authorisation and impact on work |
| Temporarily unavailable | Provider outage, rate limit, offline device, or observation gap with retry timing if known |
| Paused | Who paused it, when, and blocked work |
| Disconnected | Historical activity plus any outstanding provider-side revocation action |

Record health per capability. Mark a provider run Status unavailable if its
state cannot be observed and keep the last confirmed event. Distinguish a
paused Plexii schedule from a running job at an external provider.

## 3. Authentication and credential handling

Keep Plexii sign-in distinct from provider authorisation. An organisation's
single sign-on authenticates users to Plexii. Each external service still
needs its own grant or approved organisation credential.

Use authorisation code with PKCE for supported OAuth flows. Bind state to the
initiating user, workspace and connection attempt. Validate exact redirect
URIs, expected issuer and returned account identity using the provider's
supported mechanisms. Bind tokens to the intended resource where required.
Exchange codes in the credential-owning runtime. Refresh tokens with a single
in-flight refresh per connection and store rotated tokens atomically.

Store local-only credentials in the OS credential store. For explicitly
enabled hosted execution, use a tenant-scoped encrypted vault. Route calls
through a broker that resolves secrets at execution time. Models, threads,
provider payloads unrelated to auth, project exports and audit entries receive
no secrets. Cloud use of a device-only connection requires setting up an
eligible hosted credential.

Model a user grant, team-owned service account and local-device credential
independently. A team role grants access to use the connection within policy.
It grants no ability to extract its credential. Support least privilege and
short-lived workload credentials when available.

On disconnect, block new calls immediately, revoke upstream where supported,
remove the stored credential and reconcile in-flight work. Show if the user
must also revoke a key at the provider. Reconnect confirms identity against
the original before reattaching. A different identity creates a separate
connection.

On rotation, verify the replacement before switching. Never replay a write
whose result is uncertain. Keep historical run identities intact.

Enforce tenant isolation in every store and worker. Validate custom and
discovered endpoints and redirects with egress controls. Cloud workers must
reject private network destinations by default. Restrict local connections to
the authorised device and workspace. Redact secrets before logging and keep an
audit trail of administrative changes.

## 4. MCP client requirements

Plexii acts as the MCP host. Use Streamable HTTP for remote servers and stdio
for approved local servers. Pin compatible protocol revisions and negotiate
capabilities during initialisation.

**Remote setup.** Inspect the endpoint and show its verified origin. Follow the
MCP authorisation discovery flow for protected servers, using protected
resource metadata and authorization server metadata. Use the registration
mechanism supported by the server and the chosen protocol revision. Request
the minimum scope and obtain consent again for scope increases. Store the
token against the exact resource and connection. Never pass an MCP token
through to an unrelated API or reuse an upstream provider's token as a
substitute for MCP authorisation.

**Local setup.** Choose an approved package or executable. Show package source,
version and permission requests before launch. Run under a restricted process
identity with explicit directory mounts, environment access and network
permissions. Local configurations apply to a named device. Warn when a
scheduled run depends on an offline device.

**Tool discovery.** List tools, resources and prompts only where the server
advertises those features. Namespace each tool by server and connection. Keep
a versioned schema snapshot for reproducible runs and refresh on supported
change events. Material changes to schemas, endpoints or required permissions
trigger a new review before an existing grant permits use. Treat tool
descriptions, annotations and results as untrusted input. An MCP server's
claims about read-only operation are advisory.

**Tool invocation.** Present the chosen tool, account, touched data and side
effect when approval is required. Apply workspace policy, project grants and
agent-specific permissions per call. Tool output enters the project as
attributed evidence. It cannot grant permission, start unrelated work or
override user instructions. Reject write calls from unknown tools until
classified and authorised. Leave capabilities such as server-initiated
sampling and elicitation disabled until they have dedicated policy and review
flows.

## 5. Direct API integrations

Use provider adapters with declarative operation definitions. Each operation
has a stable ID, input and output schemas, read or write classification, auth
scope, approved destination, rate limit, timeout and retry rules. Support
official webhooks where available with signature verification, replay
protection, deduplication and tenant binding. Otherwise poll within an
adapter-specific rate limit. Preserve raw provider identifiers with normalized
states.

Release catalogue adapters first. For custom APIs, allow an administrator to
select operations from a reviewed OpenAPI definition or define an exact
request template. Bind credentials to approved origins. Define allowable
parameters and operation types before exposing any operation to agents.
Prevent tool input from changing the credential destination, redirects or
allowed network scope. Use a read-only sandbox or test account when
certifying an integration. Where MCP and a direct API provide the same action,
let the project select one connection and record that selection for each run.

## 6. How a project uses connections

| Permission question | Enforcement |
|---|---|
| Can this run use this connection? | Check workspace policy, project grant, user or service principal, and agent assignment |
| Can it send this file to that provider? | Check source permissions and destination policy before building the request |
| Can it invoke this exact action? | Check operation, granted scope, account, affected target and current approval |
| Can it spend this amount? | Check limits before running and track actual usage where available |
| Who signed or paid for the call? | Save the credential reference and billed profile, without secrets |
| Can it switch when the provider fails? | Ask before changing provider, billing identity, region, approval scope or data destination unless that exact fallback was pre-authorised |

Show the current model, connection alias and tool set in the composer. Allow
the Project Manager to choose from eligible models within project rules, and
show its choice in the run. Generate a run manifest with selected credentials
by reference, approved tools, input versions, ability to use hosted execution,
and budget. Recheck authority at each action. Do not let a run inherit a wider
grant when moving between projects or handing over to another AI.

For a SaaSMouth project, the Manager might send approved brief excerpts to a
writing model, let a research agent call a read-only source connector, and
route a site preview to the design agent as a versioned reference. Each step
records what went to which account and what came back. A later publish
operation requires its own authority. Impact View links decisions to affected
runs and outputs. It can show that a key was revoked and which drafts or
scheduled jobs need attention.

## 7. Usage, activity and reliability

Track reported usage by workspace, project, run, provider and connection.
Label costs Reported, Estimated, or Unavailable. For Plexii-controlled
requests, reserve estimated budget before dispatch, enforce available output
limits and reconcile when usage arrives. Provider-side usage outside Plexii
appears only where an approved reporting integration supplies it. Include
links to official billing pages and keep budgets distinct from provider
invoices.

Implement durable run events and idempotency for operations that support it.
After transient errors, retry safe reads with backoff. For writes, retry only
when an idempotency mechanism or reconciliation makes it safe. Show what work
completed and what is uncertain. Keep configuration changes, capability
changes, approvals, invocations and failures attributed and timestamped. Store
payload contents only under the workspace's chosen retention policy.

### Core records

- **Provider definition** holds adapter version, supported auth and capability
  descriptors.
- **Connection** holds owner, scope, provider account, region, billing
  profile, health and vault reference.
- **Grant** holds the project, agents, approved actions, data filters, expiry
  and approval level.
- **Operation** holds connector, schema version and action policy.
- **Invocation** holds run, principal, operation, input and output version
  references, approval, timestamps and provider identifiers.
- **Usage entry** holds quantities, currency, amount and reporting source.

## 8. Release order and acceptance

**Release 1.** Deliver the Connections screen, workspace and project grants,
OpenAI and Anthropic API setups, link and selected manual imports, one
certified remote OAuth MCP server, and one direct API adapter. Make test,
repair, replace and disconnect usable end to end. Display usage estimates and
an attributed run log.

**Release 2.** Add further certified model providers, supported external run
adapters and signed webhook ingestion. Release local MCP with device-scoped
permissions, followed by reviewed custom operations. Add team-owned
connections and cost allocation as team support matures.

| Acceptance test | Pass condition |
|---|---|
| Two accounts with one provider | A work project uses only the approved work connection. Personal route and usage remain separate |
| Web subscription and API key | An account link can open a chat. Running a model uses the selected valid API credential and shows its payer or an unknown payer state |
| Remote MCP consent | A read-only tool runs. Requesting a wider scope requires consent. A token for a different resource is rejected |
| Agent permissions | Untrusted prompt or tool output cannot select an ungranted operation or send protected data to another account |
| Custom endpoint | A cloud connector cannot reach a blocked network or send credentials to an unapproved redirect destination |
| Expiry and reconnect | A failed refresh pauses affected work, preserves inputs and restores eligible runs after the same account reconnects |
| Disconnect mid-run | New calls stop, historical outputs remain, and any external job of uncertain status stays visibly unresolved |
| Usage and fallback | Budget blocks an over-limit new request. A fallback with a different payer or destination requires an approved route |
| Daily use | Launch a model run, call an MCP tool and inspect a direct API action from one Desk. From Connections, see their account, scope, usage and recent activity without searching chat history |
