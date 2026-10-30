import type { Widget } from '@shared/types'
import { summariseWidget } from './widgetSummary'
import { aggregatePortalContent } from './portalAggregate'
import { extractFileText, extractTextFromBuffer } from '../fileText'
import { fetchPageText } from '../webPage'

// Turn a wired-in widget into readable content a desk agent can actually reason
// over. Most kinds use the shared, network-free summariser; two are special:
// a browser is FETCHED (or uses its live page text) so a research agent has the
// real page, and a portal is AGGREGATED so an agent wired to it sees that whole
// desk (and any desks inherited into the portal).

export interface AgentInput {
  kind: string
  title: string
  content: string
}

export async function describeWidgetForAgent(w: Widget, liveText?: string): Promise<AgentInput> {
  const base = { kind: w.kind, title: w.title ?? '' }
  // Browser: real page text (live or fetched), the one async case.
  if (w.kind === 'webview') {
    const raw = w.content ?? ''
    const page = liveText && liveText.trim() ? liveText : await fetchPageText(raw)
    return { ...base, content: `Browser tab at ${raw || '(no URL)'}\n\n${page}` }
  }
  // Portal: aggregate the whole desk it points at, plus anything inherited into
  // it (control room). Cycle + depth guards live in the aggregator.
  if (w.kind === 'portal') {
    return { ...base, content: aggregatePortalContent(w) }
  }
  // File / PDF: read the actual CONTENTS. A locally-stored file (content is a
  // files-store id) is parsed by type; a document URL is downloaded and parsed if
  // it's a PDF, else fetched as a page. This is what lets a wire/agent summarise a
  // real PDF instead of just seeing its name.
  if (w.kind === 'file' || w.kind === 'pdf') {
    const raw = (w.content ?? '').trim()
    if (!raw) return { ...base, content: '(empty file)' }
    const isUrl = /^https?:\/\//i.test(raw)
    if (!isUrl) {
      // A bare files-store id (fb-file:// stripped) — extract its text locally.
      const id = raw.replace(/^fb-file:\/\//i, '')
      const text = await extractFileText(id)
      if (text && text.trim()) return { ...base, content: `File "${w.title || id}":\n\n${text}` }
      return { ...base, content: `(couldn't read the text of file "${w.title || id}")` }
    }
    // A URL. PDFs and office files won't fetch as text, so download + parse.
    if (/\.(pdf|docx|xlsx|xls|csv)(\?|$)/i.test(raw)) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12000)
        const res = await fetch(raw, { signal: controller.signal, redirect: 'follow' })
        clearTimeout(timer)
        if (!res.ok) return { ...base, content: `(could not download ${raw}: HTTP ${res.status})` }
        const buf = Buffer.from(await res.arrayBuffer())
        const ext = raw.toLowerCase().match(/\.([a-z0-9]+)(\?|$)/)?.[1] ?? ''
        const text = await extractTextFromBuffer(buf, ext, res.headers.get('content-type') ?? '')
        if (text && text.trim()) return { ...base, content: `File at ${raw}:\n\n${text}` }
        return { ...base, content: `(couldn't read the text of ${raw})` }
      } catch (e) {
        return { ...base, content: `(could not download ${raw}: ${e instanceof Error ? e.message : String(e)})` }
      }
    }
    // Any other URL: treat like a page.
    const page = liveText && liveText.trim() ? liveText : await fetchPageText(raw)
    return { ...base, content: `File/link at ${raw}\n\n${page}` }
  }
  // Everything else: the shared, network-free summary.
  return { ...base, content: summariseWidget(w) }
}
