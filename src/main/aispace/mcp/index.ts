// Public surface of Plexii's MCP client (Plexii Connections, SPEC-CONNECTIONS.md §4).
//
// Kept small on purpose: the broker and the Connections screen need a client,
// the authorisation flow, the snapshot/review helpers and the typed errors.
// The transport, SSE parser and loopback receiver stay internal.

export { McpClient, capToolText, MAX_LIST_PAGES, TOOL_TEXT_CAP } from './client'
export type {
  McpClientOptions,
  InteractiveAuth,
  CallOptions,
  McpServerInfo,
  McpListResult,
  McpResource,
  McpPrompt,
  McpContentItem,
  McpToolOutput,
  McpResourceOutput,
  RefusedServerRequest
} from './client'

export {
  authorizeMcpServer,
  discoverAuthorization,
  tokenManagerFor,
  McpTokenManager,
  PendingAuthStore,
  pendingAuthorizations,
  mergeScopes,
  AUTHORIZE_TIMEOUT_MS,
  PENDING_TTL_MS
} from './oauth'
export type { McpTokens, McpTokenStore, AuthBinding, AuthorizeOptions, AuthorizeResult, AuthorizationDiscovery } from './oauth'

export { toolsToOperations, diffSnapshots, approveOperation, toolSchemaHash, suggestedClassOf, MCP_OPERATION_DEFAULTS } from './snapshot'
export type { McpOperation, McpTool, McpToolAnnotations, SnapshotDiff, SuggestedClass, SkippedTool } from './snapshot'

export { McpError, ConsentRequired, isMcpError } from './errors'
export type { McpErrorCode } from './errors'

export { canonicalResource, sameResource } from './egress'
export type { McpNetOptions } from './egress'
export { parseWwwAuthenticate } from './challenge'
export type { BearerChallenge } from './challenge'
export { SUPPORTED_PROTOCOL_VERSIONS, PREFERRED_PROTOCOL_VERSION } from './transport'
