import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import { getIntelligenceProfile } from './intelligence';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import type { GuardianStartRequest, SessionIntentProfile, WorkMode } from './guardian-types';

// ─── Session history for similar topics ──────────────────────────────────────

function loadSimilarSessionHistory(topic: string): string {
  try {
    const db = getDb();
    // Match on first 3 meaningful words of the topic
    const keywords = topic.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    const likeClause = keywords.map(() => 'target_title LIKE ?').join(' OR ');
    const likeParams = keywords.map(w => `%${w}%`);

    const sessions = (likeClause
      ? db.prepare(`
          SELECT target_title, mood, elapsed_minutes, average_focus_score,
                 override_count, blocked_count, distraction_events, productive_events
          FROM guardian_session_summaries
          WHERE ${likeClause}
          ORDER BY completed_at DESC
          LIMIT 6
        `).all(...likeParams)
      : []) as Array<{
        target_title: string;
        mood: string | null;
        elapsed_minutes: number;
        average_focus_score: number;
        override_count: number;
        blocked_count: number;
        distraction_events: number;
        productive_events: number;
      }>;

    if (sessions.length === 0) return 'No prior sessions on similar topics.';

    return sessions.map(s =>
      `- "${s.target_title}" (${s.mood || '?'} energy): ${s.elapsed_minutes}min, ` +
      `focus=${Math.round(s.average_focus_score)}, overrides=${s.override_count}, ` +
      `blocked=${s.blocked_count}, distractions=${s.distraction_events}, productive=${s.productive_events}`
    ).join('\n');
  } catch {
    return 'No prior sessions found.';
  }
}

// ─── Main resolver ────────────────────────────────────────────────────────────

export async function resolveSessionIntent(
  request: GuardianStartRequest,
): Promise<SessionIntentProfile> {
  const topic = request.topic || 'Deep Work';
  const mood = request.mood || null;

  const uil = getIntelligenceProfile();
  const durationMinutes = getAdaptiveSessionMinutes(request.durationMinutes);
  const energyAtStart = (mood ?? uil.currentEnergyEstimate ?? 'medium') as 'high' | 'medium' | 'low';
  const coachingStyle = uil.preferredCoachingStyle ?? 'balanced';
  const recentDistractionTriggers = uil.distractionTriggers?.slice(0, 5) ?? [];
  const recentAvoidancePatterns = uil.avoidancePatterns?.slice(0, 5) ?? [];
  const optimalSprintMinutes = uil.optimalSessionMinutes || durationMinutes;
  const deadlineUrgency = resolveDeadlineUrgency(request.goalId, topic);
  const sessionHistory = loadSimilarSessionHistory(topic);

  const workMode = await resolveWorkMode({
    topic,
    energyAtStart,
    deadlineUrgency,
    sessionContext: request.sessionContext,
    goalTitle: request.goalTitle,
    sessionHistory,
    uil,
  });

  return {
    workMode,
    topic,
    goalId: request.goalId ?? null,
    goalTitle: request.goalTitle ?? null,
    deadlineUrgency,
    energyAtStart,
    coachingStyle,
    recentDistractionTriggers,
    recentAvoidancePatterns,
    optimalSprintMinutes,
  };
}

// ─── Deadline urgency ─────────────────────────────────────────────────────────

function resolveDeadlineUrgency(
  goalId: string | null | undefined,
  topic: string,
): SessionIntentProfile['deadlineUrgency'] {
  try {
    const db = getDb();
    const now = new Date(Date.now() + 19800000);
    const todayStr = now.toISOString().slice(0, 10);
    const threeDaysLater = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);

    let tasks: Array<{ due_date: string | null }> = [];
    if (goalId) {
      tasks = db.prepare(
        `SELECT due_date FROM tasks WHERE goal_id = ? AND status NOT IN ('done', 'cancelled') AND due_date IS NOT NULL ORDER BY due_date ASC LIMIT 5`
      ).all(Number(goalId)) as Array<{ due_date: string | null }>;
    }
    if (tasks.length === 0) {
      const keyword = topic.split(' ').slice(0, 3).join('%');
      tasks = db.prepare(
        `SELECT due_date FROM tasks WHERE title LIKE ? AND status NOT IN ('done', 'cancelled') AND due_date IS NOT NULL ORDER BY due_date ASC LIMIT 5`
      ).all(`%${keyword}%`) as Array<{ due_date: string | null }>;
    }

    for (const t of tasks) {
      if (!t.due_date) continue;
      if (t.due_date < todayStr) return 'overdue';
      if (t.due_date === todayStr) return 'today';
      if (t.due_date <= threeDaysLater) return 'this_week';
    }
  } catch { /* non-fatal */ }

  return 'none';
}

// ─── Work mode — fully AI-driven, no hard-coded gates ─────────────────────────

interface ResolveWorkModeInput {
  topic: string;
  energyAtStart: 'high' | 'medium' | 'low';
  deadlineUrgency: SessionIntentProfile['deadlineUrgency'];
  sessionContext?: string;
  goalTitle?: string | null;
  sessionHistory: string;
  uil: ReturnType<typeof getIntelligenceProfile>;
}

async function resolveWorkMode(input: ResolveWorkModeInput): Promise<WorkMode> {
  const ai = getGenAI();
  if (!ai) return fallbackWorkMode(input.topic, input.deadlineUrgency, input.energyAtStart);

  const {
    topic, energyAtStart, deadlineUrgency, sessionContext, goalTitle, sessionHistory, uil,
  } = input;

  const contextLine = sessionContext?.trim()
    ? `USER CONTEXT (what they said about this session): "${sessionContext.trim()}"`
    : '';

  const uilLine = [
    uil.distractionTriggers?.length ? `Known distraction triggers: ${uil.distractionTriggers.slice(0, 3).join(', ')}` : '',
    uil.avoidancePatterns?.length ? `Avoidance patterns: ${uil.avoidancePatterns.slice(0, 3).join(', ')}` : '',
    uil.optimalSessionMinutes ? `Optimal session length: ${uil.optimalSessionMinutes}min` : '',
    uil.preferredCoachingStyle ? `Coaching style: ${uil.preferredCoachingStyle}` : '',
  ].filter(Boolean).join('\n');

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: `You are classifying the work mode for a focus session for a specific person.
Do NOT apply generic rules. Reason from the actual data about this person and this topic.

TOPIC: "${topic}"
GOAL: ${goalTitle || 'not specified'}
ENERGY: ${energyAtStart}
DEADLINE URGENCY: ${deadlineUrgency}
${contextLine}

USER PROFILE:
${uilLine || 'No profile data yet.'}

PAST SESSIONS ON SIMILAR TOPICS:
${sessionHistory}

AVAILABLE MODES:
- deep_work: Single-focused creation — writing, coding, designing with minimal switching.
- research: Exploring, referencing, reading across multiple sources. Tab switching is part of the work.
- urgent_sprint: Deadline-driven. Needs tight protection from distraction.
- learning: Studying, consuming educational content, note-taking. Natural pauses expected.
- recovery: Low energy, light tasks. Maximum leniency.

REASON FROM THE DATA:
- If past sessions on this topic had many overrides/blocks, the mode was probably too tight — consider more lenient.
- If past sessions had low focus scores with many distractions, tighter mode may help.
- If user context mentions switching tabs or referencing materials, lean toward research or learning.
- Energy and deadline urgency are inputs to consider, not hard gates — a low-energy user might still need deep_work if the deadline is today.

Return ONLY valid JSON:
{"workMode": "deep_work"|"research"|"urgent_sprint"|"learning"|"recovery", "confidence": "high"|"medium"|"low", "reason": "<one sentence based on the actual data>"}`,
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse((result.text || '{}').trim()) as {
      workMode: WorkMode;
      confidence: string;
      reason: string;
    };

    console.log(`[session-intent] workMode=${parsed.workMode} (${parsed.confidence}): ${parsed.reason}`);

    const validModes: WorkMode[] = ['deep_work', 'research', 'urgent_sprint', 'learning', 'recovery'];
    if (validModes.includes(parsed.workMode)) return parsed.workMode;
  } catch { /* fall through */ }

  return fallbackWorkMode(topic, deadlineUrgency, energyAtStart);
}

function fallbackWorkMode(topic: string, deadlineUrgency: string, energy: string): WorkMode {
  // Only use these as a last resort when AI is unavailable
  if (deadlineUrgency === 'overdue' || deadlineUrgency === 'today') return 'urgent_sprint';
  if (energy === 'low') return 'recovery';
  const t = topic.toLowerCase();
  if (/fix|bug|urgent|submit|deadline|asap/i.test(t)) return 'urgent_sprint';
  if (/read|research|explore|paper|survey|investigate|docs/i.test(t)) return 'research';
  if (/write|draft|design|create|compose|build|implement|code/i.test(t)) return 'deep_work';
  if (/study|learn|review|practice|watch|course|lecture|assignment/i.test(t)) return 'learning';
  return 'deep_work';
}
