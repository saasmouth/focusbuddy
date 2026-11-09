import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { useMessagingStore } from '../../../stores/messaging'
import { uploadAttachment, attachmentKindForMime, composeIntentDraft, type MessageAttachment } from '../../../lib/messagingClient'
import { EmojiPicker } from './EmojiPicker'
import { GifPicker } from './GifPicker'
import { launchMeeting } from '../../../lib/startMeeting'
import { personDisplayName } from '../../../lib/personName'

// The message composer: text plus the ways to enrich a message — attach a file or
// image, record a voice note, insert an emoji. A pending attachment is uploaded
// to the conversation immediately and shown as a chip; sending then posts the
// message that references it. Upload failures surface honestly rather than
// silently dropping the file.

interface PendingAttachment {
  attachment: Extract<MessageAttachment, { kind: 'image' | 'file' | 'voice' | 'video' | 'gif' }>
  previewUrl?: string // object URL for local image/gif preview before send
}

export function ChatComposer({
  conversationId,
  token,
  onSend,
  onTyping,
  compact = false,
  compactBelow
}: {
  conversationId: string
  token: string
  onSend: (body: string, attachment: MessageAttachment | null) => Promise<void>
  onTyping: () => void
  /** DEC-131 — the assistant panel's shape: no meeting door (the header's
   *  Meet is that), the voice-note mic INSIDE the message box at its right,
   *  attach · emoji · GIF kept, and a taller box that fills the width. */
  compact?: boolean
  /** Lay out like compact whenever the composer is narrower than this many px. */
  compactBelow?: number
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = root.current
    if (!el || compactBelow === undefined) return
    const measure = (): void => setNarrow(el.clientWidth < compactBelow)
    measure()
    const seen = new ResizeObserver(measure)
    seen.observe(el)
    return () => seen.disconnect()
  }, [compactBelow])
  // The box you type in gets the width. A narrow widget keeps its meeting door,
  // because unlike the assistant panel its header has no Meet of its own.
  const stacked = compact || narrow
  const [draft, setDraft] = useState('')
  // Consume an AI-queued draft for this conversation (post-chat proposal).
  // One-shot: clears the pending entry the moment it lands in the input.
  const pendingDraft = useMessagingStore((s) => s.pendingDraft)
  useEffect(() => {
    if (pendingDraft && pendingDraft.conversationId === conversationId) {
      setDraft(pendingDraft.text)
      useMessagingStore.getState().setPendingDraft(null)
    }
  }, [pendingDraft, conversationId])

  // @mention autocomplete: when the draft ends in "@prefix", offer matching
  // member handles from this conversation. Arrow keys move, Enter/Tab or a
  // click inserts. Purely additive — typing an unknown @word sends as-is.
  const conversations = useMessagingStore((s) => s.conversations)
  // Members who can be mentioned. We keep the whole member so the picker can show
  // the person's real name while the inserted token stays the unique @handle.
  const memberOptions = useMemo(() => {
    const conv = conversations.find((c) => c.id === conversationId)
    return (conv?.members ?? []).filter(
      (m): m is typeof m & { handle: string } => !!m.handle
    )
  }, [conversations, conversationId])
  const [mentionIdx, setMentionIdx] = useState(0)
  const mentionMatch = /(^|\s)@([a-z0-9._-]*)$/i.exec(draft)
  const mentionCandidates = mentionMatch
    ? memberOptions
        .filter((m) => {
          const q = mentionMatch[2].toLowerCase()
          return m.handle.toLowerCase().startsWith(q) || personDisplayName(m, m.handle).toLowerCase().startsWith(q)
        })
        .slice(0, 6)
    : []
  function insertMention(handle: string): void {
    if (!mentionMatch) return
    const upto = draft.slice(0, draft.length - mentionMatch[2].length)
    setDraft(`${upto}${handle} `)
    setMentionIdx(0)
  }
  const [pending, setPending] = useState<PendingAttachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showGif, setShowGif] = useState(false)
  const [clarifying, setClarifying] = useState(false)
  // Holds the pre-clarify draft so the writer can revert a rewrite in one tap.
  const [preClarify, setPreClarify] = useState<string | null>(null)

  async function onClarify(): Promise<void> {
    const body = draft.trim()
    if (!body || clarifying) return
    if (preClarify !== null) {
      // Toggle back to the original.
      setDraft(preClarify)
      setPreClarify(null)
      return
    }
    setClarifying(true)
    const res = await composeIntentDraft(token, conversationId, body)
    setClarifying(false)
    if (res.text && res.text.trim() && res.text.trim() !== body) {
      setPreClarify(body)
      setDraft(res.text.trim())
    }
  }
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordStartRef = useRef<number>(0)

  function extOf(name: string): string {
    const i = name.lastIndexOf('.')
    return i >= 0 ? name.slice(i).toLowerCase() : ''
  }

  async function uploadFile(file: File): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      const kind = attachmentKindForMime(file.type)
      const buf = await file.arrayBuffer()
      const result = await uploadAttachment(token, conversationId, kind, buf, {
        name: file.name,
        mime: file.type || 'application/octet-stream',
        ext: extOf(file.name)
      })
      if (!result) {
        setError('Could not upload that file.')
        return
      }
      setPending({
        attachment: {
          kind,
          id: result.id,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: result.sizeBytes
        },
        previewUrl: kind === 'file' ? undefined : URL.createObjectURL(file)
      })
    } finally {
      setBusy(false)
    }
  }

  async function startRecording(): Promise<void> {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        const durationMs = Date.now() - recordStartRef.current
        setBusy(true)
        try {
          const result = await uploadAttachment(token, conversationId, 'voice', await blob.arrayBuffer(), {
            name: `voice-note.webm`,
            mime: blob.type || 'audio/webm',
            ext: '.webm'
          })
          if (!result) {
            setError('Could not save the voice note.')
            return
          }
          setPending({
            attachment: {
              kind: 'voice',
              id: result.id,
              name: 'Voice note',
              mimeType: blob.type || 'audio/webm',
              sizeBytes: result.sizeBytes,
              durationMs
            }
          })
        } finally {
          setBusy(false)
        }
      }
      recordStartRef.current = Date.now()
      rec.start()
      recorderRef.current = rec
      setRecording(true)
    } catch {
      setError('Microphone is not available.')
    }
  }

  function stopRecording(): void {
    recorderRef.current?.stop()
    recorderRef.current = null
    setRecording(false)
  }

  // Selecting a GIF: download the chosen gif bytes and upload them as a 'gif'
  // attachment, so it persists in our blob store and renders through the same
  // authenticated route as other attachments (no hotlinking).
  async function pickGif(url: string, description: string): Promise<void> {
    setShowGif(false)
    setError(null)
    setBusy(true)
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        setError('Could not fetch that GIF.')
        return
      }
      const buf = await resp.arrayBuffer()
      const result = await uploadAttachment(token, conversationId, 'gif', buf, {
        name: `${description || 'gif'}.gif`.slice(0, 80),
        mime: 'image/gif',
        ext: '.gif'
      })
      if (!result) {
        setError('Could not attach that GIF.')
        return
      }
      setPending({
        attachment: { kind: 'gif', id: result.id, name: description || 'GIF', mimeType: 'image/gif', sizeBytes: result.sizeBytes },
        previewUrl: url
      })
    } finally {
      setBusy(false)
    }
  }

  function clearPending(): void {
    if (pending?.previewUrl) URL.revokeObjectURL(pending.previewUrl)
    setPending(null)
  }

  async function submit(): Promise<void> {
    const body = draft.trim()
    if (!body && !pending) return
    if (busy) return
    const attachment = pending?.attachment ?? null
    setDraft('')
    clearPending()
    setShowEmoji(false)
    await onSend(body, attachment)
  }

  const canSend = (draft.trim().length > 0 || pending !== null) && !busy

  return (
    <div ref={root} className="px-4 py-3 border-t border-[var(--edge-soft)]">
      {error && (
        <div className="mb-2 text-[11px] text-rose-500" data-testid="composer-error">
          {error}
        </div>
      )}
      {pending && (
        <div
          className="mb-2 inline-flex items-center gap-2 rounded-lg bg-[var(--surface-sunken)] border border-[var(--edge-soft)] px-2 py-1.5"
          data-testid="composer-pending"
        >
          {pending.previewUrl && pending.attachment.kind === 'video' ? (
            <video src={pending.previewUrl} className="h-9 w-9 rounded object-cover bg-black" muted />
          ) : pending.previewUrl && pending.attachment.kind !== 'voice' ? (
            <img src={pending.previewUrl} alt="" className="h-9 w-9 rounded object-cover" />
          ) : (
            <Icon name={pending.attachment.kind === 'voice' ? 'mic' : pending.attachment.kind === 'video' ? 'movie' : 'description'} size={16} />
          )}
          <span className="text-[12px] text-[var(--ink-90)] truncate max-w-[200px]">{pending.attachment.name}</span>
          <button onClick={clearPending} aria-label="Remove attachment" className="text-[var(--ink-50)] hover:text-[var(--ink-90)]">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <div className={`relative flex items-end gap-1.5 ${stacked ? 'flex-wrap' : ''}`}>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          data-testid="composer-file-input"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            if (f) void uploadFile(f)
            e.currentTarget.value = ''
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="icon-btn shrink-0"
          title="Attach a file or image"
          data-testid="composer-attach"
          disabled={busy}
        >
          <Icon name="attach_file" size={16} />
        </button>
        {!stacked && (
          <button
            onClick={() => (recording ? stopRecording() : void startRecording())}
            className={`icon-btn shrink-0 ${recording ? 'text-rose-500' : ''}`}
            title={recording ? 'Stop recording' : 'Record a voice note'}
            data-testid="composer-voice"
            disabled={busy && !recording}
          >
            <Icon name={recording ? 'stop_circle' : 'mic'} size={16} />
          </button>
        )}
        <div className="relative shrink-0">
          <button
            onClick={() => setShowEmoji((s) => !s)}
            className="icon-btn"
            title="Emoji"
            data-testid="composer-emoji"
          >
            <Icon name="mood" size={16} />
          </button>
          {showEmoji && (
            <EmojiPicker
              onPick={(e) => {
                setDraft((d) => d + e)
                setShowEmoji(false)
              }}
              onClose={() => setShowEmoji(false)}
            />
          )}
        </div>
        <div className="relative shrink-0">
          <button
            onClick={() => setShowGif((s) => !s)}
            className="icon-btn"
            title="GIF"
            data-testid="composer-gif"
          >
            <Icon name="gif_box" size={16} />
          </button>
          {showGif && <GifPicker onSelect={(url, desc) => void pickGif(url, desc)} onClose={() => setShowGif(false)} />}
        </div>
        {!compact && (
          <button
            onClick={() => void launchMeeting({ kind: 'chat', channelId: conversationId, title: 'Chat meeting' })}
            className="icon-btn shrink-0"
            title="Start a meeting"
            data-testid="composer-meet"
          >
            <Icon name="videocam" size={16} />
          </button>
        )}
        {draft.trim().length > 0 && (
          <button
            onClick={() => void onClarify()}
            disabled={clarifying}
            className={`icon-btn shrink-0 ${preClarify !== null ? 'text-accent' : ''}`}
            title={preClarify !== null ? 'Revert to your original wording' : 'Clarify this draft before sending'}
            data-testid="composer-clarify"
          >
            <Icon name={clarifying ? 'hourglass_empty' : preClarify !== null ? 'undo' : 'auto_fix_high'} size={16} />
          </button>
        )}
        {mentionCandidates.length > 0 && (
          <div
            className="absolute bottom-full mb-1 left-0 z-40 min-w-[180px] rounded-lg border border-[var(--edge-soft)] bg-[var(--surface-raised)] shadow-lg py-1"
            role="listbox"
            data-testid="mention-popover"
          >
            {mentionCandidates.map((m, i) => (
              <button
                key={m.accountId}
                role="option"
                aria-selected={i === mentionIdx}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMention(m.handle)
                }}
                className={`w-full text-left px-2.5 py-1 text-[12.5px] ${
                  i === mentionIdx
                    ? 'bg-accent/10 text-accent'
                    : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                {personDisplayName(m, m.handle)}
                <span className="text-[var(--ink-40)]"> @{m.handle}</span>
              </button>
            ))}
          </div>
        )}
        <div className={`relative flex-1 min-w-0 ${stacked ? 'basis-full order-first mb-1.5' : ''}`}>
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setPreClarify(null)
            onTyping()
          }}
          onKeyDown={(e) => {
            if (mentionCandidates.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionIdx((i) => {
                  const n = mentionCandidates.length
                  return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n
                })
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                insertMention(mentionCandidates[Math.min(mentionIdx, mentionCandidates.length - 1)].handle)
                return
              }
              if (e.key === 'Escape') {
                // Swallow so the mention popover closes without closing panels.
                e.stopPropagation()
                setDraft((d) => d) // no-op; popover hides when match breaks
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={recording ? 'Recording… tap stop when done' : 'Write a message…'}
          rows={stacked ? 3 : 1}
          data-testid="message-composer"
          className={`block w-full resize-none bg-[var(--surface-raised)] border border-[var(--edge-firm)] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-accent ${
            stacked ? 'pr-10 min-h-[76px]' : ''
          }`}
        />
        {stacked && (
          <button
            onClick={() => (recording ? stopRecording() : void startRecording())}
            className={`absolute right-1.5 bottom-1.5 icon-btn !h-7 !w-7 ${recording ? 'text-rose-500' : ''}`}
            title={recording ? 'Stop recording' : 'Record a voice note'}
            data-testid="composer-voice"
            disabled={busy && !recording}
          >
            <Icon name={recording ? 'stop_circle' : 'mic'} size={16} />
          </button>
        )}
        </div>
        <button
          onClick={() => void submit()}
          disabled={!canSend}
          className="btn-primary shrink-0"
          data-testid="message-send"
        >
          <Icon name="send" size={14} />
        </button>
      </div>
    </div>
  )
}
