import { useState, type CSSProperties } from 'react'
import Icon from './Icon'
import { resolveEntityIcon, type PlexiiIconKind } from '../lib/plexiiIconMap'
import type { PlexiiIconAsset } from '../lib/plexiiIconAssets.generated'

// The one way to draw an ENTITY's icon — an app, a work widget kind, a tool or
// a connected app — from the owner's Plexii icon set.
//
//   <PlexiiIcon kind="app" id="docs" size={20} />
//
// - tile / logo assets render as an <img> with a width-described srcset, so the
//   browser takes the 32, 64 or 128px file that covers size x devicePixelRatio.
//   width/height are always set, so nothing shifts when the file arrives.
//   Connected-app logos are third-party marks used exactly as supplied; the
//   rounded corners that make them read as tiles are a CSS mask here, not baked
//   into the file.
// - glyph assets (single-colour marks) render as a CSS mask filled with
//   --plexii-glyph, so the owner's violet is used on dark and a deeper violet on
//   light, from one file and without recolouring it.
// - no asset (declared in lib/plexiiIconMap), or a file that fails to load:
//   the entity's existing Material/Plexii glyph, so nothing is ever blank.
//
// Accessibility: pass `label` when the icon is the only thing naming the
// entity (an icon-only button). Leave it out where visible text beside the icon
// already names it; the icon is then decorative (alt="" / aria-hidden) and is
// not read twice.

interface Props {
  kind: PlexiiIconKind
  id: string
  /** Edge in CSS px. */
  size?: number
  /** Accessible name. Omit when adjacent text already names the entity. */
  label?: string
  /** The glyph to draw when there is no asset; defaults to the entity's declared fallback. */
  fallback?: string
  /** Classes for the fallback glyph only (its tone). Assets carry their own colour. */
  fallbackClassName?: string
  /** The fallback glyph's fill, as the call site drew it before (Icon's default when omitted). */
  fallbackFilled?: boolean
  className?: string
  style?: CSSProperties
}

const SIZES = [32, 64, 128] as const

function sources(asset: PlexiiIconAsset): { size: number; url: string }[] {
  return SIZES.filter((s) => asset.src[s]).map((s) => ({ size: s, url: asset.src[s] as string }))
}

/** The smallest file covering `px` device pixels, else the largest there is. */
function pick(list: { size: number; url: string }[], px: number): string {
  return (list.find((s) => s.size >= px) ?? list[list.length - 1]).url
}

/** For tests and the e2e: the URL a given entity would load at a size and DPR. */
export function plexiiIconUrl(kind: PlexiiIconKind, id: string, size = 32, dpr = 2): string | null {
  const { asset } = resolveEntityIcon(kind, id)
  if (!asset) return null
  const list = sources(asset)
  return list.length ? pick(list, size * dpr) : null
}

export default function PlexiiIcon({
  kind,
  id,
  size = 20,
  label,
  fallback,
  fallbackClassName = '',
  fallbackFilled,
  className = '',
  style
}: Props): JSX.Element {
  const resolved = resolveEntityIcon(kind, id)
  const [failed, setFailed] = useState<string | null>(null)
  const asset = resolved.asset
  const list = asset ? sources(asset) : []
  const entity = `${kind}:${id}`

  if (!asset || list.length === 0 || failed === entity) {
    return (
      <Icon
        name={fallback ?? resolved.fallback}
        size={size}
        filled={fallbackFilled}
        className={`${fallbackClassName} ${className}`.trim()}
        style={style}
      />
    )
  }

  const a11y = label ? { 'aria-label': label } : { 'aria-hidden': true as const }
  const box: CSSProperties = { width: size, height: size, flexShrink: 0, ...style }

  if (asset.style === 'glyph') {
    const set = `image-set(${list.map((s) => `url("${s.url}") ${(s.size / size).toFixed(3)}x`).join(', ')})`
    return (
      <span
        role={label ? 'img' : undefined}
        {...a11y}
        data-plexii-icon={entity}
        data-plexii-style="glyph"
        data-plexii-src={pick(list, size * 2)}
        className={`plexii-icon plexii-icon-glyph ${className}`.trim()}
        style={{
          display: 'inline-block',
          backgroundColor: 'var(--plexii-glyph)',
          WebkitMaskImage: set,
          maskImage: set,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          ...box
        }}
      />
    )
  }

  return (
    <img
      src={pick(list, size * 2)}
      srcSet={list.map((s) => `${s.url} ${s.size}w`).join(', ')}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt={label ?? ''}
      {...(label ? {} : { 'aria-hidden': true as const })}
      draggable={false}
      decoding="async"
      data-plexii-icon={entity}
      data-plexii-style={asset.style}
      onError={() => setFailed(entity)}
      className={`plexii-icon ${className}`.trim()}
      style={{
        objectFit: 'contain',
        display: 'inline-block',
        ...(asset.style === 'logo' ? { borderRadius: 'var(--plexii-logo-radius)' } : null),
        ...box
      }}
    />
  )
}

/**
 * A dashboard tile's icon well (44px). An entity with a Plexii asset wears it
 * bare — the asset is already its own coloured tile, and a tinted chip behind
 * it would be a border around a border. Without one, the existing tinted chip
 * and glyph, exactly as before.
 */
export function PlexiiTileIcon({
  kind,
  id,
  fallback,
  tone = '',
  size = 40
}: {
  kind: PlexiiIconKind
  id: string
  fallback: string
  /** Tailwind text-* tone for the fallback chip. */
  tone?: string
  size?: number
}): JSX.Element {
  if (resolveEntityIcon(kind, id).asset) {
    return (
      <span className="inline-flex items-center justify-center w-11 h-11 shrink-0">
        <PlexiiIcon kind={kind} id={id} size={size} fallback={fallback} />
      </span>
    )
  }
  return (
    <span
      className={`inline-flex items-center justify-center w-11 h-11 rounded-xl shrink-0 ${tone}`}
      style={{ background: 'color-mix(in srgb, currentColor 12%, transparent)' }}
    >
      <Icon name={fallback} size={22} />
    </span>
  )
}
