// Renders a sheet chart by resolving its range against the live tab (through the
// formula engine, so it plots REAL computed values) and drawing it with the
// shared PlexiChart core — the same renderer PlexiSlides uses, so a chart looks
// identical wherever it lives. Bar, line, area, pie and scatter are supported.

import type { SheetChartSpec, SheetTab } from '@shared/types'
import type { ChartCore } from '@shared/chart'
import { buildChartData } from '../../../lib/chartData'
import PlexiChart from '../../charts/PlexiChart'
import Icon from '../../Icon'

interface Props {
  spec: SheetChartSpec
  tab: SheetTab
  onRemove: () => void
}

export default function SheetChart({ spec, tab, onRemove }: Props): JSX.Element {
  const chart: ChartCore = {
    type: spec.type,
    title: spec.title,
    data: buildChartData({ range: spec.range, headerRow: spec.headerRow, headerCol: spec.headerCol }, tab),
    stacked: spec.stacked
  }

  return (
    // data-chart-id: Print… snapshots this chart's drawing (lib/sheetPrintModel.ts).
    <div className="fb-card p-3" data-testid="sheet-chart" data-chart-id={spec.id}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-semibold text-[var(--ink-70)]">
          {spec.title || `${spec.type[0].toUpperCase()}${spec.type.slice(1)} chart`}
        </span>
        <button onClick={onRemove} className="icon-btn" title="Remove chart">
          <Icon name="close" size={13} />
        </button>
      </div>
      <PlexiChart chart={chart} height={220} />
    </div>
  )
}
