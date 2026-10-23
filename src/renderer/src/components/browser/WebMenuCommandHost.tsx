// Carries out what was chosen in the native right-click menus
// (main/webContextMenu.ts): on a web page, Add to desk, Ask PlexiiAssist about
// this and the AI Assist text actions; in the app window's text menu, the
// Plexii rows, through the surface registry (lib/textMenuHandlers.ts). Mounted
// once; renders nothing itself.
import { useEffect } from 'react'
import type { WebMenuCommand } from '@shared/webMenu'
import { resolveAiCommand } from '@shared/aiTextActions'
import { addToDesk } from '../../lib/addToDesk'
import { useAddToDeskPicker } from '../../stores/addToDeskPicker'
import { useAiAssistPreview } from '../../stores/aiAssistPreview'
import { useAssistantChrome } from '../../stores/assistantChrome'
import { useChatStore, NEW_CHAT_KEY } from '../../stores/chat'
import { dispatchTextMenuCommand, installTextMenuQuery } from '../../lib/textMenuHandlers'

/** The composer text for "Ask PlexiiAssist about this": the passage quoted, its page named. Pure; exported for tests. */
export function askAboutPrompt(text: string, pageTitle: string, pageUrl: string): string {
  const quoted = text
    .trim()
    .slice(0, 4000)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
  const from = /^https?:\/\//i.test(pageUrl) ? ` (from ${pageTitle.trim() || pageUrl}, ${pageUrl})` : ''
  return `About this passage${from}:\n\n${quoted}\n\n`
}

/** Stage text in PlexiiAssist's composer for the person to finish; never sent by itself. */
function stageInComposer(text: string): void {
  const chat = useChatStore.getState()
  const key = chat.activeConversationId ?? NEW_CHAT_KEY
  chat.setThreadDraft(key, {
    type: 'doc',
    content: text
      .split('\n')
      .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }))
  })
  const chrome = useAssistantChrome.getState()
  chrome.setTab('chat')
  chrome.openPanel()
  // The panel may still be mounting: its editor reads the draft on mount, and
  // an editor already on screen fills from the event (voiceHold does the same).
  const stage = (): void => void window.dispatchEvent(new CustomEvent('fb:composer-stage', { detail: text }))
  stage()
  setTimeout(stage, 400)
}

export function runWebMenuCommand(cmd: WebMenuCommand): void {
  if (cmd.command === 'add-to-desk') {
    if (cmd.desk === 'new' || cmd.desk === 'choose') useAddToDeskPicker.getState().open(cmd)
    else void addToDesk(cmd, { deskId: cmd.desk })
    return
  }
  if (cmd.command === 'ask-assist') {
    stageInComposer(askAboutPrompt(cmd.text, cmd.pageTitle, cmd.pageUrl))
    return
  }
  const ai = resolveAiCommand(cmd.ai)
  if (!ai) return
  useAiAssistPreview.getState().start({
    label: ai.label,
    instruction: ai.instruction,
    text: cmd.text.slice(0, 12000),
    wholeContent: false,
    awaitInput: ai.awaitInput,
    web: { pageUrl: cmd.pageUrl, pageTitle: cmd.pageTitle }
  })
}

export default function WebMenuCommandHost(): null {
  useEffect(() => {
    const off = window.api.webMenu?.onCommand?.(runWebMenuCommand)
    // The app window's text menu asks the page which Plexii rows apply, then
    // sends the chosen one back; with no surface claiming it, "Ask PlexiiAssist
    // about this" quotes the passage in the composer like a web page's does.
    installTextMenuQuery()
    const offText = window.api.textMenu?.onAction?.((cmd) =>
      dispatchTextMenuCommand(cmd, (text) => runWebMenuCommand({ command: 'ask-assist', text, pageUrl: '', pageTitle: '' }))
    )
    return () => {
      off?.()
      offText?.()
    }
  }, [])
  return null
}
