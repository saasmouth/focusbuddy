// The one AI Assist preview. Mounted once at the app root, it listens to the
// aiAssistPreview store, runs the ai:transformText IPC, shows the result before
// anything is written, and applies it in place on confirmation. This is the
// "preview before applying" guarantee from the spec, deliverable 7.
//
// Write-back is deliberately conservative. A sub-selection is spliced back into
// the widget's text when that exact text is found in the content; the whole
// content is replaced only for plain-text widgets; and anything that cannot be
// spliced safely (a selection inside a rich Tiptap document) falls back to
// spawning a connected sticky with the result, so AI Assist can never corrupt
// structured content.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'
import { useAiAssistPreview } from '../../stores/aiAssistPreview'
import { useWidgetStore } from '../../stores/widgets'
import { createConnectedTool } from '../../lib/createConnectedTool'
import AnsweredBy from '../ai/AnsweredBy'
import { useAddToDeskPicker } from '../../stores/addToDeskPicker'

const PLAIN_TEXT_KINDS = ['sticky', 'note', 'markdown']

export default function AiAssistPreview(): JSX.Element | null {
  const { open, request, status, result, error, setLoading, setResult, setError, close } =
    useAiAssistPreview()
  const [instr, setInstr] = useState('')
  const ranFor = useRef<string | null>(null)
  // When this run started: "Answered by" names the engine of THIS result.
  const [ranAt, setRanAt] = useState(0)

  // Reset the editable instruction whenever a new request opens.
  useEffect(() => {
    if (request) {
      setInstr(request.instruction)
      ranFor.current = null
    }
  }, [request])

  async function run(instruction: string): Promise<void> {
    if (!request) return
    if (!instruction.trim()) return
    setLoading()
    setRanAt(Date.now())
    const r = await window.api.ai.transformText({
      text: request.text,
      instruction,
      kind: request.sourceKind
    })
    if (r.ok && r.result) setResult(r.result)
    else setError(r.needsApiKey ? 'No Anthropic API key is set. Add one in Settings, AI, API keys.' : r.error || 'AI Assist failed.')
  }

  // Auto-run for preset actions. Custom actions wait for the user to type and
  // press Run (status starts at idle for those).
  useEffect(() => {
    if (open && request && status === 'loading' && ranFor.current !== request.instruction + (request.sourceWidgetId ?? request.text)) {
      ranFor.current = request.instruction + (request.sourceWidgetId ?? request.text)
      void run(request.instruction)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request, status])

  if (!open || !request) return null

  async function apply(): Promise<void> {
    if (!result || !request) return
    const store = useWidgetStore.getState()
    const w = request.sourceWidgetId ? store.widgets.find((x) => x.id === request.sourceWidgetId) : undefined
    if (!w) {
      close()
      return
    }
    const content = w.content || ''
    if (!request.wholeContent && request.text && content.includes(request.text)) {
      await store.update(w.id, { content: content.replace(request.text, result) })
    } else if (request.wholeContent && PLAIN_TEXT_KINDS.includes(w.kind)) {
      await store.update(w.id, { content: result })
    } else {
      // Cannot splice safely (e.g. a selection inside a rich document). Spawn a
      // connected sticky rather than risk corrupting structured content.
      await createConnectedTool({ sourceWidgetId: w.id, kind: 'sticky', content: result.slice(0, 2000) })
    }
    close()
  }

  // Text from a web page: the result goes to a desk as its own work widget.
  function addResultToDesk(): void {
    if (!result || !request?.web) return
    useAddToDeskPicker.getState().open({
      command: 'add-to-desk',
      target: 'selection',
      desk: 'choose',
      text: result,
      pageUrl: request.web.pageUrl,
      pageTitle: request.web.pageTitle
    })
    close()
  }

  async function copy(): Promise<void> {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result)
    } catch {
      // ignore
    }
    close()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        data-testid="ai-assist-preview"
        className="fb-card w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--edge-soft)]">
          <Icon name="auto_awesome" size={18} className="text-accent" />
          <span className="font-medium text-[var(--ink-100)]">{request.label}</span>
          <button
            onClick={close}
            className="ml-auto h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--surface-sunken)] text-[var(--ink-50)]"
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="px-4 py-3 overflow-y-auto flex-1 flex flex-col gap-3">
          <label className="text-xs uppercase tracking-wide text-[var(--ink-50)]">Instruction</label>
          <textarea
            data-testid="ai-assist-instruction"
            value={instr}
            onChange={(e) => setInstr(e.target.value)}
            rows={2}
            placeholder="Describe what you want done with the text"
            className="fb-field w-full resize-none px-2 py-1.5 text-sm text-[var(--ink-100)]"
          />

          {status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-[var(--ink-50)] py-6 justify-center">
              <Icon name="autorenew" size={16} className="animate-spin" />
              Working on it
            </div>
          )}

          {status === 'error' && (
            <div data-testid="ai-assist-error" className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          {status === 'ready' && result && (
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-[var(--ink-50)]">Result</span>
              <div
                data-testid="ai-assist-result"
                className="whitespace-pre-wrap text-sm text-[var(--ink-100)] bg-[var(--surface-sunken)] rounded px-3 py-2 max-h-72 overflow-y-auto"
              >
                {result}
              </div>
              <AnsweredBy feature="writing" since={ranAt} className="mt-1" />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--edge-soft)]">
          {status !== 'ready' ? (
            <button
              data-testid="ai-assist-run"
              onClick={() => void run(instr)}
              disabled={status === 'loading' || !instr.trim()}
              className="px-3 py-1.5 rounded bg-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {status === 'loading' ? 'Working' : 'Run'}
            </button>
          ) : (
            <>
              {request.web ? (
                <button
                  data-testid="ai-assist-add-to-desk"
                  onClick={addResultToDesk}
                  className="px-3 py-1.5 rounded bg-accent text-white text-sm font-medium"
                >
                  Add to desk…
                </button>
              ) : (
                <button
                  data-testid="ai-assist-apply"
                  onClick={() => void apply()}
                  className="px-3 py-1.5 rounded bg-accent text-white text-sm font-medium"
                >
                  Apply
                </button>
              )}
              <button
                onClick={() => void copy()}
                data-testid="ai-assist-copy"
                className="fb-btn-surface px-3 py-1.5 text-sm text-[var(--ink-90)]"
              >
                Copy
              </button>
              <button
                onClick={() => void run(instr)}
                className="fb-btn-surface px-3 py-1.5 text-sm text-[var(--ink-90)]"
              >
                Regenerate
              </button>
            </>
          )}
          <button
            onClick={close}
            className="ml-auto px-3 py-1.5 rounded text-sm text-[var(--ink-50)] hover:text-[var(--ink-90)]"
          >
            Discard
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
