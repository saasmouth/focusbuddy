import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useWorkItemStore } from '../stores/workItems'
import { useNodeStore } from '../stores/nodes'
import { useActionHistory } from '../stores/actionHistory'
import { CLASS_CHOICES, CLASS_LABEL } from '../lib/attentionQueues'
import Icon from './Icon'
import TagMentionInput from './TagMentionInput'
import { URGENCY_LEVELS } from '../lib/itemTags'
import { serializeTags } from '../lib/itemTags'
import { serializeMentions, mentionKey, type ItemMention } from '../lib/itemMentions'
import { usePeopleStore, personName } from '../lib/peopleDirectory'
import { useAccountStore } from '../stores/account'
import { parseSelectionList, normalizeSelectionText } from '../lib/selectionList'
import AttentionOffNotice from './AttentionOffNotice'
import { useWorkItemsCapability } from '../lib/workItemsCapability'

// The ONE confirm stop (DEC-019), extracted so every capture surface renders
// the SAME flow (DEC-028): the console overlay and the chat's inline card are
// two hosts of this single component. Rebuilt as Book time's sibling: a
// stated default, fully editable in place, one keystroke to accept. Four
// labelled pills (CATEGORY / URGENCY / WHEN / DESK) that VISIBLY open — one
// drawer at a time, each led by its question; number keys 1–8 set the
// category directly; Esc closes an open drawer first and only then leaves.
// CONFIDENCE: a value Plexii inferred renders in accent; a default, or a
// value the user changed by hand, renders in ink — accent means "a machine
// guessed this, look at it". (The classifier carries confidence for the
// CATEGORY and an inferred date for WHEN; urgency is never inferred, so its
// pill honestly never lights.) Status is gone from capture — a new item is
// open; waiting is reachable with W in Attention. Classification, the tidy,
// DEC-025's secondaries and DEC-046's list splitting are untouched — this is
// how the output is presented, not what it decides.

export { CLASS_CHOICES, CLASS_LABEL }

/** How long Enter will wait on an in-flight tidy before filing what it has.
 *  Long enough for a normal Haiku round trip, short enough that a dead call
 *  never strands the capture. */
export const TIDY_WAIT_CAP_MS = 4000

interface ConfirmState {
  picked: string
  confidence: number
  title: string
  /** DEC-034: the operator's own notes, tidied in place when a tidy lands. */
  notes: string
  dueAt: string | null
  needsDate: boolean
  phrase: string | null
  secondaries: Array<{
    text: string
    intentClass: string
    title: string
    dueAt: string | null
    checked: boolean
    /** DEC-046: -1 = grouped under the primary; n ≥ 0 = under secondary n;
     *  undefined = a plain sibling (typed-compound behavior unchanged). */
    parentIdx?: number
    /** List-derived rows follow the primary's class chip at filing time —
     *  one highlighted list is one kind of work. */
    listDerived?: boolean
  }>
}

export default function AttentionConfirmCard({
  text,
  notes: rawNotes = '',
  deskCtx,
  source,
  onFiled,
  onCancel,
  cancelLabel = '← Edit text'
}: {
  /** The capture, verbatim — classified on mount. */
  text: string
  /** DEC-034: optional context typed into the console's notes field. */
  notes?: string
  /** DEC-023 desk-context parenting, resolved by the host at its own moment. */
  deskCtx: { id: string; title: string } | null
  /** CR-09 D-A: set when this capture came from MARKING an object. The item
   *  then points at that object (sourceType/sourceRef) and opens on the class
   *  the preset table chose — deterministic, no model call. */
  source?: { sourceType: string; sourceRef: string; intentClass?: string; sourceUrl?: string | null } | null
  /** Fired once everything is filed: a human summary + how many items. */
  onFiled: (summary: string, count: number, primaryId: string) => void
  onCancel: () => void
  cancelLabel?: string
}): JSX.Element {
  const createItem = useWorkItemStore((s) => s.create)
  const attention = useWorkItemsCapability()
  const nodes = useNodeStore((s) => s.nodes)
  const reduceMotion = useReducedMotion()
  const updateFieldsStore = useWorkItemStore((s) => s.updateFields)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** One drawer at a time — same rule as Where in Book time. */
  const [openDrawer, setOpenDrawer] = useState<
    'category' | 'urgency' | 'when' | 'people' | 'desk' | null
  >(null)
  const [catTouched, setCatTouched] = useState(false)
  const [whenTouched, setWhenTouched] = useState(false)
  /** 'someday' = no date (the honest default; filing semantics unchanged). */
  const [whenChoice, setWhenChoice] = useState<'someday' | 'today' | 'tomorrow' | 'week' | 'date'>(
    'someday'
  )
  const [customDate, setCustomDate] = useState('')
  const [whenInferred, setWhenInferred] = useState(false)
  /** undefined = follow the DEC-023 desk context; null = explicitly no desk. */
  const [deskPick, setDeskPick] = useState<{ id: string; title: string } | null | undefined>(
    undefined
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // DEC-088 — PEOPLE is its own dimension. The demo buried the @ field under
  // Desk (#2/#6); the person references an item carries deserve their own
  // labelled pill, their own drawer, and their own confidence accent.
  const [peopleTouched, setPeopleTouched] = useState(false)
  const [peopleInferred, setPeopleInferred] = useState(false)
  const [personClarify, setPersonClarify] = useState<{
    phrase: string
    candidates: Array<{ id: string; title: string; hint: string }>
  } | null>(null)
  const [peopleFilter, setPeopleFilter] = useState('')
  const dirPeople = usePeopleStore((s) => s.people)
  // DEC-026: the tidy — requested AFTER the screen is up, seq-guarded.
  const [cleanup, setCleanup] = useState<{ title: string; note: string; originalTitle: string } | null>(null)
  const [cleanupUsed, setCleanupUsed] = useState(false)
  const cleanupSeq = useRef(0)
  // The Enter that OPENED this card must not also file it. The card mounts
  // with a class chip auto-focused, so that same keystroke (or its auto-repeat)
  // landed straight on the confirm handler and filed the untidied item —
  // "if I click enter it just enters as is" (operator live QA). The card arms
  // on the first keyUP, which is the release of the very key that opened it.
  const [armed, setArmed] = useState(false)
  // DEC-039 — chosen context at CAPTURE time: urgency + tags/mentions ride
  // the preview screen, so an item can arrive in the queue already tagged.
  const [urgency, setUrgency] = useState<string>('normal')
  const [capTags, setCapTags] = useState<string[]>([])
  // #16 (analysis/27 P4) — tags the capture's own words evoke, drawn from the
  // vocabulary already in use (deterministic, tagSuggest.ts). SUGGESTED, not
  // applied: they render accent-marked like every inference, and only a click
  // moves one into the chosen set. Tags stay never-mandatory.
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
  const [capMentions, setCapMentions] = useState<ItemMention[]>([])
  // DEC-040: notes are editable ON the preview. The chat's inline card and
  // every prefilled console open render the card directly — the console's
  // notes stage never appears on those paths, which is where the operator
  // "lost the ability to add a note". Card-typed notes are HIS words: both
  // Enter and "Enter as is" keep them.
  const [notesEdited, setNotesEdited] = useState(false)
  // The tidy in flight, so Enter can WAIT for it rather than racing it.
  const tidyPending = useRef<Promise<unknown> | null>(null)
  // The card OWNS the keyboard from the moment it appears: number keys, the
  // two-stage Esc, and the armed Enter all listen on this container, so it
  // takes focus on mount (the old build did this via an autofocused chip —
  // without it, keys land on <body> and the card is deaf until a click).
  const cardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (confirm) cardRef.current?.focus()
  }, [confirm != null])

  useEffect(() => {
    let alive = true
    setConfirm(null)
    setCleanup(null)
    setCleanupUsed(false)
    setError(null)
    setArmed(false)
    setUrgency('normal')
    setOpenDrawer(null)
    setCatTouched(false)
    setWhenTouched(false)
    setWhenChoice('someday')
    setCustomDate('')
    setWhenInferred(false)
    setDeskPick(undefined)
    setCapTags([])
    setCapMentions([])
    setNotesEdited(false)
    setPeopleTouched(false)
    setPeopleInferred(false)
    setPersonClarify(null)
    setPeopleFilter('')
    tidyPending.current = null
    // DEC-088 — the directory loads on the chat panel today; a capture can
    // happen first. Fetch once (attempted-guarded) so the People drawer and
    // main's scan have real names to offer. Never awaited — capture never
    // waits (R011); the first post-boot capture may honestly offer nobody.
    if (!usePeopleStore.getState().attempted) void usePeopleStore.getState().load()
    // A MARKED object already knows what it is — the preset table decided,
    // so the classifier is skipped entirely (no latency, no model, works with
    // the key removed). Typed captures still classify.
    if (source?.intentClass) {
      // DEC-046: a marked SELECTION that is a LIST becomes several items —
      // deterministically (markers/indentation only; flattened lists split
      // as siblings; prose never splits) and always PREVIEWED here as the
      // pre-checked chips before anything files. Headers become primaries,
      // sub-bullets group under them via DEC-035's sibling grouping.
      const list = parseSelectionList(rawNotes.trim() || text)
      if (list && list.lines.length >= 2) {
        const [head, ...rest] = list.lines
        let lastPrimary = -1 // -1 = the head item
        setConfirm({
          picked: source.intentClass,
          confidence: 1,
          title: head.text.length > 120 ? `${head.text.slice(0, 117)}…` : head.text,
          notes: '',
          dueAt: null,
          needsDate: false,
          phrase: null,
          secondaries: rest.map((l, idx) => {
            const parentIdx = l.depth === 1 ? lastPrimary : undefined
            if (l.depth === 0) lastPrimary = idx
            return {
              text: l.text,
              intentClass: source.intentClass!,
              title: l.text.length > 120 ? `${l.text.slice(0, 117)}…` : l.text,
              dueAt: null,
              checked: true,
              parentIdx,
              listDerived: true
            }
          })
        })
        // DEC-088 — marked captures skip the classifier by design; the
        // deterministic people scan still runs (selection text included).
        void window.api.workItems
          .scanPeople([text, rawNotes].filter(Boolean).join('\n'))
          .then((s) => {
            if (!alive) return
            const pc = seedPeople({ people: s.people, clarify: s.clarify })
            if (pc) setOpenDrawer('people')
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }
      const markedTitle = text.length > 120 ? `${text.slice(0, 117)}…` : text
      setConfirm({
        picked: source.intentClass,
        confidence: 1,
        title: markedTitle,
        notes: normalizeSelectionText(rawNotes),
        dueAt: null,
        needsDate: false,
        phrase: null,
        secondaries: []
      })
      // DEC-046: a marked capture with SUBSTANTIAL prose notes (the chat
      // summary case) still gets the tidy — for its FORMATTING: the model
      // breaks a paragraph into bullet lines. The preset title stands; only
      // the notes land, and only if the operator has not edited them.
      const prose = normalizeSelectionText(rawNotes)
      if (prose.length >= 80) {
        const seq = ++cleanupSeq.current
        const tidy = window.api.workItems
          .proposeCleanup(markedTitle, prose)
          .then((p) => {
            if (alive && p && p.note && cleanupSeq.current === seq) {
              setCleanup({ title: markedTitle, note: p.note, originalTitle: markedTitle })
              setCleanupUsed(true)
              setConfirm((prev) =>
                prev && !notesEdited ? { ...prev, notes: p.note } : prev
              )
            }
            return p
          })
          .catch(() => null)
          .finally(() => {
            if (tidyPending.current === tidy) tidyPending.current = null
          })
        tidyPending.current = tidy
      }
      void window.api.workItems
        .scanPeople([text, rawNotes].filter(Boolean).join('\n'))
        .then((s) => {
          if (!alive) return
          const pc = seedPeople({ people: s.people, clarify: s.clarify })
          if (pc) setOpenDrawer('people')
        })
        .catch(() => {})
      return () => {
        alive = false
      }
    }
    void window.api.workItems
      .classify(text)
      .then((c) => {
        if (!alive) return
        setConfirm({
          picked: c.intentClass,
          confidence: c.confidence,
          title: c.title,
          notes: rawNotes.trim(),
          dueAt: c.dueAt,
          needsDate: c.clarify != null,
          phrase: c.clarify?.phrase ?? null,
          secondaries: (c.secondaries ?? []).map((s) => ({
            text: s.text,
            intentClass: s.intentClass,
            title: s.title,
            dueAt: s.dueAt,
            checked: true
          }))
        })
        // The WHEN pill: an inferred date renders in accent and lands on the
        // matching choice; a deadline question auto-opens the drawer.
        if (c.dueAt) {
          const d = new Date(c.dueAt)
          const today = new Date()
          const tomorrow = new Date()
          tomorrow.setDate(today.getDate() + 1)
          setWhenInferred(true)
          if (d.toDateString() === today.toDateString()) setWhenChoice('today')
          else if (d.toDateString() === tomorrow.toDateString()) setWhenChoice('tomorrow')
          else {
            setWhenChoice('date')
            setCustomDate(c.dueAt.slice(0, 10))
          }
        } else if (c.clarify != null) {
          setOpenDrawer('when')
        }
        // DEC-088 — people the capture references arrive pre-suggested. The
        // People drawer auto-opens for an ambiguity ONLY when the deadline
        // question didn't take the one auto-open (DEC-016: one question) —
        // otherwise the lit pill carries it until opened.
        const pc = seedPeople({ people: c.people ?? [], clarify: c.personClarify ?? null })
        if (c.clarify == null && pc) setOpenDrawer('people')
        // #16 — vocabulary-grounded tag suggestions ride the same result.
        setTagSuggestions(c.tags ?? [])
        // Notes typed in the console can name people the title didn't.
        if (rawNotes.trim()) {
          void window.api.workItems
            .scanPeople(rawNotes)
            .then((s) => {
              if (alive) seedPeople({ people: s.people, clarify: s.clarify })
            })
            .catch(() => {})
        }
        const seq = ++cleanupSeq.current
        // The tidy is still requested AFTER the screen is up — a capture never
        // waits on it (R011) — but it now lands INTO the preview rather than
        // sitting beside it as an offer. "Enter as is" is the escape hatch.
        const tidy = window.api.workItems
          .proposeCleanup(text, rawNotes.trim() || undefined)
          .then((p) => {
            if (alive && p && cleanupSeq.current === seq) {
              setCleanup({ title: p.title, note: p.note, originalTitle: c.title })
              setCleanupUsed(true)
              setConfirm((prev) =>
                prev
                  ? {
                      ...prev,
                      title: p.title,
                      // Never overwrite notes the operator typed in the card —
                      // the tidy proposes; his words stand.
                      notes: notesEdited ? prev.notes : p.note || prev.notes
                    }
                  : prev
              )
            }
            return p
          })
          .catch(() => null)
          .finally(() => {
            if (tidyPending.current === tidy) tidyPending.current = null
          })
        tidyPending.current = tidy
      })
      .catch(() => {
        if (alive) setError('Could not classify that. Try again.')
      })
    return () => {
      alive = false
      cleanupSeq.current++
    }
  }, [text, rawNotes, source?.intentClass])

  /** DEC-088 — fold a people scan into the card: self filtered out (a
   *  mention of yourself is noise), suggestions merged into the mention
   *  chips, and ONE surviving ambiguity kept as the drawer's question.
   *  Returns the surviving clarify so the caller can decide auto-open —
   *  the deadline question outranks it (DEC-016: one question). */
  function seedPeople(scan: {
    people: Array<{ id: string; title: string }>
    clarify: { phrase: string; candidates: Array<{ id: string; title: string; hint: string }> } | null
  }): typeof scan.clarify {
    const acct = useAccountStore.getState()
    const selfEmail = (acct.account?.email ?? acct.cachedEmail ?? '').toLowerCase()
    const dir = usePeopleStore.getState().people
    const isSelf = (id: string): boolean => {
      if (!selfEmail) return false
      const person = dir.find((d) => d.accountId === id)
      return !!person?.email && person.email.toLowerCase() === selfEmail
    }
    const add = scan.people.filter((s) => !isSelf(s.id))
    let clarify = scan.clarify
    if (clarify) {
      const cands = clarify.candidates.filter((c) => !isSelf(c.id))
      if (cands.length === 0) clarify = null
      else if (cands.length === 1) {
        // The "ambiguity" was you plus one other — that's an answer.
        add.push({ id: cands[0].id, title: cands[0].title })
        clarify = null
      } else clarify = { ...clarify, candidates: cands }
    }
    if (add.length) {
      setCapMentions((prev) => {
        const seen = new Set(prev.map(mentionKey))
        const next = [...prev]
        for (const s of add)
          if (!seen.has(`person:${s.id}`)) next.push({ kind: 'person', id: s.id, title: s.title })
        return next
      })
      setPeopleInferred(true)
    }
    if (clarify) setPersonClarify((prev) => prev ?? clarify)
    return clarify
  }

  function cycleClass(dir: 1 | -1): void {
    if (!confirm) return
    const idx = CLASS_CHOICES.findIndex((c) => c.value === confirm.picked)
    const next = CLASS_CHOICES[(idx + dir + CLASS_CHOICES.length) % CLASS_CHOICES.length]
    setConfirm({ ...confirm, picked: next.value })
  }

  /** asIs = file the operator's OWN words: no tidied title, no tidied notes. */
  async function fileConfirmed(asIs = false): Promise<void> {
    if (!confirm || busy) return
    setBusy(true)
    try {
      // "If I click enter there, it should save the TIDIED item." When the
      // tidy is still in flight, Enter waits for it rather than racing it —
      // capped, so a slow or dead call can never strand the capture. (The
      // capture path itself still never waits: this is the confirm step.)
      if (!asIs && tidyPending.current) {
        await Promise.race([
          tidyPending.current,
          new Promise((r) => setTimeout(r, TIDY_WAIT_CAP_MS))
        ])
      }
      // WHEN → a real instant (the house 5pm convention). 'This week' means
      // the upcoming Friday (today, if today is Friday). Someday = no date —
      // the default writes nothing, exactly as before this redesign.
      const at5 = (d: Date): string => {
        d.setHours(17, 0, 0, 0)
        return d.toISOString()
      }
      const dueAt = ((): string | null => {
        switch (whenChoice) {
          case 'today':
            return at5(new Date())
          case 'tomorrow': {
            const d = new Date()
            d.setDate(d.getDate() + 1)
            return at5(d)
          }
          case 'week': {
            const d = new Date()
            d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7))
            return at5(d)
          }
          case 'date':
            return customDate ? new Date(`${customDate}T17:00:00`).toISOString() : null
          default:
            return null
        }
      })()
      const extras = confirm.secondaries.filter((s) => s.checked)
      // (extras counts the summary; the filing loop below walks the full
      // secondary list so parentIdx indexing stays stable.)
      // The verbatim capture is NEVER lost (DEC-026): a tidied item keeps the
      // original under an "as captured" rule, and "Enter as is" files the
      // operator's own words as the item itself.
      const typed = text.trim()
      const rawTitle = typed.length > 120 ? `${typed.slice(0, 117)}…` : typed
      const ownNotes = rawNotes.trim()
      const title = asIs ? rawTitle : confirm.title
      // Untidied: keep BOTH the operator's notes and the verbatim capture when
      // the derived title dropped part of it (e.g. "fyi:" stripped, or only the
      // first sentence became the title). Letting notes win alone would have
      // silently discarded the rest of what was typed.
      const verbatim = typed === confirm.title ? '' : typed
      const notes = asIs
        ? // "Enter as is" reverts the AI's rewording — but notes typed in the
          // CARD are the operator's own words and stand on every path.
          (notesEdited ? confirm.notes : ownNotes) ||
          (typed === rawTitle ? undefined : typed)
        : cleanupUsed && cleanup
          ? // A tidied save is CLEAN (operator ruling): no "— as captured —"
            // block trailing the notes. The two recovery paths sit BEFORE the
            // save — "Tidied · undo" restores his wording in the preview, and
            // "Enter as is" files it untouched — so the choice is always his
            // and always visible, rather than archived into the notes.
            confirm.notes || undefined
          : [confirm.notes, verbatim].filter(Boolean).join('\n\n') || undefined
      const parentDeskId = deskPick === undefined ? (deskCtx?.id ?? null) : (deskPick?.id ?? null)
      const item = await createItem({
        title,
        notes,
        parentId: parentDeskId,
        intentClass: confirm.picked,
        dueAt,
        wiUrgency: urgency === 'normal' ? null : urgency,
        // Status is removed from capture: a new item is open, always.
        tags: serializeTags(capTags),
        mentions: serializeMentions(capMentions),
        confidence: confirm.confidence,
        approvalState: 'auto', // user-authored: submitting IS the approval
        sourceType: source?.sourceType ?? 'note',
        sourceRef: source?.sourceRef ?? null,
        sourceUrl: source?.sourceUrl ?? null,
        wiOrigin: 'human'
      })
      // DEC-046: filing preserves the previewed structure. createdBySecIdx
      // maps each secondary's ORIGINAL index to its created id, so a child
      // groups under the item its header actually produced — and a child
      // whose header was UNCHECKED stands alone rather than vanishing.
      const createdBySecIdx = new Map<number, string>()
      for (const s of confirm.secondaries) {
        if (!s.checked) continue
        const idx = confirm.secondaries.indexOf(s)
        const parentId =
          s.parentIdx === undefined
            ? null
            : s.parentIdx === -1
              ? item.id
              : (createdBySecIdx.get(s.parentIdx) ?? null)
        const child = await createItem({
          title: s.title,
          notes: s.text.trim() === s.title ? undefined : s.text.trim(),
          parentId: parentDeskId,
          intentClass: s.listDerived ? confirm.picked : s.intentClass,
          dueAt: s.dueAt,
          confidence: s.listDerived ? 1 : 0.95,
          approvalState: 'auto',
          sourceType: s.listDerived ? (source?.sourceType ?? 'note') : 'note',
          sourceRef: s.listDerived ? (source?.sourceRef ?? null) : null,
          wiOrigin: 'human'
        })
        createdBySecIdx.set(idx, child.id)
        if (parentId) await updateFieldsStore(child.id, { groupId: parentId })
      }
      const summary =
        `Filed to ${CLASS_LABEL[confirm.picked] ?? confirm.picked} — “${item.title}”` +
        (extras.length > 0 ? ` · +${extras.length} more` : '')
      // The action keeps its name: "File it" → "Filed to …", with Undo. Work
      // items are never hard-deleted (R008), so Undo dismisses — revivable,
      // honest — and redo reopens.
      const filedIds = [item.id, ...createdBySecIdx.values()]
      const store = useWorkItemStore.getState()
      useActionHistory.getState().recordWithToast({
        label: summary,
        undo: async () => {
          for (const id of filedIds) await store.setState(id, 'dismissed')
        },
        redo: async () => {
          for (const id of filedIds) await store.setState(id, 'open')
        }
      })
      onFiled(summary, 1 + extras.length, item.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not file that. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="text-[12px] text-red-600 dark:text-red-400 flex items-center gap-2">
        {error}
        <button onClick={onCancel} className="underline underline-offset-2 fb-press">
          Back
        </button>
      </div>
    )
  }
  if (!confirm) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--ink-40)] py-1.5">
        <Icon name="progress_activity" size={14} className="animate-spin" /> Classifying…
      </div>
    )
  }

  if (attention === 'off') {
    return (
      <div className="flex flex-col gap-2 py-1">
        <AttentionOffNotice what="file this" />
        <button onClick={onCancel} className="self-start fb-t-caption underline underline-offset-2 fb-press">
          Back
        </button>
      </div>
    )
  }

  const eyebrow = 'text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1'
  const catAccent = !catTouched
  const whenAccent = whenInferred && !whenTouched
  // #16 — unaccepted tag suggestions light the DESK pill (tags live in its
  // drawer): accent = an inference is waiting, the DEC-088 pill doctrine.
  const pendingTagSuggestions = tagSuggestions.filter((s) => !capTags.includes(s))
  const deskAccent = (deskPick === undefined && !!deskCtx) || pendingTagSuggestions.length > 0
  const deskBase =
    deskPick === undefined ? (deskCtx?.title ?? 'No desk') : (deskPick?.title ?? 'No desk')
  const deskValue =
    pendingTagSuggestions.length > 0 && capTags.length === 0
      ? `${deskBase} · ${pendingTagSuggestions.length} tag${pendingTagSuggestions.length === 1 ? '' : 's'}?`
      : deskBase
  const whenValue =
    whenChoice === 'someday'
      ? 'Someday'
      : whenChoice === 'today'
        ? 'Today'
        : whenChoice === 'tomorrow'
          ? 'Tomorrow'
          : whenChoice === 'week'
            ? 'This week'
            : customDate
              ? new Date(`${customDate}T12:00:00`).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric'
                })
              : 'Pick a date'
  // DEC-088 — the People pill's face and accent. Accent = Plexii put a name
  // there (or holds a question) and the operator hasn't touched the dimension.
  const capPeople = capMentions.filter((m) => m.kind === 'person')
  const peopleValue =
    capPeople.length === 0
      ? 'No one'
      : capPeople.length === 1
        ? capPeople[0].title
        : `${capPeople[0].title.split(' ')[0]} +${capPeople.length - 1}`
  const peopleAccent = (peopleInferred || personClarify != null) && !peopleTouched
  const addPerson = (id: string, title: string): void => {
    setCapMentions((prev) =>
      prev.some((m) => m.kind === 'person' && m.id === id)
        ? prev
        : [...prev, { kind: 'person', id, title }]
    )
    setPeopleTouched(true)
    setPersonClarify(null)
    setPeopleFilter('')
  }
  const removePerson = (id: string): void => {
    setCapMentions((prev) => prev.filter((m) => !(m.kind === 'person' && m.id === id)))
    setPeopleTouched(true)
  }
  const selfEmailLc = (
    useAccountStore.getState().account?.email ??
    useAccountStore.getState().cachedEmail ??
    ''
  ).toLowerCase()
  const peopleOffers = dirPeople
    .filter((d) => !capPeople.some((m) => m.id === d.accountId))
    .filter((d) => !selfEmailLc || (d.email ?? '').toLowerCase() !== selfEmailLc)
    .filter(
      (d) => !peopleFilter || personName(d).toLowerCase().includes(peopleFilter.toLowerCase())
    )
    .slice(0, 6)
  const recentDesks = nodes
    .filter((n) => n.kind === 'task' && !n.archived && !n.sharedRootId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)

  const revealTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.28, ease: [0.16, 1, 0.3, 1] as const }

  function pickOption(apply: () => void): void {
    apply()
    // Selecting answers the question — the drawer closes itself (~150ms so
    // the chosen pill is seen landing).
    setTimeout(() => setOpenDrawer(null), 150)
  }

  const pill = (
    key: 'category' | 'urgency' | 'when' | 'people' | 'desk',
    labelTxt: string,
    value: string,
    accent: boolean
  ): JSX.Element => (
    <div className="min-w-0">
      <div className={eyebrow}>{labelTxt}</div>
      <button
        type="button"
        data-testid={`pill-${key}`}
        aria-expanded={openDrawer === key}
        onClick={() => setOpenDrawer((d) => (d === key ? null : key))}
        className={`w-full h-10 px-3 rounded-[var(--radius-field)] border inline-flex items-center justify-between gap-1.5 text-[14px] font-medium fb-press transition-colors ${
          openDrawer === key
            ? 'border-[rgb(var(--accent))] bg-accent/10'
            : 'border-[var(--edge-strong)] bg-[var(--surface-raised)] hover:border-[rgb(var(--accent))] hover:bg-accent/10'
        }`}
      >
        <span
          className={`truncate ${accent ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-100)]'}`}
        >
          {value}
        </span>
        <Icon
          name="expand_more"
          size={16}
          className={`shrink-0 text-[var(--ink-40)] transition-transform ${
            openDrawer === key ? 'rotate-180' : ''
          }`}
        />
      </button>
    </div>
  )

  const option = (selected: boolean, onPick: () => void, children: React.ReactNode, key?: string): JSX.Element => (
    <button
      key={key}
      type="button"
      onClick={() => pickOption(onPick)}
      className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-[13px] fb-press transition-colors ${
        selected
          ? 'bg-[rgb(var(--accent))] text-white font-semibold'
          : 'bg-[var(--surface-raised)] text-[var(--ink-90)] hover:text-[var(--ink-100)]'
      }`}
    >
      {children}
    </button>
  )

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-testid="capture-confirm"
      className="outline-none [&:focus-visible]:outline-none"
      onKeyUp={(e) => {
        // The release of the Enter that opened this card arms it.
        if (e.key === 'Enter') setArmed(true)
      }}
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName
        const typing = tag === 'TEXTAREA' || tag === 'INPUT'
        // Number keys 1–8 set the category directly, drawer open or not.
        if (!typing && /^[1-8]$/.test(e.key)) {
          const c = CLASS_CHOICES[Number(e.key) - 1]
          if (c && confirm) {
            setConfirm({ ...confirm, picked: c.value })
            setCatTouched(true)
          }
          return
        }
        if (e.key === 'ArrowRight' && !typing) cycleClass(1)
        if (e.key === 'ArrowLeft' && !typing) cycleClass(-1)
        if (e.key === 'Enter') {
          e.preventDefault()
          if (!armed) return // the keystroke that got us here
          void fileConfirmed()
        }
        if (e.key === 'Escape') {
          // Two-stage: an open drawer closes first; only the second press
          // leaves. Esc never destroys work on the first press.
          if (openDrawer) {
            e.stopPropagation()
            setOpenDrawer(null)
            return
          }
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-[var(--ink-70)]">
          Plexii read it like this.{' '}
          <span className="font-semibold text-[var(--ink-100)]">
            Click any field below to change it
          </span>{' '}
          — or press Enter to file.
        </span>
        {cleanupUsed && cleanup && (
          <button
            onClick={() => {
              setConfirm({ ...confirm, title: cleanup.originalTitle, notes: rawNotes.trim() })
              setCleanupUsed(false)
            }}
            title="Put my own wording back"
            className="inline-flex items-center gap-1 text-[11px] text-[var(--ink-40)] hover:text-[var(--ink-100)] fb-press shrink-0"
          >
            <Icon name="auto_awesome" size={12} /> Tidied · undo
          </button>
        )}
      </div>

      {/* The draft — the item as it will sit in the queue. */}
      <div className="mt-2.5 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3.5 py-2.5">
        <div className="text-[16px] font-semibold text-[var(--ink-100)] break-words">
          {confirm.title}
        </div>
        <textarea
          value={confirm.notes}
          onChange={(e) => {
            setNotesEdited(true)
            setConfirm({ ...confirm, notes: e.target.value })
          }}
          onKeyDown={(e) => {
            // Enter here makes a NEWLINE; only ⌘/Ctrl+Enter bubbles to file.
            if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) e.stopPropagation()
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation()
          }}
          rows={confirm.notes ? Math.min(5, confirm.notes.split('\n').length + 1) : 1}
          placeholder="Add notes…"
          className="mt-0.5 w-full bg-transparent outline-none [&:focus-visible]:outline-none resize-y text-[13px] text-[var(--ink-70)] placeholder:text-[var(--ink-40)]"
        />
      </div>

      {/* The five dimensions — labelled pills that visibly open. PEOPLE sits
          before DESK on purpose: the demo's complaint was people buried
          under the desk selector (who before where). */}
      <div className="mt-3 grid grid-cols-2 min-[560px]:grid-cols-5 gap-2.5">
        {pill('category', 'CATEGORY', CLASS_LABEL[confirm.picked] ?? confirm.picked, catAccent)}
        {pill('urgency', 'URGENCY', urgency[0].toUpperCase() + urgency.slice(1), false)}
        {pill('when', 'WHEN', whenValue, whenAccent)}
        {pill('people', 'PEOPLE', peopleValue, peopleAccent)}
        {pill('desk', 'DESK', deskValue, deskAccent)}
      </div>

      {/* One drawer at a time, each led by its question. */}
      <AnimatePresence initial={false}>
        {openDrawer && (
          <motion.div
            key={openDrawer}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={revealTransition}
            className="overflow-hidden"
            data-testid={`drawer-${openDrawer}`}
          >
            <div className="mt-2.5 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3.5 py-3">
              <div className="text-[12.5px] text-[var(--ink-50)] mb-2">
                {openDrawer === 'category' && 'What is this item asking you to do?'}
                {openDrawer === 'urgency' && 'How hard is it pushing?'}
                {openDrawer === 'when' &&
                  (confirm.phrase
                    ? `When should this come back to you? (“${confirm.phrase}”)`
                    : 'When should this come back to you?')}
                {openDrawer === 'people' &&
                  (personClarify
                    ? `Which “${personClarify.phrase}”?`
                    : 'Who is this about or with?')}
                {openDrawer === 'desk' && 'Where does this work already live?'}
              </div>
              {openDrawer === 'category' && (
                <div className="flex flex-wrap gap-1.5">
                  {CLASS_CHOICES.map((c, i) =>
                    option(
                      confirm.picked === c.value,
                      () => {
                        setConfirm({ ...confirm, picked: c.value })
                        setCatTouched(true)
                      },
                      <>
                        <span
                          className={`text-[11px] ${
                            confirm.picked === c.value ? 'text-white/70' : 'text-[var(--ink-40)]'
                          }`}
                        >
                          {i + 1}
                        </span>
                        {c.label}
                      </>,
                      c.value
                    )
                  )}
                </div>
              )}
              {openDrawer === 'urgency' && (
                <div className="flex flex-wrap gap-1.5">
                  {URGENCY_LEVELS.map((u) =>
                    option(
                      urgency === u,
                      () => setUrgency(u),
                      u[0].toUpperCase() + u.slice(1),
                      u
                    )
                  )}
                </div>
              )}
              {openDrawer === 'when' && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ['today', 'Today'],
                        ['tomorrow', 'Tomorrow'],
                        ['week', 'This week'],
                        ['someday', 'Someday']
                      ] as const
                    ).map(([v, labelTxt]) =>
                      option(
                        whenChoice === v,
                        () => {
                          setWhenChoice(v)
                          setWhenTouched(true)
                        },
                        labelTxt,
                        v
                      )
                    )}
                  </div>
                  <input
                    type="date"
                    value={customDate}
                    onChange={(e) => {
                      setCustomDate(e.target.value)
                      setWhenChoice('date')
                      setWhenTouched(true)
                    }}
                    className="mt-2 w-full h-9 px-3 rounded-full bg-[var(--surface-raised)] outline-none [&:focus-visible]:outline-none text-[13px] text-[var(--ink-90)]"
                  />
                </>
              )}
              {openDrawer === 'people' && (
                <>
                  {personClarify && (
                    <div className="flex flex-wrap gap-1.5 mb-2" data-testid="person-clarify">
                      {personClarify.candidates.map((c) =>
                        option(
                          false,
                          () => addPerson(c.id, c.title),
                          <>
                            <span className="max-w-[160px] truncate">{c.title}</span>
                            <span className="text-[11px] text-[var(--ink-40)]">{c.hint}</span>
                          </>,
                          c.id
                        )
                      )}
                    </div>
                  )}
                  {capPeople.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {capPeople.map((m) => (
                        <span
                          key={m.id}
                          className="inline-flex items-center gap-1 pl-2 pr-1 h-8 rounded-full text-[13px] bg-[rgb(var(--accent))] text-white font-semibold"
                        >
                          <Icon name="person" size={13} />
                          <span className="max-w-[160px] truncate">{m.title}</span>
                          <button
                            onClick={() => removePerson(m.id)}
                            className="inline-flex items-center justify-center h-5 w-5 rounded-full hover:bg-white/20 fb-press"
                            aria-label={`Remove ${m.title}`}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {peopleOffers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {peopleOffers.map((d) =>
                        option(
                          false,
                          () => addPerson(d.accountId, personName(d)),
                          <span className="max-w-[160px] truncate">{personName(d)}</span>,
                          d.accountId
                        )
                      )}
                    </div>
                  )}
                  {dirPeople.length > 6 && (
                    <input
                      value={peopleFilter}
                      onChange={(e) => setPeopleFilter(e.target.value)}
                      placeholder="Find a person…"
                      className="mt-2 w-full h-9 px-3 rounded-full bg-[var(--surface-raised)] outline-none [&:focus-visible]:outline-none text-[13px] text-[var(--ink-90)] placeholder:text-[var(--ink-40)]"
                    />
                  )}
                  {dirPeople.length === 0 && capPeople.length === 0 && (
                    <div className="text-[12.5px] text-[var(--ink-40)]">
                      Nobody to offer — this workspace has no org directory loaded.
                    </div>
                  )}
                  {/* The honest boundary (DEC-039): a reference, not a send.
                      Routing an item TO someone arrives with SPEC-027. */}
                  <div className="mt-2 text-[11px] text-[var(--ink-40)]">
                    A mention keeps the person with the item — it doesn’t send them anything yet.
                  </div>
                </>
              )}
              {openDrawer === 'desk' && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {option(
                      deskValue === 'No desk',
                      () => setDeskPick(null),
                      'No desk',
                      'none'
                    )}
                    {(deskCtx && !recentDesks.some((d) => d.id === deskCtx.id)
                      ? [{ id: deskCtx.id, title: deskCtx.title }, ...recentDesks]
                      : recentDesks
                    ).map((d) =>
                      option(
                        deskPick === undefined ? deskCtx?.id === d.id : deskPick?.id === d.id,
                        () => setDeskPick({ id: d.id, title: d.title }),
                        <span className="max-w-[180px] truncate">{d.title}</span>,
                        d.id
                      )
                    )}
                  </div>
                  {/* The product-wide @ grammar (DEC-039): a person, a desk, a
                      room or a plan — plus free tags. Lives here, not as a
                      standing row. */}
                  <div className="mt-2">
                    <TagMentionInput
                      tags={capTags}
                      mentions={capMentions}
                      onTags={setCapTags}
                      onMentions={setCapMentions}
                    />
                    {/* #16 — suggested tags: accent = inferred (the house
                        doctrine). A click ACCEPTS one into the chosen set;
                        nothing applies on its own. Already-chosen tags stop
                        being suggestions. */}
                    {tagSuggestions.filter((s) => !capTags.includes(s)).length > 0 && (
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap" data-testid="tag-suggestions">
                        <span className="text-[10.5px] text-[var(--ink-40)]">Suggested</span>
                        {tagSuggestions
                          .filter((s) => !capTags.includes(s))
                          .map((s) => (
                            <button
                              key={s}
                              onClick={() => setCapTags([...capTags, s])}
                              className="h-6 px-2 rounded-full text-[11px] fb-press border border-[rgb(var(--accent)/0.35)] text-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)] hover:bg-[rgb(var(--accent)/0.15)]"
                              title={`Used on your items before — click to tag this one “${s}”`}
                              data-testid={`tag-suggestion-${s}`}
                            >
                              #{s}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {confirm.secondaries.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[11px] text-[var(--ink-40)]">
            Also caught{' '}
            {confirm.secondaries.length === 1 ? 'another' : `${confirm.secondaries.length} more`} —
            filed together unless unchecked:
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {confirm.secondaries.map((s, idx) => (
              <button
                key={idx}
                onClick={() =>
                  setConfirm({
                    ...confirm,
                    secondaries: confirm.secondaries.map((x, i) =>
                      i === idx ? { ...x, checked: !x.checked } : x
                    )
                  })
                }
                title={s.text}
                className={`inline-flex items-center gap-1.5 pl-1.5 pr-2.5 h-7 fb-t-label fb-press rounded-full ${
                  s.checked
                    ? 'bg-accent/10 text-[var(--ink-100)] shadow-[0_0_0_1px_rgb(var(--accent)/0.4)]'
                    : 'bg-[var(--surface-raised)] text-[var(--ink-40)] line-through'
                }`}
              >
                <Icon name={s.checked ? 'check_circle' : 'radio_button_unchecked'} size={13} />
                <span className="max-w-[200px] truncate">
                  {CLASS_LABEL[s.intentClass] ?? s.intentClass} · {s.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-[var(--edge-soft)] flex items-center gap-2">
        <button
          onClick={onCancel}
          data-testid="back-to-words"
          className="text-[13px] text-[var(--ink-50)] hover:text-[var(--ink-100)] fb-press"
        >
          {cancelLabel}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          {cleanupUsed && cleanup && (
            <button
              onClick={() => void fileConfirmed(true)}
              disabled={busy}
              title="File exactly what I typed — no rewritten title, no rewritten notes"
              className="h-8 px-3 fb-press fb-t-label text-[var(--ink-60)] hover:text-[var(--ink-100)] disabled:opacity-50"
            >
              Enter as is
            </button>
          )}
          <button
            onClick={() => void fileConfirmed()}
            disabled={busy}
            data-testid="file-it"
            className="btn-primary"
          >
            <span>{busy ? 'Filing…' : 'File it'}</span>
            <span aria-hidden className="rounded bg-white/20 px-1 text-[11px] leading-4">
              ↵
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
