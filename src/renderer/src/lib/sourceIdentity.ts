// The identity a retrieved source wears in the trace (facelift F2).
//
// Caleb's ruling, from the Claude-research reference: the trace is a
// credibility surface. Each source row carries a kind glyph coloured by the
// AREA it lives in — the same colour language the sidebar speaks, consumed
// from the canonical lib/areaTones mapping (never forked) — plus a
// right-aligned provenance slot naming that place, the way a web result names
// its domain. Colour answers WHERE, the glyph answers WHAT.

import { areaTone } from './areaTones'

export interface SourceIdentity {
  // Icon name — routed through the plexii interception like all chrome icons.
  icon: string
  // Text colour class from the canonical area mapping.
  tone: string
  // The provenance slot: where this source lives.
  location: string
}

const IDENTITIES: Record<string, SourceIdentity> = {
  knowledge: { icon: 'neurology', tone: areaTone('brain'), location: 'PlexiiBrain' },
  doc: { icon: 'description', tone: areaTone('office'), location: 'Documents' },
  slides: { icon: 'slideshow', tone: areaTone('office'), location: 'Documents' },
  sheet: { icon: 'table_chart', tone: areaTone('office'), location: 'Documents' },
  map: { icon: 'description', tone: areaTone('office'), location: 'Documents' },
  design: { icon: 'gesture', tone: areaTone('office'), location: 'Documents' },
  task: { icon: 'desk', tone: areaTone('desks'), location: 'Desks' },
  table: { icon: 'table_chart', tone: areaTone('desks'), location: 'Tables' },
  note: { icon: 'edit_note', tone: areaTone('desks'), location: 'Desk notes' },
  // Canvas widget kinds the chunk index retrieves (A2, #16). They live on
  // desks, so colour answers WHERE with the desks tone; the glyph answers
  // WHAT with each kind's own icon — the same names the widget catalogue uses.
  'living-doc': { icon: 'auto_awesome', tone: areaTone('desks'), location: 'Desks' },
  card: { icon: 'view_agenda', tone: areaTone('desks'), location: 'Desks' },
  'custom-block': { icon: 'dashboard_customize', tone: areaTone('desks'), location: 'Desks' },
  field: { icon: 'edit_note', tone: areaTone('desks'), location: 'Desks' },
  agent: { icon: 'smart_toy', tone: areaTone('desks'), location: 'Desks' },
  mindmap: { icon: 'account_tree', tone: areaTone('desks'), location: 'Desks' },
  diagram: { icon: 'schema', tone: areaTone('desks'), location: 'Desks' },
  chart: { icon: 'bar_chart', tone: areaTone('desks'), location: 'Desks' },
  // Drive files and past Plexii conversations (A2, #17).
  file: { icon: 'draft', tone: areaTone('files'), location: 'Files' },
  chat: { icon: 'forum', tone: areaTone('home'), location: 'Plexii chats' },
  // Meeting transcripts (M4, SPEC-003 P4). They live in PlexiMeet, an Office
  // surface, so colour answers WHERE with the office tone.
  meeting: { icon: 'video_call', tone: areaTone('office'), location: 'PlexiiMeet' }
}

export function sourceIdentity(docType: string | undefined): SourceIdentity | null {
  if (!docType) return null
  return IDENTITIES[docType.trim().toLowerCase()] ?? null
}
