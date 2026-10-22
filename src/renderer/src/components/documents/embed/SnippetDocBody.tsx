import { docToHtml } from '../../../lib/docHtml'
import { sanitizeHtml } from '../../../lib/htmlSanitize'

// Read-only render of a doc snippet's saved content.
//
// Split into its own module and loaded lazily by SnippetEmbed for the same
// reason EmbeddedWidgetBody is: `docHtml` pulls in buildDocExtensions, which
// registers SnippetEmbedNode, which renders SnippetEmbed. That cycle is
// legitimate — a snippet really can contain a document fragment, and the schema
// really must be shared with the headless converters — so it is broken at the
// import boundary rather than by duplicating a renderer.
//
// It goes through the editor's OWN schema (docToHtml) rather than a second
// renderer, so a live instance shows what the master would show, and then
// through the sanitizer, because the HTML is generated from stored content and
// is inserted as markup.

export default function SnippetDocBody({ content }: { content: unknown[] }): JSX.Element {
  const html = sanitizeHtml(docToHtml({ type: 'doc', content: content as never }))
  if (!html.trim()) {
    return (
      <div className="px-3 py-2 text-[12px] text-[var(--ink-50)]">
        This snippet has no renderable content.
      </div>
    )
  }
  return (
    <div
      className="prose prose-sm prose-stone dark:prose-invert max-w-none px-3 py-2"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
