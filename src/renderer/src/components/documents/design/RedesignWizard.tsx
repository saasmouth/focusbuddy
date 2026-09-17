import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import SlideCanvas from '../slides/SlideCanvas'
import { autoLayout, LAYOUT_STYLES, planFromContent, type LayoutPlan, type LayoutStyle } from '@shared/designAutoLayout'
import { contentStats, isContentEmpty, parsePaste, parsePlainText, parseTiptap, toPlainText, type ContentDoc } from '@shared/designContent'
import { masterForPage, resolveMasterElements, type DesignBody, type DesignSize } from '@shared/design'
import type { FlowMeasurer } from '@shared/designFlow'
import type { DeckTheme, DocumentMeta } from '@shared/types'
import type { OrgBrandKit } from '@shared/brandKit'

// The redesign wizard — the way a layout actually gets made.
//
// You bring a DOCUMENT (paste it, drop in a .docx, pull in a PlexiDoc) and pick
// a look. Every option is a live miniature of your own words laid out that way,
// built by the same engine that will build the real thing — so what you click is
// exactly what you get, down to the page count.
//
// Nothing here writes copy. The AI, when a key is configured, only chooses the
// arrangement: which style, how many columns, which of YOUR sentences to lift
// into a pull quote. Without a key the built-in planner makes the same kind of
// choice from the shape of the content, so the feature works fully offline.

interface Props {
  size: DesignSize
  brand: OrgBrandKit
  measure: FlowMeasurer
  theme: DeckTheme
  /** Content already in the document, so reopening the wizard does not lose it. */
  initialContent?: ContentDoc
  onApply: (body: DesignBody, content: ContentDoc, styleId: string) => void
  onCancel: () => void
}

interface Option {
  style: LayoutStyle
  body: DesignBody
  pages: number
  overset: boolean
}

export default function RedesignWizard({ size, brand, measure, theme, initialContent, onApply, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(() => (initialContent ? toPlainText(initialContent) : ''))
  const [content, setContent] = useState<ContentDoc>(() => initialContent ?? { blocks: [] })
  const [chosen, setChosen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [plan, setPlan] = useState<LayoutPlan | null>(null)
  const [aiReason, setAiReason] = useState<string | null>(null)
  const [pickDocOpen, setPickDocOpen] = useState(false)
  const [docs, setDocs] = useState<DocumentMeta[]>([])
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  // Re-parse as the author types, but only the structure — the text box stays
  // the source of truth so nothing is ever rewritten under the cursor.
  useEffect(() => {
    const t = setTimeout(() => setContent(parsePlainText(text, { firstLineIsTitle: true })), 180)
    return () => clearTimeout(t)
  }, [text])

  const stats = useMemo(() => contentStats(content), [content])
  const empty = isContentEmpty(content)
  const heuristic = useMemo(() => (empty ? null : planFromContent(content)), [content, empty])
  const activePlan = plan ?? heuristic

  // Every style, laid out for real with the author's own words. This is the
  // preview: not a mock-up of a template, but the document itself.
  const options: Option[] = useMemo(() => {
    if (empty) return []
    return LAYOUT_STYLES.map((style) => {
      const r = autoLayout({ content, size, brand, style, plan: activePlan ?? undefined, measure, maxPages: 24 })
      return { style, body: r.body, pages: r.pages, overset: r.overset }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, size, brand, activePlan, empty])

  const recommendedId = activePlan?.styleId ?? 'editorial'
  const selectedId = chosen ?? recommendedId
  const selected = options.find((o) => o.style.id === selectedId) ?? options[0]

  async function pasteFromClipboard(): Promise<void> {
    try {
      // The HTML flavour carries the structure a Word or web paste has; the
      // plain flavour is the fallback.
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text()
          const plain = item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : ''
          const parsed = parsePaste({ html, text: plain })
          setContent(parsed)
          setText(toPlainText(parsed))
          setStatus(`Pasted ${contentStats(parsed).words} words with their structure.`)
          return
        }
      }
      const plain = await navigator.clipboard.readText()
      setText(plain)
      setStatus(`Pasted ${plain.split(/\s+/).filter(Boolean).length} words.`)
    } catch {
      setStatus('Could not read the clipboard — paste into the box with ⌘V instead.')
      areaRef.current?.focus()
    }
  }

  async function importDocx(): Promise<void> {
    setBusy('Reading document…')
    try {
      const res = await window.api.office.importDocx()
      if (!res.ok || !res.html) {
        if (res.error) setStatus(res.error)
        return
      }
      const parsed = parsePaste({ html: res.html })
      setContent(parsed)
      setText(toPlainText(parsed))
      setStatus(`Imported ${contentStats(parsed).words} words from ${res.fileName ?? 'the document'}.`)
    } finally {
      setBusy(null)
    }
  }

  async function openDocPicker(): Promise<void> {
    const all = await window.api.documents.list()
    setDocs(all.filter((d) => d.docType === 'doc'))
    setPickDocOpen(true)
  }

  async function pullFromDoc(id: string): Promise<void> {
    setPickDocOpen(false)
    setBusy('Reading document…')
    try {
      const doc = await window.api.documents.get(id)
      if (!doc) return
      const parsed = parseTiptap(doc.body)
      if (parsed.blocks.length === 0) {
        setStatus('That document has no text in it yet.')
        return
      }
      setContent(parsed)
      setText(toPlainText(parsed))
      setStatus(`Pulled ${contentStats(parsed).words} words from “${doc.title}”.`)
    } finally {
      setBusy(null)
    }
  }

  async function askAi(): Promise<void> {
    setBusy('Planning the layout…')
    setStatus(null)
    try {
      // Only an OUTLINE goes to the model — headings, block kinds and lengths.
      // The copy itself never leaves, and the reply can only choose arrangement.
      const outline = content.blocks.map((b, i) => ({
        i,
        kind: b.kind,
        words: (b.kind === 'list' ? b.items.join(' ') : 'text' in b ? b.text : '').split(/\s+/).filter(Boolean).length,
        preview: (b.kind === 'list' ? b.items[0] : 'text' in b ? b.text : '').slice(0, 90)
      }))
      const res = await window.api.design.planLayout({
        outline,
        styles: LAYOUT_STYLES.map((s) => ({ id: s.id, name: s.name, blurb: s.blurb, columns: s.columns })),
        page: { width: size.w, height: size.h, label: size.label }
      })
      if (!res.ok) {
        setStatus(res.needsApiKey ? 'No AI key configured — using the built-in planner, which works offline.' : res.error ?? 'The planner could not run.')
        return
      }
      if (res.plan) {
        // A plan may only ever name REAL block indexes; anything else is dropped
        // rather than trusted into the layout.
        const safe: LayoutPlan = {
          styleId: LAYOUT_STYLES.some((s) => s.id === res.plan!.styleId) ? res.plan!.styleId : recommendedId,
          columns: res.plan.columns,
          pullQuoteBlocks: (res.plan.pullQuoteBlocks ?? []).filter((i) => content.blocks[i]?.kind === 'paragraph'),
          reason: res.plan.reason
        }
        setPlan(safe)
        setChosen(safe.styleId)
        setAiReason(safe.reason ?? null)
      }
    } finally {
      setBusy(null)
    }
  }

  function apply(): void {
    if (!selected) return
    onApply(selected.body, content, selected.style.id)
  }

  return (
    <div className="space-y-3 text-[12px]" data-testid="design-redesign-wizard">
      {/* ── The document ──────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] flex-1">Your text</span>
          <button onClick={() => void pasteFromClipboard()} data-testid="design-wizard-paste" className="fb-btn-surface px-2 py-1 hover:border-accent inline-flex items-center gap-1">
            <Icon name="content_paste" size={13} /> Paste
          </button>
          <button onClick={() => void importDocx()} data-testid="design-wizard-docx" className="fb-btn-surface px-2 py-1 hover:border-accent inline-flex items-center gap-1">
            <Icon name="description" size={13} /> Import .docx
          </button>
          <button onClick={() => void openDocPicker()} data-testid="design-wizard-from-doc" className="fb-btn-surface px-2 py-1 hover:border-accent inline-flex items-center gap-1">
            <Icon name="article" size={13} /> From a PlexiDoc
          </button>
          {text && (
            <button onClick={() => setText('')} className="fb-btn-surface px-2 py-1 hover:border-accent" title="Clear the text">
              Clear
            </button>
          )}
        </div>
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="design-wizard-text"
          rows={7}
          placeholder={
            'Paste or type your document here.\n\nThe first short line becomes the headline. Blank lines separate paragraphs.\n# Title   ### Heading   - bullet   1. numbered   > quote'
          }
          className="fb-field w-full px-2 py-1.5 text-[12px] leading-relaxed resize-y font-mono"
        />
        <div className="flex items-center gap-2 mt-1 text-[10px] text-[var(--ink-40)]">
          {empty ? (
            <span>Nothing to lay out yet.</span>
          ) : (
            <span data-testid="design-wizard-stats">
              {stats.words.toLocaleString()} words · {stats.paragraphs} paragraphs
              {stats.headings ? ` · ${stats.headings} headings` : ''}
              {stats.lists ? ` · ${stats.lists} lists` : ''}
              {stats.images ? ` · ${stats.images} images` : ''}
            </span>
          )}
          <span className="flex-1" />
          {(busy || status) && (
            <span className="inline-flex items-center gap-1 text-[var(--ink-50)] max-w-[420px] truncate">
              {busy && <Icon name="autorenew" size={11} className="animate-spin" />}
              {busy ?? status}
            </span>
          )}
        </div>
      </div>

      {/* ── The looks ─────────────────────────────────────────────────────── */}
      {!empty && (
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] flex-1">Pick a look</span>
            <button onClick={() => void askAi()} disabled={!!busy} data-testid="design-wizard-ai" className="fb-btn-surface px-2 py-1 hover:border-accent inline-flex items-center gap-1 disabled:opacity-50">
              <Icon name="auto_awesome" size={13} className="text-accent" /> Ask AI to choose
            </button>
          </div>
          {(aiReason || activePlan?.reason) && (
            <p className="text-[11px] text-[var(--ink-50)] mb-1.5 inline-flex items-start gap-1" data-testid="design-wizard-reason">
              <Icon name={aiReason ? 'auto_awesome' : 'lightbulb'} size={12} className="mt-0.5 text-accent shrink-0" />
              <span>{aiReason ?? activePlan?.reason}</span>
            </p>
          )}
          <div className="flex gap-2 overflow-x-auto pb-1" data-testid="design-wizard-options">
            {options.map((o) => {
              const active = o.style.id === selectedId
              const page = o.body.pages?.[0]
              const master = page ? masterForPage(o.body, page) : null
              return (
                <button
                  key={o.style.id}
                  onClick={() => setChosen(o.style.id)}
                  data-testid={`design-wizard-style-${o.style.id}`}
                  title={o.style.blurb}
                  className={`shrink-0 rounded-lg border p-1.5 text-left transition ${
                    active ? 'border-accent bg-accent/5 shadow-sm' : 'border-[var(--edge-soft)] hover:border-accent/60'
                  }`}
                  style={{ width: 132 }}
                >
                  <div className="pointer-events-none mb-1 overflow-hidden rounded bg-white" style={{ height: (118 * size.h) / size.w }}>
                    {page && (
                      <SlideCanvas
                        slide={{ id: 'preview', notes: '', elements: page.elements, background: page.background, schemaVersion: 2 }}
                        theme={theme}
                        width={118}
                        logicalW={o.body.width}
                        logicalH={o.body.height}
                        selectedIds={[]}
                        underlay={master ? resolveMasterElements(master, { page: 1, pages: o.pages }) : undefined}
                        onSelect={() => {}}
                        onSelectMany={() => {}}
                        onUpdateElement={() => {}}
                        onMoveMany={() => {}}
                        onSetText={() => {}}
                      />
                    )}
                  </div>
                  <div className="text-[11px] font-medium text-[var(--ink-80)] flex items-center gap-1">
                    {o.style.name}
                    {o.style.id === recommendedId && <Icon name="star" size={10} className="text-accent" />}
                  </div>
                  <div className="text-[10px] text-[var(--ink-40)]">
                    {o.pages} page{o.pages === 1 ? '' : 's'} · {o.style.columns} col{o.style.columns === 1 ? '' : 's'}
                  </div>
                </button>
              )
            })}
          </div>
          {selected && <p className="text-[11px] text-[var(--ink-50)] mt-1.5">{selected.style.blurb}</p>}
          {selected?.overset && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 inline-flex items-center gap-1">
              <Icon name="warning" size={12} />
              This look needs more than 24 pages for that much copy — trim the text or pick a denser layout.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1 border-t border-[var(--edge-soft)]">
        <span className="text-[10px] text-[var(--ink-40)] flex-1">
          Applying replaces the document&apos;s pages. Your text stays editable afterwards in the story editor.
        </span>
        <button onClick={onCancel} className="fb-btn-surface px-3 py-1.5 hover:border-accent">
          Cancel
        </button>
        <button onClick={apply} disabled={empty || !selected} data-testid="design-wizard-apply" className="btn-primary px-3 py-1.5 disabled:opacity-40">
          Lay it out
        </button>
      </div>

      {pickDocOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setPickDocOpen(false)}>
          <div className="fb-glass-panel rounded-xl p-3 w-[380px] max-h-[60vh] overflow-auto" onClick={(e) => e.stopPropagation()} data-testid="design-wizard-doc-list">
            <div className="text-[12px] font-medium mb-2 text-[var(--ink-80)]">Pull text from a document</div>
            {docs.length === 0 && <p className="text-[11px] text-[var(--ink-40)]">You have no documents yet.</p>}
            {docs.map((d) => (
              <button
                key={d.id}
                onClick={() => void pullFromDoc(d.id)}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--surface-sunken)] text-[12px] text-[var(--ink-80)]"
              >
                {d.title || 'Untitled document'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
