/**
 * The class on PlexiiWrite's editing surface (the ProseMirror element), for
 * Write's own surface rules in globals.css: the empty-document placeholder.
 * The shared .tiptap-editor rules belong to the page and markdown widgets and
 * never reached Write, so an empty document showed no prompt at all.
 */
export const DOC_SURFACE_CLASS = 'doc-surface'
