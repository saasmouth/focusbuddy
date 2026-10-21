// Generic cloud architecture icons — vendor-neutral names and Material Symbols
// glyphs (no provider logos or trademarks) — plus boundary containers for
// VPCs, regions, zones and subnets. Ids are saved in documents — never rename.

import { type ShapeDef, rect } from './types'
import { PORTS_THIRDS, box, fill, iconShape, shape } from './kit'

const CL = 'Cloud' as const
const cl = (id: string, label: string, icon: string, keywords: string[]): ShapeDef =>
  iconShape(`cloud-${id}`, label, CL, icon, ['cloud', 'service', ...keywords])

function boundary(
  id: string,
  label: string,
  keywords: string[],
  dash: 'dashed' | 'dotted' | 'solid' | 'dashdot',
  color: string,
  w: number,
  h: number
): ShapeDef {
  return shape(
    `cloud-${id}`,
    label,
    CL,
    w,
    h,
    (W, H) => ({
      parts: [fill(rect(0, 0, W, H, Math.min(8, W * 0.04, H * 0.04)))],
      text: box(W, H, 10, 2, W - 20, Math.min(26, H * 0.3))
    }),
    {
      keywords: ['cloud', 'boundary', 'container', 'group', ...keywords],
      container: true,
      ports: PORTS_THIRDS,
      minW: 60,
      minH: 40,
      defaultLabel: label,
      color,
      defaultStyle: { strokeDash: dash, fill: 'none', textAlign: 'left', bold: true }
    }
  )
}

export const CLOUD_SHAPES: ShapeDef[] = [
  cl('compute', 'Compute instance', 'memory', ['compute', 'vm', 'virtual machine', 'instance', 'server', 'ec2']),
  cl('container', 'Container', 'deployed_code', ['container', 'docker', 'image', 'pod', 'runtime']),
  cl('cluster', 'Container cluster', 'hub', ['cluster', 'kubernetes', 'orchestration', 'nodes', 'k8s']),
  cl('function', 'Serverless function', 'functions', ['serverless', 'function', 'lambda', 'faas', 'event driven']),
  cl('object-storage', 'Object storage', 'inventory_2', ['object storage', 'bucket', 'blob', 'files', 's3', 'storage']),
  cl('block-storage', 'Block storage', 'stacks', ['block storage', 'volume', 'disk', 'ssd', 'storage']),
  cl('file-storage', 'File storage', 'folder_open', ['file storage', 'shared drive', 'nfs', 'smb', 'files']),
  cl('database', 'Managed database', 'database', ['database', 'sql', 'relational', 'rds', 'postgres', 'mysql', 'db']),
  cl('nosql', 'NoSQL database', 'data_object', ['nosql', 'document database', 'key value', 'database', 'json']),
  cl('cache', 'Cache', 'bolt', ['cache', 'in-memory', 'redis', 'memcached', 'fast']),
  cl('queue', 'Message queue', 'view_stream', ['queue', 'message queue', 'mq', 'buffer', 'jobs']),
  cl('pubsub', 'Pub/sub topic', 'campaign', ['pub sub', 'pubsub', 'topic', 'broadcast', 'events', 'fan out']),
  cl('stream', 'Event stream', 'stream', ['stream', 'event stream', 'kafka', 'real time', 'ingest']),
  cl('api-gateway', 'API gateway', 'api', ['api gateway', 'api', 'endpoint', 'rest', 'gateway']),
  cl('load-balancer', 'Load balancer', 'balance', ['load balancer', 'lb', 'traffic', 'ingress']),
  cl('cdn', 'CDN', 'language', ['cdn', 'content delivery', 'edge', 'cache', 'global']),
  cl('dns', 'DNS', 'signpost', ['dns', 'domain', 'name resolution', 'routing', 'records']),
  cl('identity', 'Identity', 'badge', ['identity', 'iam', 'auth', 'sso', 'login', 'users', 'directory']),
  cl('secrets', 'Key vault / secrets', 'key', ['key vault', 'secrets', 'kms', 'keys', 'encryption', 'credentials']),
  cl('certificate', 'Certificate', 'verified_user', ['certificate', 'tls', 'ssl', 'https', 'trust']),
  cl('waf', 'Web firewall', 'shield_lock', ['waf', 'firewall', 'security', 'ddos', 'protection']),
  cl('policy', 'Policy', 'policy', ['policy', 'governance', 'compliance', 'rules', 'iam policy']),
  cl('monitoring', 'Monitoring', 'monitoring', ['monitoring', 'metrics', 'observability', 'dashboard', 'alerts']),
  cl('logging', 'Logging', 'receipt_long', ['logging', 'logs', 'audit', 'trail', 'events']),
  cl('analytics', 'Analytics', 'analytics', ['analytics', 'bi', 'reporting', 'insights', 'charts']),
  cl('warehouse', 'Data warehouse', 'warehouse', ['data warehouse', 'warehouse', 'olap', 'lake', 'big data']),
  cl('etl', 'Data pipeline', 'sync_alt', ['etl', 'pipeline', 'data pipeline', 'transform', 'ingest', 'elt']),
  cl('ml-model', 'ML model', 'model_training', ['ml', 'machine learning', 'model', 'training', 'ai']),
  cl('ai', 'AI service', 'smart_toy', ['ai', 'assistant', 'llm', 'bot', 'agent', 'inference']),
  cl('search', 'Search service', 'search', ['search', 'index', 'full text', 'elasticsearch', 'query']),
  cl('vpn', 'VPN', 'vpn_lock', ['vpn', 'tunnel', 'private network', 'site to site', 'secure']),
  cl('email', 'Email service', 'mail', ['email', 'mail', 'smtp', 'transactional', 'newsletter']),
  cl('notification', 'Notification', 'notifications', ['notification', 'push', 'sms', 'alert', 'message']),
  cl('scheduler', 'Scheduler', 'schedule', ['scheduler', 'cron', 'timer', 'jobs', 'batch']),
  cl('workflow', 'Workflow', 'account_tree', ['workflow', 'orchestration', 'state machine', 'step functions', 'process']),
  cl('webhook', 'Webhook', 'webhook', ['webhook', 'callback', 'integration', 'http event']),
  cl('registry', 'Artifact registry', 'package_2', ['registry', 'artifacts', 'container registry', 'packages', 'images']),
  cl('cicd', 'CI/CD pipeline', 'rocket_launch', ['ci', 'cd', 'cicd', 'deploy', 'build', 'pipeline', 'release']),
  cl('backup', 'Backup', 'backup', ['backup', 'snapshot', 'restore', 'disaster recovery', 'dr']),
  cl('iot-hub', 'IoT hub', 'sensors', ['iot', 'devices', 'telemetry', 'hub', 'edge']),
  cl('billing', 'Billing', 'payments', ['billing', 'cost', 'payments', 'invoice', 'budget']),
  boundary('vpc', 'VPC / network', ['vpc', 'vnet', 'virtual network', 'private network', 'network boundary'], 'dashed', '#7C3AED', 520, 340),
  boundary('subnet', 'Subnet', ['subnet', 'public subnet', 'private subnet', 'network segment'], 'dotted', '#0891B2', 360, 220),
  boundary('region', 'Region', ['region', 'geography', 'location', 'data centre region'], 'dashdot', '#2563EB', 640, 420),
  boundary('zone', 'Availability zone', ['availability zone', 'az', 'zone', 'fault domain'], 'dashed', '#0D9488', 420, 300),
  boundary('account', 'Account / project', ['account', 'project', 'subscription', 'tenant', 'organisation'], 'solid', '#475569', 680, 460)
]
