// Lazily-fetched QuickLook thumbnails for Files entries, cached across
// renders, remounts and BOTH Files surfaces (the full view and the panel
// beside your work), so scrolling, re-sorting or opening the panel never
// re-thumbnails the same file.

import { useEffect, useState } from 'react'
import type { FileEntry } from '@shared/fields'

const thumbCache = new Map<string, string | null>()

export function previewable(entry: FileEntry): boolean {
  if (entry.kind !== 'file') return false
  const m = entry.mimeType ?? ''
  return m.startsWith('image/') || m === 'application/pdf' || m.startsWith('video/')
}

export function useThumbnail(entry: FileEntry, want: boolean): string | null {
  const key = entry.id
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(key) ?? null)
  useEffect(() => {
    if (!want || !previewable(entry)) return
    if (thumbCache.has(key)) {
      setUrl(thumbCache.get(key) ?? null)
      return
    }
    let alive = true
    void window.api.files.thumbnail(entry.id, { size: 256 }).then((res) => {
      const value = res ? `data:${res.mimeType};base64,${res.base64}` : null
      thumbCache.set(key, value)
      if (alive) setUrl(value)
    })
    return () => {
      alive = false
    }
  }, [entry, key, want])
  return url
}

