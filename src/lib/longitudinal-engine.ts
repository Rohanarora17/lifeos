import { getDb } from './db';
import { classifyEnergy, getAdaptiveBands } from './adaptive-bands';
import type { DayBriefing, GuardianSemanticProfile, GuardianSessionReflection, GuardianSessionSummary, SoftWatchCommitment } from './guardian-types';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import { getAdaptiveTaskRecommendations } from './adaptive-task-recommendations';
import { buildPersonalizationSnapshot } from './personalization-context';

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toEnergyBand(score: number): 'low' | 'medium' | 'high' {
  return classifyEnergy(score);
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function titleFrequency(rows: Array<{ targetTitle: string; focusScore: number }>, highWaterMark: number, lowWaterMark: number) {
  const strong = new Map<string, number>();
  const friction = new Map<string, number>();

  for (const row of rows) {
    if (row.focusScore >= highWaterMark) {
      strong.set(row.targetTitle, (strong.get(row.targetTitle) || 0) + 1);
    }
    if (row.focusScore <= lowWaterMark) {
      friction.set(row.targetTitle, (friction.get(row.targetTitle) || 0) + 1);
    }
  }

  return {
    strongTopics: Array.from(strong.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([title]) => title),
    frictionTopics: Array.from(friction.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([title]) => title),
  };
}

function distractionFrequency(rows: Array<{ dominantDistractionDomain: string | null }>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.dominantDistractionDomain) continue;
    counts.set(row.dominantDistractionDomain, (counts.get(row.dominantDistractionDomain) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain]) => domain);
}

function deriveCoachingStyle(avgFocusScore: number, avgOverrides: number): 'gentle' | 'balanced' | 'direct' {
  const bands = getAdaptiveBands();
  const isLowFocus = avgFocusScore < bands.focusNeutral;
  const isHighFocus = avgFocusScore >= bands.focusExcellent;
  if (isLowFocus || avgOverrides < bands.overrideThreshold) return 'direct';
  if (isHighFocus && avgOverrides >= bands.overrideThreshold * 3) return 'gentle';
  return 'balanced';
}

export function listRecentGuardianSessionSummaries(limit: number = 20): GuardianSessionSummary[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      id,
      session_id as sessionId,
      target_title as targetTitle,
      goal_title as goalTitle,
      concept_node_name as conceptNodeName,
      mood,
      duration_minutes as durationMinutes,
      elapsed_minutes as elapsedMinutes,
      average_focus_score as trajectoryAverageFocusScore,
      final_focus_score as focusScore,
      final_focus_score as finalFocusScore,
      blocked_count as blockedCount,
      override_count as overrideCount,
      distraction_events as distractionEvents,
      productive_events as productiveEvents,
      neutral_events as neutralEvents,
      dominant_distraction_domain as dominantDistractionDomain,
      completed_at as completedAt
    FROM guardian_session_summaries
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(limit) as GuardianSessionSummary[];
}

export function getGuardianSemanticProfile(userId: string = 'default'): GuardianSemanticProfile {
  const db = getDb();
  const existing = db.prepare(`
    SELECT
      id,
      user_id as userId,
      coaching_style as coachingStyle,
      typical_energy_band as typicalEnergyBand,
      best_start_hour as bestStartHour,
      recurring_distraction_domains as recurringDistractionDomains,
      strong_topics as strongTopics,
      friction_topics as frictionTopics,
      updated_at as updatedAt
    FROM guardian_semantic_profiles
    WHERE user_id = ?
  `).get(userId) as
    | (Omit<GuardianSemanticProfile, 'recurringDistractionDomains' | 'strongTopics' | 'frictionTopics'> & {
        recurringDistractionDomains: string;
        strongTopics: string;
        frictionTopics: string;
      })
    | undefined;

  if (existing) {
    return {
      ...existing,
      recurringDistractionDomains: parseJsonArray(existing.recurringDistractionDomains),
      strongTopics: parseJsonArray(existing.strongTopics),
      frictionTopics: parseJsonArray(existing.frictionTopics),
    };
  }

  db.prepare(`
    INSERT OR IGNORE INTO guardian_semantic_profiles (user_id)
    VALUES (?)
  `).run(userId);

  return getGuardianSemanticProfile(userId);
}

export function updateGuardianSemanticProfile(userId: string = 'default') {
  const db = getDb();
  const recent = db.prepare(`
    SELECT
      target_title as targetTitle,
      final_focus_score as focusScore,
      override_count as overrideCount,
      dominant_distraction_domain as dominantDistractionDomain,
      CAST(strftime('%H', datetime(completed_at, '-' || elapsed_minutes || ' minutes')) as INTEGER) as startHour
    FROM guardian_session_summaries
    ORDER BY completed_at DESC
    LIMIT 20
  `).all() as Array<{
    targetTitle: string;
    focusScore: number;
    overrideCount: number;
    dominantDistractionDomain: string | null;
    startHour: number | null;
  }>;

  if (recent.length === 0) {
    return getGuardianSemanticProfile(userId);
  }

  const avgFocusScore = average(recent.map((row) => row.focusScore));
  const avgOverrides = average(recent.map((row) => row.overrideCount));
  const bestStartHour = recent
    .filter((row) => row.startHour !== null && row.focusScore >= avgFocusScore)
    .sort((a, b) => b.focusScore - a.focusScore)[0]?.startHour ?? null;
  const bands = getAdaptiveBands();
  const { strongTopics, frictionTopics } = titleFrequency(recent, bands.focusExcellent, bands.focusNeutral);
  const recurringDistractionDomains = distractionFrequency(recent);

  const profile: GuardianSemanticProfile = {
    ...getGuardianSemanticProfile(userId),
    userId,
    coachingStyle: deriveCoachingStyle(avgFocusScore, avgOverrides),
    typicalEnergyBand: toEnergyBand(avgFocusScore),
    bestStartHour,
    recurringDistractionDomains,
    strongTopics,
    frictionTopics,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO guardian_semantic_profiles (
      user_id,
      coaching_style,
      typical_energy_band,
      best_start_hour,
      recurring_distraction_domains,
      strong_topics,
      friction_topics,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(user_id) DO UPDATE SET
      coaching_style = excluded.coaching_style,
      typical_energy_band = excluded.typical_energy_band,
      best_start_hour = excluded.best_start_hour,
      recurring_distraction_domains = excluded.recurring_distraction_domains,
      strong_topics = excluded.strong_topics,
      friction_topics = excluded.friction_topics,
      updated_at = datetime('now', 'localtime')
  `).run(
    profile.userId,
    profile.coachingStyle,
    profile.typicalEnergyBand,
    profile.bestStartHour,
    JSON.stringify(profile.recurringDistractionDomains),
    JSON.stringify(profile.strongTopics),
    JSON.stringify(profile.frictionTopics)
  );

  return getGuardianSemanticProfile(userId);
}

export function getUpcomingCommitments(): SoftWatchCommitment[] {
  try {
    const db = getDb();
    const windowStart = Date.now();
    const windowEnd = Date.now() + 4 * 60 * 60_000; // next 4 hours
    db.prepare(`
      UPDATE soft_watch_commitments
      SET status = 'expired'
      WHERE status = 'pending'
        AND intended_start_at < ?
    `).run(windowStart);
    db.prepare(`
      UPDATE soft_watch_commitments
      SET status = 'dismissed'
      WHERE status = 'pending'
        AND id IN (
          SELECT sw.id
          FROM soft_watch_commitments sw
          JOIN planned_focus_sessions pfs ON pfs.soft_watch_id = sw.id
          WHERE pfs.status IN ('completed','skipped','cancelled')
        )
    `).run();
    return db.prepare(`
      SELECT id, target_title as targetTitle, goal_id as goalId, task_id as taskId,
        intended_start_at as intendedStartAt, planned_minutes as plannedMinutes,
        source, reminder_sent_at as reminderSentAt, check_in_sent_at as checkInSentAt,
        status, locked_in_session_id as lockedInSessionId, created_at as createdAt
      FROM soft_watch_commitments
      WHERE status = 'pending' AND intended_start_at BETWEEN ? AND ?
      ORDER BY intended_start_at ASC
      LIMIT 5
    `).all(windowStart, windowEnd) as SoftWatchCommitment[];
  } catch {
    return [];
  }
}

export function getRecentReflections(limit: number = 3): GuardianSessionReflection[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      id,
      session_id as sessionId,
      reflection_text as reflectionText,
      focus_quality as focusQuality,
      generated_at as generatedAt
    FROM guardian_session_reflections
    ORDER BY generated_at DESC
    LIMIT ?
  `).all(limit) as GuardianSessionReflection[];
}

export function getDayBriefing(userId: string = 'default'): DayBriefing {
  const db = getDb();
  const recent = listRecentGuardianSessionSummaries(7);
  const profile = updateGuardianSemanticProfile(userId);
  const recentReflections = getRecentReflections(3);
  const upcomingCommitments = getUpcomingCommitments();
  const personalization = buildPersonalizationSnapshot({
    surface: 'guidance',
    maxInsights: 2,
    includeMemoryFacts: 3,
  });
  const adaptiveTasks = getAdaptiveTaskRecommendations(personalization, 3);
  const activeGoals = db.prepare(`
    SELECT title
    FROM goals
    WHERE active = 1
    ORDER BY updated_at DESC, id DESC
    LIMIT 5
  `).all() as Array<{ title: string }>;
  const activeTasks = db.prepare(`
    SELECT title
    FROM tasks
    WHERE status IN ('todo', 'doing')
    ORDER BY priority_rank ASC NULLS LAST, updated_at DESC, id DESC
    LIMIT 5
  `).all() as Array<{ title: string }>;

  const avgFocusScore = recent.length > 0 ? average(recent.map((session) => session.focusScore)) : 0;
  const activeGoalTitles = activeGoals.map((goal) => goal.title);
  const activeTaskTitles = activeTasks.map((task) => task.title);
  const upcomingFocusTarget =
    adaptiveTasks[0]?.title ||
    personalization.userState.standupGoal ||
    activeTaskTitles[0] ||
    activeGoalTitles[0] ||
    recent[0]?.targetTitle ||
    profile.frictionTopics[0] ||
    profile.strongTopics[0] ||
    null;
  const modeLabel: Record<NonNullable<DayBriefing['personalization']>['mode'], string> = {
    protect_focus: 'Protect focus',
    deadline_pressure: 'Deadline pressure',
    recovery: 'Recovery',
    planning: 'Planning',
    normal: 'Balanced',
  };
  const adaptiveOpening = (() => {
    const topTask = adaptiveTasks[0];
    const prefix = `${modeLabel[personalization.moment.mode]} mode.`;
    if (topTask) return `${prefix} Best next target: ${topTask.title} - ${topTask.reason}.`;
    if (personalization.userState.standupGoal) return `${prefix} Anchor the next block on "${personalization.userState.standupGoal}".`;
    return `${prefix} ${personalization.moment.guidance}`;
  })();

  return {
    recentSessions: recent.length,
    avgFocusScore,
    activeGoals: activeGoalTitles,
    activeTasks: activeTaskTitles,
    upcomingFocusTarget,
    bestStartHour: profile.bestStartHour,
    recurringDistractions: profile.recurringDistractionDomains,
    coachingStyle: profile.coachingStyle,
    energyForecast: profile.typicalEnergyBand,
    recentReflections,
    upcomingCommitments,
    openingMessage: adaptiveOpening,
    personalization: {
      mode: personalization.moment.mode,
      guidance: personalization.moment.guidance,
      recommendedSessionMinutes: getAdaptiveSessionMinutes(),
      energy: personalization.userState.energy,
      mood: personalization.userState.mood,
      standupGoal: personalization.userState.standupGoal,
      alertFatigueLevel: personalization.feedback.alertFatigueLevel,
      recentAlerts: personalization.feedback.recentAlerts,
      nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
    },
    adaptiveTasks,
  };
}

export function getEnergyForecast(userId: string = 'default', hour: number) {
  const profile = getGuardianSemanticProfile(userId);
  if (profile.bestStartHour === null) {
    return profile.typicalEnergyBand;
  }

  const adaptiveBands = getAdaptiveBands();
  const distance = Math.abs(profile.bestStartHour - hour);
  if (distance <= 1) return 'high';
  if (distance <= Math.max(2, Math.round(adaptiveBands.energyHigh / 25))) return 'medium';
  return 'low';
}

export function detectGoalDrift(): Array<{ goalTitle: string; daysSinceLastSession: number | null }> {
  const db = getDb();
  // Goals that are active but haven't had a guardian session in 7+ days (or ever).
  // Ordered: never-studied first, then most-neglected first.
  return db.prepare(`
    SELECT
      g.title as goalTitle,
      CAST(
        (julianday('now', 'localtime') - julianday(MAX(gss.completed_at)))
        AS INTEGER
      ) as daysSinceLastSession
    FROM goals g
    LEFT JOIN guardian_session_summaries gss ON gss.goal_title = g.title
    WHERE g.active = 1
    GROUP BY g.id, g.title
    HAVING daysSinceLastSession IS NULL OR daysSinceLastSession >= 7
    ORDER BY daysSinceLastSession IS NULL DESC, daysSinceLastSession DESC
  `).all() as Array<{ goalTitle: string; daysSinceLastSession: number | null }>;
}

export async function generateOpeningLine(
  briefing: Pick<DayBriefing, 'avgFocusScore' | 'energyForecast' | 'coachingStyle' | 'upcomingFocusTarget'>,
  intent: { durationMinutes?: number; topic?: string; mood?: 'high' | 'medium' | 'low' | null }
): Promise<string> {
  try {
    const { buildPersonalizationSnapshot, formatPersonalizationContext } = await import('./personalization-context');
    const personalization = buildPersonalizationSnapshot({
      surface: 'guidance',
      maxInsights: 2,
      includeMemoryFacts: 4,
    });
    const context = formatPersonalizationContext(personalization);

    const { getDb } = await import('./db');
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const morningCheckin = db.prepare(`
      SELECT commitment, likelihood_score FROM daily_checkins
      WHERE checkin_date = ? AND checkin_type = 'morning' LIMIT 1
    `).get(today) as { commitment: string; likelihood_score: number } | undefined;

    const morningLine = morningCheckin
      ? `Today's commitment: "${morningCheckin.commitment}" (likelihood: ${morningCheckin.likelihood_score}/10)`
      : '';

    const prompt = `Given this current personalization profile about this person:
${context}

${morningLine}

Write ONE sentence to open this guardian session on "${intent.topic || 'their task'}" for ${intent.durationMinutes || 30} minutes.

Rules:
- Be specific to what you know about this person — reference actual recent patterns, not generic motivation
- Do not use filler phrases like "Let's get started" or "You've got this"
- Speak like a coach who has been watching, not an app notification
- If they said something honest in their morning check-in, reference it
- If they have a pattern of avoiding this specific topic, name it directly
- If their energy is low, suggest something smaller
- Maximum 25 words
- Return ONLY the sentence, no quotes, no explanation`;

    const { tryGetGenAI, generateWithFallback } = await import('./ai');
    const { MODEL_PRO } = await import('./models');
    const ai = tryGetGenAI();
    if (ai) {
      const result = await generateWithFallback(ai, {
        model: MODEL_PRO,
        contents: prompt,
        config: { temperature: 0.7, maxOutputTokens: 60 },
      });
      const text = result.text;
      if (text && text.trim().length > 0) {
        return text.trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch (err) {
    console.error('[LongitudinalEngine] generateOpeningLine failed, using fallback:', err);
  }

  // Fallback to original template logic
  const { durationMinutes, topic, mood } = intent;
  const { energyForecast, coachingStyle, avgFocusScore } = briefing;

  if (mood === 'low' || energyForecast === 'low') {
    return `Energy is lower today. Keep it simple: ${durationMinutes} minutes on ${topic}.`;
  }
  if (coachingStyle === 'direct') {
    return `Starting ${durationMinutes} minutes on ${topic}. Recent average focus is ${Math.round(avgFocusScore || 74)}. Beat it.`;
  }
  return `Starting ${durationMinutes} minute focus block on ${topic}. Your recent sessions averaged ${Math.round(avgFocusScore || 74)}.`;
}
