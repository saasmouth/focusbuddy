// The Link mark options the page and markdown work widgets share.
//
// TipTap's Link drops (or renders with an empty href) any address whose
// scheme it does not know, so a `plexii://file/<id>` link (a file, document or
// folder dropped from the Files panel, shared/snippetWidgets.ts linkParagraph)
// would arrive as dead text. Registering `plexii`, as PlexiiWrite's editor
// does (documents/editor/extensions.ts), keeps it through save and reload.

export const WIDGET_LINK_PROTOCOLS = ['http', 'https', 'mailto', 'plexii']

export function widgetLinkAllowed(url: string, ctx: { defaultValidate: (u: string) => boolean }): boolean {
  return url.startsWith('plexii://') || ctx.defaultValidate(url)
}

export const WIDGET_LINK_OPTIONS = { protocols: WIDGET_LINK_PROTOCOLS, isAllowedUri: widgetLinkAllowed }
