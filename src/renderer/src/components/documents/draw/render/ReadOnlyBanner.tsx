import Icon from '../../../Icon'
import type { DrawCompatibility } from '@shared/draw'

/**
 * The honest notice a read-only drawing carries. It says what happened and
 * what to do, and promises only what is true: nothing here will be saved, and
 * the parts this build cannot show are kept, untouched, in the file.
 */
export default function ReadOnlyBanner({ compat }: { compat: DrawCompatibility }): JSX.Element {
  const details: string[] = []
  if (compat.reasons.includes('newer-schema')) details.push(`It was saved in a newer file format (version ${Math.max(compat.schemaVersion, compat.minWriterVersion)}).`)
  if (compat.reasons.includes('unknown-objects'))
    details.push(
      `${compat.unknownCount} object${compat.unknownCount === 1 ? '' : 's'} (${compat.unknownTypes.join(', ')}) can't be shown here; they are kept in the file untouched.`
    )
  if (compat.reasons.includes('unknown-layers')) details.push('Some layers are of a kind this version cannot show.')
  return (
    <div
      role="status"
      data-testid="draw-readonly-banner"
      className="shrink-0 flex items-start gap-2 px-3 py-1.5 border-b border-amber-300/60 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200 text-[12px]"
    >
      <Icon name="lock" size={14} className="mt-[1px] shrink-0" />
      <span>
        <strong>Made in a newer PlexiiDraw — update to edit.</strong> This copy is read-only, so nothing you do here is saved. {details.join(' ')}
      </span>
    </div>
  )
}
