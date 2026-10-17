import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWidgetStore } from '../stores/widgets'
import { useLinksStore } from '../stores/links'
import { metricsStatus } from '../lib/metricsStatus'
import { widgetDisplayName, hostnameOf } from '../lib/widgetDisplayName'
import { lookupWebview } from '../lib/webviewRegistry'
import Icon from './Icon'

// Dev performance overlay. Toggle with Cmd/Ctrl+Shift+M. Shows per-process RAM +
// CPU from app.getAppMetrics() alongside live widget / browser / wire counts, so
// you can see exactly what a browser-heavy desk costs and catch regressions.
// Available in any build (handy for diagnosing a user's perf report), but inert
// until toggled.

interface ProcMetric {
  pid: number
  type: string
  name: string
  cpu: number
  memMB: number
}

interface WcMetric {
  webContentsId: number
  osPid: number
  type: string
  title: string
  url: string
}

function fmtMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`
}

export default function MetricsOverlay(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [procs, setProcs] = useState<ProcMetric[]>([])
  const [wcs, setWcs] = useState<WcMetric[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const widgets = useWidgetStore((s) => s.widgets)
  const links = useLinksStore((s) => s.links)

  // Toggle hotkey.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Poll metrics while open.
  useEffect(() => {
    if (!open) return
    let alive = true
    const tick = async (): Promise<void> => {
      // The metrics:get handler lives in the main process and the `metrics`
      // namespace in the preload — neither hot-reloads. If you added the
      // overlay during a running session, `window.api.metrics` won't exist
      // until a full app restart (not a Cmd+R reload). Say that out loud
      // instead of silently rendering zeros.
      const getter = window.api?.metrics?.get
      if (typeof getter !== 'function') {
        if (alive) {
          setProcs([])
          setStatus(metricsStatus({ hasGetter: false, count: 0 }))
        }
        return
      }
      try {
        const m = await getter()
        if (alive) {
          setProcs(m)
          setStatus(metricsStatus({ hasGetter: true, count: m.length }))
        }
        // Best-effort: map renderer processes to their owning widget. Older
        // builds (stale preload) won't have this; the rows just fall back to
        // the process type then.
        const wcGetter = window.api?.metrics?.webContents
        if (typeof wcGetter === 'function') {
          const w = await wcGetter()
          if (alive) setWcs(w)
        }
      } catch (err) {
        if (alive) {
          setProcs([])
          setStatus(metricsStatus({ hasGetter: true, threw: err instanceof Error ? err.message : String(err), count: 0 }))
        }
      }
    }
    void tick()
    const h = window.setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      window.clearInterval(h)
    }
  }, [open])

  if (!open) return null

  const totalMem = procs.reduce((a, p) => a + p.memMB, 0)
  const totalCpu = Math.round(procs.reduce((a, p) => a + p.cpu, 0) * 10) / 10
  // 'Browser' = the main process; 'Tab' = renderer processes (the main window +
  // one per <webview>). GPU / Utility are their own.
  const renderers = procs.filter((p) => p.type === 'Tab')
  const main = procs.find((p) => p.type === 'Browser')
  const gpu = procs.find((p) => p.type === 'GPU')
  const top = [...procs].sort((a, b) => b.memMB - a.memMB).slice(0, 8)

  const browsers = widgets.filter((w) => w.kind === 'webview' && !w.archived).length
  const liveWidgets = widgets.filter((w) => !w.archived).length

  // Join renderer processes to the widget that owns them. A process can host
  // more than one webContents (same-site renderers share), so labels accumulate.
  const labelByPid = new Map<number, string[]>()
  for (const wc of wcs) {
    if (!wc.osPid) continue
    let label = ''
    if (wc.type === 'window') {
      label = 'This window'
    } else {
      const entry = lookupWebview(wc.webContentsId)
      const widget = entry ? widgets.find((w) => w.id === entry.widgetId) : undefined
      label = widget ? widgetDisplayName(widget) : hostnameOf(wc.url) || wc.title || ''
    }
    if (!label) continue
    const arr = labelByPid.get(wc.osPid) ?? []
    if (!arr.includes(label)) arr.push(label)
    labelByPid.set(wc.osPid, arr)
  }
  const labelFor = (pid: number): string | null => labelByPid.get(pid)?.join(', ') ?? null

  const Row = ({ label, value, warn }: { label: string; value: string; warn?: boolean }): JSX.Element => (
    <div className="flex items-center justify-between gap-4">
      <span className="text-stone-400">{label}</span>
      <span className={warn ? 'text-amber-400' : 'text-stone-100'}>{value}</span>
    </div>
  )

  return createPortal(
    // Debug chrome: deliberately stone-literal, a fixed dark instrument outside the theme system.
    <div
      className="fixed left-2 bottom-2 z-[500] w-72 rounded-lg bg-stone-900/95 border border-stone-700 shadow-2xl text-[11px] font-mono text-stone-200 backdrop-blur"
      data-testid="metrics-overlay"
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-stone-700">
        <span className="flex items-center gap-1.5 text-stone-300">
          <Icon name="speed" size={13} className="text-emerald-400" />
          Performance
        </span>
        <button onClick={() => setOpen(false)} className="text-stone-500 hover:text-stone-200" aria-label="Close">
          <Icon name="close" size={12} />
        </button>
      </div>

      {status && (
        <div
          className="px-2.5 py-2 border-b border-amber-800/60 bg-amber-950/40 text-amber-300 text-[10px] leading-snug"
          data-testid="metrics-status"
        >
          {status}
        </div>
      )}

      <div className="px-2.5 py-2 space-y-0.5 border-b border-stone-800">
        <Row label="Total RAM" value={fmtMB(totalMem)} warn={totalMem > 3072} />
        <Row label="Total CPU" value={`${totalCpu}%`} warn={totalCpu > 80} />
        <Row label="Processes" value={`${procs.length}`} />
        <Row label="Renderers" value={`${renderers.length}`} />
        {main && <Row label="Main" value={fmtMB(main.memMB)} />}
        {gpu && <Row label="GPU" value={fmtMB(gpu.memMB)} />}
      </div>

      <div className="px-2.5 py-2 space-y-0.5 border-b border-stone-800" data-testid="metrics-counts">
        <div className="flex items-center justify-between gap-4">
          <span className="text-stone-400">Work widgets (desk)</span>
          <span className={liveWidgets > 60 ? 'text-amber-400' : 'text-stone-100'} data-testid="metrics-widgets">{liveWidgets}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-stone-400">Browsers</span>
          <span className={browsers >= 8 ? 'text-amber-400' : 'text-stone-100'} data-testid="metrics-browsers">{browsers}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-stone-400">Wires</span>
          <span className={links.length > 50 ? 'text-amber-400' : 'text-stone-100'} data-testid="metrics-wires">{links.length}</span>
        </div>
      </div>

      <div className="px-2.5 py-2">
        <div className="text-[9px] uppercase tracking-wider text-stone-500 mb-1">Top processes by RAM</div>
        <div className="space-y-0.5">
          {top.map((p) => {
            const label = labelFor(p.pid)
            return (
              <div key={p.pid} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {label ? (
                    <span className="text-stone-200">{label}</span>
                  ) : (
                    <span className="text-stone-400">
                      {p.type}
                      {p.name ? ` · ${p.name}` : ''}
                    </span>
                  )}
                  {label && <span className="text-stone-500"> · {p.type === 'Tab' ? 'renderer' : p.type}</span>}
                </span>
                <span className="text-stone-200 shrink-0">
                  {fmtMB(p.memMB)} · {p.cpu}%
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="px-2.5 py-1 border-t border-stone-800 text-[9px] text-stone-500">
        Cmd/Ctrl+Shift+M to toggle. Each browser work widget is its own renderer.
      </div>
    </div>,
    document.body
  )
}
