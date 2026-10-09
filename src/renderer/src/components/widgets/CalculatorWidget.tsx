import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import { evaluateArithmetic } from '../../lib/calcExpression'

const KEYS: Array<{
  label: string
  value: string
  kind: 'num' | 'op' | 'eq' | 'clr' | 'back' | 'dot'
}> = [
  { label: 'C', value: 'C', kind: 'clr' },
  { label: '⌫', value: 'back', kind: 'back' },
  { label: '%', value: '%', kind: 'op' },
  { label: '÷', value: '/', kind: 'op' },
  { label: '7', value: '7', kind: 'num' },
  { label: '8', value: '8', kind: 'num' },
  { label: '9', value: '9', kind: 'num' },
  { label: '×', value: '*', kind: 'op' },
  { label: '4', value: '4', kind: 'num' },
  { label: '5', value: '5', kind: 'num' },
  { label: '6', value: '6', kind: 'num' },
  { label: '−', value: '-', kind: 'op' },
  { label: '1', value: '1', kind: 'num' },
  { label: '2', value: '2', kind: 'num' },
  { label: '3', value: '3', kind: 'num' },
  { label: '+', value: '+', kind: 'op' },
  { label: '0', value: '0', kind: 'num' },
  { label: '.', value: '.', kind: 'dot' },
  { label: '=', value: '=', kind: 'eq' }
]

const ALLOWED = /^[0-9+\-*/%.()\s]+$/

// Evaluated by a parser, never by eval: the renderer CSP has no 'unsafe-eval',
// so `new Function` throws and every expression showed "error" (see calcExpression).
function safeEval(expr: string): string {
  if (!expr.trim()) return ''
  if (!ALLOWED.test(expr)) return 'err'
  const result = evaluateArithmetic(expr)
  if (result === null) return 'err'
  return String(Math.round(result * 1e10) / 1e10)
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function CalculatorWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [expr, setExpr] = useState(widget.content || '')
  const lastSavedRef = useRef(widget.content || '')

  useEffect(() => {
    if (expr === lastSavedRef.current) return
    const handle = window.setTimeout(() => {
      lastSavedRef.current = expr
      void update(widget.id, { content: expr })
    }, 400)
    return () => window.clearTimeout(handle)
  }, [expr, widget.id, update])

  const preview = safeEval(expr)

  function press(key: (typeof KEYS)[number]): void {
    switch (key.kind) {
      case 'clr':
        setExpr('')
        return
      case 'back':
        setExpr((s) => s.slice(0, -1))
        return
      case 'eq': {
        const r = safeEval(expr)
        setExpr(r === 'err' ? expr : r)
        return
      }
      default:
        setExpr((s) => s + key.value)
    }
  }

  const content = (
    <div className={`h-full w-full bg-[#f6f3eb] flex flex-col gap-2 ${inline ? 'p-6' : 'p-2'}`}>
      {/* Calculator face: a physical-object material, forced light in every theme. */}
      <div
        className={`flex-1 min-h-0 bg-white border border-stone-300 rounded p-2 flex flex-col justify-end overflow-hidden`}
      >
        <div
          className={`text-right text-stone-600 break-all ${inline ? 'text-base' : 'text-xs'}`}
        >
          {expr || '0'}
        </div>
        <div
          className={`text-right font-mono text-stone-900 truncate ${
            inline ? 'text-5xl' : 'text-2xl'
          }`}
        >
          {preview === 'err' ? (
            <span className="text-red-700 text-base">error</span>
          ) : (
            preview || '0'
          )}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {KEYS.map((k) => (
          <button
            key={k.label}
            onClick={() => press(k)}
            className={`rounded transition-colors select-none ${
              inline ? 'py-4 text-lg' : 'py-2 text-sm'
            } ${
              k.kind === 'num' || k.kind === 'dot'
                ? 'bg-white hover:bg-stone-100 text-stone-900 border border-stone-300'
                : k.kind === 'op'
                  ? 'bg-stone-200 hover:bg-stone-300 text-stone-900 border border-stone-400'
                  : k.kind === 'eq'
                    ? 'bg-stone-900 hover:bg-stone-800 text-stone-50'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-300'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  )

  if (inline) return content

  return (
    <WidgetFrame widget={widget} headerLabel="calculator" headerAccent="bg-stone-300/60 dark:bg-white/[0.09]">
      {content}
    </WidgetFrame>
  )
}
