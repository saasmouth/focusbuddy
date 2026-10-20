// "Answered by: Local (Qwen3 4B)" — the engine that produced the latest AI
// result for a feature, shown on the surface that result appears in. With
// several engines in play (on-device, your Anthropic or OpenAI key, Plexii AI
// credits), the person can always see which one wrote what they are reading.
import type { AiFeature } from '@shared/localAi'
import { useAnsweredBy } from '../../lib/localAiEngine'

export default function AnsweredBy({ feature, since = 0, className = '' }: { feature: AiFeature; since?: number; className?: string }): JSX.Element | null {
  const a = useAnsweredBy(feature, since)
  if (!a) return null
  return (
    <div className={`fb-t-caption text-[var(--ink-50)] ${className}`} data-testid={`answered-by-${feature}`} data-engine={a.engine}>
      Answered by: {a.label}
    </div>
  )
}
