import Icon from '../Icon'
import { useViewStore } from '../../stores/view'
import { productByKey, STATUS_LABEL } from '@shared/plexiSuite'
import UpvoteButton from './UpvoteButton'
import { launchProduct } from './PlexiSuiteHome'
import { PLEXI_CARD } from '../plexi'

// A product's own home page, generated from the shared catalog so every product
// has a real page from one source of truth. Live products lead with an Open
// action; coming-soon and planned products lead with the upvote and the list of
// what is being built, and record the voter so we can notify them at test time.

export default function ProductHome({ productKey }: { productKey: string }): JSX.Element {
  const goSuite = useViewStore((s) => s.goSuite)
  const product = productByKey(productKey)

  if (!product) {
    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center"
        style={{ background: 'var(--surface-base)', color: 'var(--ink-70)' }}
      >
        <Icon name="help" size={28} />
        <p className="mt-2 text-[13px]">That product is not in the catalog.</p>
        <button onClick={goSuite} className="mt-3 text-[13px] text-indigo-500 hover:underline">
          Back to PlexiiSuite
        </button>
      </div>
    )
  }

  const ready = product.status === 'ready'

  return (
    <div
      className="h-full w-full overflow-auto"
      style={{ background: 'var(--surface-base)' }}
      data-testid={`product-home-${product.key}`}
    >
      <div className="mx-auto max-w-[920px] px-6 py-7">
        <button
          onClick={goSuite}
          className="inline-flex items-center gap-1 text-[12px] text-[var(--ink-70)] hover:text-[var(--ink-100)] mb-5"
        >
          <Icon name="arrow_back" size={14} /> PlexiiSuite
        </button>

        {/* Hero */}
        <div
          className="rounded-2xl border p-6 mb-6"
          style={{
            borderColor: `${product.accent}33`,
            background: `linear-gradient(135deg, ${product.accent}14, transparent 70%)`
          }}
        >
          <div className="flex items-start gap-4">
            <span
              className="shrink-0 inline-flex h-16 w-16 items-center justify-center rounded-2xl"
              style={{ backgroundColor: `${product.accent}24`, color: product.accent }}
            >
              <Icon name={product.icon} size={32} filled />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[24px] font-bold tracking-tight text-[var(--ink-100)]">{product.name}</h1>
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                    product.status === 'ready'
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : product.status === 'soon'
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-[var(--ink-50)]/15 text-[var(--ink-50)]'
                  }`}
                >
                  {STATUS_LABEL[product.status]}
                </span>
              </div>
              <p className="mt-1 text-[15px] text-[var(--ink-90)] font-medium">{product.tagline}</p>
              <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--ink-90)]">{product.about}</p>

              <div className="mt-5 flex items-center gap-3 flex-wrap">
                {ready ? (
                  <button
                    onClick={() => launchProduct(product)}
                    data-testid={`open-${product.key}`}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white shadow-sm"
                    style={{ backgroundColor: product.accent }}
                  >
                    <Icon name="open_in_new" size={16} /> Open {product.name}
                  </button>
                ) : (
                  <>
                    <UpvoteButton featureKey={product.key} size="lg" />
                    <span className="text-[12px] text-[var(--ink-70)]">
                      We will notify you the moment it is ready to test.
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Why it wins */}
        <section className="mb-6">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--ink-70)] mb-3">
            {product.insteadOf ? `Why it beats ${product.insteadOf}` : 'Why it leads'}
          </h2>
          <div className="space-y-2">
            {product.edges.map((edge, i) => (
              <div
                key={i}
                className={`flex items-start gap-2.5 ${PLEXI_CARD} p-3`}
              >
                <Icon name="bolt" size={16} className="mt-0.5 shrink-0" style={{ color: product.accent }} filled />
                <p className="text-[13px] text-[var(--ink-90)] leading-relaxed">{edge}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Planned capabilities (coming-soon / planned) */}
        {product.planned && product.planned.length > 0 && (
          <section className="mb-6">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--ink-70)] mb-3">
              What we are building
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {product.planned.map((cap, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] px-3 py-2"
                >
                  <Icon name="schedule" size={14} className="shrink-0 text-[var(--ink-50)]" />
                  <span className="text-[12.5px] text-[var(--ink-90)]">{cap}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
