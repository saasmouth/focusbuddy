// The provider catalogue (SPEC-CONNECTIONS.md §1 Provider catalogue and
// certification).
//
// Each entry publishes what its adapter can offer. Two honesty rules hold:
//  1. `certification.status` says what the entry rests on. 'certified' is only
//     for an adapter that passed its live checks against a real account;
//     'conformance_tested' means the adapter passed its contract tests against a
//     local reference server that speaks the provider's documented protocol;
//     'planned' entries are listed as coming and cannot be added yet.
//  2. A CONNECTION shows a capability label only after that connection's own
//     check passed (connections.ts capabilityPassed). Declared ≠ working.
//
// Prices are deliberately absent here. Claude estimates come from the verified
// table in src/main/ai/aiCost.ts; providers without a verified table report
// tokens and show the amount as Unavailable.

import type { ProviderDefinition } from './connections'

const TEXT_IMAGE: Array<'text' | 'image'> = ['text', 'image']

export const PROVIDERS: ProviderDefinition[] = [
  // ── Model APIs ──────────────────────────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Claude API',
    group: 'Anthropic',
    kind: 'model_api',
    adapterVersion: '1.0.0',
    auth: ['api_key'],
    accountDiscovery: true,
    // Filled in main from CONNECTION_CLAUDE_MODELS in src/main/ai/modelRouting.ts,
    // the one place Claude model ids live (src/main/aispace/models.ts).
    models: [],
    streaming: true,
    maxTaskDuration: 'Minutes while Plexii is open',
    usageReporting: 'per_request',
    declaredCapabilities: ['run_model'],
    regions: ['Anthropic default'],
    dataDestination: 'api.anthropic.com',
    keySettingsUrl: 'https://console.anthropic.com/settings/keys',
    billingUrl: 'https://console.anthropic.com/settings/billing',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    chatUrlPattern: null,
    certification: {
      status: 'conformance_tested',
      basis: 'Contract tests against a local server speaking the Messages and Models APIs. A live check needs a key.'
    }
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    group: 'OpenAI',
    kind: 'model_api',
    adapterVersion: '1.0.0',
    auth: ['api_key'],
    accountDiscovery: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', modalities: TEXT_IMAGE, usdPerMInput: null, usdPerMOutput: null, maxOutputTokens: 16000 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', modalities: TEXT_IMAGE, usdPerMInput: null, usdPerMOutput: null, maxOutputTokens: 16000 }
    ],
    streaming: true,
    // Background responses keep running at OpenAI after Plexii closes, and
    // Plexii picks them up again by id. This is the trackable background agent.
    maxTaskDuration: 'Continues at OpenAI after Plexii closes (background mode)',
    usageReporting: 'per_request',
    declaredCapabilities: ['run_model', 'track_run', 'cancel_run', 'resume_run'],
    regions: ['OpenAI default'],
    dataDestination: 'api.openai.com',
    keySettingsUrl: 'https://platform.openai.com/api-keys',
    billingUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    docsUrl: 'https://platform.openai.com/docs/api-reference/responses',
    chatUrlPattern: null,
    certification: {
      status: 'conformance_tested',
      basis: 'Contract tests against a local server speaking the Responses and Models APIs, including background runs. A live check needs a key.'
    }
  },

  // ── AI web accounts (link + capture; no credentials, no cookies) ────────────
  {
    id: 'chatgpt_web',
    name: 'ChatGPT',
    group: 'OpenAI',
    kind: 'ai_account',
    adapterVersion: '1.0.0',
    auth: ['account_link'],
    accountDiscovery: false,
    models: [],
    streaming: false,
    maxTaskDuration: 'n/a',
    usageReporting: 'none',
    declaredCapabilities: ['open_source', 'import'],
    regions: [],
    dataDestination: 'Nothing is sent. Links open in your browser; imports are what you paste.',
    keySettingsUrl: null,
    billingUrl: null,
    docsUrl: null,
    chatUrlPattern: '^https://(chatgpt\\.com|chat\\.openai\\.com)/(c|share|g)/[A-Za-z0-9_\\-/]+',
    certification: { status: 'conformance_tested', basis: 'Links are recognised and opened in your browser; imports are your own selection.' }
  },
  {
    id: 'claude_web',
    name: 'Claude',
    group: 'Anthropic',
    kind: 'ai_account',
    adapterVersion: '1.0.0',
    auth: ['account_link'],
    accountDiscovery: false,
    models: [],
    streaming: false,
    maxTaskDuration: 'n/a',
    usageReporting: 'none',
    declaredCapabilities: ['open_source', 'import'],
    regions: [],
    dataDestination: 'Nothing is sent. Links open in your browser; imports are what you paste.',
    keySettingsUrl: null,
    billingUrl: null,
    docsUrl: null,
    chatUrlPattern: '^https://claude\\.ai/(chat|share|project)/[A-Za-z0-9_\\-/]+',
    certification: { status: 'conformance_tested', basis: 'Links are recognised and opened in your browser; imports are your own selection.' }
  },
  {
    id: 'gemini_web',
    name: 'Gemini',
    group: 'Google',
    kind: 'ai_account',
    adapterVersion: '1.0.0',
    auth: ['account_link'],
    accountDiscovery: false,
    models: [],
    streaming: false,
    maxTaskDuration: 'n/a',
    usageReporting: 'none',
    declaredCapabilities: ['open_source', 'import'],
    regions: [],
    dataDestination: 'Nothing is sent. Links open in your browser; imports are what you paste.',
    keySettingsUrl: null,
    billingUrl: null,
    docsUrl: null,
    chatUrlPattern: '^https://(gemini\\.google\\.com/(app|share)|g\\.co/gemini/share)/[A-Za-z0-9_\\-/]+',
    certification: { status: 'conformance_tested', basis: 'Links are recognised and opened in your browser; imports are your own selection.' }
  },
  {
    id: 'perplexity_web',
    name: 'Perplexity',
    group: 'Perplexity',
    kind: 'ai_account',
    adapterVersion: '1.0.0',
    auth: ['account_link'],
    accountDiscovery: false,
    models: [],
    streaming: false,
    maxTaskDuration: 'n/a',
    usageReporting: 'none',
    declaredCapabilities: ['open_source', 'import'],
    regions: [],
    dataDestination: 'Nothing is sent. Links open in your browser; imports are what you paste.',
    keySettingsUrl: null,
    billingUrl: null,
    docsUrl: null,
    chatUrlPattern: '^https://(www\\.)?perplexity\\.ai/(search|page)/[A-Za-z0-9_\\-/]+',
    certification: { status: 'conformance_tested', basis: 'Links are recognised and opened in your browser; imports are your own selection.' }
  },

  // ── MCP ─────────────────────────────────────────────────────────────────────
  {
    id: 'mcp_remote',
    name: 'Remote MCP server',
    group: 'MCP',
    kind: 'mcp',
    adapterVersion: '1.0.0',
    auth: ['oauth_pkce', 'bearer_token', 'none'],
    accountDiscovery: false,
    models: [],
    streaming: false,
    maxTaskDuration: 'One tool call at a time',
    usageReporting: 'none',
    declaredCapabilities: ['call_tool', 'read_resource'],
    regions: [],
    dataDestination: 'The server you enter. Its verified origin is shown before you connect.',
    keySettingsUrl: null,
    billingUrl: null,
    docsUrl: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization',
    chatUrlPattern: null,
    certification: {
      status: 'conformance_tested',
      basis: 'Streamable HTTP and the MCP authorisation flow (protected resource metadata, authorisation server metadata, dynamic registration, PKCE, resource-bound tokens) pass against a local reference server. Each real server is certified once someone connects it and its checks pass.'
    }
  },

  // ── Direct app APIs ─────────────────────────────────────────────────────────
  {
    id: 'notion',
    name: 'Notion',
    group: 'Notion',
    kind: 'app_api',
    adapterVersion: '1.0.0',
    auth: ['bearer_token'],
    accountDiscovery: true,
    models: [],
    streaming: false,
    maxTaskDuration: 'One request at a time',
    usageReporting: 'none',
    declaredCapabilities: ['app_read', 'app_write'],
    regions: ['Notion default'],
    dataDestination: 'api.notion.com',
    keySettingsUrl: 'https://www.notion.so/profile/integrations',
    billingUrl: null,
    docsUrl: 'https://developers.notion.com/reference/intro',
    chatUrlPattern: null,
    certification: {
      status: 'conformance_tested',
      basis: 'Operations pass against a local server speaking the documented Notion API. A live check needs an internal integration token and a test page.'
    }
  },

  // ── Planned coverage (§1): listed, not yet addable ─────────────────────────
  ...(
    [
      ['gemini_api', 'Gemini API', 'Google', 'generativelanguage.googleapis.com'],
      ['azure_openai', 'Azure OpenAI', 'Microsoft', 'Your Azure resource'],
      ['bedrock', 'Amazon Bedrock', 'AWS', 'bedrock-runtime.<region>.amazonaws.com'],
      ['vertex', 'Vertex AI', 'Google', '<region>-aiplatform.googleapis.com'],
      ['mistral', 'Mistral API', 'Mistral', 'api.mistral.ai'],
      ['xai', 'xAI API', 'xAI', 'api.x.ai'],
      ['perplexity_api', 'Perplexity API', 'Perplexity', 'api.perplexity.ai'],
      ['openrouter', 'OpenRouter', 'OpenRouter', 'openrouter.ai']
    ] as const
  ).map(
    ([id, name, group, dest]): ProviderDefinition => ({
      id,
      name,
      group,
      kind: 'model_api',
      adapterVersion: '0.0.0',
      auth: ['api_key'],
      accountDiscovery: false,
      models: [],
      streaming: true,
      maxTaskDuration: 'n/a',
      usageReporting: 'per_request',
      declaredCapabilities: ['run_model'],
      regions: [],
      dataDestination: dest,
      keySettingsUrl: null,
      billingUrl: null,
      docsUrl: null,
      chatUrlPattern: null,
      certification: { status: 'planned', basis: 'Planned. Added once its adapter passes certification.' }
    })
  ),
  {
    id: 'local_runtime',
    name: 'On this device',
    group: 'Local',
    kind: 'local',
    adapterVersion: '0.0.0',
    auth: ['none'],
    accountDiscovery: false,
    models: [],
    streaming: true,
    maxTaskDuration: 'n/a',
    usageReporting: 'none',
    declaredCapabilities: ['run_model'],
    regions: ['This Mac'],
    dataDestination: 'Stays on this device',
    keySettingsUrl: null,
    billingUrl: null,
    docsUrl: null,
    chatUrlPattern: null,
    certification: { status: 'planned', basis: 'Planned for AI Space runs. Plexii features already use it under Settings › AI.' }
  }
]

// Known remote MCP servers people can pick instead of typing a URL. Each is
// "not yet certified" until a connection to it passes its own checks.
export interface McpCatalogueEntry {
  id: string
  name: string
  endpoint: string
  description: string
}

export const MCP_CATALOGUE: McpCatalogueEntry[] = [
  { id: 'linear', name: 'Linear', endpoint: 'https://mcp.linear.app/mcp', description: 'Issues, projects and comments in your Linear workspace.' },
  { id: 'notion', name: 'Notion', endpoint: 'https://mcp.notion.com/mcp', description: 'Pages and databases you allow in Notion.' },
  { id: 'sentry', name: 'Sentry', endpoint: 'https://mcp.sentry.dev/mcp', description: 'Errors and releases from Sentry.' },
  { id: 'github', name: 'GitHub', endpoint: 'https://api.githubcopilot.com/mcp/', description: 'Repositories, issues and pull requests.' }
]

export function providerById(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export function addableProviders(): ProviderDefinition[] {
  return PROVIDERS.filter((p) => p.certification.status !== 'planned')
}

// Recognise a pasted chat link (Start and capture): which AI web account it
// belongs to, if any.
export function providerForChatUrl(url: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.chatUrlPattern && new RegExp(p.chatUrlPattern, 'i').test(url.trim()))
}
