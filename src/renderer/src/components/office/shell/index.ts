// The shared office shell (spec: docs/office-shell/SPEC.md).
export { default as ToolRail, railSlots, railTooltip, type RailItem, type RailKind, type ToolRailProps } from './ToolRail'
export { default as ContextBar, visibleTabs, resolveActiveTab, type BarTab, type ContextBarProps, type ContextBarHandle } from './ContextBar'
export { default as ShellPanel, shellPanelDomId, type ShellPanelProps } from './ShellPanel'
export { default as ShellSidePane, type SidePane, type ShellSidePaneProps } from './ShellSidePane'
export { default as OfficeShellLayout, useShellSize, type OfficeShellLayoutProps } from './OfficeShellLayout'
export * from './primitives'
export * from './layout'
