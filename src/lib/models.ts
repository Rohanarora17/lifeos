/**
 * Centralized Gemini model configuration for LifeOS.
 *
 * Model assignment strategy:
 *   PRO      (gemini-3.1-pro-preview) — Planning, reasoning, and deep analysis.
 *   VISION   (gemini-3.1-pro-preview) — Screen and multimodal interpretation.
 *   REALTIME (gemini-3.1-flash-lite)  — Activity classification and nudges only.
 *   VOICE    (gemini-live-2.5-flash) — Live Guardian conversations.
 */

/** Reasoning model — latest, for voice intent parsing, tutor, deep analysis */
export const MODEL_THINKING = 'gemini-3.1-pro-preview';

/** Deep synthesis model — for summaries, reports, behavioral analysis */
export const MODEL_PRO = 'gemini-3.1-pro-preview';

/** Strong multimodal model — screen and screenshot understanding */
export const MODEL_VISION = MODEL_PRO;

/** Low-latency model — activity classification and distraction nudges only */
export const MODEL_REALTIME_ACTIVITY = 'gemini-3.1-flash-lite';

/** Native-audio Live API model — real-time Guardian voice conversations */
export const MODEL_VOICE = 'gemini-live-2.5-flash';
