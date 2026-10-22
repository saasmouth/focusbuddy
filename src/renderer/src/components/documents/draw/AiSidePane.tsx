// PlexiiAssist in PlexiiDraw: describe it, SEE it, then apply it.
//
// The owner's report: "This works in diagrams, but not in draw. Draw needs to
// be able to build vector designs and paint designs." Two routes, and the
// pane is honest about the difference between them, because they are not the
// same engine:
//
//   VECTOR runs wherever the person's AI runs, the device included. What
//   comes back is editable art — real paths with anchors you can drag.
//
//   PAINT is OpenAI's gpt-image-1 and needs the person's own OpenAI key.
//   There is no on-device image model, so this option shows DISABLED with
//   that reason rather than failing after someone has typed a prompt and
//   pressed Generate.
//
// Nothing is applied unseen. A generation is previewed with the SAME renderer
// the exporter uses (drawDocToSvg), so the preview is the art, not an
// impression of it, and Apply is a separate press.

import { useEffect, useMemo, useState } from 'react'
import Icon from '../../Icon'
import AnsweredBy from '../../ai/AnsweredBy'
import { compileScene, sceneBounds } from '@shared/draw/generate/compile'
import { fitNodesToArtboard, targetArtboard } from '@shared/draw/generate/apply'
import type { Scene } from '@shared/draw/generate/scene'
import { drawId } from '@shared/draw'
import { drawDocToSvg } from '@shared/draw/svg'
import type { DrawDoc, DrawNode } from '@shared/draw/model'
import { generateBlockedReason } from './commands/ai.commands'
import type { EditorCtx } from './editor/types'
import { sceneForSelection } from './generate/selectionScene'

type Mode = 'art' | 'paint'

interface Preview {
  mode: Mode
  /** Vector: the scene as the model returned it, already validated. */
  scene?: Scene
  /** Paint: the generated picture. */
  dataUrl?: string
  /** What was asked for, so the layer carries a name a person recognises. */
  name: string
  /** Ids the apply will replace, when the request was "change my selection". */
  replaceIds?: string[]
  /** Dropped shapes, reported rather than hidden. */
  problems: Array<{ at: string; why: string }>
}

/** A throwaway document holding just the preview, rendered by the real exporter. */
function previewSvg(ctx: EditorCtx, scene: Scene): string | null {
  const doc = ctx.doc()
  const board = targetArtboard(doc)
  if (!board) return null
  const { nodes } = compileScene(scene, { newId: () => drawId('pv') })
  if (!nodes.length) return null
  const fitted: DrawNode[] = fitNodesToArtboard(nodes, sceneBounds(scene), board)
  const preview: DrawDoc = {
    ...doc,
    artboards: [{ ...board, background: { type: 'solid', color: '#ffffff' } }],
    activeArtboardId: board.id,
    layers: [{ id: 'pv-layer', kind: 'vector', name: 'Preview', visible: true, locked: false, opacity: 1, blend: 'normal', objects: fitted }],
    activeLayerId: 'pv-layer'
  }
  return drawDocToSvg(preview, { artboardId: board.id })
}

export default function AiSidePane({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<Mode>('art')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [since, setSince] = useState(0)
  const [paintKey, setPaintKey] = useState<boolean | null>(null)

  // Asked once, so the paint option can be disabled BEFORE anyone types a
  // prompt. d1's rule: never fail after the person has pressed Generate.
  useEffect(() => {
    let live = true
    void window.api.settings
      .hintOpenAI()
      .then((r) => live && setPaintKey(r.hasKey))
      .catch(() => live && setPaintKey(false))
    return () => {
      live = false
    }
  }, [])

  const selection = ctx.get().selection
  const blocked = generateBlockedReason(ctx)
  const paintReason = paintKey === false ? 'Paint designs need your own OpenAI key; vector art works on this device.' : null
  const svg = useMemo(() => (preview?.scene ? previewSvg(ctx, preview.scene) : null), [preview, ctx])

  async function generate(): Promise<void> {
    const text = prompt.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    setPreview(null)
    setSince(Date.now())
    const board = targetArtboard(ctx.doc())
    try {
      if (mode === 'paint') {
        const r = await window.api.design.generateImage({ prompt: text, width: Math.round(board?.w ?? 1024), height: Math.round(board?.h ?? 1024) })
        if (!r.ok || !r.dataUrl) setError(r.error || 'The image could not be generated.')
        else setPreview({ mode: 'paint', dataUrl: r.dataUrl, name: text.slice(0, 60), problems: [] })
        return
      }
      // "Change what I have selected" when there is a selection to change.
      const sel = selection.length ? sceneForSelection(ctx.doc(), selection) : undefined
      const r = await window.api.draw.generate({
        prompt: text,
        width: Math.round(board?.w ?? 800),
        height: Math.round(board?.h ?? 600),
        ...(sel ? { selection: sel } : {}),
        palette: ctx.doc().swatches.map((s) => s.color).filter((c): c is string => typeof c === 'string').slice(0, 12)
      })
      if (!r.ok) setError(r.error)
      else setPreview({ mode: 'art', scene: r.scene, name: r.scene.name, problems: r.problems, ...(sel ? { replaceIds: selection } : {}) })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function apply(): void {
    if (!preview) return
    if (preview.mode === 'paint' && preview.dataUrl) {
      ctx.run('ai.applyPaint', { dataUrl: preview.dataUrl, name: preview.name })
    } else if (preview.scene) {
      ctx.run('ai.applyScene', { scene: preview.scene, ...(preview.replaceIds ? { replaceIds: preview.replaceIds } : {}) })
    }
    setPreview(null)
  }

  // The root carries no testid: ShellSidePane puts draw-ai-pane on its own
  // tabpanel, and two live elements with one id is the duplicate-id trap.
  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-2">
        <p className="text-[11px] text-[var(--ink-50)]">
          Describe what to draw. Vector art comes back as real paths you can edit; a paint design comes back as pixels on
          a paint layer.
        </p>

        <div className="flex items-center gap-1" role="radiogroup" aria-label="What to generate">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'art'}
            onClick={() => setMode('art')}
            className={`flex-1 rounded px-2 py-1 text-[11px] ${mode === 'art' ? 'bg-accent/15 text-accent font-semibold' : 'fb-btn-surface'}`}
            data-testid="draw-ai-mode-art"
          >
            Vector art
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'paint'}
            disabled={!!paintReason}
            title={paintReason ?? 'A painted design on a paint layer'}
            onClick={() => setMode('paint')}
            className={`flex-1 rounded px-2 py-1 text-[11px] disabled:opacity-40 ${mode === 'paint' ? 'bg-accent/15 text-accent font-semibold' : 'fb-btn-surface'}`}
            data-testid="draw-ai-mode-paint"
          >
            Paint design
          </button>
        </div>
        {paintReason && (
          <p className="text-[10px] text-[var(--ink-40)] leading-snug" data-testid="draw-ai-paint-reason">
            {paintReason}
          </p>
        )}

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate()
          }}
          rows={4}
          placeholder={
            mode === 'paint'
              ? 'e.g. a watercolour wash of a coastline at dusk'
              : selection.length
                ? 'e.g. make these icons rounder, and recolour them to the brand palette'
                : 'e.g. a flat-style delivery van badge, side view, two colours'
          }
          className="fb-field w-full px-2 py-1.5 text-[12px]"
          data-testid="draw-ai-prompt"
        />
        {mode === 'art' && selection.length > 0 && (
          <p className="text-[10px] text-[var(--ink-40)]" data-testid="draw-ai-selection-note">
            {selection.length} object{selection.length === 1 ? '' : 's'} selected — this will rewrite them.
          </p>
        )}

        {error && (
          <div className="rounded border border-rose-400/50 bg-rose-400/10 px-2 py-1.5 text-[11px] text-rose-700 dark:text-rose-300" data-testid="draw-ai-error">
            {error}
          </div>
        )}

        {preview && (
          <div className="flex flex-col gap-1.5" data-testid="draw-ai-preview">
            <div className="fb-t-caption text-[var(--ink-40)]">Preview — nothing has changed in your drawing yet.</div>
            <div className="rounded border border-[var(--edge-soft)] bg-white p-1 flex items-center justify-center min-h-[120px] overflow-hidden">
              {preview.mode === 'paint' && preview.dataUrl ? (
                <img src={preview.dataUrl} alt="" className="max-h-[220px] w-auto" data-testid="draw-ai-preview-image" />
              ) : svg ? (
                <div className="w-full [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-h-[220px]" dangerouslySetInnerHTML={{ __html: svg }} data-testid="draw-ai-preview-svg" />
              ) : (
                <span className="text-[11px] text-[var(--ink-40)]">Nothing drawable in that result.</span>
              )}
            </div>
            {preview.problems.length > 0 && (
              <details className="text-[10px] text-[var(--ink-40)]" data-testid="draw-ai-problems">
                <summary>{preview.problems.length} part{preview.problems.length === 1 ? '' : 's'} of the reply could not be drawn</summary>
                <ul className="mt-1 list-disc pl-4">
                  {preview.problems.slice(0, 8).map((p, i) => (
                    <li key={i}>
                      {p.at ? `${p.at}: ` : ''}
                      {p.why}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {blocked && (
              <p className="text-[10px] text-amber-700 dark:text-amber-300" data-testid="draw-ai-blocked">
                {blocked}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={apply}
                disabled={!!blocked}
                className="rounded bg-[rgb(var(--accent))] px-2.5 py-1 text-[11px] text-white disabled:opacity-40"
                data-testid="draw-ai-apply"
              >
                {preview.replaceIds ? 'Replace selection' : 'Add to drawing'}
              </button>
              <button type="button" onClick={() => setPreview(null)} className="fb-btn-surface px-2 py-1 text-[11px]" data-testid="draw-ai-discard">
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--edge-soft)] p-2 flex items-center gap-2">
        <AnsweredBy feature={mode === 'paint' ? 'media' : 'office'} since={since} className="flex-1 min-w-0 truncate" />
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy || !prompt.trim()}
          className="rounded bg-[rgb(var(--accent))] px-3 py-1 text-[11px] text-white disabled:opacity-40 inline-flex items-center gap-1"
          data-testid="draw-ai-generate"
        >
          {busy ? <Icon name="progress_activity" size={13} className="animate-spin" /> : <Icon name="auto_awesome" size={13} />}
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </div>
  )
}
