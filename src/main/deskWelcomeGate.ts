// The desk hello behind chat:proactiveWelcome, gated like the other background
// AI jobs (backgroundAiGate.ts).
//
// Canvas.tsx asks for it with no click: the first time each session that a
// desk is open while in progress, generateProactiveWelcome sends the desk's
// name and what is on it to the model PlexiiAssist uses. Unasked, that is
// background AI, and the privacy notes say background AI sends nothing until
// the person turns on Background AI tasks. So with the switch off, and the
// hello not written on this computer, no client is called: the answer is
// { ok: false, reason: BACKGROUND_AI_OFF } and the renderer drops it quietly.
//
// `asked: true` is the person clicking "Have AI suggest the first step" in the
// Pre-Task Bridge (PreTaskBridge.tsx). That is a request like any other AI
// button, so it is not gated. Every other caller leaves `asked` out.

import type { ChatResponse, ProactiveWelcomeOpts } from '@shared/types'
import { generateProactiveWelcome } from './ai/anthropic'
import { BACKGROUND_AI_OFF, backgroundModelAllowed } from './backgroundAiGate'

export async function proactiveWelcome(taskId: string, opts?: ProactiveWelcomeOpts): Promise<ChatResponse> {
  if (opts?.asked !== true && !backgroundModelAllowed('welcome')) {
    return { ok: false, reason: BACKGROUND_AI_OFF }
  }
  return generateProactiveWelcome(taskId)
}
