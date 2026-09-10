// The largest file whose BYTES will travel.
//
// The server refuses an upload above this (MAX_LIVE_FILE_BYTES in
// focusbuddy-signal/src/server.ts, enforced with a 413). Until now the client
// had no idea the limit existed: an oversized file sat in the Drive looking
// exactly like every other file, synced its metadata row, and then appeared on
// another device as something that could never be opened. Nothing anywhere said
// why, and there was nothing to look at that would have told you.
//
// One real Drive had 4,951 MB across three such files -- an editor installer
// and two copies of the same recording -- against 233 MB of everything that
// actually syncs. The number was not the problem; the silence was.
export const MAX_SYNCED_FILE_BYTES = 50 * 1024 * 1024

/** True when this file's bytes are too large to leave the device. */
export function exceedsSyncLimit(sizeBytes: number | null | undefined): boolean {
  return (sizeBytes ?? 0) > MAX_SYNCED_FILE_BYTES
}

/** Human-readable cap, for telling someone why their file stayed put. */
export function syncLimitLabel(): string {
  return `${Math.round(MAX_SYNCED_FILE_BYTES / (1024 * 1024))} MB`
}
