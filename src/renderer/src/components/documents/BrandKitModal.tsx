import { useState } from 'react'
import { useBrandStore } from '../../stores/brand'
import { brandContrastWarnings, type OrgBrandKit } from '@shared/brandKit'
import { GOOGLE_FONTS, loadGoogleFont, fontFamilyValue, familyLabel } from '../../lib/googleFonts'
import Icon from '../Icon'

// The Brand Kit editor — set the organization's logo, colors and fonts once and
// every surface that reads the brand store presents consistently. Contrast is
// checked live so a brand can't quietly produce unreadable text.

export default function BrandKitModal({ onClose }: { onClose: () => void }): JSX.Element {
  const kit = useBrandStore((s) => s.kit)
  const save = useBrandStore((s) => s.save)
  const [draft, setDraft] = useState<OrgBrandKit>(kit)
  const [saving, setSaving] = useState(false)
  const warnings = brandContrastWarnings(draft)

  function set<K extends keyof OrgBrandKit>(key: K, value: OrgBrandKit[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function pickLogo(): Promise<void> {
    const res = await window.api.office.pickImage()
    if (res.ok && res.dataUrl) set('logoUrl', res.dataUrl)
  }

  async function onSave(): Promise<void> {
    setSaving(true)
    try {
      await save(draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fb-scrim fixed inset-0 z-[200] flex items-center justify-center" onClick={onClose}>
      <div
        className="fb-card fb-press w-[460px] max-h-[88vh] overflow-auto p-5"
        onClick={(e) => e.stopPropagation()}
        data-testid="brand-kit-modal"
      >
        <div className="flex items-center gap-2 mb-3">
          <Icon name="palette" size={18} className="text-accent" />
          <h2 className="text-[15px] font-semibold text-[var(--ink-100)]">Brand kit</h2>
          <button onClick={onClose} className="ml-auto text-[var(--ink-40)] hover:text-[var(--ink-70)]">
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="text-[12px] text-[var(--ink-50)] mb-4">
          Set your logo, colors and fonts once. PlexiiDesign and other surfaces use them so everything looks like you.
        </p>

        {/* Logo */}
        <div className="mb-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--ink-40)] mb-1.5">Logo</div>
          <div className="flex items-center gap-3">
            <div className="w-16 h-16 rounded-lg flex items-center justify-center overflow-hidden bg-[var(--surface-sunken)]">
              {draft.logoUrl ? (
                <img src={draft.logoUrl} alt="Logo" className="max-w-full max-h-full object-contain" data-testid="brand-logo-preview" />
              ) : (
                <Icon name="image" size={20} className="text-[var(--ink-30)]" />
              )}
            </div>
            <button onClick={() => void pickLogo()} data-testid="brand-pick-logo" className="fb-btn-surface text-[12px] px-2.5 py-1.5 hover:border-accent">
              {draft.logoUrl ? 'Replace' : 'Upload'}
            </button>
            {draft.logoUrl && (
              <button onClick={() => set('logoUrl', undefined)} className="text-[12px] px-2.5 py-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-950">
                Remove
              </button>
            )}
          </div>
        </div>

        {/* Colors */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <ColorField label="Primary color" value={draft.colorPrimary} onChange={(c) => set('colorPrimary', c)} testid="brand-primary" />
          <ColorField label="Secondary color" value={draft.colorSecondary ?? '#0d9488'} onChange={(c) => set('colorSecondary', c)} testid="brand-secondary" />
        </div>

        {/* Fonts */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <FontField label="Heading font" value={draft.fontHeading} onChange={(f) => set('fontHeading', f)} testid="brand-font-heading" />
          <FontField label="Body font" value={draft.fontBody} onChange={(f) => set('fontBody', f)} testid="brand-font-body" />
        </div>

        {warnings.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-2.5" data-testid="brand-warnings">
            {warnings.map((w, i) => (
              <div key={i} className="text-[11.5px] text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                <Icon name="warning" size={13} className="mt-0.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="fb-btn-surface text-[13px] px-3 py-1.5 hover:bg-[var(--surface-sunken)]">
            Cancel
          </button>
          <button onClick={() => void onSave()} disabled={saving} data-testid="brand-save" className="btn-primary text-[13px] px-4 py-1.5 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save brand'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ColorField({ label, value, onChange, testid }: { label: string; value: string; onChange: (c: string) => void; testid: string }): JSX.Element {
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--ink-50)]">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <input type="color" value={value.startsWith('#') ? value : '#000000'} data-testid={testid} onChange={(e) => onChange(e.target.value)} className="fb-field w-9 h-8 cursor-pointer" />
        <input value={value} onChange={(e) => onChange(e.target.value)} className="fb-field flex-1 min-w-0 px-2 py-1 text-[12px] fb-tabular" />
      </div>
    </label>
  )
}

function FontField({ label, value, onChange, testid }: { label: string; value: string; onChange: (f: string) => void; testid: string }): JSX.Element {
  const current = familyLabel(value)
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--ink-50)]">{label}</span>
      <select
        value={current}
        data-testid={testid}
        onChange={(e) => {
          loadGoogleFont(e.target.value)
          onChange(fontFamilyValue(e.target.value))
        }}
        className="fb-field mt-1 w-full px-2 py-1.5 text-[12px]"
        style={{ fontFamily: value }}
      >
        {!GOOGLE_FONTS.includes(current) && current !== 'Default' && <option value={current}>{current}</option>}
        {GOOGLE_FONTS.map((fam) => (
          <option key={fam} value={fam} style={{ fontFamily: `"${fam}", sans-serif` }}>
            {fam}
          </option>
        ))}
      </select>
    </label>
  )
}
