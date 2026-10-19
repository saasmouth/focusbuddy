import { useState } from 'react'
import type {
  ActionKind,
  KeyComboAction,
  MediaKeyAction,
  Modifier,
  MultiStepAction,
  OpenAppAction,
  OpenUrlAction,
  RunShellAction,
  SetVolumeAction,
  SingleStepAction,
  StreamDeckAction,
  TypeTextAction,
  DelayAction
} from '@shared/streamdeck'
import Icon from '../../Icon'

interface Props {
  action: StreamDeckAction
  onChange: (next: StreamDeckAction) => void
}

// Action editor — drives every action type with a focused mini-UI.
// Multi-step is rendered as a list of single-step editors with add /
// remove / reorder. Switching the top-level type wipes the payload (a
// confirmation isn't worth the friction for a single-step config).

const ACTION_OPTIONS: Array<{ value: ActionKind; label: string; hint: string; icon: string }> = [
  { value: 'open-app', label: 'Open app', hint: 'Launch any app installed on this machine', icon: 'launch' },
  { value: 'open-url', label: 'Open URL', hint: 'Open a website in your default browser', icon: 'language' },
  { value: 'key-combo', label: 'Keyboard shortcut', hint: 'Send a hotkey like ⌘⇧T', icon: 'keyboard' },
  { value: 'type-text', label: 'Type text', hint: 'Type a string at the cursor', icon: 'text_fields' },
  { value: 'media-key', label: 'Media control', hint: 'Play, pause, next, previous, volume', icon: 'music_note' },
  { value: 'set-volume', label: 'Set volume', hint: 'Set system volume to a specific level', icon: 'volume_up' },
  { value: 'run-shell', label: 'Shell command', hint: 'Run a command in your shell (advanced)', icon: 'terminal' },
  { value: 'delay', label: 'Delay', hint: 'Pause before the next step (multi-step only)', icon: 'hourglass_empty' },
  { value: 'multi-step', label: 'Multi-step macro', hint: 'Chain several actions in sequence', icon: 'auto_awesome' }
]

export default function StreamDeckActionEditor({ action, onChange }: Props): JSX.Element {
  function changeKind(next: ActionKind): void {
    onChange(makeBlank(next))
  }

  if (action.type === 'multi-step') {
    return (
      <div className="space-y-3">
        <KindPicker value="multi-step" onChange={changeKind} excludeMultiStepFromList={false} />
        <MultiStepEditor
          action={action as MultiStepAction}
          onChange={(next) => onChange(next)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <KindPicker value={action.type} onChange={changeKind} excludeMultiStepFromList={false} />
      <SingleStepEditor
        step={action as SingleStepAction}
        onChange={(next) => onChange(next)}
      />
    </div>
  )
}

// ─── Kind picker ───────────────────────────────────────────────────────

function KindPicker({
  value,
  onChange,
  excludeMultiStepFromList
}: {
  value: ActionKind
  onChange: (k: ActionKind) => void
  excludeMultiStepFromList: boolean
}): JSX.Element {
  const opts = excludeMultiStepFromList
    ? ACTION_OPTIONS.filter((o) => o.value !== 'multi-step')
    : ACTION_OPTIONS
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold mb-1.5">
        What does this button do?
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ActionKind)}
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label} — {o.hint}
          </option>
        ))}
      </select>
    </div>
  )
}

// ─── Single-step editor ───────────────────────────────────────────────

function SingleStepEditor({
  step,
  onChange,
  hideHeader
}: {
  step: SingleStepAction
  onChange: (next: SingleStepAction) => void
  hideHeader?: boolean
}): JSX.Element {
  void hideHeader
  switch (step.type) {
    case 'open-app':
      return <OpenAppEditor a={step as OpenAppAction} onChange={onChange} />
    case 'open-url':
      return <OpenUrlEditor a={step as OpenUrlAction} onChange={onChange} />
    case 'key-combo':
      return <KeyComboEditor a={step as KeyComboAction} onChange={onChange} />
    case 'type-text':
      return <TypeTextEditor a={step as TypeTextAction} onChange={onChange} />
    case 'media-key':
      return <MediaKeyEditor a={step as MediaKeyAction} onChange={onChange} />
    case 'set-volume':
      return <SetVolumeEditor a={step as SetVolumeAction} onChange={onChange} />
    case 'run-shell':
      return <RunShellEditor a={step as RunShellAction} onChange={onChange} />
    case 'delay':
      return <DelayEditor a={step as DelayAction} onChange={onChange} />
  }
}

// ── Open app ──
function OpenAppEditor({
  a,
  onChange
}: {
  a: OpenAppAction
  onChange: (next: OpenAppAction) => void
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        App path or name
      </label>
      <input
        value={a.target}
        onChange={(e) => onChange({ ...a, target: e.target.value })}
        placeholder='e.g. "Visual Studio Code" or /Applications/Spotify.app'
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100 font-mono"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      />
      <p className="text-[10px] text-stone-500 leading-snug">
        On macOS, type the app's display name (PlexiiDesk uses{' '}
        <code className="text-stone-300">open -a</code>) or paste a full path
        to a .app bundle.
      </p>
    </div>
  )
}

// ── Open URL ──
function OpenUrlEditor({
  a,
  onChange
}: {
  a: OpenUrlAction
  onChange: (next: OpenUrlAction) => void
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        URL
      </label>
      <input
        type="url"
        value={a.url}
        onChange={(e) => onChange({ ...a, url: e.target.value })}
        placeholder="https://"
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      />
    </div>
  )
}

// ── Key combo ──
const MOD_OPTIONS: Modifier[] = ['cmd', 'shift', 'option', 'control', 'fn']
function KeyComboEditor({
  a,
  onChange
}: {
  a: KeyComboAction
  onChange: (next: KeyComboAction) => void
}): JSX.Element {
  function toggleMod(m: Modifier): void {
    const has = a.modifiers.includes(m)
    onChange({
      ...a,
      modifiers: has ? a.modifiers.filter((x) => x !== m) : [...a.modifiers, m]
    })
  }
  return (
    <div className="space-y-2">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        Modifiers
      </label>
      <div className="flex flex-wrap gap-1.5">
        {MOD_OPTIONS.map((m) => {
          const on = a.modifiers.includes(m)
          return (
            <button
              key={m}
              onClick={() => toggleMod(m)}
              className="px-2 py-1 rounded text-[11px] font-mono uppercase tracking-wide"
              style={{
                background: on ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.04)',
                border: on ? '1px solid rgba(139,92,246,0.5)' : '1px solid rgba(255,255,255,0.08)',
                color: on ? '#a78bfa' : '#94a3b8'
              }}
            >
              {m === 'cmd' ? '⌘' : m === 'shift' ? '⇧' : m === 'option' ? '⌥' : m === 'control' ? '⌃' : 'fn'}
              <span className="ml-1">{m}</span>
            </button>
          )
        })}
      </div>
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold pt-1">
        Key
      </label>
      <input
        value={a.key}
        onChange={(e) => onChange({ ...a, key: e.target.value })}
        placeholder='single character ("t") or special key ("enter", "tab", "f5", "arrow-up")'
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100 font-mono"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      />
      <p className="text-[10px] text-stone-500 leading-snug">
        Special keys: <code>enter</code>, <code>tab</code>, <code>space</code>,{' '}
        <code>escape</code>, <code>delete</code>, <code>arrow-left/right/up/down</code>,{' '}
        <code>f1</code>–<code>f12</code>.
      </p>
    </div>
  )
}

// ── Type text ──
function TypeTextEditor({
  a,
  onChange
}: {
  a: TypeTextAction
  onChange: (next: TypeTextAction) => void
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        Text to type at the cursor
      </label>
      <textarea
        value={a.text}
        onChange={(e) => onChange({ ...a, text: e.target.value })}
        rows={4}
        placeholder="What to type"
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100 font-mono"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      />
      <p className="text-[10px] text-stone-500 leading-snug">
        Tip: useful for email signatures, code boilerplate, common phrases.
        Newlines are sent as Return keypresses.
      </p>
    </div>
  )
}

// ── Media key ──
function MediaKeyEditor({
  a,
  onChange
}: {
  a: MediaKeyAction
  onChange: (next: MediaKeyAction) => void
}): JSX.Element {
  const opts: Array<{ value: MediaKeyAction['key']; label: string; icon: string }> = [
    { value: 'play-pause', label: 'Play / pause', icon: 'play_pause' },
    { value: 'next', label: 'Next track', icon: 'skip_next' },
    { value: 'previous', label: 'Previous track', icon: 'skip_previous' },
    { value: 'volume-up', label: 'Volume up', icon: 'volume_up' },
    { value: 'volume-down', label: 'Volume down', icon: 'volume_down' },
    { value: 'mute', label: 'Mute / unmute', icon: 'volume_off' }
  ]
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        Media key
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        {opts.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange({ ...a, key: o.value })}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-left transition-colors"
            style={{
              background: a.key === o.value ? 'rgba(139,92,246,0.20)' : 'rgba(255,255,255,0.03)',
              border: a.key === o.value ? '1px solid rgba(139,92,246,0.45)' : '1px solid rgba(255,255,255,0.06)',
              color: a.key === o.value ? '#c4b5fd' : '#cbd5e1'
            }}
          >
            <Icon name={o.icon} size={12} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      <p className="text-[10px] text-stone-500 leading-snug">
        Play / pause / next / previous target Spotify and Apple Music. Volume
        affects system audio.
      </p>
    </div>
  )
}

// ── Set volume ──
function SetVolumeEditor({
  a,
  onChange
}: {
  a: SetVolumeAction
  onChange: (next: SetVolumeAction) => void
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        Volume level (0–100)
      </label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={100}
          value={a.level}
          onChange={(e) => onChange({ ...a, level: parseInt(e.target.value, 10) })}
          className="flex-1"
        />
        <span className="text-[12px] font-mono text-stone-200 w-9 text-right tabular-nums">
          {a.level}%
        </span>
      </div>
    </div>
  )
}

// ── Run shell ──
function RunShellEditor({
  a,
  onChange
}: {
  a: RunShellAction
  onChange: (next: RunShellAction) => void
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        Shell command
      </label>
      <div
        className="p-2 rounded-md text-[10px] flex items-start gap-1.5"
        style={{
          background: 'rgba(244, 114, 182, 0.08)',
          border: '1px solid rgba(244, 114, 182, 0.25)',
          color: 'rgb(251, 207, 232)'
        }}
      >
        <Icon name="warning" size={11} className="mt-0.5 shrink-0" />
        <span>
          Runs the command with your full user privileges. Only save shell
          actions you wrote yourself.
        </span>
      </div>
      <textarea
        value={a.command}
        onChange={(e) => onChange({ ...a, command: e.target.value })}
        rows={3}
        placeholder='e.g. say "deploy complete" or git -C ~/myrepo pull'
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100 font-mono"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      />
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold pt-1">
        Timeout (ms)
      </label>
      <input
        type="number"
        min={500}
        max={60000}
        value={a.timeoutMs ?? 10000}
        onChange={(e) => onChange({ ...a, timeoutMs: parseInt(e.target.value, 10) || 10000 })}
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100 font-mono"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      />
    </div>
  )
}

// ── Delay ──
function DelayEditor({
  a,
  onChange
}: {
  a: DelayAction
  onChange: (next: DelayAction) => void
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
        Delay (ms)
      </label>
      <input
        type="number"
        min={0}
        max={60000}
        value={a.ms}
        onChange={(e) => onChange({ ...a, ms: parseInt(e.target.value, 10) || 0 })}
        className="w-full px-2.5 py-1.5 rounded-md text-[12px] text-stone-100 font-mono"
        style={{
          background: 'rgba(0,0,0,0.32)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      />
      <p className="text-[10px] text-stone-500 leading-snug">
        Only meaningful inside a multi-step macro — pauses between steps.
      </p>
    </div>
  )
}

// ── Multi-step ──
function MultiStepEditor({
  action,
  onChange
}: {
  action: MultiStepAction
  onChange: (next: MultiStepAction) => void
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({})

  function update(idx: number, next: SingleStepAction): void {
    onChange({
      ...action,
      steps: action.steps.map((s, i) => (i === idx ? next : s))
    })
  }
  function remove(idx: number): void {
    onChange({ ...action, steps: action.steps.filter((_, i) => i !== idx) })
  }
  function add(): void {
    onChange({
      ...action,
      steps: [...action.steps, { type: 'key-combo', key: 't', modifiers: ['cmd'] }]
    })
  }
  function move(idx: number, dir: -1 | 1): void {
    const j = idx + dir
    if (j < 0 || j >= action.steps.length) return
    const next = [...action.steps]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    onChange({ ...action, steps: next })
  }

  return (
    <div className="space-y-2">
      {action.steps.length === 0 && (
        <div className="text-[12px] text-stone-400 px-3 py-3 rounded-md" style={{
          background: 'rgba(0,0,0,0.20)',
          border: '1px dashed rgba(255,255,255,0.08)'
        }}>
          No steps yet — add one below.
        </div>
      )}
      {action.steps.map((step, i) => (
        <div
          key={i}
          className="rounded-md p-2"
          style={{
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.06)'
          }}
        >
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] text-stone-500 font-mono tabular-nums">
              #{i + 1}
            </span>
            <select
              value={step.type}
              onChange={(e) =>
                update(i, makeBlankSingle(e.target.value as Exclude<ActionKind, 'multi-step'>))
              }
              className="flex-1 text-[11px] px-1.5 py-0.5 rounded text-stone-100"
              style={{
                background: 'rgba(0,0,0,0.32)',
                border: '1px solid rgba(255,255,255,0.06)'
              }}
            >
              {ACTION_OPTIONS.filter((o) => o.value !== 'multi-step').map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [i]: !c[i] }))}
              className="text-stone-400 hover:text-stone-100 px-1"
              title={collapsed[i] ? 'Expand' : 'Collapse'}
            >
              <Icon name={collapsed[i] ? 'expand_more' : 'expand_less'} size={12} />
            </button>
            <button
              onClick={() => move(i, -1)}
              disabled={i === 0}
              className="text-stone-400 hover:text-stone-100 disabled:opacity-30 px-1"
              title="Move up"
            >
              <Icon name="arrow_upward" size={11} />
            </button>
            <button
              onClick={() => move(i, 1)}
              disabled={i === action.steps.length - 1}
              className="text-stone-400 hover:text-stone-100 disabled:opacity-30 px-1"
              title="Move down"
            >
              <Icon name="arrow_downward" size={11} />
            </button>
            <button
              onClick={() => remove(i)}
              className="text-rose-300 hover:bg-rose-500/10 rounded px-1"
              title="Remove"
            >
              <Icon name="delete" size={11} />
            </button>
          </div>
          {!collapsed[i] && (
            <SingleStepEditor
              step={step}
              onChange={(next) => update(i, next)}
              hideHeader
            />
          )}
        </div>
      ))}
      <button
        onClick={add}
        className="w-full px-3 py-1.5 rounded-md text-[11px] font-medium border border-dashed"
        style={{
          background: 'rgba(255,255,255,0.02)',
          borderColor: 'rgba(255,255,255,0.10)',
          color: '#a78bfa'
        }}
      >
        + Add step
      </button>
    </div>
  )
}

// ─── Defaults ──────────────────────────────────────────────────────────

function makeBlankSingle(kind: Exclude<ActionKind, 'multi-step'>): SingleStepAction {
  switch (kind) {
    case 'open-app':
      return { type: 'open-app', target: '' }
    case 'open-url':
      return { type: 'open-url', url: 'https://' }
    case 'key-combo':
      return { type: 'key-combo', key: '', modifiers: [] }
    case 'type-text':
      return { type: 'type-text', text: '' }
    case 'media-key':
      return { type: 'media-key', key: 'play-pause' }
    case 'set-volume':
      return { type: 'set-volume', level: 50 }
    case 'run-shell':
      return { type: 'run-shell', command: '', timeoutMs: 10000 }
    case 'delay':
      return { type: 'delay', ms: 200 }
  }
}

function makeBlank(kind: ActionKind): StreamDeckAction {
  if (kind === 'multi-step') return { type: 'multi-step', steps: [] }
  return makeBlankSingle(kind)
}
