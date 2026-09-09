import { useState } from 'react'
import type { Widget } from '@shared/types'
import { useWidgetStore } from '../../stores/widgets'
import { catalogFor } from '../../lib/widgetCatalog'
import Icon from '../Icon'
import { fileSrc } from '../../lib/fileUrl'

// Prompt-to-image on the desk, via OpenAI's gpt-image-1.
//
// The generation itself already existed for the design editor; this puts it on a
// desk and lands the result as a REAL image file rather than a data URI, so it
// renders through the same fb-file:// path as any other image and does not push
// megabytes of base64 through sync.
//
// Honest with no key: the button explains that a key is needed and links where to
// put it, rather than failing generically or showing a placeholder image.

interface State {
  prompt: string
  fileId: string | null
}

function parse(content: string | null | undefined): State {
  if (!content) return { prompt: '', fileId: null }
  try {
    const p = JSON.parse(content) as Partial<State>
    return { prompt: p.prompt ?? '', fileId: p.fileId ?? null }
  } catch {
    // Older/foreign content: treat a bare string as a file id so nothing is lost.
    return { prompt: '', fileId: content.trim() || null }
  }
}

const SHAPES = [
  { label: 'Square', w: 1024, h: 1024 },
  { label: 'Landscape', w: 1536, h: 1024 },
  { label: 'Portrait', w: 1024, h: 1536 }
] as const

export default function ImageGenWidget({
  widget,
  inline = false
}: {
  widget: Widget
  inline?: boolean
}): React.JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const create = useWidgetStore((s) => s.create)
  const saved = parse(widget.content)
  const [prompt, setPrompt] = useState(saved.prompt)
  const [shape, setShape] = useState<(typeof SHAPES)[number]>(SHAPES[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsKey, setNeedsKey] = useState(false)
  const fileId = saved.fileId

  async function generate(): Promise<void> {
    const p = prompt.trim()
    if (!p || busy) return
    setBusy(true)
    setError(null)
    setNeedsKey(false)
    try {
      const r = await window.api.design.generateToFile({ prompt: p, width: shape.w, height: shape.h })
      if (r.ok && r.fileId) {
        await update(widget.id, { content: JSON.stringify({ prompt: p, fileId: r.fileId }) })
      } else {
        setNeedsKey(!!r.needsKey)
        setError(r.error ?? 'Could not generate that image.')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Place the finished image as its own widget, so the generator can be reused
  // without losing what it already made.
  async function placeOnDesk(): Promise<void> {
    if (!fileId) return
    const entry = catalogFor('file')
    await create({
      taskId: widget.taskId,
      kind: 'file',
      title: prompt.trim().slice(0, 60) || 'Generated image',
      content: fileId,
      x: Math.round(widget.x + widget.width + 24),
      y: widget.y,
      width: entry?.defaultWidth,
      height: entry?.defaultHeight
    })
  }

  if (inline) {
    return fileId ? (
      <img src={fileSrc(fileId)} alt={prompt || 'Generated image'} className="w-full h-full object-contain" />
    ) : (
      <div className="fb-t-caption text-[var(--ink-50)] p-2">Image generator</div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col fb-card overflow-hidden" data-testid="image-gen-widget">
      <div className="px-2.5 py-1.5 border-b border-[var(--edge-soft)] flex items-center gap-1.5">
        <Icon name="auto_awesome" size={13} />
        <span className="fb-t-caption text-[var(--ink-70)]">Generate an image</span>
      </div>

      <div className="flex-1 min-h-0 relative bg-[var(--surface-sunken)]">
        {fileId ? (
          <img
            src={fileSrc(fileId)}
            alt={prompt || 'Generated image'}
            className="absolute inset-0 w-full h-full object-contain"
            data-testid="image-gen-result"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
            <span className="fb-t-caption text-[var(--ink-40)] leading-snug">
              {busy ? 'Generating…' : 'Describe an image and it will appear here.'}
            </span>
          </div>
        )}
        {busy && fileId && <div className="absolute inset-0 bg-black/30 flex items-center justify-center fb-t-caption text-white">Generating…</div>}
      </div>

      {(error || needsKey) && (
        <div className="px-2.5 py-1.5 fb-t-caption text-amber-600 leading-snug" data-testid="image-gen-error">
          {error}
          {needsKey && <span className="text-[var(--ink-50)]"> Settings → AI · API keys.</span>}
        </div>
      )}

      <div className="px-2.5 py-1.5 border-t border-[var(--edge-soft)] flex flex-col gap-1.5">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate()
          }}
          placeholder="A calm desk workspace at golden hour, soft focus…"
          rows={2}
          className="w-full resize-none bg-transparent border border-[var(--edge-soft)] rounded px-1.5 py-1 fb-t-caption text-[var(--ink-90)] placeholder:text-[var(--ink-40)]"
          data-testid="image-gen-prompt"
        />
        <div className="flex items-center gap-1">
          {SHAPES.map((s) => (
            <button
              key={s.label}
              onClick={() => setShape(s)}
              className={`fb-t-caption px-1.5 py-0.5 rounded border transition-colors ${
                shape.label === s.label
                  ? 'border-accent bg-accent/10 text-[var(--ink-100)]'
                  : 'border-[var(--edge-soft)] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              {s.label}
            </button>
          ))}
          <div className="flex-1" />
          {fileId && (
            <button
              onClick={() => void placeOnDesk()}
              className="fb-t-caption px-1.5 py-0.5 rounded border border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
              data-testid="image-gen-place"
              title="Add this image to the desk as its own widget"
            >
              Add to desk
            </button>
          )}
          <button
            onClick={() => void generate()}
            disabled={busy || prompt.trim() === ''}
            className="fb-t-caption px-2 py-0.5 rounded bg-accent text-white disabled:opacity-50"
            data-testid="image-gen-go"
          >
            {busy ? 'Generating…' : fileId ? 'Regenerate' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
