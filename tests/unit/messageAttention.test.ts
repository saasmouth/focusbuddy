// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FbNode } from '../../src/shared/types'
import { liveItemForMessage } from '../../src/renderer/src/lib/messageAttention'
import { buildMessageUrl } from '../../src/renderer/src/lib/messageLink'

// ── DEC-125 — the message bell behaves as the desk widget's: filled while an
// open item points at the message, a check-off circle beside it, empty again
// once closed. And the row's meta lives under the bubble.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, 'src', p), 'utf-8')
const messages = read('renderer/src/components/views/MessagesView.tsx')
const frame = read('renderer/src/components/widgets/WidgetFrame.tsx')
const bell = read('renderer/src/components/attention/BellIcon.tsx')

const item = (over: Partial<FbNode>): FbNode =>
  ({
    id: 'i', kind: 'work_item', title: 't', parentId: null, description: '', status: 'open',
    workItemState: 'open', sourceType: 'message', sourceRef: 'conv-1',
    sourceUrl: buildMessageUrl('conv-1', 'msg-1'), updatedAt: 1, createdAt: 1, ...over
  }) as unknown as FbNode

describe('DEC-125 — the live item for a message', () => {
  it('finds the open item whose moment link names the message', () => {
    expect(liveItemForMessage([item({})], 'msg-1')?.id).toBe('i')
    expect(liveItemForMessage([item({})], 'msg-2')).toBeNull()
  })
  it('a closed, dismissed or detached item no longer fills the bell', () => {
    expect(liveItemForMessage([item({ workItemState: 'completed' })], 'msg-1')).toBeNull()
    expect(liveItemForMessage([item({ workItemState: 'dismissed' })], 'msg-1')).toBeNull()
    expect(liveItemForMessage([item({ detachedFromId: 'x' } as Partial<FbNode>)], 'msg-1')).toBeNull()
  })
  it('only message items count, and the most recently touched one wins', () => {
    expect(liveItemForMessage([item({ sourceType: 'widget' })], 'msg-1')).toBeNull()
    expect(liveItemForMessage([item({ id: 'a', updatedAt: 1 }), item({ id: 'b', updatedAt: 5 })], 'msg-1')?.id).toBe('b')
  })
})

describe('DEC-125 — the bell on a message is the widget\'s bell', () => {
  it('one bell source, shared by the widget frame and the message row', () => {
    expect(bell).toContain("PLEXII_ICONS['notifications']")
    expect(bell).toContain("fill={active ? 'currentColor' : 'none'}")
    expect(frame).toContain("import BellIcon from '../attention/BellIcon'")
    expect(frame).not.toContain('function BellIcon(')
    expect(messages).toContain("import BellIcon from '../attention/BellIcon'")
    expect(messages).toContain("import CompleteCircle from '../attention/CompleteCircle'")
  })
  it('filled and visible while marked, with the check-off circle closing through the one path with the queue\'s verb', () => {
    expect(messages).toContain('<BellIcon size={14} active={!!marked} />')
    expect(messages).toContain("marked ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100'")
    expect(messages).toContain('onClick={() => void closeWorkItem(marked, verb.state)}')
    expect(messages).toContain('dataTestId={`msg-attn-complete-${m.id}`}')
    expect(messages).toContain('const verb = marked ? (PRIMARY_ACTION[queueOf(marked)] ?? PRIMARY_ACTION.to_do) : null')
    // a filled bell opens the queue; an empty one opens the capture prompt
    expect(messages).toContain('onClick={marked ? () => goAttention() : onCapture}')
    expect(messages).toContain('const markedFor = (id: string): FbNode | null => liveItemForMessage(workItems, id)')
    expect(messages).toContain('marked={markedFor(m.id)}')
    expect(messages).toContain('marked={markedFor ? markedFor(parent.id) : null}')
  })
})

describe('DEC-125 — the meta lives under the bubble', () => {
  it('time and the pin icon on the left; the thread on the right edge; nothing of it inside the bubble', () => {
    expect(messages).toContain('data-testid={`msg-meta-${m.id}`}')
    expect(messages).toContain('className="mt-0.5 w-full flex items-center gap-2 text-[10px] text-[var(--ink-40)]"')
    expect(messages).toContain('<span className="ml-auto shrink-0">')
    expect(messages).toContain('<Icon name="keep" size={12} filled={pinned} />')
    expect(messages).not.toContain("'Pinned' : 'Pin'")
    expect(messages).not.toContain('msg-translate-toggle-')
    // the bubble no longer carries the time
    expect(messages).not.toContain("text-[9px] mt-0.5 flex items-center gap-1.5")
    // DEC-126: Translate left the meta row for the ⋯ menu — one door, the
    // same three states, now naming the target language.
    expect(messages).toContain("{translating ? 'Translating…' : translated ? (showOriginal ? `Show ${translateLang || 'translation'}` : 'Show original') : `Translate to ${translateLang || 'English'}`}")
  })
})
