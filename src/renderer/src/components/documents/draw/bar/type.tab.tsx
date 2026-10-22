// Type (contextual, one text object selected): font, size, weight, italic,
// alignment, leading and tracking. It was the inspector's Type section.

import { BarGroup, BarNumber, BarSelect, BarSep, BarToggle } from '../../../office/shell'
import { getObjects } from '@shared/draw/ops'
import type { DrawTextNode } from '@shared/draw/model'
import { GOOGLE_FONTS, familyLabel, fontFamilyValue, loadGoogleFont } from '../../../../lib/googleFonts'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { BarLabel, useEditor } from './controls'

/** The one selected text object, or null. */
export function selectedText(s: Pick<EditorState, 'doc' | 'selection'>): DrawTextNode | null {
  if (s.selection.length !== 1) return null
  const o = getObjects(s.doc, s.selection)[0]
  return o && o.type === 'text' ? o : null
}

function TypeTab({ ctx }: { ctx: EditorCtx }): JSX.Element | null {
  const s = useEditor(ctx)
  const text = selectedText(s)
  if (!text) return null
  const patch = (p: Partial<DrawTextNode>): void => ctx.run('object.textPatch', p)
  const family = familyLabel(text.fontFamily)
  const families = [...(!GOOGLE_FONTS.includes(family) && family !== 'Default' ? [family] : []), ...GOOGLE_FONTS]
  return (
    <>
      <BarGroup label="Character">
        <BarSelect
          label="Font"
          value={family}
          width={150}
          options={families.map((f) => ({ value: f, label: f }))}
          onChange={(f) => {
            loadGoogleFont(f)
            patch({ fontFamily: fontFamilyValue(f) })
          }}
          testid="draw-text-family"
        />
        <BarNumber label="Font size" value={Math.round(text.fontSize)} min={1} suffix="px" width={44} onChange={(v) => patch({ fontSize: Math.max(1, v) })} testid="draw-text-size" />
        <BarSelect
          label="Weight"
          value={String(text.fontWeight ?? 400)}
          width={64}
          options={['300', '400', '500', '600', '700', '800'].map((w) => ({ value: w, label: w }))}
          onChange={(w) => patch({ fontWeight: Number(w) })}
          testid="draw-text-weight"
        />
        <BarToggle icon="format_italic" label="Italic" pressed={!!text.italic} onChange={(v) => patch({ italic: v })} testid="draw-text-italic" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Paragraph">
        {(['left', 'center', 'right'] as const).map((a) => (
          <BarToggle key={a} icon={`format_align_${a}`} label={`Align ${a}`} pressed={(text.align ?? 'left') === a} onChange={() => patch({ align: a })} testid={`draw-text-align-${a}`} />
        ))}
        <BarLabel>Leading</BarLabel>
        <BarNumber label="Leading (line height)" value={text.lineHeight ?? 1.2} min={0.5} step={0.05} width={44} onChange={(v) => patch({ lineHeight: Math.max(0.5, v) })} testid="draw-text-leading" />
        <BarLabel>Tracking</BarLabel>
        <BarNumber label="Tracking (letter spacing)" value={text.letterSpacing ?? 0} step={0.5} suffix="px" width={44} onChange={(v) => patch({ letterSpacing: v })} testid="draw-text-tracking" />
      </BarGroup>
    </>
  )
}

const type: DrawBarTab = { id: 'type', label: 'Type', order: 100, when: (s) => selectedText(s) !== null, component: TypeTab }

export default type
