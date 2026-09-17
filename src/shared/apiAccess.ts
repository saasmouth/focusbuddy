// Shared PlexiAPI types. The local REST API exposes workspace data and a few
// create actions to scripts and tools on the same machine, gated by scoped
// tokens. A token's raw value is returned exactly once at creation and only its
// hash is stored, so it can never be read back.

export type ApiScope = 'read' | 'write'

export interface ApiTokenPublic {
  id: string
  name: string
  scopes: ApiScope[]
  createdAt: number
  lastUsedAt: number | null
}

export interface ApiServerConfig {
  enabled: boolean
  port: number
  // Always 127.0.0.1; surfaced so the UI can show the base URL honestly.
  host: string
  // The live running state, which can differ from `enabled` if the port was busy.
  running: boolean
}

export interface CreateTokenResult {
  token: ApiTokenPublic
  // The raw bearer token, shown once and never stored in clear.
  secret: string
}

// One documented endpoint, for the in-app reference so the API is self-describing.
export interface ApiEndpointDoc {
  method: 'GET' | 'POST'
  path: string
  scope: ApiScope
  summary: string
}

export const API_ENDPOINTS: ApiEndpointDoc[] = [
  { method: 'GET', path: '/api/tasks', scope: 'read', summary: 'List tasks.' },
  { method: 'POST', path: '/api/tasks', scope: 'write', summary: 'Create a task. Body: { "title": "..." }.' },
  { method: 'GET', path: '/api/tables', scope: 'read', summary: 'List tables.' },
  { method: 'GET', path: '/api/tables/:id/rows', scope: 'read', summary: 'List rows in a table.' },
  { method: 'POST', path: '/api/tables/:id/rows', scope: 'write', summary: 'Add a row. Body: { "cells": { ... } }.' },
  { method: 'GET', path: '/api/knowledge', scope: 'read', summary: 'List knowledge entries.' },
  { method: 'POST', path: '/api/knowledge', scope: 'write', summary: 'Create a knowledge entry. Body: { "title": "...", "body": "..." }.' },
  // Plexii over MCP: point any MCP client (Claude Code directly; Claude
  // Desktop via the stdio bridge in tools/plexii-mcp-bridge) at this endpoint.
  // A read token gets search + read tools over desks, work items, documents,
  // tables, knowledge, calendar, flows and meeting Recall. A write token adds
  // create tools (work items, desks, knowledge, documents, table rows, time
  // blocks) and run-flow for WORKSPACE-INTERNAL flows only — a flow carrying
  // send-email or http-request is refused, so nothing on this surface deletes,
  // sends, or reaches off the machine. See docs/MCP.md.
  { method: 'POST', path: '/mcp', scope: 'read', summary: 'MCP endpoint — search, read and (write token) add to the workspace from AI tools.' }
]
