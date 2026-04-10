/**
 * Centralized Gemini model configuration for LifeOS.
 *
 * Model assignment strategy:
 *   THINKING (gemini-2.5-pro-preview-03-25) — Reasoning / intent-parsing / deep analysis.
 *   PRO      (gemini-3.1-pro-preview)        — Long-form synthesis, reports, behavioral analysis.
 *   FLASH    (gemini-3-flash-preview)         — Real-time classification, nudges.
 */

/** Reasoning model — latest, for voice intent parsing, tutor, deep analysis */
export const MODEL_THINKING = 'gemini-2.5-pro-preview-03-25';

/** Deep synthesis model — for summaries, reports, behavioral analysis */
export const MODEL_PRO = 'gemini-3.1-pro-preview';

/** Fast model — for classification, nudges, real-time evaluation */
export const MODEL_FLASH = 'gemini-3-flash-preview';
