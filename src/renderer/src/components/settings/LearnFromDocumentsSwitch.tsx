import { useEffect, useState } from 'react'

// "Learn from my documents automatically" (Settings › AI › Local, 4.3.50).
// The main process's privacy pref learnFromDocuments (main/privacyPrefs.ts),
// read by the local-AI tick's memory sweep (main/ai/localAiSweeps.ts). On by
// default: it runs on the on-device model only, so nothing leaves the computer.
export default function LearnFromDocumentsSwitch(): JSX.Element {
  const [on, setOn] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    // Where the runtime has no privacy prefs (the web app), the switch stays
    // disabled rather than guessing a state.
    const read = window.api?.privacy?.getPrefs
    if (!read) return
    void read()
      .then((p) => live && setOn(p.learnFromDocuments))
      .catch(() => live && setOn(null))
    return () => {
      live = false
    }
  }, [])

  function change(next: boolean): void {
    setOn(next)
    void window.api.privacy
      .setPrefs({ learnFromDocuments: next })
      .then((p) => setOn(p.learnFromDocuments))
      .catch(() => setOn(!next))
  }

  return (
    <label className="mt-2 flex items-start gap-2.5 cursor-pointer" data-testid="learn-from-documents-row">
      <input
        type="checkbox"
        checked={on === true}
        disabled={on === null}
        onChange={(e) => change(e.target.checked)}
        data-testid="learn-from-documents"
        className="mt-0.5 h-4 w-4 accent-accent"
      />
      <span className="text-[12px] text-[var(--ink-70)] leading-relaxed">
        <span className="text-[var(--ink-90)] font-medium">Learn from my documents automatically</span>
        <span className="block">
          While PlexiiDesk is open, the on-device model reads documents it has not read yet and adds what is worth
          remembering to Memory. It runs on this computer only, and nothing is sent anywhere. Off, it learns only when you
          press Learn from my documents in Memory.
        </span>
      </span>
    </label>
  )
}
