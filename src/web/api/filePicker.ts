// The browser's file picker.
//
// The desktop opens a native dialog from the main process and ingests from the
// path it returns. A tab is never given a path, so `files:pickAndIngest` is not
// served by the Worker at all — which left the File widget's "Choose file…"
// button calling a channel that refused, with the rejection dropped on the
// floor. The button did nothing, silently, and dropping a file was the only way
// to attach one.
//
// The shape the Worker's Drive notes already prescribe: a tab gets a File from
// a picker or a drop and reads the bytes itself, then hands them to
// `files:ingestBuffer` — the same ingest the drop path has always used, so a
// file attached by either route is identical once stored.

import type { FbFile } from '@shared/fields'

/** Open the browser's file chooser and resolve with what was picked. */
function chooseFiles(opts: { multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    // No `accept`: every kind of file is attachable, as on the desktop, whose
    // dialog is opened with no filters.
    if (opts.multiple) input.multiple = true
    // Safari and Firefox only fire `change` for an input that is in the
    // document; it is removed again as soon as the choice is made.
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    document.body.appendChild(input)

    let settled = false
    const finish = (files: File[]): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    // `cancel` fires when the chooser is dismissed. Where it is unsupported the
    // promise simply never settles, which is why the caller must treat an empty
    // result and a never-resolving pick the same way: nothing was attached.
    input.addEventListener('cancel', () => finish([]))
    input.click()
  })
}

type IngestBuffer = (input: {
  buffer: ArrayBuffer
  originalName: string
  mimeType: string
  parentId?: string | null
}) => Promise<FbFile>

/** Read one File and store it through the Drive's ordinary ingest. */
async function ingest(file: File, ingestBuffer: IngestBuffer, parentId: string | null): Promise<FbFile> {
  return ingestBuffer({
    buffer: await file.arrayBuffer(),
    // A picked file always has a name; a type is best-effort, and the same
    // octet-stream fallback the drop path uses keeps the two identical.
    originalName: file.name,
    mimeType: file.type || 'application/octet-stream',
    parentId
  })
}

/** `files.pickAndIngest` for the browser. Null means nothing was chosen. */
export async function pickAndIngest(
  ingestBuffer: IngestBuffer,
  opts?: { parentId?: string | null }
): Promise<FbFile | null> {
  const [file] = await chooseFiles()
  if (!file) return null
  return ingest(file, ingestBuffer, opts?.parentId ?? null)
}

/** `fileManager.pickFiles` for the browser: multi-select into a folder. */
export async function pickFilesIntoFolder(
  ingestBuffer: IngestBuffer,
  parentId: string | null
): Promise<FbFile[]> {
  const files = await chooseFiles({ multiple: true })
  const out: FbFile[] = []
  for (const file of files) {
    // One unreadable file must not lose the rest of the selection.
    try {
      out.push(await ingest(file, ingestBuffer, parentId))
    } catch (err) {
      console.error('[files:pick] could not ingest', file.name, err)
    }
  }
  return out
}
