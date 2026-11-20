import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import { readingControl, useWidgetReadOnly } from '../../lib/widgetSurface'

interface EyeDropperResult {
  sRGBHex: string
}
interface EyeDropperLike {
  open: () => Promise<EyeDropperResult>
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim())
  if (!m) return null
  const v = parseInt(m[1], 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function ColorWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [color, setColor] = useState<string>(widget.content || '#fbbf24')
  const [copied, setCopied] = useState(false)
  // A viewer (read-only, lib/widgetSurface): the colour and its values, and
  // copying the hex (a reading control); no picker, no eyedropper.
  const readOnly = useWidgetReadOnly()
  const lastSavedRef = useRef(color)

  useEffect(() => {
    if (color === lastSavedRef.current) return
    const handle = window.setTimeout(() => {
      lastSavedRef.current = color
      void update(widget.id, { content: color })
    }, 300)
    return () => window.clearTimeout(handle)
  }, [color, widget.id, update])

  const hasDropper = typeof window !== 'undefined' && 'EyeDropper' in window

  async function pickFromScreen(): Promise<void> {
    if (!hasDropper) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ed = (window as any).EyeDropper as new () => EyeDropperLike
      const dropper = new Ed()
      const result = await dropper.open()
      setColor(result.sRGBHex)
    } catch {
      // user dismissed
    }
  }

  async function copyHex(): Promise<void> {
    await navigator.clipboard.writeText(color)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const rgb = hexToRgb(color)

  const content = (
    <div className={`h-full w-full bg-[var(--surface-raised)] flex flex-col gap-2 ${inline ? 'p-6' : 'p-3'}`}>
      {/* Swatch containment: a literal hairline holds the arbitrary picked colour. */}
      <div
        className={`flex-1 rounded border border-black/10 ${inline ? 'min-h-[200px]' : 'min-h-[60px]'}`}
        style={{ backgroundColor: color }}
      />
      {readOnly ? (
        <div className={`text-[var(--ink-100)] font-mono ${inline ? 'text-base' : 'text-xs'}`} data-testid="color-hex">{color}</div>
      ) : (
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="fb-field h-8 w-12 cursor-pointer"
          aria-label="Pick color"
        />
        <input
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className={`fb-field flex-1 bg-[var(--surface-raised)] px-2 py-1.5 font-mono ${
            inline ? 'text-base' : 'text-xs'
          }`}
        />
      </div>
      )}
      <div className={`text-[var(--ink-70)] font-mono ${inline ? 'text-sm' : 'text-[11px]'}`}>
        {rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : 'invalid hex'}
      </div>
      <div className="flex gap-1.5">
        <button
          {...readingControl}
          onClick={() => void copyHex()}
          className="fb-btn-surface flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5"
        >
          <Icon name={copied ? 'check' : 'content_copy'} size={14} />
          <span>{copied ? 'copied' : 'copy hex'}</span>
        </button>
        {hasDropper && !readOnly && (
          <button
            onClick={() => void pickFromScreen()}
            title="Pick a color from anywhere on screen"
            className="flex-1 inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded bg-stone-900 hover:bg-stone-800 text-stone-50"
          >
            <Icon name="colorize" size={14} />
            <span>pick screen</span>
          </button>
        )}
      </div>
    </div>
  )

  if (inline) return content

  return (
    <WidgetFrame widget={widget} headerLabel="color" headerAccent="bg-stone-200/70 dark:bg-white/[0.07]">
      {content}
    </WidgetFrame>
  )
}
