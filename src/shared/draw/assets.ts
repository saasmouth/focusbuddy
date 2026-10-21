// The v2 asset store: image and paint-layer bytes kept ONCE, under a content
// hash.
//
// v1 kept every image and every paint layer inline as a PNG data URL, so each
// brush stroke put a whole-layer PNG on the undo stack and into the co-editing
// log, and a duplicated photo doubled the file. In v2 a node holds an asset id;
// the bytes sit in `DrawDoc.assets` once. Because the id IS the hash of the
// bytes, the same picture always gets the same id -- on every device, in every
// session -- so storing it twice is impossible and an asset never changes
// under its id.

import { isDrawImageSrc } from '../draw'
import type { DrawAsset } from './model'

// SHA-256, synchronous and dependency-free, so the hash is identical in the
// renderer, the main process and the tests (WebCrypto is async-only and
// node:crypto does not exist in the renderer).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

function utf8(s: string): Uint8Array {
  // TextEncoder exists in every runtime this code runs in (browser, Node, Electron).
  return new TextEncoder().encode(s)
}

/** SHA-256 of a string's UTF-8 bytes, as lowercase hex. */
export function sha256Hex(input: string): string {
  const msg = utf8(input)
  const bitLen = msg.length * 8
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6)
  padded.set(msg)
  padded[msg.length] = 0x80
  const view = new DataView(padded.buffer)
  // Length in bits as a 64-bit big-endian integer (inputs here are far below 2^53).
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(padded.length - 4, bitLen >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]
      const b = w[i - 2]
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('')
}

/** The shape every asset id has: `asset-` and 32 hex digits (128 bits of SHA-256). */
export const DRAW_ASSET_ID = /^asset-[0-9a-f]{32}$/

/**
 * The id the bytes `dataUrl` are stored under. Pure and deterministic: the same
 * bytes always give the same id, so an asset is never stored twice and two
 * devices agree on its name without talking.
 */
export function assetIdFor(dataUrl: string): string {
  const hit = idCache.get(dataUrl)
  if (hit) return hit
  const id = `asset-${sha256Hex(dataUrl).slice(0, 32)}`
  idCache.set(dataUrl, id)
  // A small most-recently-used window: a paint layer's PNG is hashed once per
  // stroke, not once per drag frame of every later edit. Map keeps insertion
  // order, so the first key is the oldest.
  if (idCache.size > ID_CACHE_MAX) idCache.delete(idCache.keys().next().value as string)
  return id
}

const ID_CACHE_MAX = 64
const idCache = new Map<string, string>()

/** The MIME type a data URL declares, or application/octet-stream. */
export function dataUrlMime(dataUrl: string): string {
  const m = /^data:([^;,]+)[;,]/i.exec(dataUrl)
  return m ? m[1].toLowerCase() : 'application/octet-stream'
}

/**
 * Put bytes in a store, returning the (possibly new) store and the id.
 * A store that already holds them is returned as-is -- identity included.
 */
export function putAsset(assets: Record<string, DrawAsset>, dataUrl: string, size?: { w: number; h: number }): { assets: Record<string, DrawAsset>; id: string } {
  const id = assetIdFor(dataUrl)
  if (Object.prototype.hasOwnProperty.call(assets, id)) return { assets, id }
  return { assets: { ...assets, [id]: { mime: dataUrlMime(dataUrl), dataUrl, ...(size ? { w: size.w, h: size.h } : {}) } }, id }
}

/** The embedded bytes for an id, or undefined when absent or not embeddable image bytes. */
export function assetSrc(assets: Record<string, DrawAsset>, id: string | undefined): string | undefined {
  if (!id || !Object.prototype.hasOwnProperty.call(assets, id)) return undefined
  const a = assets[id]
  return a && isDrawImageSrc(a.dataUrl) ? a.dataUrl : undefined
}
