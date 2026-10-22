// Edit › Save selection as snippet…: the app's own save dialog, given the body
// edit.saveAsSnippet captured from the selection (editor/drawSnippets.ts). It
// brings its own modal, so the studio shows it frameless.

import type { DrawSnippetBody } from '@shared/snippets'
import SaveSnippetDialog from '../../../snippets/SaveSnippetDialog'
import type { DrawDialog } from '../editor/types'
import { emptyDrawBody } from '../editor/drawSnippets'

const saveSnippet: DrawDialog = {
  id: 'save-snippet',
  title: 'Save as snippet',
  frameless: true,
  component: function SaveDrawSnippet({ ctx, props, close }) {
    const body = (props?.body as DrawSnippetBody | undefined) ?? emptyDrawBody()
    const suggestedName = typeof props?.suggestedName === 'string' ? props.suggestedName : ''
    return (
      <SaveSnippetDialog
        body={body}
        suggestedName={suggestedName}
        onSaved={() => ctx.status('Saved as a snippet.')}
        onClose={close}
      />
    )
  }
}

export default saveSnippet
