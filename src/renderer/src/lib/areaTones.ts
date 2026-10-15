// The canonical per-area stroke colours — ONE hue per destination, used by the
// side menu (the accordion's rows and tiles, the desk list, the collapsed
// rail), the home Quick Links widget, and any surface that references an area
// by colour (e.g. the Plexii trace's kind icons). This mapping is the source of
// truth: consume it, never fork it.
//
// WHY IT IS THE SOURCE OF TRUTH, stated plainly because it was forked twice and
// both forks drifted. `AreaAccordion` kept its own literals in `DESK_VIEWS` and
// `SECTIONS`, and the merged menu renders the Sidebar's desk list INSIDE the
// accordion — so the same concept arrived in two colours at once. Rooms was sky
// here and teal there; Desks was teal here and sky there. A hue that changes
// depending on which component drew it is worse than no hue, because it reads
// as meaning something.
//
// Values are Tailwind text-* classes because the icons are coloured in the
// stroke itself (brand treatment: no tile behind them). If an area ever needs a
// bg tint, derive it as `bg-<hue>-500/10` from the same hue.

export type AreaId =
  // Desk area — top-level places
  | 'home'
  | 'attention'
  | 'rooms'
  | 'desks'
  | 'shared'
  | 'trash'
  // Desk area — Attention's six state/due filters
  | 'attention-open'
  | 'attention-due-today'
  | 'attention-overdue'
  | 'attention-in-progress'
  | 'attention-waiting'
  | 'attention-closed-7d'
  // Apps / documents
  | 'plans'
  | 'tasks'
  | 'calendar'
  | 'files'
  | 'vault'
  | 'office'
  | 'people'
  | 'brain'

export const AREA_TONES: Record<AreaId, string> = {
  // ── Desk: the places ──────────────────────────────────────────────────────
  home: 'text-indigo-500',
  // Attention is amber on purpose: it is the one row whose job is to say
  // "something needs you", and amber is the only warning hue in the set.
  attention: 'text-amber-500',
  rooms: 'text-teal-500',
  desks: 'text-sky-500',
  shared: 'text-violet-500',
  // Trash is the one deliberately drab entry. It is a destination you need to
  // find, not one to draw the eye, and a coloured bin competes with real work.
  trash: 'text-slate-500',

  // ── Desk: Attention's filters ─────────────────────────────────────────────
  // These used to share one hue, which made six different questions look like
  // one row repeated. Each now carries the colour of what it means, and the
  // set reads as a temperature: open and in-progress are cool, due and overdue
  // warm through to red, closed resolves to green.
  'attention-open': 'text-sky-500',
  'attention-due-today': 'text-amber-500',
  'attention-overdue': 'text-red-500',
  'attention-in-progress': 'text-blue-500',
  'attention-waiting': 'text-slate-400',
  'attention-closed-7d': 'text-emerald-500',

  // ── Apps and documents ────────────────────────────────────────────────────
  plans: 'text-violet-500',
  tasks: 'text-emerald-500',
  calendar: 'text-amber-500',
  files: 'text-orange-500',
  vault: 'text-rose-500',
  office: 'text-purple-500',
  people: 'text-pink-500',
  brain: 'text-cyan-500'
}

export function areaTone(id: AreaId): string {
  return AREA_TONES[id]
}

/**
 * The tone for one of Attention's filters, by filter id.
 *
 * A helper rather than inline lookups at the call site, so `ATTENTION_FILTERS`
 * stays the single list of filters (its ids drive the view and the predicate)
 * and this stays the single list of colours. A filter added there without a
 * colour here falls back to Attention's own amber rather than rendering grey.
 */
export function attentionFilterTone(filterId: string): string {
  const key = `attention-${filterId}` as AreaId
  return AREA_TONES[key] ?? AREA_TONES.attention
}
