import Icon from '../Icon'
import { useViewStore } from '../../stores/view'
import { useAccountStore } from '../../stores/account'
import { personFirstName } from '../../lib/personName'
import {
  PLEXI_GROUPS,
  PLEXI_DESK,
  productsInGroup,
  STATUS_LABEL,
  type PlexiProduct
} from '@shared/plexiSuite'
import UpvoteButton from './UpvoteButton'
import { PLEXI_CARD } from '../plexi'
import { useNodeStore } from '../../stores/nodes'
import { useViewKindEnabled } from '../../lib/viewCapability'
import HomeDashboardRegion from './HomeDashboardRegion'

// PlexiSuite home: the launcher for the whole suite. Every product reads from the
// shared catalog, so what is live, what is coming, and what is planned stay
// honest in one place. Live products open their own home page; coming-soon and
// planned ones render in lighter grey with a badge and an upvote that records who
// asked, so we can tell them when it is ready to test.

// Map a ready product's launch hint to the right destination. Anything we do not
// route directly simply opens the product's home page.
export function launchProduct(product: PlexiProduct): void {
  const v = useViewStore.getState()
  switch (product.launch) {
    // The launcher maps each product to its home inside the three-segment
    // structure: PlexiDesk (workspace), PlexiOffice (documents + comms) and
    // PlexiBrain (knowledge, automation, insights).
    case 'documents':
      return v.goOffice()
    case 'tasks':
      return v.goAllTasks()
    case 'calendar':
      return v.goCalendar()
    case 'messages':
      return v.goOffice('chat')
    case 'mail':
      return v.goOffice('mail')
    case 'files':
      return v.goFiles()
    case 'vault':
      return v.goVault()
    case 'knowledge':
      return v.goPlexiBrain('ask')
    case 'meetings':
      return v.goOffice('meet')
    case 'apps':
      return v.goPlexiBrain('connect')
    case 'forms':
      return v.goProduct(product.key)
    case 'sign':
      return v.goOffice('sign')
    case 'search':
      return v.goPlexiBrain('search')
    case 'projects':
      return v.goProjects()
    case 'reports':
      return v.goPlexiBrain('insights')
    case 'flows':
      return v.goPlexiBrain('flows')
    case 'api':
      return v.goPlexiBrain('api')
    case 'marketplace':
      return v.goMarketplace()
    case 'design':
      return v.goDesign()
    case 'draw':
      return v.goDraw()
    case 'canvas':
      return v.goHome()
    default:
      return v.goProduct(product.key)
  }
}

function greeting(): string {
  // Stable across a render without Date.now in shared code; this is renderer-only
  // so the clock is fine here.
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function ProductTile({ product }: { product: PlexiProduct }): JSX.Element {
  const goProduct = useViewStore((s) => s.goProduct)
  const ready = product.status === 'ready'

  return (
    // PLX-A11Y-001: this card was a single <button> wrapping the UpvoteButton
    // for not-ready products — a button nested inside a button, which axe's
    // nested-interactive check (correctly) flags because nested interactive
    // controls aren't reliably announced by assistive tech. Same fix as the
    // PlexiDesk hero below: the outer element is a plain container, the
    // navigate action is its own <button>, and the upvote control is a
    // sibling rather than a descendant.
    <div
      className={`group relative rounded-xl border p-3 transition-all ${
        ready
          ? `${PLEXI_CARD} fb-lift`
          : 'border-[color-mix(in_oklab,var(--edge-soft)_50%,transparent)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]'
      }`}
    >
      <button
        onClick={() => goProduct(product.key)}
        data-testid={`product-tile-${product.key}`}
        className="w-full text-left"
      >
        <div className="flex items-start gap-2.5">
          <span
            className={`shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-lg ${ready ? '' : 'opacity-50 grayscale'}`}
            // Calm, unified icon treatment: a neutral glyph on a quiet accent-tinted
            // chip, so each product keeps a whisper of its colour without the whole
            // grid reading as a saturated rainbow.
            style={{ backgroundColor: `${product.accent}26`, color: 'var(--ink-90)' }}
          >
            <Icon name={product.icon} size={18} filled />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span
                className={`text-[13px] font-semibold truncate ${
                  ready ? 'text-[var(--ink-100)]' : 'text-[var(--ink-50)]'
                }`}
              >
                {product.name}
              </span>
              {!ready && (
                <span
                  className={`shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
                    product.status === 'soon'
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : 'bg-[var(--ink-50)]/15 text-[var(--ink-50)]'
                  }`}
                >
                  {STATUS_LABEL[product.status]}
                </span>
              )}
            </div>
            <p
              className={`mt-0.5 text-[11px] leading-snug line-clamp-2 min-h-[2.75em] ${
                ready ? 'text-[var(--ink-70)]' : 'text-[var(--ink-50)]/70'
              }`}
            >
              {product.tagline}
            </p>
          </div>
        </div>
      </button>
      {!ready && (
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[10px] text-[var(--ink-50)]">Upvote to prioritise</span>
          <UpvoteButton featureKey={product.key} />
        </div>
      )}
    </div>
  )
}

// PLX-A11Y-001: every group heading below is set in its own brand hue, but
// the vivid PLEXI_GROUPS accents used for icon fills/badges/glows don't clear
// WCAG AA 4.5:1 as TEXT against --surface-base. These are same-hue, darkened
// (light theme) / lightened (dark themes) text-only variants defined once in
// tokens.css — the accent itself is untouched everywhere else it's used.
const GROUP_HEADING_INK: Record<string, string> = {
  office: 'var(--brand-office-ink)',
  work: 'var(--brand-work-ink)',
  ai: 'var(--brand-ai-ink)',
  data: 'var(--brand-data-ink)',
  build: 'var(--brand-build-ink)',
  connect: 'var(--brand-connect-ink)',
  ops: 'var(--brand-ops-ink)'
}

function GroupSection({ groupKey }: { groupKey: string }): JSX.Element | null {
  const group = PLEXI_GROUPS.find((g) => g.key === groupKey)
  if (!group) return null
  const products = productsInGroup(groupKey)
  if (products.length === 0) return null

  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <h2
          className="text-[15px] font-bold tracking-tight"
          style={{ color: GROUP_HEADING_INK[group.key] ?? group.accent }}
        >
          {group.name}
        </h2>
        <span className="text-[12px] text-[var(--ink-70)]">{group.tagline}</span>
      </div>
      <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {products.map((p) => (
          <ProductTile key={p.key} product={p} />
        ))}
      </div>
    </section>
  )
}

export default function PlexiSuiteHome(): JSX.Element {
  const account = useAccountStore((s) => s.account)
  const goProduct = useViewStore((s) => s.goProduct)
  const v = useViewStore()
  const createNode = useNodeStore((s) => s.create)
  const setActive = useNodeStore((s) => s.setActive)
  const name = account ? personFirstName(account, '') : ''
  const viewEnabled = useViewKindEnabled()

  async function newDesk(): Promise<void> {
    const desk = await createNode({ parentId: null, kind: 'task', title: 'New desk' })
    setActive(desk.id)
    v.goTask(desk.id)
  }

  // Calendar is dropped from the quick actions when time_blocking is off, so the
  // launcher never offers a jump into a locked surface. The rest are core.
  const quickActions: { icon: string; label: string; onClick: () => void }[] = [
    { icon: 'dashboard', label: 'Open my desk', onClick: () => v.goHome() },
    { icon: 'add', label: 'New desk', onClick: () => void newDesk() },
    { icon: 'plexii:templates', label: 'Templates', onClick: () => v.goMarketplace() },
    { icon: 'check_circle', label: 'All tasks', onClick: () => v.goAllTasks() },
    ...(viewEnabled('calendar')
      ? [{ icon: 'calendar_today', label: 'Calendar', onClick: () => v.goCalendar() }]
      : [])
  ]

  return (
    <div
      className="h-full w-full overflow-auto"
      style={{ background: 'var(--surface-base)' }}
      data-testid="plexisuite-home"
    >
      <div className="mx-auto max-w-[1280px] px-6 py-7">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <h1 className="text-[26px] font-bold tracking-tight text-[var(--ink-100)] fb-display-hero">PlexiSuite</h1>
            {name && <span className="text-[15px] text-[var(--ink-70)]">· {greeting()}, {name}</span>}
          </div>
          <p className="mt-1 text-[14px] text-[var(--ink-70)]">
            Everything your team needs to create, run, and grow. One connected workspace, built to leave Microsoft and
            Google behind.
          </p>
        </div>

        {/* Global search: opens PlexiSearch over the whole workspace */}
        <button
          onClick={() => v.goSearch()}
          data-testid="suite-search-bar"
          className="fb-btn-surface w-full flex items-center gap-3 h-12 px-4 hover:border-[rgb(var(--accent)/0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent)/0.40)] transition-colors mb-5 group"
        >
          <Icon name="search" size={18} className="text-[var(--ink-50)] group-hover:text-accent transition-colors" />
          <span className="flex-1 text-left text-[14px] text-[var(--ink-50)]">Search anything in Plexii</span>
          <span className="shrink-0 hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--surface-sunken)] text-[11px] text-[var(--ink-50)] fb-tabular">
            ⌘K
          </span>
        </button>

        {/* PlexiDesk hero */}
        <div className="relative rounded-2xl border border-indigo-300/30 dark:border-indigo-400/20 bg-gradient-to-br from-indigo-500/10 via-violet-500/[0.06] to-transparent p-5 mb-7 overflow-hidden">
          <button
            onClick={() => goProduct(PLEXI_DESK.key)}
            data-testid="hero-plexidesk"
            className="group w-full text-left"
          >
            <div className="flex items-center gap-4">
              <span
                className="shrink-0 inline-flex h-14 w-14 items-center justify-center rounded-2xl"
                style={{ backgroundColor: `${PLEXI_DESK.accent}24`, color: PLEXI_DESK.accent }}
              >
                <Icon name={PLEXI_DESK.icon} size={28} filled />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-[19px] font-bold text-[var(--ink-100)]">PlexiDesk</h2>
                  <span className="text-[12px] text-emerald-600 dark:text-emerald-400 font-medium">{PLEXI_DESK.tagline}</span>
                </div>
                <p className="mt-1 text-[13px] text-[var(--ink-90)] max-w-2xl leading-relaxed">
                  {PLEXI_DESK.about}
                </p>
              </div>
              <span className="shrink-0 hidden sm:inline-flex items-center gap-1 text-[13px] font-semibold text-indigo-600 dark:text-indigo-300 group-hover:gap-2 transition-all">
                Explore <Icon name="arrow_forward" size={16} />
              </span>
            </div>
          </button>
          {/* Quick actions, siblings of the hero button to keep interactives un-nested */}
          <div className="mt-3.5 flex flex-wrap items-center gap-2" data-testid="hero-quick-actions">
            {quickActions.map((a) => (
              <button
                key={a.label}
                onClick={a.onClick}
                data-testid={`hero-action-${a.label.toLowerCase().replace(/\s+/g, '-')}`}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-indigo-300/30 dark:border-indigo-400/20 bg-white/40 dark:bg-white/[0.06] hover:bg-white/60 dark:hover:bg-white/10 text-[12px] font-medium text-[var(--ink-90)] hover:text-[var(--ink-100)] transition-colors"
              >
                <Icon name={a.icon} size={14} /> {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* Product groups */}
        <div className="space-y-7">
          {PLEXI_GROUPS.map((g) => (
            <GroupSection key={g.key} groupKey={g.key} />
          ))}
        </div>

        <p className="mt-8 text-center text-[12px] text-[var(--ink-50)]">
          Greyed products are on the way. Upvote the ones you want first, and we will tell you the moment they are ready
          to test.
        </p>

        {/* Live dashboard: your real upcoming, tasks, desks, documents and team */}
        <HomeDashboardRegion />
      </div>
    </div>
  )
}
