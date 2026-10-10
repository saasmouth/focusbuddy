import Icon from '../Icon'
import { useViewStore } from '../../stores/view'
import { useViewKindEnabled } from '../../lib/viewCapability'

// The vault's home in Settings.
//
// It used to be a sidebar row, which put a credential store in the same list
// as the places you browse — Rooms, Desks, Files. It is not a place you visit
// on the way to work; it is something you set up once and then rely on. So the
// sidebar no longer carries it and this is where it lives.
//
// The vault itself is still a full view: this opens it rather than embedding
// it, because unlocking and editing credentials needs the room.

export default function VaultSection(): JSX.Element | null {
  const goVault = useViewStore((s) => s.goVault)
  const viewEnabled = useViewKindEnabled()
  if (!viewEnabled('vault')) return null

  return (
    <section className="px-3 py-3 space-y-2" data-testid="settings-vault">
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-1">Vault</div>
      <p className="text-[12px] text-[var(--ink-50)]">
        Passwords and keys the app fills in for you, encrypted on this machine. Nothing in the
        vault is sent anywhere, and it stays locked until you unlock it.
      </p>
      <button
        onClick={() => goVault()}
        data-testid="settings-vault-open"
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[var(--edge-firm)] text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] transition-colors"
      >
        <Icon name="plexii:vault" size={13} />
        <span>Open the vault</span>
      </button>
    </section>
  )
}
