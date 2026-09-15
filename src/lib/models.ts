/**
 * Centralized Gemini model configuration for LifeOS.
 *
 * Model assignment strategy:
 *   PRO      (gemini-3.1-pro-preview) — Planning, reasoning, and deep analysis.
 * Callers declare capability intent with these constants. ai-execution-policy.ts
 * owns the actual per-feature model, reasoning level, timeout, and output cap.
 *   VOICE    (gemini-live-2.5-flash) — Live Guardian conversations.
 */

/** Reasoning model — latest, for voice intent parsing, tutor, deep analysis */
export const MODEL_THINKING = 'gemini-3.1-pro-preview';

/** Deep synthesis model — for summaries, reports, behavioral analysis */
export const MODEL_PRO = 'gemini-3.1-pro-preview';

/** Capability marker for multimodal calls; the unified policy routes the request. */
export const MODEL_VISION = MODEL_PRO;

/** Low-latency model — activity classification and distraction nudges only */
export const MODEL_REALTIME_ACTIVITY = 'gemini-3.1-flash-lite';

/** Native-audio Live API model — real-time Guardian voice conversations */
export const MODEL_VOICE = 'gemini-live-2.5-flash';
