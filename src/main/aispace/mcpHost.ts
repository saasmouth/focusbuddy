// Plexii as MCP host for Connections (SPEC-CONNECTIONS.md §4).
//
// Wraps the MCP client (./mcp) with Connections records: inspect an endpoint
// and show its verified origin first; add it; sign in through the system
// browser when the server is protected; snapshot its tools for review; serve
// tool calls to the tool gateway (which owns policy). Tokens live in the vault
// as one JSON value per connection, bound to the exact resource.
//
// Loopback ("on this Mac") is allowed only when the person TYPED a loopback
// address; the client refuses loopback/private targets reached through
// redirects or discovered metadata for any other connection.

import { randomUUID } from 'node:crypto'
import type { AiSpaceStore } from './store'
import type { ConnectionsStore } from './connectionsStore'
import type { Vault } from './vault'
import { vaultRef } from './vault'
import type { McpCaller } from './tools'
import { isLoopback, validateEndpoint } from '@shared/aispace/netPolicy'
import { checkDestination } from './net'
import type { ConnectionCard, McpAddResult, McpAuthorizeResult, McpInspectResult } from '@shared/aispace/api'
import { McpClient, McpError, authorizeMcpServer, canonicalResource, diffSnapshots, discoverAuthorization, toolsToOperations } from './mcp'
import type { McpNetOptions, McpOperation, McpTokenStore, McpTokens } from './mcp'

export interface McpHostDeps {
  store: AiSpaceStore
  conns: ConnectionsStore
  vault: Vault
  emit?: (p: { topic: string }) => void
  openExternal?: (url: string) => Promise<void>
  clientVersion?: () => string
  // Tests: extra net options (fetchImpl, allowLoopback).
  netExtra?: McpNetOptions
  // The service's card builder, so results carry the same shape as every list.
  card: (connectionId: string) => ConnectionCard
}

export type McpHost = ReturnType<typeof createMcpHost>

export function createMcpHost(deps: McpHostDeps) {
  const { conns, vault } = deps
  const clients = new Map<string, McpClient>()

  const tokenStore: McpTokenStore = {
    async get(connectionId) {
      const raw = vault.get(vaultRef.oauth(connectionId))
      if (raw) {
        try {
          return JSON.parse(raw) as McpTokens
        } catch {
          return null
        }
      }
      // A static bearer token (servers that issue one instead of OAuth).
      const c = conns.getConnection(connectionId)
      const bearer = c?.config.authMode === 'bearer' ? vault.get(vaultRef.key(connectionId)) : null
      if (bearer && c?.endpoint) return { accessToken: bearer, refreshToken: null, expiresAt: null, scope: null, resource: canonicalResource(c.endpoint), tokenEndpoint: '', clientId: '', issuer: '' }
      return null
    },
    async set(connectionId, tokens) {
      vault.set(vaultRef.oauth(connectionId), JSON.stringify(tokens))
    },
    async clear(connectionId) {
      vault.clear(vaultRef.oauth(connectionId))
    }
  }

  async function openExternal(url: string): Promise<void> {
    if (deps.openExternal) return deps.openExternal(url)
    const { shell } = await import('electron')
    await shell.openExternal(url)
  }

  function version(): string {
    try {
      return deps.clientVersion?.() ?? '1'
    } catch {
      return '1'
    }
  }

  function netFor(endpoint: string, local: boolean): McpNetOptions {
    return { ...(deps.netExtra ?? {}), localEndpoint: local && isLoopback(new URL(endpoint).hostname) }
  }

  function clientFor(connectionId: string, interactive = false): McpClient {
    const c = conns.getConnection(connectionId)
    if (!c || !c.endpoint) throw new Error('MCP connection not found.')
    if (!interactive) {
      const cached = clients.get(connectionId)
      if (cached) return cached
    }
    const client = new McpClient({
      connectionId,
      endpoint: c.endpoint,
      clientVersion: version(),
      auth:
        c.config.authMode === 'none'
          ? null
          : {
              tokenStore,
              interactive: interactive ? { binding: { userId: 'me', workspaceId: c.workspaceId, connectionAttemptId: randomUUID() }, openExternal, clientId: c.config.clientId ?? null } : null
            },
      net: netFor(c.endpoint, Boolean(c.config.localEndpoint)),
      onToolsListChanged: () => void refreshTools(connectionId),
      onServerRequestRefused: (r) => {
        const conn = conns.getConnection(connectionId)
        if (conn) deps.store.appendEvent({ workspaceId: conn.workspaceId, projectId: null, actor: `connection:${connectionId}`, kind: 'connection.status_changed', subject: { type: 'connection', id: connectionId, label: conn.alias }, summary: `${conn.alias} asked Plexii for ${String((r as { method?: string }).method ?? 'something')}; refused (not enabled).`, data: {}, visibility: 'workspace' })
      }
    })
    if (!interactive) clients.set(connectionId, client)
    return client
  }

  async function dropClient(connectionId: string): Promise<void> {
    const c = clients.get(connectionId)
    clients.delete(connectionId)
    try {
      await c?.close()
    } catch {
      /* closing a session that is already gone */
    }
  }

  // Show the verified origin and what the server needs, before any credential.
  async function inspect(endpoint: string): Promise<McpInspectResult> {
    const raw = endpoint.trim()
    let host = ''
    try {
      host = new URL(raw).hostname
    } catch {
      return { ok: false, origin: null, onThisMac: false, reason: 'That isn’t a valid web address.', needsAuth: null, authServer: null, scopes: [] }
    }
    const onThisMac = isLoopback(host)
    const v = validateEndpoint(raw, { allowLoopback: onThisMac })
    if (!v.ok || !v.url) return { ok: false, origin: null, onThisMac, reason: v.reason, needsAuth: null, authServer: null, scopes: [] }
    try {
      await checkDestination(v.url.toString(), { allowedOrigin: v.url.origin, allowLoopback: onThisMac || deps.netExtra?.allowLoopback })
    } catch (e) {
      return { ok: false, origin: v.url.origin, onThisMac, reason: e instanceof Error ? e.message : String(e), needsAuth: null, authServer: null, scopes: [] }
    }
    const probe = new McpClient({ connectionId: `probe_${randomUUID()}`, endpoint: v.url.toString(), clientVersion: version(), auth: null, net: netFor(v.url.toString(), onThisMac) })
    try {
      await probe.connect()
      return { ok: true, origin: v.url.origin, onThisMac, reason: 'Open server: no sign-in needed.', needsAuth: false, authServer: null, scopes: [] }
    } catch (e) {
      if (e instanceof McpError && e.code === 'reconnect_required') {
        try {
          const d = await discoverAuthorization(v.url.toString(), e.challenge, netFor(v.url.toString(), onThisMac))
          return { ok: true, origin: v.url.origin, onThisMac, reason: 'Sign-in needed. You’ll approve access in your browser.', needsAuth: true, authServer: d.issuer, scopes: d.scopesSupported ?? [] }
        } catch (e2) {
          return { ok: true, origin: v.url.origin, onThisMac, reason: `It needs sign-in, but its sign-in details couldn’t be read: ${e2 instanceof Error ? e2.message : String(e2)} You can paste a token instead.`, needsAuth: true, authServer: null, scopes: [] }
        }
      }
      return { ok: false, origin: v.url.origin, onThisMac, reason: e instanceof Error ? e.message : String(e), needsAuth: null, authServer: null, scopes: [] }
    } finally {
      try {
        await probe.close()
      } catch {
        /* probe session */
      }
    }
  }

  async function add(input: { workspaceId: string; alias: string; endpoint: string; bearerToken?: string | null; clientId?: string | null }): Promise<McpAddResult> {
    const info = await inspect(input.endpoint)
    if (!info.ok || !info.origin) return { ok: false, detail: info.reason }
    const bearer = input.bearerToken?.trim() || null
    const authMode = bearer ? 'bearer' : info.needsAuth ? 'oauth' : 'none'
    const endpoint = canonicalResource(new URL(input.endpoint.trim()).toString())
    const c = conns.addConnection({
      workspaceId: input.workspaceId,
      providerId: 'mcp_remote',
      kind: 'mcp',
      alias: input.alias.trim() || new URL(endpoint).host,
      credentialOwner: authMode === 'none' ? 'No sign-in' : 'You',
      billedTo: null,
      endpoint,
      verifiedOrigin: info.origin,
      config: { localEndpoint: info.onThisMac, authMode, clientId: input.clientId ?? null }
    })
    if (bearer) {
      vault.set(vaultRef.key(c.id), bearer)
      conns.updateConnection(c.id, { hasSecret: true, secretHint: `…${bearer.slice(-4)}` })
    }
    if (authMode === 'oauth') {
      conns.saveDraft({ id: `mcp_${c.id}`, providerId: 'mcp_remote', workspaceId: input.workspaceId, step: 'authorize', state: { connectionId: c.id, endpoint } })
      return { ok: true, connection: cardOf(c.id), next: 'authorize', confirmed: [`Verified origin: ${info.origin}${info.onThisMac ? ' (on this Mac)' : ''}.`, info.authServer ? `Sign-in through ${info.authServer}.` : 'Sign-in needed.'] }
    }
    const r = await refreshTools(c.id)
    return { ok: true, connection: cardOf(c.id), next: 'done', confirmed: [`Verified origin: ${info.origin}${info.onThisMac ? ' (on this Mac)' : ''}.`, r.detail] }
  }

  async function authorize(connectionId: string, requestedScope: string | null): Promise<McpAuthorizeResult> {
    const c = conns.getConnection(connectionId)
    if (!c || !c.endpoint) return { ok: false, outcome: 'error', detail: 'MCP connection not found.', connection: null }
    try {
      const res = await authorizeMcpServer({
        connectionId,
        endpoint: c.endpoint,
        binding: { userId: 'me', workspaceId: c.workspaceId, connectionAttemptId: randomUUID() },
        openExternal,
        tokenStore,
        scope: requestedScope,
        clientId: c.config.clientId ?? null,
        net: netFor(c.endpoint, Boolean(c.config.localEndpoint))
      })
      conns.updateConnection(connectionId, { hasSecret: true, secretHint: null, config: { grantedScope: res.scope } })
      conns.deleteDraft(`mcp_${connectionId}`)
      await dropClient(connectionId)
      const r = await refreshTools(connectionId)
      return { ok: true, outcome: 'authorized', detail: `Signed in${res.scope ? ` with access: ${res.scope}` : ''}. ${r.detail}`, connection: cardOf(connectionId) }
    } catch (e) {
      const code = e instanceof McpError ? e.code : 'error'
      const outcome: McpAuthorizeResult['outcome'] = code === 'denied' ? 'denied' : code === 'timeout' ? 'timeout' : code === 'consent_required' ? 'consent_required' : 'error'
      const detail =
        outcome === 'denied'
          ? 'Access was declined in the browser. Nothing was stored; try again when you’re ready.'
          : outcome === 'timeout'
            ? 'The sign-in wasn’t finished in time. Your setup is saved; try again.'
            : e instanceof Error
              ? e.message
              : String(e)
      return { ok: false, outcome, detail, connection: cardOf(connectionId) }
    }
  }

  // Snapshot tools; a changed schema or endpoint goes back to review (§4).
  async function refreshTools(connectionId: string): Promise<{ ok: boolean; detail: string; changed: number }> {
    const c = conns.getConnection(connectionId)
    if (!c || !c.endpoint) return { ok: false, detail: 'MCP connection not found.', changed: 0 }
    try {
      const client = clientFor(connectionId)
      const info = await client.connect()
      const tools = await client.listTools()
      const { operations } = toolsToOperations({ connectionId, endpoint: c.endpoint, tools: tools.items })
      const prev: McpOperation[] = conns.listOperations(connectionId).map((o) => ({
        ...o,
        origin: 'mcp',
        connectionId,
        toolName: o.id.split(':').slice(2).join(':'),
        endpoint: canonicalResource(c.endpoint!),
        suggestedClass: o.suggestedClass,
        annotations: {}
      })) as unknown as McpOperation[]
      const diff = diffSnapshots(prev, operations)
      for (const op of diff.operations) conns.upsertOperation({ ...op, suggestedClass: op.suggestedClass })
      for (const gone of diff.removed) conns.upsertOperation({ ...gone, reviewState: 'needs_review', description: `No longer offered by the server. ${gone.description}`.trim() })
      const resources = info.capabilities.resources ? await client.listResources().catch(() => null) : null
      const t = Date.now()
      conns.recordCheck(connectionId, [
        { capability: 'call_tool', state: tools.advertised ? 'passed' : 'unsupported', checkedAt: t, detail: tools.advertised ? `Signed in and listed ${tools.items.length} tool${tools.items.length === 1 ? '' : 's'}.` : 'This server offers no tools.' },
        { capability: 'read_resource', state: resources ? 'passed' : info.capabilities.resources ? 'failed' : 'unsupported', checkedAt: t, detail: resources ? `${resources.items.length} resources.` : info.capabilities.resources ? 'Resources couldn’t be listed.' : 'This server offers no resources.' }
      ], { identity: info.name, providerOrg: info.title ?? info.name })
      deps.emit?.({ topic: 'connection' })
      const changed = diff.added.length + diff.changed.length + diff.removed.length
      return { ok: true, detail: `${info.title ?? info.name}: ${tools.items.length} tools${changed ? `, ${changed} new or changed (review before use)` : ''}.`, changed }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof McpError && e.code === 'reconnect_required') conns.setStatus(connectionId, 'reconnect_required', 'Sign in again to keep using this server.', 'system')
      else if (e instanceof McpError && e.code === 'unavailable') conns.setStatus(connectionId, 'unavailable', msg, 'system')
      await dropClient(connectionId)
      return { ok: false, detail: msg, changed: 0 }
    }
  }

  async function test(connectionId: string): Promise<{ confirmed: string[] }> {
    const r = await refreshTools(connectionId)
    return { confirmed: [r.detail] }
  }

  async function forget(connectionId: string): Promise<void> {
    await dropClient(connectionId)
    await tokenStore.clear(connectionId)
  }

  const caller: McpCaller = {
    async call(connectionId, toolName, input) {
      try {
        const out = await clientFor(connectionId).callTool(toolName, (input ?? {}) as Record<string, unknown>)
        return { ok: !out.isError, uncertain: false, text: out.text, output: out, detail: out.isError ? 'The tool reported an error.' : 'Done.', providerRequestId: null }
      } catch (e) {
        if (e instanceof McpError) {
          if (e.code === 'reconnect_required') conns.setStatus(connectionId, 'reconnect_required', 'Sign in again to keep using this server.', 'system')
          if (e.code === 'consent_required') return { ok: false, uncertain: false, text: '', output: null, detail: 'This tool needs more access than you approved. Reconnect and approve the wider access to use it.', providerRequestId: null }
          return { ok: false, uncertain: e.uncertain, text: '', output: null, detail: e.message, providerRequestId: null }
        }
        throw e
      }
    }
  }

  function cardOf(connectionId: string): ConnectionCard {
    return deps.card(connectionId)
  }

  return { inspect, add, authorize, refreshTools, test, forget, caller }
}
