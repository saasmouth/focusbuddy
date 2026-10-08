import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useWidgetStore } from '../stores/widgets'
import { useLinksStore } from '../stores/links'
import { parseAgent, serializeAgent } from '../lib/deskAgent'
import Icon from './Icon'

// Desk "Automations" panel — the plain, one-place list of everything on this
// desk that runs on its own: reactive wires (transform / mirror) and desk agents.
// Each row shows what it does, when it last ran and whether it's healthy, an
// on/off switch, and a jump-to that centres the canvas on it. The "boomer's
// weekly statement of what my desk does automatically", plus an honest receipt
// of how those runs reach the model (data receipt).
//
// Follows the minimap FAB pattern: a small button in the canvas that blooms into
// a panel. It renders OUTSIDE the LinkOverlay SVG (which is pointer-events-none),
// as its own pointer-events-auto floating chrome. Jump-to uses WORLD-space math
// (widget.x/y + zoom/pan via setPan) — never the wire overlay's viewport GBCR.

const PANEL_W = 300
const PANEL_MAX_H = 380

type Tone = 'ok' | 'stale' | 'error' | 'off' | 'idle'
interface Status {
  label: string
  tone: Tone
}
interface Row {
  kind: 'agent' | 'transform' | 'mirror' | 'webhook'
  id: string
  title: string
  sub: string
  status: Status
  enabled: boolean
  center: { x: number; y: number } | null
  toggle: (next: boolean) => void
}

function relAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-400',
  stale: 'bg-amber-400',
  error: 'bg-red-500',
  off: 'bg-[var(--ink-30)]',
  idle: 'bg-sky-400'
}

export default function AutomationsFAB(): JSX.Element {
  const widgets = useWidgetStore((s) => s.widgets)
  const zoom = useWidgetStore((s) => s.zoom)
  const setPan = useWidgetStore((s) => s.setPan)
  const updateWidget = useWidgetStore((s) => s.update)
  const links = useLinksStore((s) => s.links)
  const updateWire = useLinksStore((s) => s.update)

  const [open, setOpen] = useState(false)
  // Honest data receipt: how automations reach the model.
  const [aiRoute, setAiRoute] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.api.ai
      .getStatus()
      .then((s) => {
        if (!alive) return
        // byok → the user's own key, direct to Anthropic. credits/auto → through
        // PlexiDesk's own relay. Mirror wires are a local copy and never leave.
        setAiRoute(
          s.mode === 'byok'
            ? 'AI transforms run with your key, sent directly to Anthropic.'
            : 'AI transforms run on PlexiDesk credits, relayed through our server to Anthropic. Mirror copies stay on your device.'
        )
      })
      .catch(() => alive && setAiRoute(null))
    return () => {
      alive = false
    }
  }, [open])

  const rows = useMemo<Row[]>(() => {
    const byId = new Map(widgets.map((w) => [w.id, w]))
    const out: Row[] = []

    // Desk agents — standing automations, wired inputs or not.
    for (const w of widgets) {
      if (w.kind !== 'agent' || w.archived) continue
      const cfg = parseAgent(w.content)
      const status: Status = cfg.lastError
        ? { label: 'Last run failed', tone: 'error' }
        : !cfg.enabled
          ? { label: 'Off', tone: 'off' }
          : cfg.lastRunAt
            ? { label: `Ran ${relAgo(cfg.lastRunAt)}`, tone: 'ok' }
            : { label: 'Ready', tone: 'idle' }
      const triggerLabel =
        cfg.trigger === 'interval'
          ? `every ${Math.round(cfg.intervalSec / 60) || 1}m`
          : cfg.trigger === 'onChange'
            ? 'on input change'
            : 'manual'
      out.push({
        kind: 'agent',
        id: w.id,
        title: w.title?.trim() || cfg.instruction.trim() || 'Untitled agent',
        sub: `Agent · ${triggerLabel}`,
        status,
        enabled: cfg.enabled,
        center: { x: w.x + w.width / 2, y: w.y + w.height / 2 },
        toggle: (next) => void updateWidget(w.id, { content: serializeAgent({ ...cfg, enabled: next }) })
      })
    }

    // Reactive wires — a plain context wire is passive, EXCEPT one whose target is
    // an outbound webhook, which fires a real POST on every source change and so is
    // very much an automation the user should see and be able to switch off.
    for (const l of links) {
      const tgt = byId.get(l.targetWidgetId)
      const isWebhook = tgt?.kind === 'webhook'
      if (l.type !== 'transform' && l.type !== 'mirror' && !isWebhook) continue
      const src = byId.get(l.sourceWidgetId)
      if (!src || !tgt) continue // endpoint not on this desk right now
      const label = (w: typeof src): string => w.title?.trim() || w.kind
      const rowKind: Row['kind'] = isWebhook ? 'webhook' : (l.type as 'transform' | 'mirror')
      const stale = !!l.enabled && l.lastRunAt != null && src.updatedAt > l.lastRunAt
      const status: Status = l.lastError
        ? { label: isWebhook ? 'Last send failed' : 'Last run failed', tone: 'error' }
        : !l.enabled
          ? { label: 'Off', tone: 'off' }
          : l.lastRunAt == null
            ? { label: isWebhook ? "Hasn't sent yet" : "Hasn't run yet", tone: 'idle' }
            : stale
              ? { label: 'Stale — source changed', tone: 'stale' }
              : { label: `${isWebhook ? 'Sent' : 'Ran'} ${relAgo(l.lastRunAt)}`, tone: 'ok' }
      out.push({
        kind: rowKind,
        id: l.id,
        title: `${label(src)} → ${label(tgt)}`,
        sub: isWebhook
          ? 'Webhook · POSTs to a URL on change'
          : l.type === 'transform'
            ? `Transform${l.verb.trim() ? ` · ${l.verb.trim()}` : ' · no instruction yet'}`
            : 'Mirror · keeps target in sync',
        status,
        enabled: l.enabled,
        center: {
          x: (src.x + src.width / 2 + (tgt.x + tgt.width / 2)) / 2,
          y: (src.y + src.height / 2 + (tgt.y + tgt.height / 2)) / 2
        },
        toggle: (next) => void updateWire(l.id, { enabled: next })
      })
    }
    return out
  }, [widgets, links, updateWidget, updateWire])

  function centerOn(c: { x: number; y: number }): void {
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
    const vw = el ? el.getBoundingClientRect().width : window.innerWidth
    const vh = el ? el.getBoundingClientRect().height : window.innerHeight
    setPan(vw / 2 - c.x * zoom, vh / 2 - c.y * zoom)
  }

  const count = rows.length
  const attention = rows.filter((r) => r.status.tone === 'error' || r.status.tone === 'stale').length

  return (
    <div
      className="fb-floating-chrome absolute bottom-[76px] right-3 z-[46] pointer-events-auto"
      /* Stacked ABOVE the Plexii pill rather than beside it. The pill grew to
         52px and went purple to be findable (2026-10-09), and at bottom-14 this
         sat underneath it — measured, not guessed: the overlap probe reported
         `overlaps: button[automations-fab]`. The pill is the primary action in
         that corner, so the secondary one moves. */
      data-automations-fab
      data-floating-menu
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {open ? (
          <motion.div
            key="panel"
            initial={{ scale: 0.45, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.45, opacity: 0, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.22, ease: [0.34, 1.2, 0.64, 1] }}
            style={{ width: PANEL_W, maxHeight: PANEL_MAX_H, transformOrigin: 'bottom right', borderRadius: 12 }}
            className="overflow-hidden shadow-xl ring-1 ring-black/10 dark:ring-white/10 bg-[var(--surface-raised)] flex flex-col fb-glass-chrome"
            data-testid="automations-panel"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--edge-soft)] shrink-0">
              <span className="text-[12px] font-semibold text-[var(--ink-80)]">
                Automations{count > 0 ? ` (${count})` : ''}
              </span>
              <button
                onClick={() => setOpen(false)}
                className="text-[var(--ink-40)] hover:text-[var(--ink-80)] transition-colors"
                title="Close"
              >
                <Icon name="close" size={13} />
              </button>
            </div>

            <div className="overflow-y-auto p-1.5 flex-1">
              {rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center text-[var(--ink-40)]">
                  <Icon name="bolt" size={20} />
                  <div className="text-[11px] leading-snug px-4">
                    Nothing runs on its own here yet. Wire a tool into an agent, or make a
                    connection a Transform or Mirror, and it shows up here.
                  </div>
                </div>
              ) : (
                <ul className="space-y-1">
                  {rows.map((r) => (
                    <li
                      key={`${r.kind}-${r.id}`}
                      data-testid={`automation-row-${r.id}`}
                      className="rounded-lg bg-[var(--surface-sunken)] px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <Icon
                          name={
                            r.kind === 'agent'
                              ? 'smart_toy'
                              : r.kind === 'transform'
                                ? 'auto_awesome'
                                : r.kind === 'webhook'
                                  ? 'webhook'
                                  : 'sync'
                          }
                          size={14}
                          className="text-accent shrink-0"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] font-medium text-[var(--ink-100)] truncate">{r.title}</span>
                          <span className="block text-[10px] text-[var(--ink-50)] truncate">{r.sub}</span>
                        </span>
                        {/* On/off toggle */}
                        <button
                          onClick={() => r.toggle(!r.enabled)}
                          data-testid={`automation-toggle-${r.id}`}
                          title={r.enabled ? 'Turn off' : 'Turn on'}
                          className={`shrink-0 w-8 h-4 rounded-full relative transition-colors ${
                            r.enabled ? 'bg-accent' : 'bg-[var(--edge-firm)]'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                              r.enabled ? 'left-[18px]' : 'left-0.5'
                            }`}
                          />
                        </button>
                      </div>
                      <div className="flex items-center justify-between mt-1 pl-6">
                        <span className="inline-flex items-center gap-1 text-[10px] text-[var(--ink-50)]">
                          <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[r.status.tone]}`} />
                          {r.status.label}
                        </span>
                        {r.center && (
                          <button
                            onClick={() => r.center && centerOn(r.center)}
                            data-testid={`automation-jump-${r.id}`}
                            className="inline-flex items-center gap-0.5 text-[10px] text-[var(--ink-40)] hover:text-accent transition-colors"
                            title="Jump to it on the canvas"
                          >
                            <Icon name="my_location" size={11} />
                            Jump
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {aiRoute && (
              <div className="px-3 py-1.5 border-t border-[var(--edge-soft)] shrink-0 flex items-start gap-1.5">
                <Icon name="receipt_long" size={12} className="text-[var(--ink-40)] mt-0.5 shrink-0" />
                <span className="text-[9px] text-[var(--ink-50)] leading-snug">{aiRoute}</span>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.button
            key="icon"
            initial={{ scale: 0.45, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.45, opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: 0.18, ease: [0.34, 1.2, 0.64, 1] }}
            style={{ transformOrigin: 'bottom right' }}
            onClick={() => setOpen(true)}
            title="Automations on this desk"
            data-testid="automations-fab"
            className="fb-glass-chrome w-8 h-8 rounded-full flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] transition-colors shadow-md relative"
          >
            <Icon name="bolt" size={16} />
            {attention > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 border border-[var(--surface-raised)]" />
            )}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
