// An embed of an OFFICE DOCUMENT (a Write document, a sheet, deck, diagram,
// design or drawing) inside another object. It is addressed as
// `doc:<document id>` beside the other embed ids (`wf:<file id>` for a work
// widget file, a bare id for a desk widget).
//
// It exists because the office apps are documents, not work widget files, so
// "embed anything in anything" could not reach them: dragging PlexiiCells into
// a document was refused with "arranges a desk, so it only lives on one",
// which was simply untrue. The embed renders the same live office editor a
// desk shows, saving to the document itself.
export const DOCUMENT_EMBED_PREFIX = 'doc:'

export function documentEmbedId(documentId: string): string {
  return `${DOCUMENT_EMBED_PREFIX}${documentId}`
}

/** The document id behind a `doc:` embed id, or null for any other id. */
export function documentIdFromEmbed(id: string | null | undefined): string | null {
  return id && id.startsWith(DOCUMENT_EMBED_PREFIX) && id.length > DOCUMENT_EMBED_PREFIX.length ? id.slice(DOCUMENT_EMBED_PREFIX.length) : null
}
