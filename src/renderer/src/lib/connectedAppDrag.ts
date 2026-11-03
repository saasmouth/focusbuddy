// The drag type a connected app carries out of the side menu (its id). Lives
// here, not in Sidebar.tsx, so a surface can accept the drag without importing
// the whole side menu; Sidebar re-exports it for the existing importers.
export const CONNECTED_APP_DRAG_MIME = 'text/fb-connected-app'
