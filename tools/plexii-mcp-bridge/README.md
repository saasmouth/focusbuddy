# Plexii MCP bridge (Claude Desktop extension)

A dependency-free stdio → HTTP adapter so Claude Desktop and Cowork — which only run local stdio MCP servers — can reach the Plexii MCP endpoint on `127.0.0.1`. It forwards every JSON-RPC message to `POST /mcp` with the bearer token and writes the reply back. It has no protocol logic of its own: every tool, capability and refusal is decided by Plexii (`src/main/mcpServer.ts`).

Claude Code does **not** need this — see `docs/MCP.md` for the one-line `claude mcp add`.

## Build the `.mcpb`

```bash
npm install -g @anthropic-ai/mcpb        # once
cd tools/plexii-mcp-bridge
node scripts/gen-manifest.mjs            # from repo root if run there: node tools/plexii-mcp-bridge/scripts/gen-manifest.mjs
mcpb validate manifest.json
mcpb pack . ../../dist/plexii.mcpb
```

Signing (`mcpb sign`) is optional for personal use and required for org-managed distribution; see the [MCPB README](https://github.com/modelcontextprotocol/mcpb).

## Install

Double-click `plexii.mcpb` (or drag it onto the Claude Desktop window, or Settings → Extensions → Advanced → Install Extension…). Fill in:

- **Plexii MCP URL** — `http://127.0.0.1:8787/mcp` unless you changed the PlexiAPI port.
- **PlexiAPI token** — from Plexii → PlexiBrain → APIs. `read` for search/read only; `write` to let Claude add things and run flows.

Plexii must be running with PlexiAPI turned on.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PLEXII_MCP_URL` | `http://127.0.0.1:8787/mcp` | Must be `http://` on a loopback host; anything else is refused at startup. |
| `PLEXII_API_TOKEN` | — | Required. Never logged. |
| `PLEXII_MCP_TIMEOUT_MS` | `120000` | Per-request timeout. |

## Troubleshooting

- **"Plexii is not reachable"** — Plexii isn't running or the API server is off (PlexiBrain → APIs).
- **"Plexii rejected the token (401)"** — token revoked or mistyped; create a new one.
- **Write tools missing** — the token is `read`-scoped; that is by design.
- **Refusing a non-loopback host** — the URL points somewhere other than this machine; this bridge won't tunnel a token off-box.

Diagnostics go to stderr, which Claude Desktop shows in its MCP logs.
