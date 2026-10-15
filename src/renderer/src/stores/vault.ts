import { create } from 'zustand'
import type {
  VaultEntryStored,
  VaultMeta,
  VaultSecret,
  VaultUnlockMethodId,
  VaultUnlockMethodInfo
} from '@shared/types'
import { hapticMedium, hapticWarning } from '../lib/haptics'

interface VaultStore {
  meta: VaultMeta | null
  unlocked: boolean
  entries: VaultEntryStored[]
  initStatus: 'idle' | 'loading' | 'ready'
  /**
   * Ways in besides the master password — Touch ID today, and whatever the
   * registry gains later. A list, not a boolean, so a new method appears here
   * without this store learning its name.
   */
  unlockMethods: VaultUnlockMethodInfo[]
  refreshUnlockMethods: () => Promise<void>
  /** Enrol a method against the live key. Requires an unlocked vault. */
  enrollUnlockMethod: (
    id: VaultUnlockMethodId
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  forgetUnlockMethod: (id: VaultUnlockMethodId) => Promise<void>
  /** Unlock via a method instead of typing the password. */
  unlockWith: (
    id: VaultUnlockMethodId
  ) => Promise<{ ok: true } | { ok: false; error: string; cancelled?: boolean }>
  refreshMeta: () => Promise<void>
  unlock: (master: string) => Promise<{ ok: true } | { ok: false; error: string }>
  createWithMaster: (
    master: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  lock: () => Promise<void>
  loadEntries: () => Promise<void>
  // Encrypt + store a credential secret
  addEntry: (input: {
    title: string
    url?: string
    username?: string
    secret: VaultSecret
  }) => Promise<VaultEntryStored | null>
  updateEntry: (
    id: string,
    input: {
      title?: string
      url?: string | null
      username?: string | null
      secret?: VaultSecret
    }
  ) => Promise<void>
  removeEntry: (id: string) => Promise<void>
  // Rotate the master password — re-encrypts the verifier and every entry under
  // the new key. Requires the current password; stays unlocked on success.
  changeMasterPassword: (
    current: string,
    next: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  // Decrypt and return the secret blob for an entry — caller holds the plaintext briefly
  reveal: (id: string) => Promise<VaultSecret | null>
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  meta: null,
  unlocked: false,
  entries: [],
  initStatus: 'idle',
  unlockMethods: [],

  refreshUnlockMethods: async () => {
    set({ unlockMethods: await window.api.vault.unlockMethods() })
  },

  enrollUnlockMethod: async (id) => {
    const res = await window.api.vault.enrollUnlockMethod(id)
    await get().refreshUnlockMethods()
    if (res.ok) hapticMedium()
    else hapticWarning()
    return res
  },

  forgetUnlockMethod: async (id) => {
    await window.api.vault.forgetUnlockMethod(id)
    await get().refreshUnlockMethods()
  },

  unlockWith: async (id) => {
    const res = await window.api.vault.unlockWithMethod(id)
    if (res.ok) {
      set({ unlocked: true })
      hapticMedium()
      await get().loadEntries()
    } else if (!res.cancelled) {
      // A cancelled Touch ID prompt is the user changing their mind, not a
      // failure to buzz about. A real failure is.
      hapticWarning()
      await get().refreshUnlockMethods()
    }
    return res
  },

  refreshMeta: async () => {
    set({ initStatus: 'loading' })
    const [meta, unlocked, methods] = await Promise.all([
      window.api.vault.meta(),
      window.api.vault.isUnlocked(),
      window.api.vault.unlockMethods()
    ])
    set({ meta, unlocked, unlockMethods: methods, initStatus: 'ready' })
    if (unlocked) await get().loadEntries()
  },
  unlock: async (master) => {
    const result = await window.api.vault.unlock(master)
    if (result.ok) {
      set({ unlocked: true })
      hapticMedium()
      await get().loadEntries()
    } else {
      hapticWarning()
    }
    return result
  },
  createWithMaster: async (master) => {
    const result = await window.api.vault.create(master)
    if (result.ok) {
      const meta = await window.api.vault.meta()
      set({ meta, unlocked: true, entries: [] })
    }
    return result
  },
  lock: async () => {
    await window.api.vault.lock()
    set({ unlocked: false, entries: [] })
  },
  loadEntries: async () => {
    const entries = await window.api.vault.listEntries()
    set({ entries })
  },
  addEntry: async (input) => {
    const enc = await window.api.vault.encrypt(JSON.stringify(input.secret))
    if (!enc) return null
    const created = await window.api.vault.createEntry({
      title: input.title,
      url: input.url ?? null,
      username: input.username ?? null,
      iv: enc.iv,
      ciphertext: enc.ciphertext
    })
    if (!created) return null
    set({ entries: [...get().entries, created] })
    return created
  },
  updateEntry: async (id, input) => {
    const patch: Parameters<typeof window.api.vault.updateEntry>[1] = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.url !== undefined) patch.url = input.url
    if (input.username !== undefined) patch.username = input.username
    if (input.secret !== undefined) {
      const enc = await window.api.vault.encrypt(JSON.stringify(input.secret))
      if (!enc) return
      patch.iv = enc.iv
      patch.ciphertext = enc.ciphertext
    }
    const updated = await window.api.vault.updateEntry(id, patch)
    if (!updated) return
    set({ entries: get().entries.map((e) => (e.id === id ? updated : e)) })
  },
  removeEntry: async (id) => {
    await window.api.vault.deleteEntry(id)
    set({ entries: get().entries.filter((e) => e.id !== id) })
  },
  changeMasterPassword: async (current, next) => {
    const result = await window.api.vault.changeMasterPassword(current, next)
    if (result.ok) {
      hapticMedium()
      // The verifier and every entry's iv/ciphertext changed in the DB, so the
      // cached meta + entries are stale — reload both under the new key.
      const meta = await window.api.vault.meta()
      set({ meta })
      await get().loadEntries()
      // Every wrapped key was of the OLD key; the main process dropped them
      // and re-enrolled under the new one, so the list may have changed.
      await get().refreshUnlockMethods()
    } else {
      hapticWarning()
    }
    return result
  },
  reveal: async (id) => {
    const entry = get().entries.find((e) => e.id === id)
    if (!entry) return null
    const plain = await window.api.vault.decrypt(entry.iv, entry.ciphertext)
    if (plain == null) return null
    try {
      return JSON.parse(plain) as VaultSecret
    } catch {
      return null
    }
  }
}))
