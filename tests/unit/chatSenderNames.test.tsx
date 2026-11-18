// Other people's messages in the Messages view say who wrote them (4.3.50).
//
// MessageRow drew other people's bubbles with no name, so a space or channel
// opened in the full Messages view could not tell you who said what (seen
// capturing 4.3.48 screens, 2026-11-17). See src/renderer/src/lib/chatSenderLabels.ts.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatSenderLabels } from '../../src/renderer/src/lib/chatSenderLabels'
import { MessageRow } from '../../src/renderer/src/components/views/MessagesView'
import type { ChatMessage } from '../../src/renderer/src/lib/messagingClient'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const members = [
  { accountId: 'me', firstName: 'Mia', lastName: 'Lee', handle: 'mia' },
  { accountId: 'ana', firstName: 'Ana', lastName: 'Ruiz', handle: 'ana' },
  { accountId: 'tom', handle: 'tom' }
]
const from = (...ids: string[]) => ids.map((fromAccount) => ({ fromAccount }))

describe('chatSenderLabels', () => {
  it('names someone else once per run of their messages, never you', () => {
    expect(chatSenderLabels(from('ana', 'ana', 'me', 'tom', 'ana'), 'me', members, false)).toEqual([
      'Ana Ruiz', null, null, 'tom', 'Ana Ruiz'
    ])
  })

  it('a sender who is no longer a member is "Someone", not blank', () => {
    expect(chatSenderLabels(from('gone'), 'me', members, false)).toEqual(['Someone'])
  })

  it('a DM names nobody: its header is the other person', () => {
    expect(chatSenderLabels(from('ana', 'me'), 'me', members, true)).toEqual([null, null])
  })
})

describe('MessageRow', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const msg = { id: 'm1', fromAccount: 'ana', body: 'Shall we ship it?', createdAt: 1_700_000_000_000, reactions: [] } as unknown as ChatMessage

  it('shows the sender’s name above someone else’s message', () => {
    act(() => root.render(<MessageRow m={msg} mine={false} myId="me" onReact={() => {}} senderName="Ana Ruiz" />))
    expect(host.querySelector('[data-testid="message-sender"]')?.textContent).toBe('Ana Ruiz')
  })

  it('shows no name above your own message', () => {
    act(() => root.render(<MessageRow m={{ ...msg, fromAccount: 'me' }} mine myId="me" onReact={() => {}} senderName="Mia Lee" />))
    expect(host.querySelector('[data-testid="message-sender"]')).toBeNull()
  })
})

describe('the Messages view passes the names', () => {
  it('each MessageRow gets its label from chatSenderLabels', () => {
    const view = readFileSync(join(__dirname, '../../src/renderer/src/components/views/MessagesView.tsx'), 'utf8')
    expect(view).toMatch(/chatSenderLabels\(/)
    expect(view).toMatch(/senderName=\{senderLabels\[i\]\}/)
  })
})
