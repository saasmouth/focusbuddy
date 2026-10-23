// The per-kind minimum sizes live in @shared/widgetSizing so the main process
// can store every widget at the size its frame renders (createWidget and
// updateWidget clamp to them). Re-exported here for the renderer's callers.
export * from '@shared/widgetSizing'
