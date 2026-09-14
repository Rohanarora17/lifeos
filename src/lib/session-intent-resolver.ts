import { getDb } from './db';
import { generateWithFallback, tryGetGenAI } from './ai';
import { MODEL_PRO } from './models';
import { getIntelligenceProfile } from './intelligence';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import { buildPersonalizationSnapshot, formatPersonalizationContext, type PersonalizationSnapshot } from './personalization-context';
import type { GuardianStartRequest, SessionIntentProfile, WorkMode } from './guardian-types';

// ─── Session history for similar topics ──────────────────────────────────────

function noSimilarSessionHistory(topic: string, personalization: PersonalizationSnapshot): string {
  const planned = personalization.today.plannedFocus.nextTitle
    ? `\n- Current planned focus: ${personalization.today.plannedFocus.nextTitle}${personalization.today.plannedFocus.nextMinutes ? ` (${personalization.today.plannedFocus.nextMinutes}m)` : ''}`
    : '';
  const standup = personalization.userState.standupGoal
    ? `\n- Today's stated goal: ${personalization.userState.standupGoal}`
    : '';

  return `No prior sessions matched "${topic}". Use today's personalization as the closest session prior:
- Moment mode: ${personalization.moment.mode}
- Energy: ${personalization.userState.energy}
- Mood: ${personalization.userState.mood ?? 'unknown'}
- Learned focus window: ${personalization.userState.nextBestFocusWindow || 'unknown'}
- Alert fatigue: ${personalization.feedback.alertFatigueLevel}${planned}${standup}`;
}

function loadSimilarSessionHistory(topic: string, personalization: PersonalizationSnapshot): string {
  try {
    const db = getDb();
    // Match on first 3 meaningful words of the topic
    const keywords = topic.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    const likeClause = keywords.map(() => 'target_title LIKE ?').join(' OR ');
    const likeParams = keywords.map(w => `%${w}%`);

    const sessions = (likeClause
      ? db.prepare(`
          SELECT target_title, mood, elapsed_minutes, final_focus_score AS focus_score,
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
        focus_score: number;
        override_count: number;
        blocked_count: number;
        distraction_events: number;
        productive_events: number;
      }>;

    if (sessions.length === 0) return noSimilarSessionHistory(topic, personalization);

    return sessions.map(s =>
      `- "${s.target_title}" (${s.mood || '?'} energy): ${s.elapsed_minutes}min, ` +
      `focus=${Math.round(s.focus_score)}, overrides=${s.override_count}, ` +
      `blocked=${s.blocked_count}, distractions=${s.distraction_events}, productive=${s.productive_events}`
    ).join('\n');
  } catch {
    return noSimilarSessionHistory(topic, personalization);
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
  const personalization = buildPersonalizationSnapshot({
    surface: 'intervention',
    maxInsights: 2,
    includeMemoryFacts: 4,
  });
  const sessionHistory = loadSimilarSessionHistory(topic, personalization);

  const workMode = await resolveWorkMode({
    topic,
    energyAtStart,
    deadlineUrgency,
    sessionContext: request.sessionContext,
    goalTitle: request.goalTitle,
    sessionHistory,
    uil,
    personalization,
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
  personalization: PersonalizationSnapshot;
}

async function resolveWorkMode(input: ResolveWorkModeInput): Promise<WorkMode> {
  const ai = tryGetGenAI();
  if (!ai) return fallbackWorkMode(input);

  const {
    topic, energyAtStart, deadlineUrgency, sessionContext, goalTitle, sessionHistory, uil, personalization,
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
  const profileFallback = [
    `No stable learned profile fields yet; use today's adaptive context instead.`,
    `Moment mode: ${personalization.moment.mode}`,
    `Energy: ${personalization.userState.energy}`,
    `Mood: ${personalization.userState.mood ?? 'unknown'}`,
    personalization.today.plannedFocus.nextTitle
      ? `Planned focus: ${personalization.today.plannedFocus.nextTitle}${personalization.today.plannedFocus.nextMinutes ? ` (${personalization.today.plannedFocus.nextMinutes}m)` : ''}`
      : '',
    personalization.userState.standupGoal ? `Today's stated goal: ${personalization.userState.standupGoal}` : '',
    personalization.userState.nextBestFocusWindow ? `Learned focus window: ${personalization.userState.nextBestFocusWindow}` : '',
  ].filter(Boolean).join('\n');

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: `You are classifying the work mode for a focus session for a specific person.
Do NOT apply generic rules. Reason from the actual data about this person and this topic.

TOPIC: "${topic}"
GOAL: ${goalTitle || 'not specified'}
ENERGY: ${energyAtStart}
DEADLINE URGENCY: ${deadlineUrgency}
${contextLine}

USER PROFILE:
${uilLine || profileFallback}

TODAY PERSONALIZATION:
${formatPersonalizationContext(personalization)}

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
- If today's planned focus already names this target, respect its planned duration and intent.
- If moment mode is recovery, prefer recovery or learning unless a real deadline is active.
- If moment mode is planning, classify setup/review/calendar work as planning-friendly learning or research instead of deep_work by default.
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

  return fallbackWorkMode(input);
}

function fallbackWorkMode(input: Pick<ResolveWorkModeInput, 'topic' | 'deadlineUrgency' | 'energyAtStart' | 'sessionContext' | 'personalization'>): WorkMode {
  const text = `${input.topic} ${input.sessionContext ?? ''}`.toLowerCase();
  const scores: Record<WorkMode, number> = {
    deep_work: 0,
    research: 0,
    urgent_sprint: 0,
    learning: 0,
    recovery: 0,
  };

  if (input.deadlineUrgency === 'overdue') scores.urgent_sprint += 5;
  if (input.deadlineUrgency === 'today') scores.urgent_sprint += 4;
  if (input.deadlineUrgency === 'this_week') scores.urgent_sprint += 2;

  if (input.personalization.moment.mode === 'deadline_pressure') scores.urgent_sprint += 3;
  if (input.personalization.moment.mode === 'recovery') scores.recovery += 3;
  if (input.personalization.moment.mode === 'planning') {
    scores.research += 2;
    scores.learning += 1;
  }
  if (input.personalization.moment.mode === 'protect_focus') scores.deep_work += 2;
  if (input.personalization.today.plannedFocus.nextTitle) {
    const planned = input.personalization.today.plannedFocus.nextTitle.toLowerCase();
    const overlaps = planned.split(/\s+/).some(word => word.length > 3 && text.includes(word));
    if (overlaps) scores.learning += 2;
  }

  if (input.energyAtStart === 'low') {
    scores.recovery += 3;
    scores.learning += 1;
  } else if (input.energyAtStart === 'high') {
    scores.deep_work += 1;
    scores.urgent_sprint += 1;
  }

  if (/(fix|bug|urgent|submit|deadline|asap|due|ship|finish|blocked|blocker)/.test(text)) scores.urgent_sprint += 3;
  if (/(read|research|explore|paper|survey|investigate|docs|documentation|google|compare|literature|source|reference)/.test(text)) scores.research += 3;
  if (/(switch(ing)? tabs|multiple tabs|browser|chatgpt|explain|look up|search|sources|unclear concept)/.test(text)) scores.research += 2;
  if (/(write|draft|design|create|compose|build|implement|code|debug|refactor|test|repo|api)/.test(text)) scores.deep_work += 3;
  if (/(study|learn|review|practice|course|lecture|assignment|math academy|problem|exercise|flashcard|quiz)/.test(text)) scores.learning += 3;
  if (/(tired|drained|low energy|sleepy|recover|light|easy|small|minimum|gentle)/.test(text)) scores.recovery += 3;

  if (scores.recovery >= 3 && scores.urgent_sprint >= 4) return 'urgent_sprint';
  return (Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] as WorkMode) || 'deep_work';
}
