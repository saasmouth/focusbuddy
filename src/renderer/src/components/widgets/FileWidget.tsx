import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import type { FbFile, FileKind } from '@shared/fields'
import {
  fileKindFromMime,
  hostnameForUrl,
  isExternalUrlContent
} from '@shared/fields'
import WidgetFrame from './WidgetFrame'
import { useFilesStore } from '../../stores/files'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import ConnectedToolMenu from '../contextMenu/UnifiedConnectedMenu'
import { fileSrc } from '../../lib/fileUrl'

interface Props {
  widget: Widget
  inline?: boolean
}

// Universal file widget. The widget's `content` field is either:
//   - an fb_files.id (local file) — rendered with fb-file:// URL, opens in
//     the user's default app via shell.openPath
//   - a cloud http(s) URL — rendered as a link card with a favicon, opens
//     in the user's default browser via shell.openExternal
//
// For local files we use macOS QuickLook (via main's nativeImage thumbnail
// API) to generate a real preview thumbnail for any file type the OS can
// preview — Word docs, Keynote, Sketch, .ai, .zip's top file, etc. — so the
// canvas shows the actual document, not a generic icon.
//
// PDFs use <iframe> (not <object>) because Chromium's built-in PDF viewer
// only exposes its toolbar — including page navigation — when loaded as a
// top-level frame document.
//
// Auto-size: when a local image is first set on this widget, we read the
// image's natural dimensions on load and resize the widget to its aspect
// ratio (capped at a sane target). One-shot per content change via a ref,
// so the user's manual resize after is never overridden.
export default function FileWidget({ widget, inline = false }: Props): JSX.Element {
  const content = widget.content ?? ''
  const isUrl = isExternalUrlContent(content)
  const fileId = !isUrl && content ? content : ''

  const file = useFilesStore((s) => (fileId ? s.files[fileId] ?? null : null))
  const ensureLoaded = useFilesStore((s) => s.ensureLoaded)
  const pickAndIngest = useFilesStore((s) => s.pickAndIngest)
  const openLocal = useFilesStore((s) => s.openLocal)
  const openExternal = useFilesStore((s) => s.openExternal)
  const update = useWidgetStore((s) => s.update)

  const [dropping, setDropping] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    selectionText?: string
  } | null>(null)

  useEffect(() => {
    if (fileId) void ensureLoaded(fileId)
  }, [fileId, ensureLoaded])

  // Track which content string has been auto-sized so we don't override a
  // user's manual resize on every re-render. Keyed by `content` because
  // replacing the file (drop a new one) is a legitimate trigger to re-size.
  const autoSizedFor = useRef<string | null>(null)
  function autoSizeOnce(newW: number, newH: number): void {
    if (autoSizedFor.current === content) return
    autoSizedFor.current = content
    // Only persist if it actually changes things — avoids a no-op IPC round-trip.
    if (newW === widget.width && newH === widget.height) return
    void update(widget.id, { width: newW, height: newH })
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDropping(false)
    // A drag of a URL (e.g. dragged from the browser tab strip) shows up as
    // dataTransfer.types containing 'text/uri-list' or 'text/plain'.
    const text =
      e.dataTransfer.getData('text/uri-list') ||
      e.dataTransfer.getData('text/plain')
    if (text && isExternalUrlContent(text)) {
      void update(widget.id, {
        content: text.trim(),
        title: hostnameForUrl(text.trim())
      })
      return
    }
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    const buffer = await f.arrayBuffer()
    const ingested = await window.api.files.ingestBuffer({
      buffer,
      originalName: f.name,
      mimeType: f.type || 'application/octet-stream'
    })
    void update(widget.id, { content: ingested.id, title: f.name })
  }

  async function handlePickClick(): Promise<void> {
    const ingested = await pickAndIngest({ title: 'Choose a file' })
    if (!ingested) return
    void update(widget.id, { content: ingested.id, title: ingested.originalName })
  }

  function handleUrlSubmit(): void {
    const trimmed = urlDraft.trim()
    if (!trimmed) return
    const normalised = isExternalUrlContent(trimmed)
      ? trimmed
      : `https://${trimmed}`
    void update(widget.id, {
      content: normalised,
      title: hostnameForUrl(normalised)
    })
    setUrlDraft('')
  }

  // ── Empty state ────────────────────────────────────────────────────────
  if (!content) {
    const body = (
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => void handleDrop(e)}
        className={`h-full w-full flex flex-col items-center justify-center gap-3 p-4 text-center ${
          dropping
            ? 'bg-accent/10 ring-2 ring-accent ring-inset'
            : 'bg-[var(--surface-sunken)]'
        }`}
      >
        <Icon name="upload_file" size={28} className="text-[var(--ink-40)]" />
        <div className="text-[12px] text-[var(--ink-70)]">
          Drop a file or paste a link
        </div>
        <button
          type="button"
          onClick={() => void handlePickClick()}
          className="text-[11px] px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
          data-testid="file-pick-button"
        >
          Choose file…
        </button>
        <div className="flex items-stretch gap-1 w-full max-w-[280px] mt-1">
          <input
            type="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleUrlSubmit()
              }
            }}
            placeholder="https://docs.google.com/…"
            className="fb-field flex-1 min-w-0 text-[11px] px-2 py-1.5 bg-[var(--surface-raised)]"
            data-testid="file-url-input"
          />
          <button
            type="button"
            onClick={handleUrlSubmit}
            disabled={!urlDraft.trim()}
            className="text-[11px] px-3 py-1.5 rounded-md bg-[var(--surface-sunken)] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="file-url-submit"
          >
            Add
          </button>
        </div>
        <div className="text-[10px] text-[var(--ink-40)]">
          Local file or any cloud link
        </div>
      </div>
    )
    if (inline) return body
    return (
      <WidgetFrame widget={widget} headerLabel="File" headerAccent="bg-stone-300/60 dark:bg-white/[0.09]">
        {body}
      </WidgetFrame>
    )
  }

  // ── URL (cloud-link) mode ──────────────────────────────────────────────
  if (isUrl) {
    const url = content
    const host = hostnameForUrl(url)
    const body = (
      <button
        type="button"
        onClick={() => void openExternal(url)}
        onContextMenu={(e) => {
          if (e.shiftKey) return
          e.preventDefault()
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            selectionText: (widget.title || url).slice(0, 200)
          })
        }}
        className="h-full w-full bg-[var(--surface-sunken)] hover:bg-[var(--surface-sunken)] transition-colors flex flex-col items-center justify-center gap-3 p-4 text-center group"
        data-testid="file-open-url"
        title={`Open ${url} in browser`}
      >
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
          alt=""
          aria-hidden="true"
          className="w-12 h-12 rounded-md shadow-sm"
          draggable={false}
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.visibility = 'hidden'
          }}
        />
        <div className="text-[12px] font-medium text-[var(--ink-90)] truncate max-w-full">
          {widget.title || host}
        </div>
        <div className="text-[10px] text-[var(--ink-50)] truncate max-w-full">{host}</div>
        <div className="text-[10px] text-accent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity inline-flex items-center gap-1">
          <Icon name="open_in_new" size={12} />
          Open in browser
        </div>
        {ctxMenu && (
          <ConnectedToolMenu
            sourceWidgetId={widget.id}
            x={ctxMenu.x}
            y={ctxMenu.y}
            selectionContext={{ selectionText: ctxMenu.selectionText }}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </button>
    )
    if (inline) return body
    return (
      <WidgetFrame
        widget={widget}
        headerLabel={widget.title || host}
        headerAccent="bg-stone-300/60 dark:bg-white/[0.09]"
      >
        {body}
      </WidgetFrame>
    )
  }

  // ── Local file mode ────────────────────────────────────────────────────
  const kind: FileKind = file ? fileKindFromMime(file.mimeType, file.ext) : 'generic'
  const url = fileSrc(fileId)
  const body = (
    <div
      className="h-full w-full bg-[var(--surface-sunken)] overflow-hidden"
      onContextMenu={(e) => {
        if (e.shiftKey) return
        e.preventDefault()
        const seed = (file?.originalName || widget.title || '').slice(0, 200)
        setCtxMenu({ x: e.clientX, y: e.clientY, selectionText: seed })
      }}
    >
      <FileRenderer
        kind={kind}
        url={url}
        fileId={fileId}
        file={file}
        onOpen={() => void openLocal(fileId)}
        onIntrinsicSize={(w, h) => autoSizeOnce(w, h)}
      />
      {ctxMenu && (
        <ConnectedToolMenu
          sourceWidgetId={widget.id}
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectionContext={{ selectionText: ctxMenu.selectionText }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
  if (inline) return body
  return (
    <WidgetFrame
      widget={widget}
      headerLabel={file ? file.originalName : 'File'}
      headerAccent="bg-stone-300/60 dark:bg-white/[0.09]"
    >
      {body}
    </WidgetFrame>
  )
}

function FileRenderer({
  kind,
  url,
  fileId,
  file,
  onOpen,
  onIntrinsicSize
}: {
  kind: FileKind
  url: string
  fileId: string
  file: FbFile | null
  onOpen: () => void
  onIntrinsicSize: (width: number, height: number) => void
}): JSX.Element {
  switch (kind) {
    case 'image':
      return (
        <img
          src={url}
          alt={file?.originalName ?? ''}
          className="w-full h-full object-contain cursor-pointer bg-[var(--surface-sunken)]"
          draggable={false}
          onClick={onOpen}
          onLoad={(e) => {
            const img = e.target as HTMLImageElement
            // Scale natural dimensions into a sensible widget target —
            // we want big enough to be useful but not so big it dominates
            // the canvas. Aspect ratio is preserved.
            const { naturalWidth, naturalHeight } = img
            if (!naturalWidth || !naturalHeight) return
            const TARGET_AREA = 480 * 320 // ~ default file widget area scaled up
            const ratio = naturalWidth / naturalHeight
            // Compute the (w, h) whose area is TARGET_AREA and ratio matches.
            // h = sqrt(area / ratio), w = h × ratio
            const h = Math.round(Math.sqrt(TARGET_AREA / ratio))
            const w = Math.round(h * ratio)
            const CAP_W = 800
            const CAP_H = 600
            const cappedW = Math.min(CAP_W, w)
            const cappedH = Math.min(CAP_H, h)
            // Add ~32px height for the widget header chrome — measured
            // empirically from the header in WidgetFrame.tsx. Keeps the
            // image rendering at its natural aspect ratio inside the body
            // without a black bar.
            onIntrinsicSize(cappedW, cappedH + 32)
          }}
          title="Open in default app"
        />
      )
    case 'pdf':
      return (
        <iframe
          src={`${url}#toolbar=1&navpanes=1&view=FitH`}
          title={file?.originalName ?? 'PDF'}
          className="w-full h-full border-0"
        />
      )
    case 'video':
      return (
        <video
          src={url}
          controls
          className="w-full h-full bg-black"
          preload="metadata"
        />
      )
    case 'audio':
      return (
        <div className="h-full w-full flex flex-col items-center justify-center gap-2 p-4">
          <Icon name="music_note" size={32} className="text-accent" />
          <div className="text-[12px] font-medium text-[var(--ink-90)] truncate max-w-full">
            {file?.originalName ?? 'Audio'}
          </div>
          <audio src={url} controls className="w-full" preload="metadata" />
        </div>
      )
    case 'generic':
    default:
      return <GenericFilePreview fileId={fileId} file={file} onOpen={onOpen} />
  }
}

/**
 * Generic-file preview: maximises real estate for the QuickLook thumbnail.
 *
 * Layout — thumbnail fills the body via object-contain (preserves aspect
 * ratio, no cropping), with a slim footer strip pinning the filename + size
 * + extension at the bottom. The entire surface is the click target so
 * "click to open" stays a one-action affordance. Hover surfaces the
 * "Open in default app" hint as an overlay so the surface stays clean at
 * rest but the action is discoverable.
 *
 * This is a deliberate trade against the previous icon-centric layout: the
 * thumbnail IS the widget. Tiny widgets still show the file name; large
 * widgets feel like a proper desktop file icon at maximum fidelity.
 */
function GenericFilePreview({
  fileId,
  file,
  onOpen
}: {
  fileId: string
  file: FbFile | null
  onOpen: () => void
}): JSX.Element {
  const thumbnail = useFilesStore((s) => s.thumbnail)
  const [thumb, setThumb] = useState<string | null>(null)
  const [pending, setPending] = useState(true)

  useEffect(() => {
    if (!fileId) return
    setPending(true)
    let cancelled = false
    void thumbnail(fileId, 512).then((url) => {
      if (cancelled) return
      setThumb(url)
      setPending(false)
    })
    return () => {
      cancelled = true
    }
  }, [fileId, thumbnail])

  return (
    <button
      type="button"
      onClick={onOpen}
      className="h-full w-full flex flex-col bg-[var(--surface-sunken)] hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)] transition-colors group relative"
      data-testid="file-open-local"
      title={file ? `Open ${file.originalName} in default app` : 'Open file'}
    >
      {/* Thumbnail occupies the entire body except the footer strip. */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-2">
        {thumb ? (
          <img
            src={thumb}
            alt={file?.originalName ?? ''}
            className="max-w-full max-h-full object-contain drop-shadow-md"
            draggable={false}
            data-testid="file-thumbnail"
          />
        ) : pending ? (
          <Icon
            name="hourglass_empty"
            size={36}
            className="text-[var(--ink-40)] animate-pulse"
          />
        ) : (
          // QuickLook couldn't preview this file — fall back to a stylised
          // generic-doc icon at large size so the widget still feels
          // intentional rather than broken.
          <Icon name="description" size={64} className="text-[var(--ink-40)]" />
        )}
      </div>
      {/* Footer strip — slim, high-contrast, never dominates the thumb. */}
      <div className="shrink-0 border-t border-[var(--edge-soft)] bg-[var(--surface-raised)] px-2 py-1 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 text-left">
          <div className="text-[11px] font-medium text-[var(--ink-90)] truncate">
            {file?.originalName ?? 'File'}
          </div>
          {file && (
            <div className="text-[9px] text-[var(--ink-50)] leading-tight">
              {formatBytes(file.sizeBytes)}
              {file.ext && ` · ${file.ext.replace(/^\./, '').toUpperCase()}`}
            </div>
          )}
        </div>
        <div className="text-[10px] text-[var(--ink-50)] group-hover:text-accent transition-colors inline-flex items-center gap-0.5 shrink-0">
          <Icon name="open_in_new" size={12} />
        </div>
      </div>
    </button>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
