// Edit › Insert snippet…: the saved-snippets library, scoped to drawings and
// aimed at this studio (editor/drawSnippets.ts registers it as the target).
// It brings its own modal, so the studio shows it frameless.

import SnippetLibrary from '../../../snippets/SnippetLibrary'
import type { DrawDialog } from '../editor/types'
import { drawSnippetTargetId } from '../editor/drawSnippets'
import type { SnippetKind } from '@shared/snippets'
import { officeAccepts } from '../../../../lib/officeSnippets'

// One array for the life of the app: the library refreshes when `kinds`
// changes identity, and the studio re-renders on every edit.
// Every kind with a conversion into this app, derived from the builders.
const DRAW_KINDS: SnippetKind[] = officeAccepts('draw')

const snippetLibrary: DrawDialog = {
  id: 'snippet-library',
  title: 'Saved snippets',
  frameless: true,
  component: function DrawSnippetLibrary({ ctx, props, close }) {
    const targetId = typeof props?.targetId === 'string' ? props.targetId : drawSnippetTargetId(ctx)
    return <SnippetLibrary kinds={DRAW_KINDS} targetId={targetId} onClose={close} />
  }
}

export default snippetLibrary
