import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import { getIntelligenceProfile } from './intelligence';
import { getActiveGuardianPolicyBundle, validatePolicyBundle } from './guardian-optimizer';
import { queryRelevantFacts, searchFactsByText } from './memory';
import type { GuardianPolicyBundle, SessionIntentProfile } from './guardian-types';

// ─── Session performance history ──────────────────────────────────────────────

function loadSessionPerformanceHistory(intent: SessionIntentProfile): string {
  try {
    const db = getDb();
    const keywords = intent.topic.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    const likeClause = keywords.length > 0
      ? keywords.map(() => 'target_title LIKE ?').join(' OR ')
      : null;
    const likeParams = keywords.map((w: string) => `%${w}%`);

    type SessionRow = {
      target_title: string; mood: string | null;
      elapsed_minutes: number; average_focus_score: number;
      override_count: number; blocked_count: number;
      distraction_events: number; productive_events: number;
    };

    const topicSessions: SessionRow[] = likeClause ? (db.prepare(`
      SELECT target_title, mood, elapsed_minutes, average_focus_score,
             override_count, blocked_count, distraction_events, productive_events
      FROM guardian_session_summaries
      WHERE ${likeClause}
      ORDER BY completed_at DESC LIMIT 5
    `).all(...likeParams)) as SessionRow[] : [];

    const recentSessions: SessionRow[] = db.prepare(`
      SELECT target_title, mood, elapsed_minutes, average_focus_score,
             override_count, blocked_count, distraction_events, productive_events
      FROM guardian_session_summaries
      ORDER BY completed_at DESC LIMIT 8
    `).all() as SessionRow[];

    type OverrideRow = { reason: string; ttl_minutes: number; approved: boolean };
    const recentOverrides: OverrideRow[] = db.prepare(`
      SELECT reason, ttl_minutes, approved
      FROM guardian_overrides
      ORDER BY created_at DESC LIMIT 5
    `).all() as OverrideRow[];

    const lines: string[] = [];

    if (topicSessions.length > 0) {
      lines.push('--- Past sessions on similar topics ---');
      for (const s of topicSessions) {
        lines.push(
          `"${s.target_title}" (${s.mood || '?'}): ${s.elapsed_minutes}min, ` +
          `focus=${Math.round(s.average_focus_score)}, ` +
          `overrides=${s.override_count}, blocked=${s.blocked_count}, ` +
          `distractions=${s.distraction_events}, productive=${s.productive_events}`
        );
      }
    } else {
      lines.push('No prior sessions on similar topics.');
    }

    if (recentSessions.length > 0) {
      const avgFocus = recentSessions.reduce((s, r) => s + r.average_focus_score, 0) / recentSessions.length;
      const avgOverrides = recentSessions.reduce((s, r) => s + r.override_count, 0) / recentSessions.length;
      const avgBlocked = recentSessions.reduce((s, r) => s + r.blocked_count, 0) / recentSessions.length;
      lines.push(`\n--- Recent baseline (last ${recentSessions.length} sessions) ---`);
      lines.push(`Avg focus: ${Math.round(avgFocus)}/100, avg overrides: ${avgOverrides.toFixed(1)}, avg blocks: ${avgBlocked.toFixed(1)}`);
    }

    if (recentOverrides.length > 0) {
      const approvedCount = recentOverrides.filter(o => o.approved).length;
      lines.push(`\n--- Recent override requests (${approvedCount}/${recentOverrides.length} approved) ---`);
      for (const o of recentOverrides.slice(0, 3)) {
        lines.push(`  ${o.approved ? '✓' : '✗'} "${o.reason}" (${o.ttl_minutes}min)`);
      }
    }

    return lines.join('\n');
  } catch {
    return 'No session history available.';
  }
}

function loadMemoryFacts(topic: string): string {
  try {
    const relevant = queryRelevantFacts({ status: 'active', limit: 10 });
    const topicFacts = searchFactsByText(topic, 10);
    const seen = new Set(relevant.map(f => f.id));
    const all = [...relevant, ...topicFacts.filter(f => !seen.has(f.id))].slice(0, 12);
    if (all.length === 0) return 'No memory facts available.';
    return all.map(f => `- [${f.category}/${f.topic}] ${f.content} (conf:${f.confidence.toFixed(2)})`).join('\n');
  } catch {
    return 'No memory facts available.';
  }
}

// ─── Main policy generator ────────────────────────────────────────────────────

export async function generateDynamicPolicy(
  intent: SessionIntentProfile,
): Promise<GuardianPolicyBundle> {
  const base = getActiveGuardianPolicyBundle();
  const uil = getIntelligenceProfile();
  const sessionHistory = loadSessionPerformanceHistory(intent);
  const memoryFacts = loadMemoryFacts(intent.topic);

  const ai = getGenAI();
  if (!ai) {
    console.warn('[DynamicPolicy] No AI client (check GEMINI_API_KEY) — using data-driven fallback');
    return applyDataDrivenFallback(base, intent, uil);
  }

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: buildPolicyPrompt(base, intent, uil, sessionHistory, memoryFacts),
      config: { responseMimeType: 'application/json', temperature: 0 },
    });

    const rawText = (result.text || '').trim();
    if (!rawText) throw new Error('Empty response from Gemini');

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(rawText);
    } catch (parseErr) {
      throw new Error(`JSON parse failed: ${(parseErr as Error).message} | Raw: ${rawText.slice(0, 200)}`);
    }

    delete raw._rationale;

    let validated: GuardianPolicyBundle;
    try {
      validated = validatePolicyBundle(raw) as GuardianPolicyBundle;
    } catch (validErr) {
      throw new Error(`Policy validation failed: ${(validErr as Error).message}`);
    }

    console.log(`[DynamicPolicy] ✓ v${validated.version} mode=${intent.workMode} energy=${intent.energyAtStart}`);
    return validated;
  } catch (err) {
    console.error('[DynamicPolicy] LLM generation failed — using data-driven fallback:', (err as Error).message);
    return applyDataDrivenFallback(base, intent, uil);
  }
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPolicyPrompt(
  base: GuardianPolicyBundle,
  intent: SessionIntentProfile,
  uil: ReturnType<typeof getIntelligenceProfile>,
  sessionHistory: string,
  memoryFacts: string,
): string {
  const t = uil.adaptiveThresholds;
  return `You are a focus-policy optimizer for a specific person. Tune the GuardianPolicyBundle for this session based on what has ACTUALLY WORKED for them — not on generic work-mode rules.

SESSION:
- Topic: "${intent.topic}"
- Work mode (AI-inferred label, not a hard rule): ${intent.workMode}
- Deadline urgency: ${intent.deadlineUrgency}
- Energy: ${intent.energyAtStart}
- Coaching style: ${intent.coachingStyle}
- Known distraction triggers: ${intent.recentDistractionTriggers.join(', ') || 'none'}
- Avoidance patterns: ${intent.recentAvoidancePatterns.join(', ') || 'none'}

ACTUAL SESSION HISTORY FOR THIS USER:
${sessionHistory}

LONG-TERM MEMORY FACTS:
${memoryFacts}

UIL ADAPTIVE THRESHOLDS (learned from past sessions):
- focusDropAlertScore: ${t.focusDropAlertScore}
- distractionAlertMinutes: ${t.distractionAlertMinutes}
- sessionDurationSweetSpot: ${t.sessionDurationSweetSpot}
- cognitiveLoadThreshold: ${t.cognitiveLoadThreshold}

CURRENT BASELINE POLICY:
${JSON.stringify(base, null, 2)}

REASONING APPROACH (use the data, not generic rules):
- High override count in similar sessions → thresholds too tight → loosen them
- Low focus + high distractions → thresholds too loose → tighten them
- Good focus with minimal overrides → policy working → minimal changes
- Low energy → raise idle thresholds, soften speech, extend cooldown
- Urgent deadline → tighten only if history shows user responds well to structure
- Many approved overrides → user prefers negotiation → nudges over hard blocks
- Work mode is a label only — let actual session data drive the numbers
- UIL thresholds are your learned starting point

HARD CONSTRAINTS:
- Weights sum to exactly 1.0 (±0.01), each weight in [0.05, 0.60]
- speechCooldownMs: [30000, 300000]
- flowSilenceThreshold: [70, 100]
- distractionRevisitBlockCount: [2, 6]
- distractionTabSwitchBlockCount: [2, 8]
- highScatterSpeakThreshold: [3, 10]
- idleConcernSeconds: [120, 900]
- focusDropSpeakThreshold: [5, 30]
- lowFocusThreshold: [40, 80]
- dwellDepthTargetSeconds: [60, 600]
- redTeamRules preserved verbatim
- Do not change retrievalPrompt or sessionPlannerPrompt

Return ONLY a complete JSON GuardianPolicyBundle with ALL fields. Include "_rationale" (will be stripped) explaining which data points drove your decisions.`;
}

// ─── Fallback — data-driven, no mode lookup table ────────────────────────────

function applyDataDrivenFallback(
  base: GuardianPolicyBundle,
  intent: SessionIntentProfile,
  uil: ReturnType<typeof getIntelligenceProfile>,
): GuardianPolicyBundle {
  const policy = structuredClone(base);

  if (uil.adaptiveThresholds) {
    const t = uil.adaptiveThresholds;
    if (t.distractionAlertMinutes) {
      policy.thresholds.idleConcernSeconds = Math.max(120, Math.min(900, t.distractionAlertMinutes * 60));
    }
    if (t.focusDropAlertScore) {
      policy.thresholds.lowFocusThreshold = Math.max(40, Math.min(80, t.focusDropAlertScore));
    }
  }

  if (intent.energyAtStart === 'low') {
    policy.thresholds.idleConcernSeconds = Math.min(900, Math.round(policy.thresholds.idleConcernSeconds * 1.5));
    policy.thresholds.speechCooldownMs = Math.min(300000, Math.round(policy.thresholds.speechCooldownMs * 1.5));
  }

  if (intent.deadlineUrgency === 'overdue' || intent.deadlineUrgency === 'today') {
    policy.thresholds.speechCooldownMs = Math.max(30000, Math.round(policy.thresholds.speechCooldownMs * 0.6));
    policy.thresholds.distractionRevisitBlockCount = Math.max(2, policy.thresholds.distractionRevisitBlockCount - 1);
  }

  policy.version = `${base.version}-dynamic-fallback`;
  return policy;
}
