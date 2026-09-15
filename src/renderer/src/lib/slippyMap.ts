// Web Mercator tile arithmetic -- the same maths every slippy map uses.
//
// This exists because the app's CSP allows `img-src https:` but not framing a
// third-party page, so an embedded map iframe is not available to us. A tile
// map IS just a grid of images, so building it directly is both permitted and
// more honest than the alternative: a static picture of a map is a picture, and
// cannot be panned or zoomed.

export interface LatLon {
  lat: number
  lon: number
}

/** Fractional tile coordinates at a zoom level. */
export function project({ lat, lon }: LatLon, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat))
  const rad = (clamped * Math.PI) / 180
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  return {
    x: ((lon + 180) / 360) * n,
    // Clamping the LATITUDE still leaves y a few parts in 10^11 outside [0, n]
    // at the exact Mercator limit -- the log/tan round just past the edge. Left
    // alone that is a negative y, which floors to tile row -1: a request for a
    // tile that does not exist. Clamp the result, not just the input.
    y: Math.max(0, Math.min(n, y))
  }
}

/** The inverse, for turning a drag in pixels back into a centre. */
export function unproject(x: number, y: number, zoom: number): LatLon {
  const n = 2 ** zoom
  const lon = (x / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  return { lat, lon }
}

export const TILE = 256

export interface TileRef {
  z: number
  x: number
  y: number
  /** Where this tile's top-left corner sits inside the viewport, in px. */
  left: number
  top: number
}

/**
 * The tiles needed to cover a viewport centred on `centre`.
 *
 * Tiles outside the valid y range are dropped rather than requested: past the
 * poles there is no tile, and asking for one is a 404 against a volunteer-run
 * service.
 */
export function tilesFor(
  centre: LatLon,
  zoom: number,
  width: number,
  height: number
): TileRef[] {
  const z = Math.max(0, Math.min(19, Math.round(zoom)))
  const n = 2 ** z
  const c = project(centre, z)
  // Pixel position of the centre within the whole world, then of the viewport's
  // top-left corner.
  const originX = c.x * TILE - width / 2
  const originY = c.y * TILE - height / 2
  const firstX = Math.floor(originX / TILE)
  const firstY = Math.floor(originY / TILE)
  const cols = Math.ceil(width / TILE) + 1
  const rows = Math.ceil(height / TILE) + 1

  const out: TileRef[] = []
  for (let dy = 0; dy < rows; dy++) {
    const ty = firstY + dy
    if (ty < 0 || ty >= n) continue
    for (let dx = 0; dx < cols; dx++) {
      const txRaw = firstX + dx
      // Longitude wraps, so a viewport crossing the antimeridian still tiles.
      const tx = ((txRaw % n) + n) % n
      out.push({
        z,
        x: tx,
        y: ty,
        left: txRaw * TILE - originX,
        top: ty * TILE - originY
      })
    }
  }
  return out
}

/** Where a point sits in the viewport, in px from its top-left. */
export function pointAt(
  point: LatLon,
  centre: LatLon,
  zoom: number,
  width: number,
  height: number
): { left: number; top: number } {
  const z = Math.max(0, Math.min(19, Math.round(zoom)))
  const p = project(point, z)
  const c = project(centre, z)
  return {
    left: (p.x - c.x) * TILE + width / 2,
    top: (p.y - c.y) * TILE + height / 2
  }
}

/** Move a centre by a drag measured in pixels. */
export function panBy(
  centre: LatLon,
  zoom: number,
  dxPx: number,
  dyPx: number
): LatLon {
  const z = Math.max(0, Math.min(19, Math.round(zoom)))
  const c = project(centre, z)
  return unproject(c.x - dxPx / TILE, c.y - dyPx / TILE, z)
}

/** OpenStreetMap's standard tile layer. Attribution is required wherever shown. */
export const tileUrl = ({ z, x, y }: Pick<TileRef, 'z' | 'x' | 'y'>): string =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'

/** A shareable link to the same view on openstreetmap.org. */
export const osmLink = (c: LatLon, zoom: number): string =>
  `https://www.openstreetmap.org/#map=${Math.round(zoom)}/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}`
