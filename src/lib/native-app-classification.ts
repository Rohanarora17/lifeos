/**
 * Native app classification for LifeOS Copilot dwell events.
 *
 * Browser activities use LLM classifyActivity (src/lib/ai.ts).
 * Native apps use deterministic rules + optional user ask during sessions.
 *
 * Shared intelligence integration:
 *  - domain_categories (native:appkey) — durable user prefs, same table as browser
 *  - mem_facts / feedback_learning — preference facts for UIL
 *  - behavioral_memory — classification_override
 *  - touchIntelligence — refresh UIL after user resolves
 *  - activities always store productive | neutral | distraction
 */

import { getDb, getSetting, setSetting } from './db';
import { sendTelegram } from './telegram';
import { touchIntelligence } from './intelligence';
import { recordExplicitFeedbackLearning } from './feedback-learning';
import { learnMemory } from './behavior';

export type ActivityCategory = 'productive' | 'neutral' | 'distraction';

export type NativeInternalCategory =
  | 'deep_work'
  | 'shallow_work'
  | 'communication'
  | 'consumption'
  | 'distraction'
  | 'idle';

export type NativeClassifyResult = {
  internal: NativeInternalCategory;
  activityCategory: ActivityCategory;
  confidence: number;
  needsUserAsk: boolean;
  reason: string;
  preferenceDomain: string;
  source: 'user_preference' | 'rules' | 'client';
};

const PENDING_ASK_KEY = 'pending_native_category_ask';
const ASK_COOLDOWN_PREFIX = 'native_ask_cooldown:';
const ASK_COOLDOWN_MS = 45 * 60_000;

function normalizeAppKey(app: string): string {
  return app
    .toLowerCase()
    .replace(/\.app$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 48) || 'unknown';
}

export function nativePreferenceDomain(app: string): string {
  return `native:${normalizeAppKey(app)}`;
}

/** Map any legacy/native internal labels into the three activity buckets. */
export function toActivityCategory(raw: string | null | undefined): ActivityCategory {
  const c = (raw || '').toLowerCase().trim();
  if (c === 'productive' || c === 'deep_work') return 'productive';
  if (c === 'distraction') return 'distraction';
  if (
    c === 'neutral' ||
    c === 'communication' ||
    c === 'consumption' ||
    c === 'shallow_work' ||
    c === 'idle' ||
    c === 'browsing'
  ) {
    return 'neutral';
  }
  return 'neutral';
}

function lookupUserPreference(app: string): { category: ActivityCategory; reasoning: string } | null {
  try {
    const domain = nativePreferenceDomain(app);
    const row = getDb().prepare(`
      SELECT category, confidence, ai_reasoning FROM domain_categories WHERE domain = ?
    `).get(domain) as { category: string; confidence: number; ai_reasoning: string | null } | undefined;
    if (!row) return null;
    const isUser =
      typeof row.ai_reasoning === 'string' &&
      (row.ai_reasoning.startsWith('user confirm') ||
        row.ai_reasoning.startsWith('user correct') ||
        row.ai_reasoning.startsWith('user native'));
    if (!isUser || Number(row.confidence) < 0.9) return null;
    return {
      category: toActivityCategory(row.category),
      reasoning: row.ai_reasoning || 'user preference',
    };
  } catch {
    return null;
  }
}

export function saveNativeAppPreference(
  app: string,
  category: ActivityCategory,
  reason = 'user native classification',
): void {
  const domain = nativePreferenceDomain(app);
  const aiReasoning = reason.startsWith('user') ? reason : `user native: ${reason}`;
  try {
    getDb().prepare(`
      INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
      VALUES (?, ?, 'native_app', 1.0, ?)
      ON CONFLICT(domain) DO UPDATE SET
        category = excluded.category,
        subcategory = 'native_app',
        confidence = 1.0,
        ai_reasoning = excluded.ai_reasoning,
        updated_at = datetime('now')
    `).run(domain, category, aiReasoning);
  } catch (err) {
    console.warn('[native-classify] save preference failed:', err);
  }
}

/** List learned native app prefs for UIL / personalization. */
export function listNativeAppPreferences(limit = 20): Array<{
  appKey: string;
  domain: string;
  category: ActivityCategory;
  reasoning: string;
}> {
  try {
    const rows = getDb().prepare(`
      SELECT domain, category, ai_reasoning
      FROM domain_categories
      WHERE domain LIKE 'native:%'
        AND confidence >= 0.9
        AND (
          ai_reasoning LIKE 'user confirm%'
          OR ai_reasoning LIKE 'user correct%'
          OR ai_reasoning LIKE 'user native%'
        )
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ domain: string; category: string; ai_reasoning: string | null }>;
    return rows.map((row) => ({
      appKey: row.domain.replace(/^native:/, ''),
      domain: row.domain,
      category: toActivityCategory(row.category),
      reasoning: row.ai_reasoning || '',
    }));
  } catch {
    return [];
  }
}

function ruleClassify(app: string, title: string): {
  internal: NativeInternalCategory;
  activityCategory: ActivityCategory;
  confidence: number;
  /** Eligible for ask during an active focus session */
  sessionAmbiguous: boolean;
  reason: string;
} {
  const appLower = app.toLowerCase();
  const titleLower = title.toLowerCase();

  const deepWork = [
    'cursor', 'code', 'visual studio', 'xcode', 'intellij', 'pycharm', 'webstorm',
    'terminal', 'iterm', 'warp', 'zed', 'sublime',
    'preview', 'zotero', 'skim', 'books', 'obsidian', 'notion', 'anki',
  ];
  if (deepWork.some((t) => appLower.includes(t))) {
    return {
      internal: 'deep_work',
      activityCategory: 'productive',
      confidence: 0.85,
      sessionAmbiguous: false,
      reason: 'known deep-work / study tool',
    };
  }

  // Communication: ambiguous during study (could be coordination or distraction)
  const communication = [
    'whatsapp', 'facetime', 'messages', 'imessage', 'signal',
    'slack', 'discord', 'teams', 'zoom', 'webex', 'skype',
  ];
  // Note: "telegram" is LifeOS itself often — treat as communication/ambiguous too
  if (communication.some((t) => appLower.includes(t)) || appLower.includes('telegram')) {
    return {
      internal: 'communication',
      activityCategory: 'neutral',
      confidence: 0.45,
      sessionAmbiguous: true,
      reason: 'communication app during a focus session — only you know if it is on-task',
    };
  }

  const distraction = [
    'youtube', 'netflix', 'instagram', 'twitter', 'reddit', 'tiktok',
    'twitch', 'steam', 'epic games',
  ];
  if (distraction.some((t) => appLower.includes(t) || titleLower.includes(t))) {
    return {
      internal: 'distraction',
      activityCategory: 'distraction',
      confidence: 0.8,
      sessionAmbiguous: false,
      reason: 'known entertainment / social distraction surface',
    };
  }

  // Browsers: extension owns page classification — do not ask via native path
  const browsers = ['chrome', 'safari', 'brave', 'firefox', 'arc', 'edge'];
  if (browsers.some((t) => appLower.includes(t))) {
    return {
      internal: 'consumption',
      activityCategory: 'neutral',
      confidence: 0.5,
      sessionAmbiguous: false,
      reason: 'browser shell; page-level category comes from extension + LLM, not native dwell',
    };
  }

  // Unknown apps: ask only during sessions (could be Calculator or a game)
  return {
    internal: 'shallow_work',
    activityCategory: 'neutral',
    confidence: 0.35,
    sessionAmbiguous: true,
    reason: 'unknown native app during a focus session',
  };
}

export function classifyNativeAppActivity(input: {
  app: string;
  title?: string;
  clientCategory?: string | null;
  sessionActive: boolean;
  sessionTargetTitle?: string | null;
}): NativeClassifyResult {
  const app = input.app || 'Unknown App';
  const title = input.title || '';
  const preferenceDomain = nativePreferenceDomain(app);

  // 1. Learned user preference (domain_categories) — shared with browser override path
  const pref = lookupUserPreference(app);
  if (pref) {
    return {
      internal:
        pref.category === 'productive' ? 'deep_work' :
        pref.category === 'distraction' ? 'distraction' : 'shallow_work',
      activityCategory: pref.category,
      confidence: 1,
      needsUserAsk: false,
      reason: pref.reasoning,
      preferenceDomain,
      source: 'user_preference',
    };
  }

  // 2. Client-provided category (rare)
  if (input.clientCategory) {
    const mapped = toActivityCategory(input.clientCategory);
    const sessionAmbiguous =
      input.sessionActive &&
      (input.clientCategory === 'communication' ||
        input.clientCategory === 'shallow_work' ||
        input.clientCategory === 'consumption');
    return {
      internal: (input.clientCategory as NativeInternalCategory) || 'shallow_work',
      activityCategory: mapped,
      confidence: sessionAmbiguous ? 0.4 : 0.7,
      needsUserAsk: sessionAmbiguous,
      reason: `client-provided category ${input.clientCategory}`,
      preferenceDomain,
      source: 'client',
    };
  }

  // 3. Deterministic rules (no LLM)
  const rules = ruleClassify(app, title);
  const needsUserAsk = input.sessionActive && rules.sessionAmbiguous;

  return {
    internal: rules.internal,
    // While waiting for user, never invent productive
    activityCategory: needsUserAsk ? 'neutral' : rules.activityCategory,
    confidence: rules.confidence,
    needsUserAsk,
    reason: rules.reason,
    preferenceDomain,
    source: 'rules',
  };
}

type PendingNativeAsk = {
  app: string;
  preferenceDomain: string;
  sessionId: string;
  sessionTargetTitle: string;
  activityIds: number[];
  askedAt: number;
  expiresAt: number;
};

function readPendingAsk(): PendingNativeAsk | null {
  try {
    const raw = getSetting(PENDING_ASK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingNativeAsk;
    if (!parsed?.app || !parsed.expiresAt) return null;
    if (Date.now() > parsed.expiresAt) {
      setSetting(PENDING_ASK_KEY, '');
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePendingAsk(pending: PendingNativeAsk | null): void {
  setSetting(PENDING_ASK_KEY, pending ? JSON.stringify(pending) : '');
}

function isAskCooldownActive(app: string): boolean {
  const key = ASK_COOLDOWN_PREFIX + normalizeAppKey(app);
  const raw = getSetting(key);
  if (!raw) return false;
  const until = Number(raw);
  return Number.isFinite(until) && Date.now() < until;
}

function setAskCooldown(app: string): void {
  setSetting(ASK_COOLDOWN_PREFIX + normalizeAppKey(app), String(Date.now() + ASK_COOLDOWN_MS));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * After inserting an activity, maybe ask the user how to classify the app.
 * One open ask at a time; cooldown per app.
 */
export async function maybeAskNativeCategory(input: {
  app: string;
  activityId: number;
  sessionId: string;
  sessionTargetTitle: string;
  classify: NativeClassifyResult;
}): Promise<{ asked: boolean }> {
  if (!input.classify.needsUserAsk) return { asked: false };
  if (isAskCooldownActive(input.app)) return { asked: false };

  const existing = readPendingAsk();
  if (existing) {
    if (
      existing.sessionId === input.sessionId &&
      normalizeAppKey(existing.app) === normalizeAppKey(input.app)
    ) {
      if (!existing.activityIds.includes(input.activityId)) {
        existing.activityIds = [...existing.activityIds, input.activityId].slice(-40);
        writePendingAsk(existing);
      }
      return { asked: false };
    }
    return { asked: false };
  }

  const pending: PendingNativeAsk = {
    app: input.app,
    preferenceDomain: input.classify.preferenceDomain,
    sessionId: input.sessionId,
    sessionTargetTitle: input.sessionTargetTitle,
    activityIds: [input.activityId],
    askedAt: Date.now(),
    expiresAt: Date.now() + 90 * 60_000,
  };
  writePendingAsk(pending);
  setAskCooldown(input.app);

  const topic = input.sessionTargetTitle || 'your focus session';
  const keyboard = [
    [
      { text: '🟢 Productive', callback_data: 'native_cat:productive' },
      { text: '🟡 Neutral', callback_data: 'native_cat:neutral' },
      { text: '🔴 Distraction', callback_data: 'native_cat:distraction' },
    ],
  ];

  const sent = await sendTelegram(
    `📱 <b>${escapeHtml(input.app)}</b> during <b>${escapeHtml(topic)}</b>\n\n` +
      `I cannot see the content (privacy). Is this productive for the session, neutral, or a distraction?\n\n` +
      `<i>${escapeHtml(input.classify.reason)}</i>\n\n` +
      `Reply <code>productive</code> / <code>neutral</code> / <code>distraction</code> or tap a button. I will remember.`,
    'HTML',
    keyboard,
  );

  if (!sent) {
    writePendingAsk(null);
    return { asked: false };
  }
  return { asked: true };
}

export function getPendingNativeCategoryAsk(): PendingNativeAsk | null {
  return readPendingAsk();
}

/**
 * Apply user's answer: update activities, write shared memory, refresh UIL.
 */
export function resolveNativeCategoryAsk(
  answer: ActivityCategory,
  source: 'telegram_text' | 'telegram_callback' | 'activity_ui' = 'telegram_text',
): { ok: boolean; app?: string; updated?: number; message: string } {
  const pending = readPendingAsk();
  if (!pending) {
    return { ok: false, message: 'No pending native app classification.' };
  }

  const category = toActivityCategory(answer);
  const db = getDb();
  let updated = 0;

  const classificationJson = JSON.stringify({
    source: 'native_copilot',
    app: pending.app,
    category,
    activityCategory: category,
    confidence: 1,
    userResolved: true,
    resolvedSource: source,
    preferenceDomain: pending.preferenceDomain,
    sessionId: pending.sessionId,
    sessionTargetTitle: pending.sessionTargetTitle,
  });

  for (const id of pending.activityIds) {
    const result = db.prepare(`
      UPDATE activities
      SET category = ?,
          ai_classification = ?,
          classification_confidence = 'high'
      WHERE id = ?
    `).run(category, classificationJson, id);
    updated += result.changes;
  }

  // Same native app, recent provisional rows
  try {
    const more = db.prepare(`
      UPDATE activities
      SET category = ?,
          classification_confidence = 'high',
          ai_classification = ?
      WHERE device_name = 'LifeOS Native Copilot'
        AND domain = ?
        AND category = 'neutral'
        AND started_at >= datetime('now', '-6 hours')
    `).run(category, classificationJson, pending.app);
    updated += more.changes;
  } catch { /* non-fatal */ }

  // Shared preference store (same table as browser domain overrides)
  saveNativeAppPreference(
    pending.app,
    category,
    `user native confirm during session "${pending.sessionTargetTitle}" via ${source}`,
  );

  // Behavioral memory (used by behavior/AI summaries)
  try {
    learnMemory(
      'user_preference',
      JSON.stringify({
        type: 'native_app_classification',
        app: pending.app,
        category,
        sessionId: pending.sessionId,
        sessionTargetTitle: pending.sessionTargetTitle,
        source,
      }),
      'classification_override',
    );
  } catch (err) {
    console.warn('[native-classify] learnMemory failed:', err);
  }

  // Semantic feedback facts for UIL / personalization
  try {
    recordExplicitFeedbackLearning({
      source: 'native_classification',
      feedback: category === 'distraction' ? 'wrong' : category === 'productive' ? 'helpful' : 'dismissed',
      surface: source,
      reason: `Native app ${pending.app} labeled ${category} during session ${pending.sessionTargetTitle}`,
      subject: pending.app,
      metadata: {
        category,
        sessionId: pending.sessionId,
        sessionTargetTitle: pending.sessionTargetTitle,
        preferenceDomain: pending.preferenceDomain,
        activityIds: pending.activityIds,
      },
    });
  } catch (err) {
    console.warn('[native-classify] feedback learning failed:', err);
  }

  // Refresh intelligence profile so coaching sees the preference
  try {
    touchIntelligence('native_app_classification');
  } catch { /* non-fatal */ }

  writePendingAsk(null);

  return {
    ok: true,
    app: pending.app,
    updated,
    message:
      `Got it — <b>${escapeHtml(pending.app)}</b> is <b>${category}</b> for you` +
      (pending.sessionTargetTitle ? ` during <i>${escapeHtml(pending.sessionTargetTitle)}</i>` : '') +
      `. Preference saved to shared intelligence.`,
  };
}

/** Parse free-text answer only when clearly a classification reply. */
export function parseNativeCategoryAnswer(text: string): ActivityCategory | null {
  const t = text.trim().toLowerCase();
  if (!t || t.startsWith('/')) return null;
  // Exact / short answers only — avoid intercepting long free-form messages
  if (/^(productive|prod|p)$/i.test(t)) return 'productive';
  if (/^(distraction|distract|dist|d)$/i.test(t)) return 'distraction';
  if (/^(neutral|neu|n)$/i.test(t)) return 'neutral';
  if (/^it'?s\s+(productive|neutral|distraction)$/i.test(t)) {
    return toActivityCategory(t.replace(/^it'?s\s+/, ''));
  }
  return null;
}
