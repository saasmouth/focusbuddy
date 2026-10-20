import Icon from './Icon'
import { logoForUrl } from '../lib/appLogos'
import { useSiteIcon } from '../lib/siteIcon'

// The one way to render a Connected App's icon. Fallback chain:
//   1. iconPngBase64 — real macOS app icon captured at create-time (local apps)
//   2. bundled catalog logo matched by URL — real brand logo, offline, crisp
//   3. the site's own icon for custom web apps, fetched from that site and
//      cached locally (lib/siteIcon → main/siteIcons.ts); no third party sees it
//   4. the original tinted Material Symbols tile, so nothing ever renders blank
interface AppLike {
  url?: string | null
  icon?: string | null
  color?: string | null
  iconPngBase64?: string | null
  kind?: 'web' | 'local'
}

interface Props {
  app: AppLike
  /** Outer square in px (the img/tile edge). */
  size: number
  /** Glyph size inside the fallback tile; defaults to ~60% of size. */
  glyphSize?: number
  className?: string
}

export default function AppLogo({ app, size, glyphSize, className = '' }: Props): JSX.Element {
  const bundled = logoForUrl(app.url)
  // Hooks before any early return. Only a custom web app with no bundled logo
  // asks for its site's icon; built-in apps never fetch anything.
  const favicon = useSiteIcon(
    !app.iconPngBase64 && !bundled && app.kind !== 'local' && app.url ? app.url : null
  )

  const box = { width: size, height: size }
  const imgClass = `rounded shrink-0 object-contain ${className}`

  if (app.iconPngBase64) {
    return (
      <img
        src={`data:image/png;base64,${app.iconPngBase64}`}
        alt=""
        style={box}
        className={imgClass}
        draggable={false}
      />
    )
  }

  if (bundled) {
    return <img src={bundled} alt="" style={box} className={imgClass} draggable={false} />
  }

  if (favicon) {
    return <img src={favicon} alt="" style={box} className={imgClass} draggable={false} />
  }

  return (
    <span
      className={`rounded inline-flex items-center justify-center shrink-0 ${className}`}
      style={{
        ...box,
        ...(app.color
          ? { backgroundColor: `${app.color}1a`, color: app.color }
          : {
              backgroundColor: 'rgb(var(--accent) / 0.12)',
              color: 'rgb(var(--accent))'
            })
      }}
    >
      <Icon name={app.icon || 'apps'} size={glyphSize ?? Math.round(size * 0.6)} />
    </span>
  )
}
