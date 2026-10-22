// Real brand logos for the standard-app catalog, bundled as local assets so
// they render instantly and offline. Since 4.3.41 they are the owner's
// Connected-Apps set (assets/plexii-icons/connected, built by
// scripts/build-plexii-icons.mjs); the older assets/app-logos copies are gone.
// Components draw them through <PlexiiIcon kind="connected">, which picks the
// size for the screen; these lookups remain for callers that need an id or URL.
//
// Lookups:
//   standardIdForUrl  — the catalog id a URL belongs to, by hostname.
//   logoForStandardId — direct hit for catalog entries (the Add dialog).
//   logoForUrl        — match any ConnectedApp back to a catalog logo by
//                       hostname, so apps added before this feature (or with
//                       equivalent URLs) pick up their real logo with no
//                       migration or DB backfill.

import { PLEXII_ICON_ASSETS } from './plexiiIconAssets.generated'
import { CONNECTED_ICON_ASSETS } from './plexiiIconMap'

/** Largest file the owner's set has for a standard-app id (lib/plexiiIconMap). */
function logoFile(id: string): string | null {
  const asset = PLEXII_ICON_ASSETS[CONNECTED_ICON_ASSETS[id] ?? '']
  return asset ? (asset.src[128] ?? asset.src[64] ?? asset.src[32] ?? null) : null
}

// hostname → catalog id. Covers the catalog URLs plus the equivalent hosts a
// user might have added by hand (chatgpt.com vs chat.openai.com, etc.).
// Subdomain fallback below handles www. and deeper subdomains of these roots.
const HOST_TO_ID: Record<string, string> = {
  'mail.google.com': 'gmail',
  'calendar.google.com': 'gcal',
  'drive.google.com': 'gdrive',
  'docs.google.com': 'gdrive',
  'notion.so': 'notion',
  'notion.site': 'notion',
  'trello.com': 'trello',
  'todoist.com': 'todoist',
  'slack.com': 'slack',
  'discord.com': 'discord',
  'discord.gg': 'discord',
  'whatsapp.com': 'whatsapp',
  'github.com': 'github',
  'linear.app': 'linear',
  'jira.com': 'jira',
  'atlassian.com': 'jira',
  'atlassian.net': 'jira',
  'claude.ai': 'claude',
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'gemini.google.com': 'gemini',
  'spotify.com': 'spotify',
  'music.youtube.com': 'ytmusic',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'figma.com': 'figma',
  'miro.com': 'miro'
}

export function logoForStandardId(id: string): string | null {
  return logoFile(id)
}

export function logoForUrl(url: string | null | undefined): string | null {
  const id = standardIdForUrl(url)
  return id ? logoFile(id) : null
}

/** The standard-app id a URL belongs to, or null. */
export function standardIdForUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  // Exact host first (music.youtube.com must win over youtube.com), then walk
  // up the domain so www.slack.com / app.slack.com resolve to slack.com.
  while (host) {
    const id = HOST_TO_ID[host]
    if (id) return id
    const dot = host.indexOf('.')
    if (dot === -1) return null
    host = host.slice(dot + 1)
  }
  return null
}
