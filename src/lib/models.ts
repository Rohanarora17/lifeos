/**
 * Centralized Gemini model configuration for LifeOS.
 *
 * Model assignment strategy:
 *   PRO   (gemini-3.1-pro-preview)   — Deep thinking, analysis, summaries, reports.
 *                                       Higher latency but better reasoning.
 *   FLASH (gemini-3-flash-preview)   — Real-time decisions, classification, nudges.
 *                                       Lower latency, optimised for speed.
 */

/** Deep thinking model — for summaries, reports, behavioral analysis, chat */
export const MODEL_PRO = 'gemini-3.1-pro-preview';

/** Fast model — for classification, nudges, real-time evaluation */
export const MODEL_FLASH = 'gemini-3-flash-preview';
