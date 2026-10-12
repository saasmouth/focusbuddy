import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BUTTON_PALETTE,
  makeButtonId,
  makePageId,
  type ActionButton,
  type ButtonStyle,
  type DeckButton,
  type DeckConfig,
  type FolderButton,
  type StreamDeckAction
} from '@shared/streamdeck'
import { checkActionConflicts } from '@shared/macroConflicts'
import Icon from '../../Icon'
import StreamDeckActionEditor from './StreamDeckActionEditor'
import { alertDialog } from '../../plexi/PromptDialog'

interface Props {
  slot: number
  existing: DeckButton | null
  onSave: (button: DeckButton | null) => void
  onCancel: () => void
  onMakeFolder: (label: string, style: ButtonStyle) => void
  // The deck currently being edited. Used to detect duplicate key
  // combos against other buttons (across all pages, including folders).
  deck: DeckConfig
}

// Per-button configuration dialog. Three tabs:
//   - Button   — label, icon, color, optional image
//   - Action   — what happens when pressed (single or multi-step macro)
//   - Folder   — convert this button into a folder of more buttons
//
// "Delete" wipes the slot. "Save" persists. The dialog is portalled to
// document.body so it escapes the widget's transform / overflow context.

type Tab = 'button' | 'action' | 'folder'

// Common Material Symbol icons curated for stream-deck use cases. The
// user can type any icon name in the override field below if they need
// something specific.
const ICON_GALLERY = [
  'play_arrow', 'pause', 'skip_next', 'skip_previous', 'volume_up',
  'volume_off', 'mic', 'mic_off', 'videocam', 'videocam_off',
  'code', 'terminal', 'language', 'lock', 'lock_open',
  'mail', 'chat', 'forum', 'phone', 'videocam',
  'folder', 'description', 'edit', 'check', 'close',
  'add', 'remove', 'arrow_forward', 'arrow_back', 'refresh',
  'settings', 'tune', 'palette', 'home', 'work',
  'music_note', 'movie', 'photo_camera', 'image', 'mic',
  'spotify', 'apple', 'open_in_new', 'launch', 'star',
  'favorite', 'thumb_up', 'lightbulb', 'auto_awesome', 'bolt',
  'science', 'school', 'sports_esports', 'restaurant', 'coffee'
]

export default function StreamDeckButtonConfig({
  slot,
  existing,
  onSave,
  onCancel,
  onMakeFolder,
  deck
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>(existing?.kind === 'folder' ? 'folder' : 'button')

  // Local copy edited in this dialog. Saved as a new ActionButton on
  // save (existing folder buttons stay folder kind unless the user
  // explicitly converts via the folder tab).
  const [label, setLabel] = useState(existing?.label ?? '')
  const [icon, setIcon] = useState(existing?.style.icon ?? 'play_arrow')
  const [color, setColor] = useState(existing?.style.color ?? BUTTON_PALETTE[0])
  const [image, setImage] = useState<string | undefined>(existing?.style.image)
  const [action, setAction] = useState<StreamDeckAction>(
    existing?.kind === 'action'
      ? existing.action
      : { type: 'open-app', target: '' }
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const style: ButtonStyle = { icon, color, image }

  function handleSave(): void {
    if (existing?.kind === 'folder') {
      // Keep folder kind; just update label/style.
      const updated: FolderButton = {
        ...existing,
        label,
        style
      }
      onSave(updated)
      return
    }
    const button: ActionButton = {
      id: existing?.id ?? makeButtonId(),
      kind: 'action',
      label,
      style,
      action,
      sound: existing && existing.kind === 'action' ? existing.sound : undefined,
      haptic: existing && existing.kind === 'action' ? existing.haptic : undefined
    }
    onSave(button)
  }

  async function handleImageFile(file: File): Promise<void> {
    // Convert to a data URL for v1 simplicity. For large images we'd
    // want to ingest via the existing fb-file:// pipeline; data URLs
    // bloat the widget.content blob. 256 KB upper bound here.
    if (file.size > 256 * 1024) {
      await alertDialog({
        title: 'Image is too big',
        body: 'The maximum is 256 KB. Try a smaller image or use an icon.'
      })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setImage(String(reader.result))
    }
    reader.readAsDataURL(file)
  }

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[260] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/[0.08] shadow-2xl flex flex-col"
        style={{
          background: 'rgba(16, 24, 39, 0.95)',
          boxShadow:
            'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(139, 92, 246, 0.12), 0 24px 64px -12px rgba(139, 92, 246, 0.28)',
          maxHeight: '85vh'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-white/[0.05]">
          <h3 className="text-[13px] font-semibold text-stone-100 flex-1">
            Slot {slot + 1}{existing?.kind === 'folder' ? ' — Folder' : ''}
          </h3>
          {existing && (
            <button
              onClick={() => onSave(null)}
              className="text-[11px] px-2 py-1 rounded text-rose-300 hover:bg-rose-500/10"
              title="Remove this button"
            >
              <Icon name="delete" size={12} />
            </button>
          )}
          <button
            onClick={onCancel}
            className="text-[11px] px-2 py-1 rounded text-stone-400 hover:text-stone-100 hover:bg-white/[0.06]"
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="flex items-center gap-0.5 px-3 py-2 border-b border-white/[0.05]">
          {(['button', 'action', 'folder'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium capitalize transition-colors ${
                tab === t
                  ? 'bg-accent/15 text-accent'
                  : 'text-stone-400 hover:text-stone-100 hover:bg-white/[0.04]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {tab === 'button' && (
            <>
              <Field label="Label">
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Spotify"
                  maxLength={20}
                  className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100"
                  style={{
                    background: 'rgba(0,0,0,0.32)',
                    border: '1px solid rgba(255,255,255,0.08)'
                  }}
                />
              </Field>

              <Field label="Color">
                <div className="grid grid-cols-12 gap-1.5">
                  {BUTTON_PALETTE.map((c) => (
                    <button
                      key={c}
                      onClick={() => setColor(c)}
                      className="h-6 w-6 rounded-md transition-transform hover:scale-110"
                      style={{
                        background: c,
                        boxShadow:
                          color === c
                            ? '0 0 0 2px rgba(255,255,255,0.85), 0 0 12px ' + c
                            : 'inset 0 0 0 1px rgba(255,255,255,0.1)'
                      }}
                      title={c}
                    />
                  ))}
                </div>
              </Field>

              <Field label="Icon">
                <div
                  className="grid grid-cols-10 gap-1 p-2 rounded-md"
                  style={{
                    background: 'rgba(0,0,0,0.32)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    maxHeight: 140,
                    overflowY: 'auto'
                  }}
                >
                  {ICON_GALLERY.map((name) => (
                    <button
                      key={name}
                      onClick={() => setIcon(name)}
                      className="h-7 w-7 inline-flex items-center justify-center rounded transition-colors"
                      style={{
                        background:
                          icon === name
                            ? 'rgba(139,92,246,0.25)'
                            : 'transparent',
                        color: icon === name ? '#a78bfa' : '#94a3b8'
                      }}
                      title={name}
                    >
                      <Icon name={name} size={14} />
                    </button>
                  ))}
                </div>
                <input
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="or type any Material Symbol name"
                  className="mt-1.5 w-full px-2.5 py-1 rounded-md text-[11px] text-stone-200 font-mono"
                  style={{
                    background: 'rgba(0,0,0,0.32)',
                    border: '1px solid rgba(255,255,255,0.06)'
                  }}
                />
              </Field>

              <Field label="Custom image (optional)">
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void handleImageFile(f)
                    }}
                    className="text-[11px] text-stone-300 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-white/[0.06] file:text-stone-200 file:cursor-pointer"
                  />
                  {image && (
                    <button
                      onClick={() => setImage(undefined)}
                      className="text-[11px] text-stone-400 hover:text-rose-300"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {image && (
                  <div className="mt-2 flex items-center gap-2">
                    <img
                      src={image}
                      alt="preview"
                      className="h-10 w-10 rounded object-cover border border-white/[0.08]"
                    />
                    <span className="text-[10px] text-stone-500">
                      Image overrides the icon
                    </span>
                  </div>
                )}
              </Field>

              {/* Live preview */}
              <Field label="Preview">
                <ButtonPreview label={label} icon={icon} color={color} image={image} />
              </Field>
            </>
          )}

          {tab === 'action' && existing?.kind !== 'folder' && (
            <>
              <ConflictBanner
                action={action}
                deck={deck}
                skipButtonId={existing?.id}
              />
              <StreamDeckActionEditor action={action} onChange={setAction} />
            </>
          )}

          {tab === 'action' && existing?.kind === 'folder' && (
            <p className="text-[12px] text-stone-400 leading-relaxed">
              This is a folder button — clicking it opens the folder's
              page instead of running an action. Use the <strong>Folder</strong> tab
              to rename it, or remove and re-add as a regular button.
            </p>
          )}

          {tab === 'folder' && (
            <div className="space-y-3">
              <p className="text-[12px] text-stone-300 leading-relaxed">
                Convert this slot into a folder. Folders contain another full
                30-button grid — nest as deep as you need to organise your
                buttons.
              </p>
              {existing?.kind === 'folder' ? (
                <div
                  className="p-3 rounded-md text-[11px] text-stone-300"
                  style={{
                    background: 'rgba(0,0,0,0.32)',
                    border: '1px solid rgba(255,255,255,0.06)'
                  }}
                >
                  This slot is already a folder. Click outside to close, or
                  use the <strong>Button</strong> tab to rename / restyle it.
                </div>
              ) : (
                <button
                  onClick={() => onMakeFolder(label, style)}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium"
                  style={{
                    background:
                      'linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95))',
                    color: 'white',
                    boxShadow:
                      'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 8px 24px -8px rgba(139, 92, 246, 0.4)'
                  }}
                >
                  Make this slot a folder
                </button>
              )}
              <p className="text-[10px] text-stone-500 leading-snug">
                Tip: name the folder after a category — "Audio", "Dev tools",
                "Streaming", "Workflows" — so you can find it at a glance.
              </p>
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-white/[0.05] flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-[12px] text-stone-300 hover:bg-white/[0.06]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium"
            style={{
              background:
                'linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95))',
              color: 'white',
              boxShadow:
                'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 8px 24px -8px rgba(139, 92, 246, 0.4)'
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}

function ButtonPreview({
  label,
  icon,
  color,
  image
}: {
  label: string
  icon: string
  color: string
  image?: string
}): JSX.Element {
  return (
    <div
      className="h-20 w-20 inline-flex items-center justify-center relative overflow-hidden"
      style={{
        borderRadius: 10,
        background: `linear-gradient(155deg, ${color}40, ${color}20), #0d1226`,
        border: `1px solid ${color}80`,
        boxShadow: [
          'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
          `inset 0 -10px 24px ${color}40`,
          `0 0 18px -2px ${color}60`
        ].join(', ')
      }}
    >
      {image && (
        <img
          src={image}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      <div className="relative z-10 flex flex-col items-center justify-center gap-0.5">
        {!image && <Icon name={icon} size={20} className="text-white" filled />}
        {label && (
          <span
            className="text-[8px] uppercase tracking-wider font-semibold text-white truncate max-w-[70px]"
            style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  )
}

// Mark makePageId as referenced to avoid TS unused-import warnings (the
// caller in StreamDeckWidget uses it, but this file imports the type
// only). Cheap no-op.
void makePageId

// ─── Conflict banner ───────────────────────────────────────────────────
// Surfaces three classes of conflict above the action editor:
//   - RESERVED (red)    — macOS system shortcut. Strong warning.
//   - DUPLICATE (amber) — another button on this deck already uses it.
//   - STANDARD (green)  — recognised standard shortcut. Informational.
// The banner is purely informational; we never block save. The point is
// to surface the conflict so the user makes an intentional choice.

function ConflictBanner({
  action,
  deck,
  skipButtonId
}: {
  action: StreamDeckAction
  deck: DeckConfig
  skipButtonId: string | undefined
}): JSX.Element | null {
  const report = useMemo(
    () => checkActionConflicts(action, deck, skipButtonId),
    [action, deck, skipButtonId]
  )
  if (!report.reserved && !report.duplicate) return null

  return (
    <div className="space-y-1.5 mb-2">
      {report.reserved && report.reserved.tier === 'reserved' && (
        <div
          className="rounded-md px-2.5 py-2 flex items-start gap-2"
          style={{
            background: 'rgba(244, 114, 182, 0.10)',
            border: '1px solid rgba(244, 114, 182, 0.35)'
          }}
        >
          <Icon name="warning" size={12} className="text-rose-300 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="text-[11px] font-medium text-rose-100 mb-0.5">
              Reserved system shortcut
            </div>
            <div className="text-[10px] text-rose-100/80 leading-snug">
              {report.reserved.message}
            </div>
          </div>
        </div>
      )}
      {report.duplicate && (
        <div
          className="rounded-md px-2.5 py-2 flex items-start gap-2"
          style={{
            background: 'rgba(251, 191, 36, 0.10)',
            border: '1px solid rgba(251, 191, 36, 0.35)'
          }}
        >
          <Icon name="report" size={12} className="text-amber-300 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="text-[11px] font-medium text-amber-100 mb-0.5">
              Already on this deck
            </div>
            <div className="text-[10px] text-amber-100/80 leading-snug">
              {report.duplicate.message}
            </div>
          </div>
        </div>
      )}
      {report.reserved && report.reserved.tier === 'standard' && (
        <div
          className="rounded-md px-2.5 py-2 flex items-start gap-2"
          style={{
            background: 'rgba(52, 211, 153, 0.08)',
            border: '1px solid rgba(52, 211, 153, 0.25)'
          }}
        >
          <Icon name="check_circle" size={12} className="text-emerald-300 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="text-[11px] font-medium text-emerald-100 mb-0.5">
              Standard shortcut
            </div>
            <div className="text-[10px] text-emerald-100/80 leading-snug">
              {report.reserved.message}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
