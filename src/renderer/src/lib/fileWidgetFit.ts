import { catalogFor } from './widgetCatalog'

/**
 * Whether a file widget is fitted to its picture's shape when it mounts
 * (FileWidget's auto-size for an image). Only while it is still at the size every
 * place that makes one gives it (the catalogue's: a drop from Finder or from
 * Files, a generated image): that is a widget nobody has sized. A size somebody
 * chose -- a resize, a room brought in from PlexiiLite laid out as it was, an
 * agent's placement -- is kept, on this mount and every later one. (Before, the
 * fit ran on every mount, so a resized picture sprang back each time its desk
 * was opened, which the widget's own comment said must never happen.)
 * Replacing the widget's file while it is shown still fits it again.
 */
export function fitsPictureOnMount(w: { width: number; height: number }): boolean {
  const d = catalogFor('file')
  return !!d && w.width === d.defaultWidth && w.height === d.defaultHeight
}
