// The shared office shell (spec: /private/tmp/claude-501/office-shell/SPEC.md).
export { default as ToolRail, railSlots, railTooltip, type RailItem, type RailKind, type ToolRailProps } from './ToolRail'
export { default as ContextBar, visibleTabs, resolveActiveTab, type BarTab, type ContextBarProps, type ContextBarHandle } from './ContextBar'
export { default as ShellPanel, type ShellPanelProps } from './ShellPanel'
export { default as OfficeShellLayout, useShellSize, type OfficeShellLayoutProps } from './OfficeShellLayout'
export * from './primitives'
export * from './layout'
