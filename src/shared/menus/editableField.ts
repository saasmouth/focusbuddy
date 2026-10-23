import { MENU } from './lexicon'
import { shortcutLabel } from './shortcuts'

// The right-click menu on TEXT, everywhere (SPEC §9.3, the third shape): a text
// field, Write's page, a cell or text box being edited. Plain data, so main can
// turn it into native MenuItems (web content, 2e's WP3) and the renderer into
// kit items, and both say exactly the same thing.

export interface EditableFieldContext {
  /** Some text is selected. */
  hasSelection: boolean
  /** The clipboard holds something pasteable. */
  canPaste: boolean
  /** The text can be changed (false: read-only text, which keeps Copy and Select all). */
  isEditable: boolean
  /** Offer the Plexii group (Ask PlexiiAssist about this, Save selection as snippet…). */
  plexii?: boolean
}

export type EditableFieldItemId =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAsPlainText'
  | 'selectAll'
  | 'askAssistAboutThis'
  | 'saveAsSnippet'

export interface EditableFieldItem {
  id: EditableFieldItemId
  label: string
  /** The hint for this platform, or '' when the action has no bound key. */
  shortcut: string
  enabled: boolean
  /** Why it is off (SPEC §9.5), when it is. */
  hint?: string
  separatorBefore: boolean
}

export function editableFieldItems(ctx: EditableFieldContext, platform: string): EditableFieldItem[] {
  const hint = (id: keyof typeof MENU): string => {
    const k = (MENU[id] as { keys?: readonly string[] }).keys
    return k ? shortcutLabel(k as never, platform) : ''
  }
  const out: EditableFieldItem[] = []
  const push = (id: EditableFieldItemId, enabled: boolean, why: string | undefined, separatorBefore = false): void => {
    out.push({ id, label: MENU[id].label, shortcut: hint(id), enabled, ...(enabled || !why ? {} : { hint: why }), separatorBefore })
  }
  // Read-only text never offers what would change it (absent, SPEC §9.5).
  if (ctx.isEditable) push('cut', ctx.hasSelection, 'Select some text first')
  push('copy', ctx.hasSelection, 'Select some text first')
  if (ctx.isEditable) {
    push('paste', ctx.canPaste, 'Nothing to paste')
    push('pasteAsPlainText', ctx.canPaste, 'Nothing to paste')
  }
  push('selectAll', true, undefined, true)
  if (ctx.plexii && ctx.hasSelection) {
    push('askAssistAboutThis', true, undefined, true)
    push('saveAsSnippet', true, undefined)
  }
  return out
}
