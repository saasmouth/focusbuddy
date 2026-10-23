import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// DEC-036 — the item editor, and the row gestures around it.
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

// DEC-144: Attention was renamed Focus and its items are "tasks"; these pins follow the new words.
describe('DEC-036 — double-click opens the whole item for editing', () => {
  const editor = read('src/renderer/src/components/AttentionItemEditor.tsx')
  const view = read('src/renderer/src/components/views/AttentionView.tsx')

  it('edits every part of the item the operator named', () => {
    expect(editor).toContain('Title')
    expect(editor).toContain('Notes')
    expect(editor).toContain('Classification')
    expect(editor).toContain('CLASS_CHOICES.map')
    expect(editor).toContain("type=\"date\"")
    expect(editor).toContain('Desk')
  })

  it('sends ONLY changed fields — an edit must not restamp what was untouched', () => {
    expect(editor).toContain("if (trimmed !== (item.title ?? '')) patch.title = trimmed")
    expect(editor).toContain('if (cls !== queueOf(item)) patch.intentClass = cls')
    expect(editor).toContain('if (nextDue !== (item.dueAt ?? null)) patch.dueAt = nextDue')
    // Writes go through the one store seam, never a bespoke path.
    expect(editor).toContain('useWorkItemStore')
    expect(editor).toContain('updateFields(item.id, patch)')
    // The desk is a node MOVE, not a work-item field.
    expect(editor).toContain('window.api.nodes.move')
  })

  it('the row opens it on double-click, and only the ACTION cluster is exempt', () => {
    expect(view).toContain('onDoubleClick')
    expect(view).toContain("closest('[data-row-action]')")
    // Guarding on `button` blocked nearly the whole row (title + expander are
    // buttons) — that regression must not come back.
    expect(view).not.toContain("(e.target as HTMLElement).closest('button')) return")
    expect(view).toContain('data-row-action')
  })
})

describe('DEC-035 follow-ups — the drag gestures the operator asked for', () => {
  const view = read('src/renderer/src/components/views/AttentionView.tsx')

  it('drags the WHOLE ROW — DEC-077 made it the drag source itself', () => {
    // DEC-035 faked this with setDragImage from the handle; DEC-077 removed
    // the handle, so the row IS the drag source and the browser renders the
    // row as the ghost natively — no image plumbing left to drift.
    expect(view).not.toContain('setDragImage')
    expect(view).toContain('draggable={canDrag && !isOpen}')
  })

  it('resting on a row means ATTACH (dwell), edges mean place', () => {
    expect(view).toContain('GROUP_DWELL_MS')
    expect(view).toContain("setOver({ id: i.id, pos: 'into' })")
    expect(view).toContain('clearDwell')
  })

  it('a whole SECTION accepts a drop, so moving between classifications is easy to hit', () => {
    expect(view).toContain('moveToSection(q.queue, grouped ?? [])')
    // …and a row drop in another queue reclassifies via the same gesture.
    expect(view).toContain('crossQueue ? targetQueue : undefined')
  })
})

describe('DEC-037 — context at a glance, and the two doors back', () => {
  const view = read('src/renderer/src/components/views/AttentionView.tsx')
  const editor = read('src/renderer/src/components/AttentionItemEditor.tsx')

  it('rows show the desk, the plan, the marked source, urgency and tags', () => {
    expect(view).toContain('itemContext(i, nodesById)')
    expect(view).toContain('urgencyOf(i)')
    expect(view).toContain('parseTags(i.tags)')
    // The plan chip opens the plan; the desk chip opens the desk.
    expect(view).toContain('goProject(ctx.plan!.id)')
    expect(view).toContain('onClick={() => openSource(i)}')
  })

  it('offers BOTH doors: the object itself in Plexi, and the whole desk', () => {
    // Marking a Notion tool and pressing "desk" launched the external Notion
    // app. Focus Mode is the in-Plexi door; the desk button is the other.
    expect(view).toContain('function openHere')
    expect(view).toContain('setFocusedWidget')
    expect(view).toContain('Open it here')
    expect(view).toContain('Open the whole desk it came from')
    // Only offered when there IS a marked object to open.
    expect(view).toContain("i.sourceRef && i.sourceType !== 'note'")
  })

  it('tags filter the queue, and are editable — but never required', () => {
    expect(view).toContain('tagFilter')
    expect(view).toContain('hasTag(i, tagFilter)')
    expect(view).toContain('tagVocabulary(items)')
    expect(editor).toContain('URGENCY_LEVELS.map')
    // DEC-039 upgraded the plain input to the shared TagMentionInput.
    expect(editor).toContain('serializeTags(tagList)')
    expect(editor).toContain('serializeMentions(mentionList)')
  })
})

describe('DEC-040 — notes exist on EVERY capture path, not only the bare console', () => {
  it('the preview card itself carries an editable notes area', () => {
    // The chat inline card and every prefilled console open render the card
    // DIRECTLY — the console's notes stage never appears there, which is
    // where the operator "lost the ability to add a note".
    const card = read('src/renderer/src/components/AttentionConfirmCard.tsx')
    // Capture-rebuild: the card's notes placeholder tightened to 'Add notes…'
    // (the mock's copy); the editable area itself is the DEC-040 substance.
    expect(card).toContain('placeholder="Add notes…"')
    expect(card).toContain('setNotesEdited(true)')
    // Enter inside the notes makes a NEWLINE, never files the item.
    expect(card).toContain("if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) e.stopPropagation()")
    // Card-typed notes are the operator's words: the tidy must not clobber
    // them, and "Enter as is" keeps them too.
    expect(card).toContain('notesEdited ? prev.notes : p.note || prev.notes')
    expect(card).toContain('(notesEdited ? confirm.notes : ownNotes)')
  })

  it('the bare manual form is GONE — capture is the only door (capture rebuild)', () => {
    // History: DEC-040 gave the manual form a notes field. The capture
    // rebuild (operator spec, 2026-08-30) then deleted the form entirely —
    // "two doors to the same room is the problem we're fixing" — and its
    // fields were absorbed into the confirm step's pills. Not behind a flag.
    const view = read('src/renderer/src/components/views/AttentionView.tsx')
    expect(view).not.toContain('New item')
    expect(view).not.toContain('fileNewItem')
  })
})

describe('DEC-039 — capture-time context + the one input everywhere', () => {
  it('the confirm card carries urgency and tags/mentions on the preview screen', () => {
    const card = read('src/renderer/src/components/AttentionConfirmCard.tsx')
    expect(card).toContain('URGENCY_LEVELS.map')
    expect(card).toContain('TagMentionInput')
    // …and they ride the create, not a follow-up patch.
    expect(card).toContain('serializeTags(capTags)')
    expect(card).toContain('serializeMentions(capMentions)')
    expect(card).toContain("wiUrgency: urgency === 'normal' ? null : urgency")
  })

  it('the @ grammar cannot fork: ONE input, now inside the Desk drawer', () => {
    // History: card + manual form + editor all rendered TagMentionInput.
    // The form is deleted (capture rebuild); the card keeps the one input —
    // moved into the expanded Desk drawer per the spec, not a standing row.
    const card = read('src/renderer/src/components/AttentionConfirmCard.tsx')
    const editor = read('src/renderer/src/components/AttentionItemEditor.tsx')
    expect(card).toContain('TagMentionInput')
    expect(editor).toContain('TagMentionInput')
  })

  it('mention chips render on rows; desk/room/plan navigate, person is honest', () => {
    const view = read('src/renderer/src/components/views/AttentionView.tsx')
    expect(view).toContain('parseMentions(i.mentions)')
    expect(view).toContain('goRoom(m.id)')
    expect(view).toContain('goProject(m.id)')
    // A person mention must SAY routing is not here yet, not imply a ping.
    expect(view).toContain('notifications arrive with routing')
    const input = read('src/renderer/src/components/TagMentionInput.tsx')
    expect(input).toContain("text.startsWith('@')")
    expect(input).toContain('usePeopleStore')
  })
})

describe('DEC-043 — queue tabs, class colors, drag-only reclassify', () => {
  const view = read('src/renderer/src/components/views/AttentionView.tsx')

  it('every class is a tab; All is the full-list view; tabs take drops', () => {
    expect(view).toContain("(['all', ...QUEUE_ORDER] as string[])")
    expect(view).toContain("localStorage.getItem('attention.queueTab')")
    // A class tab narrows to its one queue…
    expect(view).toContain("allQueues.filter((q) => q.queue === queueTab)")
    // …and dragging an item onto a tab reclassifies it into that class.
    expect(view).toContain('void moveToSection(t, [])')
  })

  it('colors come from the ONE palette, subtly applied', () => {
    const lib = read('src/renderer/src/lib/attentionQueues.ts')
    // Every class has a hue, from the PlexiSuite brand family.
    for (const c of ['to_do','to_review','to_decide','to_respond','to_meet','to_discuss','to_remember','to_know'])
      expect(lib).toContain(`${c}: '#`)
    // Subtle by construction: low-alpha washes, not colored panels.
    expect(view).toContain('queueTint(hue, 0.1)')
    expect(view).toContain('QUEUE_COLOR[q.queue]')
  })

  it('the row reclassify button is GONE — drag or the editor are the two paths', () => {
    expect(view).not.toContain('This isn’t right — reclassify')
    expect(view).not.toContain('swap_horiz')
    // The editor path still exists (class chips in the edit dialog).
    expect(read('src/renderer/src/components/AttentionItemEditor.tsx')).toContain('Classification')
  })
})

describe('DEC-044 — the highlight travels the WHOLE path to the notes', () => {
  it('menu → seam → console → card: notes at every hop', () => {
    // The desk-page path: a selection leads with its own text + notes.
    const universal = read('src/renderer/src/lib/contextMenu/universal.ts')
    expect(universal).toContain('presetForSelection(w.kind, sel)')
    expect(universal).toContain('p.notes || undefined')
    // The seam and store carry them…
    expect(read('src/renderer/src/components/Sidebar.tsx')).toContain('detail?.notes ?? ')
    expect(read('src/renderer/src/stores/captureConsole.ts')).toContain('initialNotes')
    // …and the console seeds its notes field from them.
    expect(read('src/renderer/src/components/CaptureConsole.tsx')).toContain(
      'useCaptureConsole.getState().initialNotes'
    )
  })

  it('the AI chat selection menu offers Add to Focus — FIRST', () => {
    // The menu's rows come from lib/chatMessageMenu.ts (WP3); ChatPanel supplies the actions.
    const chat = read('src/renderer/src/components/ChatPanel.tsx')
    expect(chat).toContain("presetForSelection('ai-chat', text)")
    const menu = read('src/renderer/src/lib/chatMessageMenu.ts')
    const sel = menu.slice(menu.indexOf('if (sel) {'), menu.indexOf('CHAT_MENU_LABELS.saveAsSticky, icon'))
    expect(sel).toContain('MENU.addToFocus.label')
    // Standalone-friendly: filing must NOT require an open desk (only the desk rows carry noDesk).
    expect(sel.slice(sel.indexOf('MENU.addToFocus.label'))).not.toContain('...noDesk')
  })
})

describe('DEC-045 — the Attention widget on any desk', () => {
  it('is a real canvas kind: union, catalog, renderer case', () => {
    expect(read('src/shared/types.ts')).toContain("| 'attention'")
    const cat = read('src/renderer/src/lib/widgetCatalog.ts')
    expect(cat).toContain("kind: 'attention'")
    expect(cat).toContain('{"scope":"desk"}') // desk is the DEFAULT
    expect(read('src/renderer/src/components/widgets/renderWidget.tsx')).toContain(
      '<DeskAttentionWidget widget={w} />'
    )
  })

  it('it is a REAL widget: framed, draggable, layered like every other kind', () => {
    // Live QA: the first cut rendered bare divs — "just text on the screen
    // with an invisible background… nothing I can grab". Every canvas kind
    // renders its OWN WidgetFrame; this one must too, or it has no header to
    // drag, no background, and no z-order.
    const w = read('src/renderer/src/components/views/attentionWidgets.tsx')
    // DEC-144: the widget header says focus (it said attention).
    expect(w).toContain('<WidgetFrame widget={widget} headerLabel="focus"')
    expect(w).toContain('bg-[var(--surface-raised)]')
  })

  it('same look as home (one component), scope persisted per widget', () => {
    const w = read('src/renderer/src/components/views/attentionWidgets.tsx')
    // The desk variant WRAPS the home widget rather than forking it.
    expect(w).toContain('itemsOverride={effective}')
    expect(w).toContain("storageKey={`attention.widget.section:${widget.id}`}")
    // Scope round-trips through widget.content.
    expect(w).toContain("content: JSON.stringify({ scope: next })")
    // Stale desks (a global feeder) hide in desk scope.
    expect(w).toContain("showStale={scope === 'all'}")
    // The fallback is honest, not silent.
    expect(w).toContain('nothing here yet — showing all')
  })
})

describe('DEC-046 — a highlighted list becomes several items, previewed first', () => {
  const card = read('src/renderer/src/components/AttentionConfirmCard.tsx')

  it('the split happens on the CARD as pre-checked chips — never silently', () => {
    expect(card).toContain('parseSelectionList(rawNotes.trim() || text)')
    expect(card).toContain('listDerived: true')
    // Headers → primaries; sub-bullets carry parentIdx into the grouping.
    expect(card).toContain("const parentIdx = l.depth === 1 ? lastPrimary : undefined")
  })

  it('filing preserves the previewed structure via DEC-035 grouping', () => {
    expect(card).toContain('createdBySecIdx')
    expect(card).toContain("updateFieldsStore(child.id, { groupId: parentId })")
    // A child whose header was unchecked STANDS ALONE — never vanishes.
    expect(card).toContain('(createdBySecIdx.get(s.parentIdx) ?? null)')
    // List rows inherit the primary's class chip and the marked source.
    expect(card).toContain('s.listDerived ? confirm.picked : s.intentClass')
    expect(card).toContain("s.listDerived ? (source?.sourceType ?? 'note') : 'note'")
  })

  it('notes are whitespace-normalized, and prose notes get the FORMATTING tidy', () => {
    expect(card).toContain('normalizeSelectionText(rawNotes)')
    // The chat-summary case: substantial prose notes request a tidy whose
    // NOTE lands (bullets), while the preset title stands.
    expect(card).toContain('if (prose.length >= 80)')
    expect(card).toContain('prev && !notesEdited ? { ...prev, notes: p.note } : prev')
    const cleanup = read('src/main/ai/cleanupRewrite.ts')
    expect(cleanup).toContain('FORMATTING MATTERS AS MUCH AS WORDING')
    expect(cleanup).toContain('short "- " bullet lines')
  })
})

describe('DEC-047 — desk ⇄ attention, the derived shape (analysis/23 executed)', () => {
  const view = read('src/renderer/src/components/views/AttentionView.tsx')

  it('D-1/D-2: desk headers are DERIVED in the render — no stored grouping anywhere', () => {
    // DEC-048: clustering runs over the collapse-FILTERED rows — still a
    // pure render derivation, never stored.
    expect(view).toContain('clusterByDesk(shown)')
    // Header anatomy: title, "Desk:"-prefixed status (the naming caution),
    // due, count, click-opens-desk.
    expect(view).toContain('Desk: {DESK_STATUS_LABEL[desk.status]')
    expect(view).toContain('cluster.rows.length')
    // The trap analysis/23 rejected must stay rejected: clustering never
    // writes groupId.
    const clusterFn = read('src/renderer/src/lib/attentionQueues.ts')
    const body = clusterFn.slice(clusterFn.indexOf('export function clusterByDesk'))
    expect(body.slice(0, body.indexOf('\n}\n'))).not.toContain('groupId')
  })

  it('D-3: closing the last item OFFERS desk-done — a suggestion, never an auto-write', () => {
    // DEC-051 — the offer moved into the SHARED close path so the widgets
    // cannot quietly diverge from the page; the view calls it, the rules live
    // in one file.
    expect(view).toContain('closeWithOffer')
    const close = read('src/renderer/src/components/attention/useCloseWorkItem.ts')
    expect(close).toContain('Mark the desk done')
    // Only fires on a still-open desk with nothing else active.
    expect(close).toContain("desk.status === 'done' || desk.status === 'parked'")
    expect(close).toContain('if (remaining.length > 0) return')
    // Accepting uses the ordinary user-owned node update.
    expect(close).toContain("updateNode(desk.id, { status: 'done' })")
  })

  it('D-4: All-Desks cards carry the attention signal; status groups untouched', () => {
    const desks = read('src/renderer/src/components/views/DesksView.tsx')
    expect(desks).toContain('attentionByDesk')
    expect(desks).toContain('open${attn.due ?')
    expect(desks).toContain("(['open', 'in_progress', 'done', 'parked']")
  })

  it('D-5 SUPERSEDED: status is removed from capture (capture rebuild)', () => {
    // History: DEC-047 D-5 put an active birth state on the capture card.
    // The rebuild removed it — "in progress / waiting / blocked at the
    // moment of intake is a state you almost never intend", and waiting is
    // one keystroke (W) away in Attention. A new item is open, always.
    const card = read('src/renderer/src/components/AttentionConfirmCard.tsx')
    expect(card).not.toContain('CAPTURE_STATES')
    expect(card).toContain('a new item is open')
  })
})

describe('DEC-049 — the command-center layout (file-level pins)', () => {
  const view = read('src/renderer/src/components/views/AttentionView.tsx')
  // The arrangement the operator ruled: KPIs across the top, the AI strip
  // with them, the day's calendar top-right under the banner, and a SHORT
  // sticky rail — no long scroll to reach anything.
  it('analytics runs across the top of the working column, with Start here beneath it', () => {
    const band = view.indexOf('<AnalyticsBlock')
    const start = view.indexOf('<StartHereBlock')
    const tabs = view.indexOf("QUEUE_ORDER] as string[]).map")
    expect(band).toBeGreaterThan(-1)
    expect(view.slice(band, band + 200)).toContain('variant="band"')
    expect(view.slice(start, start + 120)).toContain('variant="band"')
    expect(band).toBeLessThan(start) // KPIs first…
    expect(start).toBeLessThan(tabs) // …then the AI strip, then the queues
  })

  it('the rail holds ONLY the day and the radar, and it sticks', () => {
    const aside = view.slice(view.indexOf('<aside'), view.indexOf('</aside>'))
    expect(aside).toContain('<AgendaBlock variant="full" />')
    expect(aside).toContain('<OverdueRadarBlock variant="full" />')
    // DEC-054: the rail sticks and is shown by a CONTAINER query, not a
    // viewport breakpoint — the sidebar reserves width with padding, so the
    // window never narrows when it opens and xl: could not respond.
    expect(aside).toContain('fb-cq-rail')
    expect(aside).toContain('sticky top-0')
    // Everything else was moved out of the column the operator called too long.
    expect(aside).not.toContain('AnalyticsBlock')
    expect(aside).not.toContain('StartHereBlock')
    expect(aside).not.toContain('RecentActivityBlock')
    expect(aside).not.toContain('AttentionPulseBlock')
  })

  it('a KPI tile filters by the SAME predicate that counted it', () => {
    // The number you press and the rows you get cannot disagree, because the
    // view filters through the exported KPI_FILTERS map itself.
    expect(view).toContain('KPI_FILTERS[kpiFilter](i, nowMs)')
    // …and a narrowed queue always says so, with an escape.
    expect(view).toContain('Showing {KPI_LABEL[kpiFilter]} only')
  })
})

describe('DEC-065 — the editor fits the screen it opens on', () => {
  const src = readFileSync(join(process.cwd(), 'src/renderer/src/components/AttentionItemEditor.tsx'), 'utf8')

  it('DEC-065_is_centred_and_bounded_by_the_viewport', () => {
    // It used to be pinned 14vh from the top with no height cap, so a Meet item
    // — once DEC-064 gave it a meeting section — ran 172px off the bottom of a
    // 997px laptop viewport with its Save button unreachable. Measured.
    expect(src).toContain('items-center justify-center p-6')
    expect(src).not.toContain('items-start justify-center pt-[14vh]')
    // Content that cannot be reached is worse than content that scrolls, so the
    // max-height is the floor beneath the sizing — not a substitute for it.
    expect(src).toContain('max-h-full overflow-y-auto')
  })

  it('DEC-065_the_two_single_line_meeting_fields_share_a_row', () => {
    // Stacked they cost a row each. Neither needs full width to be usable, and
    // that pairing is most of the 105px that brought the form back on screen.
    const meeting = src.slice(src.indexOf("cls === 'to_meet'"), src.indexOf('Others coming'))
    expect(meeting).toContain('grid grid-cols-2 gap-3')
    expect(meeting).toContain('Join link')
    expect(meeting).toContain('Location')
  })
})

describe('DEC-050 — the item rows read like a project tool', () => {
  const view = read('src/renderer/src/components/views/AttentionView.tsx')
  const pill = read('src/renderer/src/components/attention/ItemStatusPill.tsx')

  it('the queue is ONE box whose rows touch, divided by a hairline (DEC-055)', () => {
    // History worth keeping: the first divider attempt drew nothing, because
    // clusterByDesk wrapped rows in per-desk DIVS — `divide-y` then only fell
    // between clusters, and DEC-055 fixed it with a Fragment so every row was
    // a direct child. DEC-070 restructures on purpose: a parent + its subtree
    // is one UNIT (so a hairline never cuts through a subtree), desk clusters
    // own their interior dividers, and only DESK-LESS items still use the
    // Fragment so the box's own hairlines separate them.
    expect(view).toContain('fb-glass-card overflow-hidden divide-y divide-[var(--edge-soft)]')
    expect(view).toContain('<Fragment key={`flat-${ci}`}>')
    expect(view).toContain('divide-y divide-[var(--edge-soft)]">')
    // Rows are flush inside that box — no per-row card, no gap, no lift.
    expect(view).toContain('flex items-center gap-2 pr-2.5 py-1.5 min-h-[40px] transition-colors')
    // GAP-018 (DEC-086): rgba(var(--accent),X) substitutes to an INVALID
    // color and never painted — swept to the slash/rgb()-slash forms.
    expect(view).toContain('hover:bg-accent/5')
    expect(view).not.toContain('rounded-lg fb-glass-row transition-all')
  })

  it('every row has the project-tool anatomy', () => {
    expect(view).toContain('<ItemStatusPill') // status you can change in place
    expect(view).toContain('close this task') // the completion circle
    expect(view).toContain('subtaskProgress(i.id, items') // the "2/5" progress
    expect(view).toContain("name=\"flag\"") // priority
    expect(view).toContain('assignees.slice(0, 3)') // who is on it
    // Nesting reads as indentation, capped with the depth rule. DEC-055 moved
    // it from margin to PADDING so an indented row still spans the box and its
    // divider runs edge to edge — DEC-062 kept that and widened the step,
    // routing every indent through one constant so the row, the spine, the
    // handle and the elbow cannot drift apart.
    expect(view).toContain('paddingLeft: `${8 + indentLevel * INDENT_PX}px`')
    expect(view).not.toContain('marginLeft') // still padding, not margin
    expect(view).toMatch(/const INDENT_PX = \d+/)
  })

  it('the status pill offers the honest set and closes with the QUEUE verb', () => {
    // Only states an open item can truthfully sit in, plus the queue's own
    // closing verb — never a generic "Done" pasted over every class.
    expect(pill).toContain("{ state: 'in_progress', label: 'In progress' }")
    expect(pill).toContain("{ state: 'waiting', label: 'Waiting' }")
    expect(pill).toContain("{ state: 'blocked', label: 'Blocked' }")
    expect(pill).toContain('closeChoice')
    expect(view).toContain('closeChoice={{ state: primary.state, label: primary.label }}')
    // Closing through the pill runs the same accounting as the circle
    // (desk-done offer + open-subtask offer), never a bare setState.
    expect(view).toContain('if (next === primary.state) void closeWithOffer(i, next)')
    // The pill colours itself from the derived projection, so a state we add
    // later can never render unstyled.
    expect(pill).toContain('statusForWorkItemState')
  })
})

describe('DEC-051 — desk + home widgets carry the same row anatomy', () => {
  const widgets = read('src/renderer/src/components/views/attentionWidgets.tsx')
  const view = read('src/renderer/src/components/views/AttentionView.tsx')
  // DEC-128: the row moved into its own component (components/attention/
  // WidgetItemRow) so it could grow the in-place summary; the anatomy pins
  // follow it there. ItemLines still feeds every widget with it.
  const row = read('src/renderer/src/components/attention/WidgetItemRow.tsx')

  it('widget rows are cards with the queue spine, a completion circle and status', () => {
    expect(row).toContain('rounded-md border border-[var(--edge-soft)]')
    expect(row).toContain('absolute left-0 top-1.5 bottom-1.5') // the spine
    expect(row).toContain('close this task') // the completion circle
    expect(row).toContain('<ItemStatusPill') // status, changeable in place
    expect(row).toContain('statusLabel(i.workItemState, primary.label)') // dense dot
    expect(widgets).toContain("import { WidgetItemRow } from '../attention/WidgetItemRow'")
    expect(widgets).toContain('<WidgetItemRow key={i.id} i={i} dense={dense} nowMs={nowMs} />')
  })

  it('ONE row renderer feeds every widget, so the surfaces cannot drift', () => {
    // Queue widgets, calendar, completed, system, and the big widget the DESK
    // widget delegates to — all render through ItemLines.
    expect(widgets.match(/<ItemLines /g)?.length).toBe(5)
    expect(widgets).toContain('function ItemLines(')
    expect(widgets.match(/function ItemLines\(/g)?.length).toBe(1)
  })

  it('closing from a widget runs the SAME accounted path as the page', () => {
    // DEC-128: the hook is imported where the row lives now.
    expect(row).toContain("import { useCloseWorkItem } from './useCloseWorkItem'")
    expect(view).toContain("import { useCloseWorkItem } from '../attention/useCloseWorkItem'")
    // Both spell the close identically: the queue's own verb, via the hook.
    expect(row).toContain('void closeItem(i, primary.state)')
    expect(view).toContain('void closeWithOffer(i, primary.state)')
  })

  it('the widget is no longer one giant button (which swallowed row clicks)', () => {
    // Nested buttons are invalid, and every inner click became "open
    // Attention" — which is why rows could never be interactive out here.
    expect(widgets).not.toContain('className="w-full h-full text-left flex flex-col p-3 fb-press"')
    expect(widgets).toContain('<div className="w-full h-full text-left flex flex-col p-3">')
  })
})

describe('DEC-051 — the agenda READS the calendar, never re-ranges it', () => {
  const blocks = read('src/renderer/src/components/attention/attentionBlocks.tsx')

  it('fetches today directly instead of calling the shared loadRange', () => {
    // The time-block store holds ONE range for whatever surface last asked.
    // WeekTimeGrid loads a week into it; a widget narrowing that to today
    // would blank the rest of an open calendar's week until it remounted.
    expect(blocks).not.toContain('s.loadRange') // never subscribes to the setter
    expect(blocks).not.toContain('void loadRange(') // never calls it
    expect(blocks).toContain('window.api.timeBlocks')
    expect(blocks).toContain('.list(from.getTime(), to.getTime())')
  })

  it('still refreshes when the calendar changes and when the day rolls over', () => {
    expect(blocks).toContain('const timeBlockTick = useTimeBlockStore((s) => s.blocks.length)')
    expect(blocks).toContain('}, [dayKey, timeBlockTick])')
  })
})
