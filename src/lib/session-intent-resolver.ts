import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import { getIntelligenceProfile } from './intelligence';
import type { GuardianStartRequest, SessionIntentProfile, WorkMode } from './guardian-types';

export async function resolveSessionIntent(
  request: GuardianStartRequest,
): Promise<SessionIntentProfile> {
  const topic = request.topic || 'Deep Work';
  const mood = request.mood || null;
  const durationMinutes = request.durationMinutes || 60;

  const uil = getIntelligenceProfile();
  const energyAtStart = mood ?? uil.currentEnergyEstimate ?? 'medium';
  const coachingStyle = uil.preferredCoachingStyle ?? 'balanced';
  const recentDistractionTriggers = uil.distractionTriggers?.slice(0, 5) ?? [];
  const recentAvoidancePatterns = uil.avoidancePatterns?.slice(0, 5) ?? [];
  const optimalSprintMinutes = uil.optimalSessionMinutes || durationMinutes;

  const deadlineUrgency = resolveDeadlineUrgency(request.goalId, topic);
  const workMode = await resolveWorkMode(topic, energyAtStart, deadlineUrgency, request, request.sessionContext);

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

async function resolveWorkMode(
  topic: string,
  energy: 'high' | 'medium' | 'low',
  deadlineUrgency: SessionIntentProfile['deadlineUrgency'],
  request: GuardianStartRequest,
  sessionContext?: string,
): Promise<WorkMode> {
  if (deadlineUrgency === 'overdue' || deadlineUrgency === 'today') return 'urgent_sprint';
  if (energy === 'low') return 'recovery';

  const ai = getGenAI();
  if (!ai) return fallbackWorkMode(topic);

  const contextLine = sessionContext?.trim()
    ? `USER CONTEXT: "${sessionContext.trim()}"`
    : '';

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: `Classify the work mode for this focus session. Consider the topic, energy, and any user-provided context.

TOPIC: "${topic}"
ENERGY: ${energy}
GOAL: ${request.goalTitle || 'not specified'}
SOURCE: ${request.source || 'manual'}
${contextLine}

Work modes:
- deep_work: Writing, designing, creating original content. Requires sustained single-page attention.
- research: Reading papers, exploring docs, searching for solutions. Tab switching is EXPECTED and productive.
- urgent_sprint: Bug fixes, deadline-driven tasks. Needs aggressive distraction protection.
- learning: Studying, watching educational content, taking notes. Pauses are natural.
- recovery: Low energy review, light reading, easy tasks. Maximum leniency needed.

If the user context mentions switching between tabs, referencing materials, or looking things up — prefer research or learning over deep_work.

Return ONLY valid JSON:
{"workMode": "deep_work" | "research" | "urgent_sprint" | "learning" | "recovery", "confidence": "high" | "medium" | "low", "reason": "<one sentence>"}`,
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse((result.text || '{}').trim()) as {
      workMode: WorkMode;
      confidence: string;
      reason: string;
    };

    const validModes: WorkMode[] = ['deep_work', 'research', 'urgent_sprint', 'learning', 'recovery'];
    if (validModes.includes(parsed.workMode)) return parsed.workMode;
  } catch { /* fall through */ }

  return fallbackWorkMode(topic);
}

function fallbackWorkMode(topic: string): WorkMode {
  const t = topic.toLowerCase();
  if (/fix|bug|urgent|due|submit|deadline|asap/i.test(t)) return 'urgent_sprint';
  if (/read|research|explore|paper|survey|investigate|docs/i.test(t)) return 'research';
  if (/write|draft|design|create|compose|build|implement|code/i.test(t)) return 'deep_work';
  if (/study|learn|review|practice|watch|course|lecture/i.test(t)) return 'learning';
  return 'deep_work';
}
