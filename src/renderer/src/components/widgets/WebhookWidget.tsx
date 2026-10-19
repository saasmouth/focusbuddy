import { useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import { useWidgetStore } from '../../stores/widgets'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'

// Outbound webhook widget (Lever 3, Phase 0). Configure a URL; wire any tool INTO
// this widget and its content is POSTed there on every change (handled in the wire
// engine). "Send test" fires a one-off POST so the user can confirm the endpoint
// before wiring. Config is { url } serialised in widget.content. Send status shown
// here is honest — a failed POST says so, never a fake success.

interface WebhookConfig {
  url: string
}

function parse(content: string): WebhookConfig {
  try {
    const o = JSON.parse(content || '{}')
    return { url: typeof o.url === 'string' ? o.url : '' }
  } catch {
    return { url: '' }
  }
}

export default function WebhookWidget({
  widget,
  inline = false
}: {
  widget: Widget
  inline?: boolean
}): JSX.Element {
  const cfg = useMemo(() => parse(widget.content), [widget.content])
  const [url, setUrl] = useState(cfg.url)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const persist = (next: string): void => {
    void useWidgetStore.getState().update(widget.id, { content: JSON.stringify({ url: next }) })
  }

  const sendTest = async (): Promise<void> => {
    if (!url.trim()) {
      setResult({ ok: false, text: 'Enter a URL first.' })
      return
    }
    setTesting(true)
    setResult(null)
    try {
      const res = await window.api.webhooks.send({
        url,
        body: JSON.stringify({ test: true, from: 'PlexiiDesk', at: new Date().toISOString() })
      })
      setResult(
        res.ok
          ? { ok: true, text: `Sent OK${res.status ? ` (${res.status})` : ''}` }
          : { ok: false, text: res.error ?? 'Send failed.' }
      )
    } finally {
      setTesting(false)
    }
  }

  const content = (
    <div className="h-full w-full flex flex-col gap-2 p-2.5 text-[12px] text-[var(--ink-70)]" data-testid="webhook-widget">
      <div className="flex items-center gap-1.5 text-[var(--ink-60)]">
        <Icon name="webhook" size={14} className="text-accent" />
        <span className="font-medium">Send to a URL</span>
      </div>
      <input
        type="url"
        value={url}
        placeholder="https://hooks.slack.com/…  or any endpoint"
        spellCheck={false}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => url !== cfg.url && persist(url)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') persist(url)
        }}
        data-testid="webhook-url"
        className="fb-field w-full px-2 py-1.5 text-[11px]"
      />
      <p className="text-[10px] text-[var(--ink-45)] leading-snug">
        Wire a tool into this and its content POSTs here whenever it changes.
      </p>
      <div className="mt-auto flex items-center gap-2">
        <button
          onClick={() => void sendTest()}
          disabled={testing}
          data-testid="webhook-test"
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-accent text-white text-[11px] disabled:opacity-50"
        >
          <Icon name={testing ? 'hourglass_empty' : 'send'} size={12} />
          {testing ? 'Sending…' : 'Send test'}
        </button>
        {result && (
          <span
            data-testid="webhook-result"
            className={`text-[10px] ${result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {result.text}
          </span>
        )}
      </div>
    </div>
  )

  if (inline) return content

  return (
    <WidgetFrame widget={widget} headerLabel="webhook" headerAccent="bg-accent/20">
      {content}
    </WidgetFrame>
  )
}
