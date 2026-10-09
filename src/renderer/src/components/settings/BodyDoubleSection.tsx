import Icon from '../Icon'
import { MODE_META, MODE_ORDER, useDefaultBodyDoubleMode } from '../../lib/bodyDoubleModes'

// Where the body-double preference lives.
//
// Before this, the mode was picked inside the Find-a-partner dialog and reset
// to Silent every time it opened, so there was no answer to "where do I
// configure how I want to pair". Choosing here sets the default every session
// starts on; the dialog still lets you change it for one session, and that
// choice updates this default too.

export default function BodyDoubleSection(): JSX.Element {
  const [mode, setMode] = useDefaultBodyDoubleMode()

  return (
    <section className="space-y-3" data-testid="settings-body-double">
      <div>
        <h3 className="text-[13px] font-semibold text-[var(--ink-80)]">Body double</h3>
        <p className="text-[12px] text-[var(--ink-50)] mt-0.5">
          Pair with another member who is also working, so you are not working alone. You are
          introduced by a made-up handle like “FocusedFalcon” — never your name or email — and you
          are only ever matched with someone who chose the same mode as you.
        </p>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--ink-45,var(--ink-50))] mb-1.5">
          How you want to pair
        </div>
        <div className="space-y-1.5" role="radiogroup" aria-label="Default body double mode">
          {MODE_ORDER.map((m) => {
            const meta = MODE_META[m]
            const active = mode === m
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setMode(m)}
                data-testid={`settings-body-double-mode-${m}`}
                className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-[var(--radius-row)] border text-left transition-colors ${
                  active
                    ? 'border-accent bg-accent/5'
                    : 'border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <Icon
                  name={meta.icon}
                  size={16}
                  className={`mt-0.5 shrink-0 ${active ? 'text-accent' : 'text-[var(--ink-50)]'}`}
                />
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-[var(--ink-80)]">
                    {meta.label}
                  </span>
                  <span className="block text-[11.5px] text-[var(--ink-50)]">{meta.tagline}</span>
                </span>
                {active && <Icon name="check" size={14} className="ml-auto mt-0.5 text-accent shrink-0" />}
              </button>
            )
          })}
        </div>
      </div>

      <p className="text-[11.5px] text-[var(--ink-45,var(--ink-50))]">
        The camera is on in every mode — seeing someone else at their desk is the point of it — and
        either of you can turn yours off at any time. Start a session from the{' '}
        <Icon name="diversity_3" size={12} className="inline align-text-bottom" /> button in the
        header, or press ⌘K and search for “body double”.
      </p>
    </section>
  )
}
