import { getDb, getSetting, setSetting } from './db';
import { computeFocusScore } from './focus-score';
import { computeEnergyComposite, recordEnergyReading } from './energy-composite';
import { logGoalTime } from './goal-health';
import { propagateMastery } from './graph';
import { speak } from './tts';
import { getDayBriefing, generateOpeningLine, updateGuardianSemanticProfile } from './longitudinal-engine';
import { getGenAI, classifyActivity, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import { getActiveGuardianPolicyBundle, recordGuardianEvalRun } from './guardian-optimizer';
import { resolveSessionIntent } from './session-intent-resolver';
import { generateDynamicPolicy } from './dynamic-policy-generator';
import { emitGuardianRuntimeEvent, consumePendingSpeech } from './guardian-bus';
import { touchIntelligence, getIntelligenceContext } from './intelligence';
import { extractMemoryFromSession } from './memory-extractor';
import { activateTasksForSession, evaluateSessionTaskCompletion } from './session-task-sync';
import {
  sendTelegram,
  formatSessionStart,
  formatSessionEnd,
  formatSoftWatchReminder,
  SESSION_START_KEYBOARD,
  SESSION_END_KEYBOARD,
  SOFT_WATCH_KEYBOARD,
  buildClassifyKeyboard,
} from './telegram';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent, isCalendarConfigured } from './google-calendar';
import {
  ActiveOverride,
  GuardianCommand,
  GuardianDecision,
  GuardianDecisionSource,
  GuardianInterventionPolicy,
  GuardianEvent,
  GuardianPolicyBundle,
  GuardianStartRequest,
  GuardianState,
  OverrideDecision,
  OverrideRequest,
  SoftWatchCommitment,
} from './guardian-types';
import { buildPersonalizationSnapshot } from './personalization-context';
import { buildAdaptiveHabitPlans, type AdaptiveHabitInput } from './adaptive-habit-plan';
import { getAutomaticityScore, getStreakCount } from './scoring';
import { getAdaptiveSessionMinuteDecision, getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import { getAdaptiveBands } from './adaptive-bands';

// guardian-runtime is the single owner of live session state.
// Routes ingest input and render output, but do not mutate session state directly.
const globalGuardian = global as unknown as {
  guardianSessions?: Map<string, GuardianState>;
  guardianIntervals?: Map<string, ReturnType<typeof setInterval>>;
  guardianCommands?: Map<string, GuardianCommand[]>;
  softWatchMap?: Map<string, SoftWatchCommitment>;
  softWatchCheckerInterval?: ReturnType<typeof setInterval>;
  calendarEventIds?: Map<string, string>;
};

function adaptiveFocusQuality(score: number): {
  quality: 'excellent' | 'good' | 'neutral' | 'poor';
  label: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  calendarColorId: string;
  reason: string;
} {
  const bands = getAdaptiveBands();
  if (score >= bands.focusExcellent) {
    return {
      quality: 'excellent',
      label: 'Excellent',
      calendarColorId: '2',
      reason: `${Math.round(score)} reached learned excellent band ${Math.round(bands.focusExcellent)}+`,
    };
  }
  if (score >= bands.focusGood) {
    return {
      quality: 'good',
      label: 'Good',
      calendarColorId: '2',
      reason: `${Math.round(score)} reached learned good band ${Math.round(bands.focusGood)}+`,
    };
  }
  if (score >= bands.focusNeutral) {
    return {
      quality: 'neutral',
      label: 'Fair',
      calendarColorId: '5',
      reason: `${Math.round(score)} reached learned neutral band ${Math.round(bands.focusNeutral)}+`,
    };
  }
  return {
    quality: 'poor',
    label: 'Poor',
    calendarColorId: '11',
    reason: `${Math.round(score)} below learned neutral band ${Math.round(bands.focusNeutral)}`,
  };
}

export function getAdaptiveVisionAlignmentThresholds(): {
  deepFlowAlignmentThreshold: number;
  offTopicAlignmentThreshold: number;
  productiveScatterAlignmentThreshold: number;
} {
  const bands = getAdaptiveBands();
  return {
    deepFlowAlignmentThreshold: bands.focusGood,
    offTopicAlignmentThreshold: bands.focusPoor,
    productiveScatterAlignmentThreshold: bands.focusNeutral,
  };
}

const guardianSessions = globalGuardian.guardianSessions || new Map<string, GuardianState>();
const guardianIntervals = globalGuardian.guardianIntervals || new Map<string, ReturnType<typeof setInterval>>();
const guardianCommands = globalGuardian.guardianCommands || new Map<string, GuardianCommand[]>();
const softWatchMap = globalGuardian.softWatchMap || new Map<string, SoftWatchCommitment>();
// sessionId → Google Calendar event ID (fire-and-forget, best-effort)
const calendarEventIds = globalGuardian.calendarEventIds || new Map<string, string>();

// Always pin maps on global so they survive hot-reloads (dev) and module re-evaluations (prod).
globalGuardian.guardianSessions = guardianSessions;
globalGuardian.guardianIntervals = guardianIntervals;
globalGuardian.guardianCommands = guardianCommands;
globalGuardian.softWatchMap = softWatchMap;
globalGuardian.calendarEventIds = calendarEventIds;

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneSession(session: GuardianState) {
  return structuredClone(session) as GuardianState;
}

function getDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Sync classification — zero latency, no network.
 * Priority: session-scoped cache (set by async classifyActivity calls during the session)
 *   → domain_categories persistent table → 'unknown' fallback.
 * Uses the same domain_categories table that classifyActivity writes to, so the
 * two paths stay in sync rather than being separate silos.
 */
function classifyUrlForGuardian(
  url: string | undefined,
  sessionClassificationCache?: Record<string, 'on_topic' | 'distraction' | 'unknown'>,
  hasSession?: boolean // when true, only trust user-confirmed domain_categories entries
): 'on_topic' | 'distraction' | 'unknown' {
  if (!url) return 'unknown';
  let domain: string;
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
  if (!domain || domain.startsWith('chrome') || domain === 'newtab') return 'unknown';

  // 1. Session-scoped cache (set by async classifyActivity with session context — highest authority)
  if (sessionClassificationCache?.[domain]) return sessionClassificationCache[domain];

  // 2. Persistent domain_categories.
  // During an active session, only trust user-confirmed entries (ai_reasoning starts with 'user').
  // AI-only cached results are bypassed so the async session-aware classification can run and
  // overwrite the cache with the correct session-scoped result.
  try {
    const row = getDb().prepare(
      'SELECT category, confidence, ai_reasoning FROM domain_categories WHERE domain = ?'
    ).get(domain) as { category: string; confidence: number; ai_reasoning?: string } | undefined;
    if (row) {
      const isUserConfirmed = typeof row.ai_reasoning === 'string' &&
        (row.ai_reasoning.startsWith('user confirm') || row.ai_reasoning.startsWith('user correct'));
      const meetsThreshold = hasSession
        ? (isUserConfirmed && row.confidence >= 0.9) // session: only human-confirmed overrides
        : row.confidence >= 0.6;                      // no session: any cached result
      if (meetsThreshold) {
        if (row.category === 'productive') return 'on_topic';
        if (row.category === 'distraction') return 'distraction';
      }
    }
  } catch { /* DB not ready */ }

  return 'unknown';
}

function queryPersonalBestFocusScore(): number | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT MAX(average_focus_score) as best FROM guardian_session_summaries
    `).get() as { best: number | null } | undefined;
    return row?.best ?? null;
  } catch {
    return null;
  }
}

function createSessionState(input: {
  sessionId: string;
  durationMinutes: number;
  targetTitle: string;
  mood?: 'high' | 'medium' | 'low' | null;
  goalId?: string | null;
  goalTitle?: string | null;
  conceptNodeId?: string | null;
  conceptNodeName?: string | null;
  personalBestFocusScore?: number | null;
  energyComposite?: number | null;
}): GuardianState {
  return {
    sessionId: input.sessionId,
    state: 'ACTIVE',
    goalId: input.goalId || null,
    goalTitle: input.goalTitle || null,
    conceptNodeId: input.conceptNodeId || null,
    conceptNodeName: input.conceptNodeName || null,
    durationMinutes: input.durationMinutes,
    mood: input.mood || null,
    startedAt: Date.now(),
    endsAt: Date.now() + input.durationMinutes * 60_000,
    tick: 0,
    tabEventLog: [],
    focusScoreHistory: [100],
    blockedCount: 0,
    overrideCount: 0,
    currentUrl: '',
    currentTitle: '',
    currentClassification: 'unknown',
    lastSpeechAt: null,
    lastDecisionAt: null,
    lastIntervention: null,
    activeOverrides: [],
    emittedMilestones: [],
    targetTitle: input.targetTitle,
    personalBestFocusScore: input.personalBestFocusScore ?? null,
    energyComposite: input.energyComposite ?? null,
    sessionClassificationCache: {},
    immediateBlockDomains: [],
    currentTabStartedAt: null,
    intentProfile: null,
    sessionPolicy: null,
    screenContext: null,
  };
}

// Restore ACTIVE sessions from SQLite when the in-memory Map is empty (e.g. after server restart).
function restoreSessionsFromDb() {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT session_id, target_title, goal_id, goal_title, concept_node_name,
             started_at, duration_minutes, mood
      FROM guardian_sessions
      WHERE state = 'ACTIVE'
    `).all() as Array<{
      session_id: string; target_title: string; goal_id: string | null;
      goal_title: string | null; concept_node_name: string | null;
      started_at: number; duration_minutes: number; mood: string | null;
    }>;

    for (const row of rows) {
      const endsAt = row.started_at + row.duration_minutes * 60_000;
      if (endsAt <= Date.now()) {
        // Session expired while server was down — mark complete
        db.prepare(`UPDATE guardian_sessions SET state = 'COMPLETE' WHERE session_id = ?`).run(row.session_id);
        continue;
      }
      if (guardianSessions.has(row.session_id)) continue; // already in memory

      const session = createSessionState({
        sessionId: row.session_id,
        durationMinutes: row.duration_minutes,
        targetTitle: row.target_title || 'Deep Work',
        mood: row.mood as 'high' | 'medium' | 'low' | null,
        goalId: row.goal_id,
        goalTitle: row.goal_title,
        conceptNodeName: row.concept_node_name,
      });
      // Preserve original timing so the countdown is accurate
      session.startedAt = row.started_at;
      session.endsAt = endsAt;

      guardianSessions.set(row.session_id, session);
      console.log('[guardian] Restored session from DB:', row.session_id, row.target_title);

      if (!guardianIntervals.has(row.session_id)) {
        const timer = setInterval(() => {
          void tickGuardianSession(row.session_id, { sessionId: row.session_id, type: 'heartbeat', timestamp: Date.now() });
        }, 30_000);
        guardianIntervals.set(row.session_id, timer);
      }
    }
  } catch (err) {
    console.error('[guardian] restoreSessionsFromDb failed:', err);
  }
}

function emitSessionEvent(sessionId: string, payload: Record<string, unknown>) {
  emitGuardianRuntimeEvent(sessionId, payload);
}

function finalizeDecision(
  sessionId: string,
  decision: GuardianDecision,
  sourceEventType: GuardianDecisionSource = 'system'
): GuardianDecision {
  const createdAt = decision.createdAt ?? Date.now();
  const reason = decision.reason || (decision.type === 'silence' ? 'No intervention needed' : 'Guardian runtime decision');
  const explainability =
    decision.explainability ||
    (decision.type === 'silence'
      ? 'The guardian runtime did not find enough evidence to intervene on this tick.'
      : 'The guardian runtime took action based on the active policy bundle and current session context.');

  return {
    ...decision,
    sessionId,
    createdAt,
    sourceEventType,
    reason,
    explainability,
    command: decision.command
      ? {
        ...decision.command,
        sessionId,
        sourceEventType,
        reason: decision.command.reason || reason,
        explainability: decision.command.explainability || explainability,
        createdAt: decision.command.createdAt ?? createdAt,
      }
      : undefined,
  };
}

function queueCommand(sessionId: string, command: GuardianCommand) {
  const commands = guardianCommands.get(sessionId) || [];
  commands.push(command);
  guardianCommands.set(sessionId, commands);
  emitSessionEvent(sessionId, { type: 'command', command });
}

function clearHeartbeat(sessionId: string) {
  const timer = guardianIntervals.get(sessionId);
  if (timer) {
    clearInterval(timer);
    guardianIntervals.delete(sessionId);
  }
}

function persistTick(session: GuardianState, decision: GuardianDecision) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO session_ticks (session_id, tick, focus_score, url, url_classification, action_taken)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionId,
      session.tick,
      session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? 100,
      session.currentUrl,
      session.currentClassification,
      decision.type
    );

    if (decision.type !== 'silence') {
      db.prepare(`
        INSERT INTO jarvis_explanations (session_id, action, reason, data_points, confidence)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        session.sessionId,
        decision.type,
        decision.reason || decision.text || '',
        JSON.stringify([decision.explainability || decision.reason || '']),
        0.7
      );
    }
  } catch (error) {
    console.error('[GuardianRuntime] Failed to persist tick', error);
  }
}

function persistOverride(request: OverrideRequest, decision: OverrideDecision) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO guardian_override_requests (
        session_id,
        url,
        title,
        reason,
        requested_minutes,
        approved,
        decision_reason,
        explainability
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.sessionId,
      request.url,
      request.title || null,
      request.reason,
      request.requestedMinutes ?? null,
      decision.approved ? 1 : 0,
      decision.reason,
      decision.explainability
    );
  } catch (error) {
    console.error('[GuardianRuntime] Failed to persist override', error);
  }
}

function persistSessionSummary(session: GuardianState) {
  try {
    const db = getDb();
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
    const focusScores = session.focusScoreHistory.length > 0 ? session.focusScoreHistory : [100];
    const averageFocusScore = focusScores.reduce((sum, score) => sum + score, 0) / focusScores.length;
    const finalFocusScore = focusScores[focusScores.length - 1] ?? 100;
    const domainCounts = new Map<string, number>();
    let distractionEvents = 0;
    let productiveEvents = 0;
    let neutralEvents = 0;

    for (const event of session.tabEventLog) {
      if (!isContinuityEvent(event)) continue;
      const classification = getEventClassification(session, event);
      if (classification === 'distraction') {
        distractionEvents += 1;
        const domain = getEventDomainKey(event);
        if (domain) {
          domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
        }
      } else if (classification === 'on_topic') {
        productiveEvents += 1;
      } else {
        neutralEvents += 1;
      }
    }

    const dominantDistractionDomain =
      Array.from(domainCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const startedAtIso = new Date(session.startedAt).toISOString();

    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id,
        target_title,
        goal_title,
        concept_node_name,
        mood,
        started_at,
        duration_minutes,
        elapsed_minutes,
        average_focus_score,
        final_focus_score,
        blocked_count,
        override_count,
        distraction_events,
        productive_events,
        neutral_events,
        dominant_distraction_domain
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        target_title = excluded.target_title,
        goal_title = excluded.goal_title,
        concept_node_name = excluded.concept_node_name,
        mood = excluded.mood,
        started_at = excluded.started_at,
        duration_minutes = excluded.duration_minutes,
        elapsed_minutes = excluded.elapsed_minutes,
        average_focus_score = excluded.average_focus_score,
        final_focus_score = excluded.final_focus_score,
        blocked_count = excluded.blocked_count,
        override_count = excluded.override_count,
        distraction_events = excluded.distraction_events,
        productive_events = excluded.productive_events,
        neutral_events = excluded.neutral_events,
        dominant_distraction_domain = excluded.dominant_distraction_domain,
        completed_at = datetime('now', 'localtime')
    `).run(
      session.sessionId,
      session.targetTitle,
      session.goalTitle || null,
      session.conceptNodeName || null,
      session.mood || null,
      startedAtIso,
      session.durationMinutes,
      elapsedMinutes,
      averageFocusScore,
      finalFocusScore,
      session.blockedCount,
      session.overrideCount,
      distractionEvents,
      productiveEvents,
      neutralEvents,
      dominantDistractionDomain
    );

    updateGuardianSemanticProfile('default');
  } catch (error) {
    console.error('[GuardianRuntime] Failed to persist session summary', error);
  }
}

async function generateSessionReflection(session: GuardianState) {
  try {
    const db = getDb();
    const focusScores = session.focusScoreHistory.length > 0 ? session.focusScoreHistory : [100];
    const averageFocusScore = Math.round(focusScores.reduce((s, v) => s + v, 0) / focusScores.length);
    const finalFocusScore = focusScores[focusScores.length - 1] ?? 100;
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
    const distractionCount = session.tabEventLog.filter(
      (e) => isContinuityEvent(e) && getEventClassification(session, e) === 'distraction'
    ).length;

    const focusQuality = adaptiveFocusQuality(averageFocusScore);

    const ai = getGenAI();
    if (!ai) return;

    const uilContext = getIntelligenceContext({ maxInsights: 2, includeToday: true });
    const nowLocal = new Date(Date.now() + 19800000); // IST offset
    const currentTimeStr = nowLocal.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

    const prompt = `You are the LifeOS guardian reflecting on a just-completed study session. Write 2–3 concise sentences (max 60 words total) as a personal coach speaking directly to the user. Be honest, specific, and reference their patterns. No filler phrases.

Current time: ${currentTimeStr}
Session: ${session.targetTitle}
Planned: ${session.durationMinutes} min | Elapsed: ${elapsedMinutes} min
Average focus: ${averageFocusScore}/100 | Final focus: ${finalFocusScore}/100
Blocks: ${session.blockedCount} | Overrides: ${session.overrideCount} | Distraction events: ${distractionCount}

${uilContext}`;

    const result = await generateWithFallback(ai, { model: MODEL_FLASH, contents: prompt });
    const reflectionText = (result.text ?? '').trim().slice(0, 400);

    db.prepare(`
      INSERT INTO guardian_session_reflections (session_id, reflection_text, focus_quality)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        reflection_text = excluded.reflection_text,
        focus_quality = excluded.focus_quality,
        generated_at = datetime('now', 'localtime')
    `).run(session.sessionId, reflectionText, focusQuality.quality);
  } catch (error) {
    console.error('[GuardianRuntime] Failed to generate session reflection', error);
  }
}

function buildSpeechText(session: GuardianState, kind: GuardianDecision['type']): string {
  const score = session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? 100;
  const elapsed = Math.max(1, Math.floor((Date.now() - session.startedAt) / 60000));
  const remaining = Math.max(0, session.durationMinutes - elapsed);
  const site = getDomain(session.currentUrl) || 'that site';

  const policy = session.sessionPolicy ?? getActiveGuardianPolicyBundle();
  const useLLM = policy.prompts.interventionPrompt && getGenAI();
  if (useLLM) {
    const context = buildSpeechContext(session, kind, score, elapsed, remaining, site);
    void generateLLMSpeech(session, context, kind);
    return fallbackSpeechText(session, kind, score, elapsed, remaining, site);
  }

  return fallbackSpeechText(session, kind, score, elapsed, remaining, site);
}

function fallbackSpeechText(
  session: GuardianState,
  kind: GuardianDecision['type'],
  score: number,
  elapsed: number,
  remaining: number,
  site: string,
): string {
  const policy = session.sessionPolicy ?? getActiveGuardianPolicyBundle();
  switch (kind) {
    case 'block':
      return `You are drifting to ${site}. Back to ${session.targetTitle}.`;
    case 'nudge':
      return `You are scattered. One thing. ${remaining} minutes left.`;
    case 'speak':
    default:
      if (score > policy.thresholds.flowConfirmationScore) return `Locked in. ${elapsed} clean minutes. Keep this pace.`;
      if (elapsed >= Math.floor(session.durationMinutes * 0.8)) return `${remaining} minutes left. Finish what you started.`;
      return `Halfway check. Score ${score}. Stay with ${session.targetTitle}.`;
  }
}

function buildSpeechContext(
  session: GuardianState,
  kind: GuardianDecision['type'],
  score: number,
  elapsed: number,
  remaining: number,
  site: string,
): string {
  const intent = session.intentProfile;
  const style = intent?.coachingStyle ?? 'balanced';
  const energy = intent?.energyAtStart ?? 'medium';
  const topic = session.targetTitle;

  const lines = [
    `Session: "${topic}", ${elapsed}/${session.durationMinutes} min, focus=${score}/100`,
    `Energy: ${energy}, coaching style: ${style}`,
  ];
  if (kind === 'block') lines.push(`Situation: User drifted to ${site}. Block + redirect.`);
  else if (kind === 'nudge') lines.push(`Situation: User is scattered. ${remaining} min left. Ground them.`);
  else if (score > 88) lines.push(`Situation: Sustained flow. Confirm and encourage.`);
  else if (elapsed >= session.durationMinutes * 0.8) lines.push(`Situation: Final sprint. ${remaining} min left. Push to finish.`);
  else lines.push(`Situation: Midpoint check-in. Score ${score}.`);

  if (intent?.workMode === 'urgent_sprint') lines.push('This is an urgent sprint — be direct and brief.');
  if (intent?.workMode === 'recovery') lines.push('This is a recovery session — be gentle and encouraging.');
  if (energy === 'low') lines.push('User has low energy — be supportive, not demanding.');

  return lines.join('\n');
}

function buildSessionMilestonePolicy(input: {
  session: GuardianState;
  focusScore: number;
  lowEnergy: boolean;
  inFlow: boolean;
}): {
  midpointRatio: number;
  finalRatio: number;
  shouldEmitMidpoint: boolean;
  shouldEmitFinalPush: boolean;
  tone: GuardianDecision['tone'];
  reason: string;
} {
  const reasons: string[] = [];
  let midpointRatio = 0.5;
  let finalRatio = 0.8;
  let shouldEmitMidpoint = true;
  let shouldEmitFinalPush = true;
  let tone: GuardianDecision['tone'] = 'midpoint_checkin';

  const workMode = input.session.intentProfile?.workMode;
  if (input.lowEnergy || workMode === 'recovery') {
    midpointRatio = 0.65;
    finalRatio = 0.88;
    tone = 'grounding_nudge';
    reasons.push('recovery/low-energy session gets fewer, later checks');
  }

  if (workMode === 'urgent_sprint') {
    midpointRatio = 0.45;
    finalRatio = 0.75;
    tone = 'direct_push';
    reasons.push('urgent sprint gets earlier accountability');
  }

  try {
    const snapshot = buildPersonalizationSnapshot({
      surface: 'intervention',
      maxInsights: 1,
      includeThresholds: true,
      includeMemoryFacts: 2,
      activeSession: {
        sessionId: input.session.sessionId,
        targetTitle: input.session.targetTitle,
        focusScore: input.focusScore,
        elapsedMinutes: Math.max(0, Math.round((Date.now() - input.session.startedAt) / 60_000)),
      },
    });

    if (snapshot.moment.mode === 'protect_focus' || input.inFlow) {
      shouldEmitMidpoint = false;
      finalRatio = Math.max(finalRatio, 0.9);
      reasons.push('protect-focus/flow mode suppresses routine midpoint interruption');
    } else if (snapshot.moment.mode === 'deadline_pressure') {
      midpointRatio = Math.min(midpointRatio, 0.45);
      finalRatio = Math.min(finalRatio, 0.75);
      tone = 'direct_push';
      reasons.push('deadline pressure moves checks earlier');
    } else if (snapshot.moment.mode === 'recovery') {
      midpointRatio = Math.max(midpointRatio, 0.65);
      finalRatio = Math.max(finalRatio, 0.88);
      tone = 'grounding_nudge';
      reasons.push('current recovery mode makes checks gentler');
    }

    if (snapshot.feedback.alertFatigueLevel === 'high') {
      shouldEmitMidpoint = false;
      finalRatio = Math.max(finalRatio, 0.9);
      reasons.push('high alert fatigue removes routine midpoint');
    }
  } catch {
    reasons.push('fallback milestone policy');
  }

  if (input.focusScore >= 90) {
    shouldEmitMidpoint = false;
    shouldEmitFinalPush = false;
    reasons.push('high focus score avoids milestone interruptions');
  } else if (input.focusScore < 60) {
    midpointRatio = Math.min(midpointRatio, 0.45);
    reasons.push('low focus score allows earlier grounding');
  }

  return {
    midpointRatio,
    finalRatio,
    shouldEmitMidpoint,
    shouldEmitFinalPush,
    tone,
    reason: reasons.join('; ') || 'balanced adaptive milestone timing',
  };
}

async function generateLLMSpeech(
  session: GuardianState,
  context: string,
  kind: GuardianDecision['type'],
): Promise<void> {
  const ai = getGenAI();
  if (!ai) return;
  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: `You are a focus coach. Generate ONE short spoken sentence for the user right now. Be specific, not generic. No filler phrases. Maximum 20 words.

${context}

Return ONLY the sentence. No quotes, no explanation.`,
      config: { temperature: 0.7, maxOutputTokens: 50 },
    });
    const text = result.text?.trim().replace(/^["']|["']$/g, '');
    if (text && text.length > 3) {
      void speak(session.sessionId, text, kind === 'block' ? 'urgent' : 'normal', kind === 'block' ? 'direct_push' : 'grounding_nudge');
    }
  } catch { /* non-fatal — fallback speech already scheduled */ }
}

function decisionCooldownPassed(session: GuardianState, policy: GuardianPolicyBundle) {
  if (!session.lastSpeechAt) return true;
  return Date.now() - session.lastSpeechAt > policy.thresholds.speechCooldownMs;
}

function pruneExpiredOverrides(session: GuardianState) {
  const now = Date.now();
  const expired = session.activeOverrides.filter((item) => item.expiresAt <= now);
  session.activeOverrides = session.activeOverrides.filter((item) => item.expiresAt > now);
  return expired;
}

function hasActiveOverride(session: GuardianState, url: string) {
  pruneExpiredOverrides(session);
  return session.activeOverrides.some((item) => url.includes(item.urlPattern));
}

function getAttentionCategory(session: GuardianState, url: string | undefined) {
  if (!url) return 'ambiguous_context' as const;
  if (hasActiveOverride(session, url)) return 'temporary_override' as const;
  if (session.currentClassification === 'distraction') return 'blocked_distractor' as const;
  if (session.currentClassification === 'on_topic') return 'productive_support' as const;
  return 'ambiguous_context' as const;
}

function isContinuityEvent(event: GuardianEvent) {
  return event.type === 'tab' || event.type === 'native_context';
}

function classificationFromNativeCategory(category: unknown): 'on_topic' | 'distraction' | 'unknown' {
  if (category === 'distraction') return 'distraction';
  if (category === 'deep_work' || category === 'shallow_work' || category === 'communication') return 'on_topic';
  return 'unknown';
}

function getEventClassification(session: GuardianState, event: GuardianEvent): 'on_topic' | 'distraction' | 'unknown' {
  const payloadClassification = event.payload?.classification;
  if (payloadClassification === 'on_topic' || payloadClassification === 'distraction' || payloadClassification === 'unknown') {
    return payloadClassification;
  }
  if (event.type === 'native_context') {
    return classificationFromNativeCategory(event.payload?.category);
  }
  return classifyUrlForGuardian(event.url, session.sessionClassificationCache, true);
}

function getEventDomainKey(event: GuardianEvent): string | null {
  if (event.domain) return event.domain;
  if (event.type === 'native_context' && typeof event.payload?.appInFocus === 'string' && event.payload.appInFocus.trim()) {
    return `native:${event.payload.appInFocus.trim().toLowerCase()}`;
  }
  return getDomain(event.url) ?? null;
}

function nativeAppUrl(app: string) {
  return `native://${encodeURIComponent(app.trim() || 'Unknown App')}`;
}

function emitExpiredOverrideCommands(session: GuardianState) {
  const expired = pruneExpiredOverrides(session);
  for (const override of expired) {
    queueCommand(session.sessionId, {
      id: randomId('cmd'),
      type: 'block',
      sessionId: session.sessionId,
      reason: 'Override expired',
      explainability: `The temporary exception for ${override.urlPattern} expired, so the guardian restored blocking automatically.`,
      urlPattern: override.urlPattern,
      targetDisplay: session.targetTitle,
      interventionPolicy: buildInterventionPolicy(session, 'override_expired'),
      sourceEventType: 'override_decision',
      createdAt: Date.now(),
    });

    emitSessionEvent(session.sessionId, {
      type: 'override_expired',
      urlPattern: override.urlPattern,
      explainability: 'A temporary override expired and the guardian restored the original blocking rule.',
    });
  }
}

function buildInterventionPolicy(session: GuardianState, source: 'block' | 'override_expired'): GuardianInterventionPolicy {
  const focusScore = session.focusScoreHistory.at(-1) ?? null;
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000));
  const snapshot = buildPersonalizationSnapshot({
    surface: 'intervention',
    maxInsights: 2,
    includeMemoryFacts: 3,
    activeSession: {
      sessionId: session.sessionId,
      targetTitle: session.targetTitle,
      focusScore,
      elapsedMinutes,
    },
  });

  const mode = snapshot.moment.mode;
  const alertFatigue = snapshot.feedback.alertFatigueLevel;
  const baseOptions = [
    { minutes: 3, label: '3 min check' },
    { minutes: 5, label: '5 min source check', default: true },
    { minutes: 10, label: '10 min bounded detour' },
  ];

  if (source === 'override_expired') {
    return {
      mode,
      headline: 'Override window ended',
      tone: 'firm',
      contextLine: `Back to ${session.targetTitle}. ${snapshot.moment.guidance}`,
      overridePrompt: 'If this still matters, explain the exact next step before asking again.',
      overrideOptions: baseOptions,
      minReasonChars: alertFatigue === 'high' ? 18 : 14,
      frictionSeconds: mode === 'recovery' ? 2 : 5,
    };
  }

  if (mode === 'recovery' || snapshot.userState.energy === 'low') {
    return {
      mode,
      headline: 'Choose the smallest useful move',
      tone: 'gentle',
      contextLine: `Low energy today. Keep the session protected without turning this into a fight.`,
      overridePrompt: 'If this helps the task, name the one concrete thing you need from it.',
      overrideOptions: baseOptions,
      minReasonChars: 8,
      frictionSeconds: 2,
    };
  }

  if (mode === 'deadline_pressure') {
    return {
      mode,
      headline: 'Deadline capacity is protected',
      tone: 'urgent',
      contextLine: snapshot.userState.standupGoal
        ? `Today is anchored on: ${snapshot.userState.standupGoal}`
        : 'Use exceptions only for direct deadline relief.',
      overridePrompt: 'Explain how this directly reduces the current deadline risk.',
      overrideOptions: [
        { minutes: 3, label: '3 min verify', default: true },
        { minutes: 5, label: '5 min reference' },
        { minutes: 10, label: '10 min only if essential' },
      ],
      minReasonChars: 14,
      frictionSeconds: 6,
    };
  }

  if (mode === 'protect_focus') {
    return {
      mode,
      headline: 'Protect this focus block',
      tone: 'firm',
      contextLine: `Focus is worth preserving right now. ${snapshot.moment.guidance}`,
      overridePrompt: 'Explain why this is part of the current session, not a context switch.',
      overrideOptions: [
        { minutes: 5, label: '5 min task check', default: true },
        { minutes: 10, label: '10 min reference' },
        { minutes: 15, label: '15 min if necessary' },
      ],
      minReasonChars: 16,
      frictionSeconds: 10,
    };
  }

  if (mode === 'planning') {
    return {
      mode,
      headline: 'Keep tonight clean',
      tone: 'gentle',
      contextLine: 'This is a planning/cleanup window, so detours should stay short and intentional.',
      overridePrompt: 'Explain whether this helps planning, review, or setup for tomorrow.',
      overrideOptions: [
        { minutes: 5, label: '5 min review', default: true },
        { minutes: 10, label: '10 min cleanup' },
        { minutes: 15, label: '15 min planning' },
      ],
      minReasonChars: 10,
      frictionSeconds: 3,
    };
  }

  return {
    mode,
    headline: 'Intervention',
    tone: 'firm',
    contextLine: snapshot.moment.guidance,
    overridePrompt: 'If this is needed, explain the specific session-relevant reason.',
    overrideOptions: [
      { minutes: 5, label: '5 min check' },
      { minutes: 10, label: '10 min override', default: true },
      { minutes: 15, label: '15 min override' },
    ],
    minReasonChars: alertFatigue === 'high' ? 14 : 10,
    frictionSeconds: alertFatigue === 'high' ? 6 : 4,
  };
}

function decide(session: GuardianState, policy: GuardianPolicyBundle): GuardianDecision {
  const focusScore = session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? 100;
  const history = session.focusScoreHistory;
  const recentEvents = session.tabEventLog.filter((event) => event.timestamp >= Date.now() - 300_000);
  const tabSwitchesLast5Min = recentEvents.filter((event) => isContinuityEvent(event)).length;
  const distractionRevisits = recentEvents.filter((event) => isContinuityEvent(event) && getEventClassification(session, event) === 'distraction').length;
  const idleSeconds = recentEvents
    .filter((event) => event.type === 'idle')
    .reduce((sum, event) => sum + (event.idleSeconds || 0), 0);
  const recentDwells = recentEvents
    .filter((event) => isContinuityEvent(event) && typeof event.dwellSeconds === 'number')
    .map((event) => event.dwellSeconds || 0);
  const avgRecentDwell = recentDwells.length > 0 ? recentDwells.reduce((sum, dwell) => sum + dwell, 0) / recentDwells.length : 0;
  const cooldownPassed = decisionCooldownPassed(session, policy);
  const inFlow = focusScore >= policy.thresholds.flowSilenceThreshold;
  const attentionCategory = getAttentionCategory(session, session.currentUrl);
  // Low-energy mode: soften direct interventions, lower break threshold
  const lowEnergy = session.energyComposite !== null && session.energyComposite < policy.thresholds.lowEnergyThreshold;
  // Vision context — available after first screen_vision event
  const screenCtx = session.screenContext;
  const visionDepth = screenCtx?.engagementDepth ?? 'unknown';
  const visionAlignment = screenCtx?.taskAlignmentAvg ?? null;
  const visionObsCount = screenCtx?.recentObservations.length ?? 0;
  const hasReliableVision = visionObsCount >= 3; // enough observations to trust
  const {
    deepFlowAlignmentThreshold,
    offTopicAlignmentThreshold,
    productiveScatterAlignmentThreshold,
  } = getAdaptiveVisionAlignmentThresholds();

  const explainabilityBase = `score=${focusScore}, tabSwitchesLast5Min=${tabSwitchesLast5Min}, distractionRevisits=${distractionRevisits}, idleSeconds=${idleSeconds}, avgRecentDwell=${Math.round(avgRecentDwell)}, attentionCategory=${attentionCategory}, energyComposite=${session.energyComposite ?? 'unknown'}, visionDepth=${visionDepth}, visionAlignment=${visionAlignment ?? 'none'}, adaptiveVisionBands=good:${Math.round(deepFlowAlignmentThreshold)} neutral:${Math.round(productiveScatterAlignmentThreshold)} poor:${Math.round(offTopicAlignmentThreshold)}`;

  // ── Vision-aware flow silence ────────────────────────────────────────────────
  // If vision confirms active_creation with high alignment, the user is in a genuine
  // flow state. Never interrupt — even for milestone messages.
  if (
    hasReliableVision &&
    visionDepth === 'active_creation' &&
    (visionAlignment ?? 0) >= deepFlowAlignmentThreshold &&
    focusScore >= (policy.thresholds.flowSilenceThreshold ?? 80)
  ) {
    const recentAllCreation = screenCtx!.recentObservations
      .slice(-4)
      .every((o) => o.engagementDepth === 'active_creation');
    if (recentAllCreation) {
      return {
        type: 'silence',
        reason: 'Vision confirms deep flow state — active creation at high alignment',
        explainability: `${explainabilityBase}; vision shows sustained active_creation, interruption cost exceeds value`,
      };
    }
  }

  // ── Vision-confirmed distraction override ────────────────────────────────────
  // If vision sees clearly off-topic content with high confidence, escalate decision
  // even if URL classification hasn't resolved yet.
  if (
    hasReliableVision &&
    visionDepth === 'distraction' &&
    (visionAlignment ?? 100) <= offTopicAlignmentThreshold &&
    cooldownPassed
  ) {
    const lastDistraction = screenCtx!.recentObservations.at(-1);
    if (lastDistraction && lastDistraction.confidence >= 0.75) {
      return {
        type: 'speak',
        tone: 'grounding_nudge',
        text: buildSpeechText(session, 'nudge'),
        reason: 'Vision confirms off-topic content',
        explainability: `${explainabilityBase}; vision detected distraction (${lastDistraction.specificContent}) with high confidence`,
      };
    }
  }

  if (attentionCategory === 'temporary_override') {
    return {
      type: 'silence',
      reason: 'Temporary override active',
      explainability: `${explainabilityBase}; a temporary override is active so the guardian stays quiet until it expires`,
    };
  }

  if (
    attentionCategory === 'productive_support' &&
    avgRecentDwell >= policy.thresholds.stableFlowMinDwellSeconds &&
    tabSwitchesLast5Min <= policy.thresholds.stableFlowMaxTabSwitches &&
    focusScore >= policy.thresholds.lowFocusThreshold
  ) {
    return {
      type: 'silence',
      reason: 'Stable productive flow detected',
      explainability: `${explainabilityBase}; stable productive dwell means interruption cost exceeds intervention value`,
    };
  }

  if (
    attentionCategory === 'ambiguous_context' &&
    tabSwitchesLast5Min <= policy.thresholds.stableFlowMaxTabSwitches &&
    focusScore >= policy.thresholds.lowFocusThreshold
  ) {
    return {
      type: 'silence',
      reason: 'Ambiguous context below intervention threshold',
      explainability: `${explainabilityBase}; the context is not clearly harmful enough to justify interruption`,
    };
  }

  if (attentionCategory === 'blocked_distractor') {
    if (distractionRevisits >= policy.thresholds.distractionRevisitBlockCount) {
      return {
        type: 'block',
        tone: 'direct_push',
        text: buildSpeechText(session, 'block'),
        reason: 'Repeated distraction revisits during an active guardian session',
        explainability: `${explainabilityBase}; repeated distraction threshold crossed`,
        command: {
          id: randomId('cmd'),
          type: 'block',
          reason: 'Repeated distraction visits',
          explainability: 'You revisited a distraction target repeatedly during a protected study session.',
          targetDisplay: session.targetTitle,
          urlPattern: getDomain(session.currentUrl),
          interventionPolicy: buildInterventionPolicy(session, 'block'),
          createdAt: Date.now(),
        },
      };
    }

    if (tabSwitchesLast5Min >= policy.thresholds.distractionTabSwitchBlockCount) {
      return {
        type: 'block',
        tone: 'grounding_nudge',
        text: buildSpeechText(session, 'block'),
        reason: 'Rapid context switching onto distraction domains',
        explainability: `${explainabilityBase}; distraction switch threshold crossed`,
        command: {
          id: randomId('cmd'),
          type: 'block',
          reason: 'Rapid distraction switching',
          explainability: 'The guardian saw repeated rapid switches into a distraction target.',
          targetDisplay: session.targetTitle,
          urlPattern: getDomain(session.currentUrl),
          interventionPolicy: buildInterventionPolicy(session, 'block'),
          createdAt: Date.now(),
        },
      };
    }
  }

  if (tabSwitchesLast5Min >= policy.thresholds.highScatterSpeakThreshold && cooldownPassed && !inFlow && attentionCategory !== 'ambiguous_context') {
    // Vision exemption: if vision confirms active_learning (research mode), high tab switching
    // is productive comparison behaviour — suppress the scatter warning.
    const productiveScatter =
      hasReliableVision &&
      visionDepth === 'active_learning' &&
      (visionAlignment ?? 0) >= productiveScatterAlignmentThreshold;

    if (!productiveScatter) {
      return {
        type: 'speak',
        tone: 'grounding_nudge',
        text: buildSpeechText(session, 'nudge'),
        reason: 'High scatter detected',
        explainability: `${explainabilityBase}; scatter threshold crossed`,
      };
    }
  }

  if (idleSeconds >= policy.thresholds.idleConcernSeconds && cooldownPassed && !inFlow) {
    return {
      type: 'speak',
      tone: 'break_suggestion',
      text: lowEnergy
        ? 'You have been idle a while. With energy running low today, a short rest break might actually help more than pushing through.'
        : 'You have been idle a while. Either reset intentionally or get back into the work.',
      reason: 'Extended idle time during active session',
      explainability: `${explainabilityBase}; idle threshold crossed`,
    };
  }

  if (history.length >= 3) {
    const previous = history[Math.max(0, history.length - 3)];
    if (previous - focusScore >= policy.thresholds.focusDropSpeakThreshold && cooldownPassed && !inFlow) {
      return {
        type: 'speak',
        // On low-energy days, a motivational push lands better than a direct command
        tone: lowEnergy ? 'grounding_nudge' : 'direct_push',
        text: lowEnergy
          ? 'Focus dropped a bit. That happens on low-energy days — take a breath and come back to it.'
          : 'Focus is slipping. Pull it back now.',
        reason: 'Sharp focus score drop',
        explainability: `${explainabilityBase}; focus drop threshold crossed`,
      };
    }
  }

  const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
  const milestonePolicy = buildSessionMilestonePolicy({ session, focusScore, lowEnergy, inFlow });
  if (
    milestonePolicy.shouldEmitMidpoint &&
    !session.emittedMilestones.includes('midpoint') &&
    elapsed >= Math.floor(session.durationMinutes * milestonePolicy.midpointRatio) &&
    cooldownPassed &&
    attentionCategory === 'productive_support'
  ) {
    session.emittedMilestones.push('midpoint');
    return {
      type: 'speak',
      tone: milestonePolicy.tone,
      text: buildSpeechText(session, 'speak'),
      reason: 'Midpoint check-in',
      explainability: `${explainabilityBase}; adaptive midpoint ratio=${milestonePolicy.midpointRatio}; ${milestonePolicy.reason}`,
    };
  }

  if (
    milestonePolicy.shouldEmitFinalPush &&
    !session.emittedMilestones.includes('final_push') &&
    elapsed >= Math.floor(session.durationMinutes * milestonePolicy.finalRatio) &&
    cooldownPassed &&
    attentionCategory === 'productive_support'
  ) {
    session.emittedMilestones.push('final_push');
    return {
      type: 'speak',
      tone: 'final_push',
      text: buildSpeechText(session, 'speak'),
      reason: 'Final push milestone',
      explainability: `${explainabilityBase}; adaptive final ratio=${milestonePolicy.finalRatio}; ${milestonePolicy.reason}`,
    };
  }

  if (
    attentionCategory === 'productive_support' &&
    cooldownPassed &&
    focusScore > policy.thresholds.flowConfirmationScore &&
    elapsed >= policy.thresholds.flowConfirmationMinElapsedMinutes &&
    !session.emittedMilestones.includes('flow_confirmed')
  ) {
    session.emittedMilestones.push('flow_confirmed');
    return {
      type: 'speak',
      tone: 'flow_confirmed',
      text: buildSpeechText(session, 'speak'),
      reason: 'Sustained high-focus flow',
      explainability: `${explainabilityBase}; flow threshold crossed`,
    };
  }

  if (
    session.personalBestFocusScore !== null &&
    focusScore > session.personalBestFocusScore &&
    attentionCategory === 'productive_support' &&
    cooldownPassed &&
    !session.emittedMilestones.includes('personal_best')
  ) {
    session.emittedMilestones.push('personal_best');
    return {
      type: 'speak',
      tone: 'personal_best',
      text: `Personal best. Score ${focusScore}, up from your previous best of ${Math.round(session.personalBestFocusScore)}. Keep going.`,
      reason: 'New personal best focus score',
      explainability: `${explainabilityBase}; current score ${focusScore} exceeds historical best ${session.personalBestFocusScore}`,
    };
  }

  return { type: 'silence', reason: 'No intervention needed', explainability: explainabilityBase };
}

async function executeDecision(session: GuardianState, decision: GuardianDecision) {
  if (decision.type === 'silence') {
    return;
  }

  session.lastDecisionAt = Date.now();
  session.lastIntervention = decision;

  if (decision.command) {
    queueCommand(session.sessionId, decision.command);
    if (decision.command.type === 'block') {
      session.blockedCount += 1;
    }
  }

  emitSessionEvent(session.sessionId, {
    type: 'guardian_decision',
    decision,
  });

  if (decision.type === 'classify' && decision.command) {
    emitSessionEvent(session.sessionId, {
      type: 'intervention',
      action: 'classify',
      payload: { conceptTitle: decision.command.conceptTitle },
    });
  }

  if (decision.type === 'block') {
    emitSessionEvent(session.sessionId, {
      type: 'intervention',
      action: 'block',
      payload: {
        reason: decision.reason,
        explainability: decision.explainability,
        urlPattern: decision.command?.urlPattern,
      },
    });
  }

  if (decision.text) {
    await speak(session.sessionId, decision.text, decision.type === 'block' ? 'urgent' : 'normal', decision.tone || 'neutral');
    session.lastSpeechAt = Date.now();
  }
}

export function setImmediateBlockDomains(sessionId: string, domains: string[]) {
  const session = guardianSessions.get(sessionId);
  if (session) session.immediateBlockDomains = domains;
}

/**
 * Apply a user classification correction to all live active sessions in real-time.
 * Called from the Telegram classify callback so the guardian reacts immediately
 * without waiting for the next AI classification cycle.
 */
export function applyUserClassificationFeedback(
  domain: string,
  classification: 'on_topic' | 'distraction' | 'unknown'
) {
  for (const session of guardianSessions.values()) {
    if (session.state !== 'ACTIVE') continue;
    session.sessionClassificationCache[domain] = classification;
    if (getDomain(session.currentUrl) === domain) {
      session.currentClassification = classification;
    }
    // Persist the update through to the session_domain_classifications table
    try {
      getDb().prepare(`
        INSERT OR REPLACE INTO session_domain_classifications
          (session_id, domain, classification, classified_at)
        VALUES (?, ?, ?, ?)
      `).run(session.sessionId, domain, classification, Date.now());
    } catch { /* non-fatal */ }
  }
}

export function listGuardianSessions() {
  if (guardianSessions.size === 0) restoreSessionsFromDb();
  return Array.from(guardianSessions.values()).map(cloneSession);
}

/**
 * Adjust the duration of a live active session.
 * Mutates the live session in-memory and persists the change to DB.
 * Returns a clone of the updated session, or null if not found.
 */
export function adjustGuardianSessionDuration(sessionId: string, newDurationMinutes: number): GuardianState | null {
  const session = guardianSessions.get(sessionId);
  if (!session || session.state !== 'ACTIVE') return null;

  session.durationMinutes = newDurationMinutes;
  // Reset midpoint/final_push milestones so they re-fire at the correct % of the new duration
  session.emittedMilestones = session.emittedMilestones.filter(m => m !== 'midpoint' && m !== 'final_push');

  try {
    getDb().prepare(
      `UPDATE guardian_sessions SET duration_minutes = ? WHERE session_id = ?`
    ).run(newDurationMinutes, sessionId);

    // Sync to Google Calendar if this session was launched from a soft watch commitment
    const linkedCommitment = Array.from(softWatchMap.values()).find(c => c.lockedInSessionId === sessionId);
    if (linkedCommitment && linkedCommitment.calendarEventId) {
      const newEndTime = new Date(session.startedAt + newDurationMinutes * 60_000);
      updateCalendarEvent(linkedCommitment.calendarEventId, { endTime: newEndTime }).catch(() => {});
    }
  } catch { /* non-fatal */ }

  return cloneSession(session);
}


export function getGuardianSession(sessionId: string) {
  const session = guardianSessions.get(sessionId);
  return session ? cloneSession(session) : null;
}

export function getActiveGuardianSession(): GuardianState | null {
  if (guardianSessions.size === 0) restoreSessionsFromDb();
  const active = Array.from(guardianSessions.values()).find(s => s.state === 'ACTIVE' || s.state === 'BREAK');
  return active ? cloneSession(active) : null;
}

export function startGuardianSession(input: GuardianStartRequest): GuardianState {
  const sessionId = randomId('session');
  const startSnapshot = buildPersonalizationSnapshot({
    surface: 'intervention',
    maxInsights: 2,
    includeThresholds: true,
    includeMemoryFacts: 3,
  });
  const durationDecision = getAdaptiveSessionMinuteDecision(input.durationMinutes, startSnapshot);
  const durationMinutes = durationDecision.minutes;
  const targetTitle = input.conceptNodeName || input.goalTitle || input.topic || 'Deep Work';
  const briefing = getDayBriefing('default');

  // Compute energy composite at session start and persist for calibration
  const energyComponents = computeEnergyComposite();
  recordEnergyReading(energyComponents, sessionId);

  const session = createSessionState({
    sessionId,
    durationMinutes,
    targetTitle,
    mood: input.mood,
    goalId: input.goalId,
    goalTitle: input.goalTitle,
    conceptNodeId: input.conceptNodeId,
    conceptNodeName: input.conceptNodeName || input.topic || null,
    personalBestFocusScore: queryPersonalBestFocusScore(),
    energyComposite: energyComponents.composite_score,
  });

  guardianSessions.set(sessionId, session);

  // Fire-and-forget: resolve intent and generate dynamic policy for this session
  void (async () => {
    try {
      const intent = await resolveSessionIntent(input);
      session.intentProfile = intent;
      const dynamicPolicy = await generateDynamicPolicy(intent);
      session.sessionPolicy = dynamicPolicy;
      emitSessionEvent(sessionId, {
        type: 'session_state',
        state: session.state,
        targetTitle,
        workMode: intent.workMode,
        policyVersion: dynamicPolicy.version,
        sessionId,
      });
      console.log(`[guardian] Dynamic policy applied: mode=${intent.workMode}, policy=${dynamicPolicy.version}`);
    } catch (err) {
      console.warn('[guardian] Dynamic policy generation failed, using default:', err);
    }
  })();

  // Restore any previously persisted session classifications (handles server restart mid-session)
  try {
    const cached = getDb().prepare(
      'SELECT domain, classification FROM session_domain_classifications WHERE session_id = ?'
    ).all(sessionId) as { domain: string; classification: string }[];
    for (const row of cached) {
      session.sessionClassificationCache[row.domain] = row.classification as 'on_topic' | 'distraction' | 'unknown';
    }
  } catch { /* non-fatal — migration 020 may not have run yet */ }

  // Persist to DB so the session survives server restarts
  try {
    getDb().prepare(`
      INSERT OR IGNORE INTO guardian_sessions
        (session_id, target_title, goal_id, goal_title, concept_node_name, started_at, duration_minutes, mood)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, targetTitle,
      input.goalId || null, input.goalTitle || null,
      input.conceptNodeName || input.topic || null,
      session.startedAt, durationMinutes,
      input.mood || null
    );
  } catch (err) {
    console.error('[guardian] Failed to persist session to DB:', err);
  }

  linkSoftWatchToSession(sessionId, targetTitle);

  // Activate matching tasks → 'doing' (sync, fast keyword match)
  try {
    activateTasksForSession(targetTitle, input.goalId ?? null);
  } catch (err) {
    console.error('[guardian] activateTasksForSession failed:', err);
  }

  emitSessionEvent(sessionId, {
    type: 'session_state',
    state: session.state,
    targetTitle,
    plannedMinutes: session.durationMinutes,
    sessionId,
    explainability: 'Guardian session started and runtime ownership is now active for this session.',
  });

  session.lastSpeechAt = Date.now();
  // Fire-and-forget: generate personalized opening line via UIL then speak it
  void (async () => {
    const openingLine = await generateOpeningLine(briefing, {
      durationMinutes,
      topic: targetTitle,
      mood: input.mood,
    });
    void speak(sessionId, openingLine, 'urgent', 'flow_confirmed');
  })();

  // Fire-and-forget: Telegram notification + Google Calendar event
  void (async () => {
    await sendTelegram(formatSessionStart(targetTitle, durationMinutes, input.mood || startSnapshot.userState.mood || 'medium', durationDecision.reason), 'HTML', SESSION_START_KEYBOARD);

    if (isCalendarConfigured()) {
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);
      const eventId = await createCalendarEvent({
        summary: `📚 ${targetTitle}`,
        description: `LifeOS Guardian session — ${durationMinutes} min planned\nAdaptive duration: ${durationDecision.reason}\nMode: ${startSnapshot.moment.mode}; energy: ${startSnapshot.userState.energy}; mood: ${startSnapshot.userState.mood ?? 'unknown'}`,
        startTime,
        endTime,
        colorId: '9', // blueberry
        reminderSnapshot: startSnapshot,
      });
      if (eventId) calendarEventIds.set(sessionId, eventId);
    }
  })();

  const timer = setInterval(() => {
    void tickGuardianSession(sessionId, { sessionId, type: 'heartbeat', timestamp: Date.now() });
  }, 30_000);
  guardianIntervals.set(sessionId, timer);

  return cloneSession(session);
}

export function endGuardianSession(sessionId: string) {
  const session = guardianSessions.get(sessionId);
  if (!session) return null;

  // Flush the final tab's dwell time — the last page visited never gets a navigate-away event,
  // so its duration would otherwise be lost entirely. Fire-and-forget, non-blocking.
  if (
    session.currentUrl &&
    !session.currentUrl.startsWith('chrome://') &&
    session.currentTabStartedAt
  ) {
    const finalDwellSeconds = Math.round((Date.now() - session.currentTabStartedAt) / 1000);
    if (finalDwellSeconds > 5) {
      const finalUrl = session.currentUrl;
      const finalTitle = session.currentTitle;
      const finalTarget = session.targetTitle;
      const tabStartedAt = session.currentTabStartedAt; // capture before async
      void (async () => {
        try {
          let domain = '';
          try { domain = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { return; }
          const classification = await classifyActivity(finalUrl, finalTitle, domain, undefined);
          // Use the exact tab activation time — no retrocomputation drift
          const startedAt = new Date(tabStartedAt).toISOString();
          getDb().prepare(`
            INSERT INTO activities (url, domain, title, category, subcategory, started_at, duration_seconds, ai_classification, device_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(finalUrl, domain, finalTitle, classification.category, classification.subcategory, startedAt, finalDwellSeconds, JSON.stringify({ ...classification, sessionTarget: finalTarget }), 'LifeOS Guardian');
        } catch (err) {
          console.warn('[guardian] Failed to log final tab dwell:', err);
        }
      })();
    }
  }

  session.state = 'COMPLETE';
  clearHeartbeat(sessionId);
  persistSessionSummary(session);

  // Mark persistent session record as complete
  try {
    getDb().prepare(`UPDATE guardian_sessions SET state = 'COMPLETE' WHERE session_id = ?`).run(sessionId);
  } catch { /* non-fatal */ }

  const elapsedMinutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));

  // Credit time to the linked goal
  if (session.goalId) {
    logGoalTime(parseInt(session.goalId, 10) || null, sessionId, elapsedMinutes);
  }

  // Task completion is now driven by linked time targets in session-task-sync.
  // Avoid creating generic pending reviews for every focus session.

  // Write time-based habit checkins from this session
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const windowStart = new Date(session.startedAt).toISOString();
    const windowEnd = new Date().toISOString();
    const timeHabits = db.prepare(`
      SELECT h.id, h.name, h.icon, h.goal_metric, h.goal_target,
             CASE WHEN hc.id IS NOT NULL THEN hc.completed ELSE 0 END as checked_today,
             COALESCE(hc.value, 0) as today_value,
             g.title as goal_title,
             (SELECT COUNT(*) FROM habit_checkins WHERE habit_id = h.id AND completed = 1) as total_checkins
      FROM habits h
      LEFT JOIN goals g ON g.id = h.goal_id
      LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
      WHERE h.archived = 0 AND h.goal_metric = 'time'
    `).all(today) as AdaptiveHabitInput[];

    for (const habit of timeHabits) {
      const checkins = db.prepare('SELECT date FROM habit_checkins WHERE habit_id = ? AND completed = 1 ORDER BY date DESC').all(habit.id) as { date: string }[];
      habit.current_streak = getStreakCount(checkins.map(c => c.date));
      habit.automaticity_score = getAutomaticityScore(habit.current_streak);
    }

    const habitPersonalization = buildPersonalizationSnapshot({
      surface: 'habits',
      maxInsights: 2,
      includeMemoryFacts: 4,
    });
    const adaptivePlans = buildAdaptiveHabitPlans(timeHabits, habitPersonalization);

    for (const habit of timeHabits) {
      const existing = db.prepare(
        `SELECT id, value FROM habit_checkins WHERE habit_id = ? AND date = ?`
      ).get(habit.id, today) as { id: number; value: number } | undefined;
      const newValue = (existing?.value ?? 0) + elapsedMinutes;
      const todayTarget = adaptivePlans.get(habit.id)?.adaptive_today_target ?? habit.goal_target ?? 1;
      const completed = newValue >= todayTarget ? 1 : 0;
      if (existing) {
        db.prepare(
          `UPDATE habit_checkins SET value = ?, completed = ?, window_end = ?, session_id = ? WHERE id = ?`
        ).run(newValue, completed, windowEnd, sessionId, existing.id);
      } else {
        db.prepare(
          `INSERT INTO habit_checkins (habit_id, date, value, completed, source, session_id, window_start, window_end)
           VALUES (?, ?, ?, ?, 'guardian_session', ?, ?, ?)`
        ).run(habit.id, today, elapsedMinutes, completed, sessionId, windowStart, windowEnd);
      }
    }
  } catch (err) {
    console.error('[guardian] habit checkin write failed:', err);
  }
  const focusScores = session.focusScoreHistory.length ? session.focusScoreHistory : [100];
  const avgFocusScore = Math.round(focusScores.reduce((s, v) => s + v, 0) / focusScores.length);

  // Fire-and-forget: task completion assessment + reflection → Telegram + Calendar update
  void (async () => {
    // Assess task completion while reflection generates in parallel
    try {
      await evaluateSessionTaskCompletion(sessionId, session.targetTitle, elapsedMinutes, avgFocusScore);
    } catch (err) {
      console.error('[guardian] evaluateSessionTaskCompletion failed:', err);
    }

    // Wait briefly for reflection to be generated
    await new Promise(r => setTimeout(r, 3000));
    let reflection: string | undefined;
    try {
      const db = getDb();
      const row = db.prepare('SELECT reflection_text FROM guardian_session_reflections WHERE session_id = ?').get(sessionId) as { reflection_text: string } | undefined;
      reflection = row?.reflection_text;
    } catch { /* non-fatal */ }

    // Build a brief score breakdown from session event log
    const allTabEvents = session.tabEventLog.filter(e => isContinuityEvent(e));
    const distractionEvents = allTabEvents.filter(e => getEventClassification(session, e) === 'distraction');
    const totalSwitches = allTabEvents.length;
    const totalDistracted = distractionEvents.length;
    const breakdownParts: string[] = [];
    if (totalSwitches > 0) breakdownParts.push(`${totalSwitches} tab switch${totalSwitches === 1 ? '' : 'es'}`);
    if (totalDistracted > 0) breakdownParts.push(`${totalDistracted} distraction visit${totalDistracted === 1 ? '' : 's'}`);
    if (session.overrideCount > 0) breakdownParts.push(`${session.overrideCount} override${session.overrideCount === 1 ? '' : 's'}`);
    const totalIdleSeconds = session.tabEventLog.filter(e => e.type === 'idle').reduce((s, e) => s + (e.idleSeconds || 0), 0);
    if (totalIdleSeconds > 120) breakdownParts.push(`${Math.round(totalIdleSeconds / 60)}min idle`);
    const breakdown = breakdownParts.length > 0 ? breakdownParts.join(' · ') : undefined;

    await sendTelegram(formatSessionEnd(session.targetTitle, elapsedMinutes, avgFocusScore, session.blockedCount, reflection, breakdown), 'HTML', SESSION_END_KEYBOARD);

    // Post-session insight delivery — top insights from UIL profile (max once per 6h)
    void (async () => {
      try {
        const lastInsightSentAt = getSetting('last_uil_insight_sent_at');
        const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
        if (lastInsightSentAt && parseInt(lastInsightSentAt, 10) > sixHoursAgo) return;

        const { getIntelligenceProfile } = await import('./intelligence');
        const profile = getIntelligenceProfile();

        const insights: string[] = [];

        // Top 2 coaching insights
        if (profile.coachingInsights && profile.coachingInsights.length > 0) {
          const topInsights = profile.coachingInsights.slice(0, 2);
          insights.push(...topInsights.map((i: string) => `💡 ${i}`));
        }

        // Goal momentum changes
        if (profile.goalMomentum) {
          for (const [goal, momentum] of Object.entries(profile.goalMomentum)) {
            if (momentum === 'at_risk') {
              insights.push(`⚠️ <b>${goal}</b> is at risk — low momentum`);
            } else if (momentum === 'gaining') {
              insights.push(`📈 <b>${goal}</b> — momentum building`);
            }
          }
        }

        if (insights.length > 0) {
          const msg = insights.slice(0, 3).join('\n');
          await new Promise(resolve => setTimeout(resolve, 3000));
          await sendTelegram(msg, 'HTML');
          setSetting('last_uil_insight_sent_at', Date.now().toString());
        }
      } catch (err) {
        console.error('[Guardian] Post-session insight delivery failed:', err);
      }
    })();

    // Fire post-session classification review for low/medium confidence activities.
    // Small delay gives logActivityAsync time to flush final tab events.
    await new Promise(r => setTimeout(r, 5000));
    void sendSessionClassifyReview(sessionId);

    // Update calendar event with actual duration and focus score
    const eventId = calendarEventIds.get(sessionId);
    if (eventId && isCalendarConfigured()) {
      const focusQuality = adaptiveFocusQuality(avgFocusScore);
      await updateCalendarEvent(eventId, {
        summary: `📚 ${session.targetTitle} — ${focusQuality.label} focus (${avgFocusScore}/100)`,
        description: `LifeOS Guardian session\nElapsed: ${elapsedMinutes} min\nFocus score: ${avgFocusScore}/100\nAdaptive quality: ${focusQuality.reason}\nBlocks: ${session.blockedCount}\n\n${reflection ?? ''}`.trim(),
        endTime: new Date(),
        colorId: focusQuality.calendarColorId,
      });
      calendarEventIds.delete(sessionId);
    }
  })();

  void generateSessionReflection(session);
  // Signal the intelligence layer — session data is now committed to DB
  touchIntelligence('session_end');

  // Propagate knowledge graph mastery for the concept studied in this session
  if (session.conceptNodeId) {
    try {
      const nodeId = parseInt(session.conceptNodeId, 10);
      if (!isNaN(nodeId)) {
        // focusScore-weighted quality: 0 → low-quality session, 100 → high quality
        propagateMastery(null, null);
        // Direct node update with session quality as evidence
        const db = getDb();
        const node = db.prepare(`SELECT id, mastery FROM knowledge_nodes WHERE id = ?`).get(nodeId) as { id: number; mastery: number } | undefined;
        if (node) {
          const quality = Math.max(0.1, avgFocusScore / 100);
          const increment = quality * 0.05 * Math.min(1, elapsedMinutes / 30);
          const newMastery = Math.min(1.0, node.mastery + increment);
          db.prepare(`UPDATE knowledge_nodes SET mastery = ?, updated_at = datetime('now') WHERE id = ?`).run(newMastery, nodeId);
          console.log(`[guardian] mastery update: node ${nodeId} ${(node.mastery * 100).toFixed(0)}% → ${(newMastery * 100).toFixed(0)}%`);
        }
      }
    } catch (err) {
      console.error('[guardian] mastery propagation failed:', err);
    }
  }

  // Extract semantic memory from this session (background, non-blocking)
  void (async () => {
    // Wait for reflection to land in DB before reading it
    await new Promise(r => setTimeout(r, 8000));
    let reflection: string | null = null;
    try {
      const reflRow = getDb().prepare(
        'SELECT reflection_text FROM guardian_session_reflections WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(sessionId) as { reflection_text: string } | undefined;
      reflection = reflRow?.reflection_text ?? null;
    } catch { /* non-fatal */ }

    const domains = [...new Set(
      session.tabEventLog
        .map(e => getEventDomainKey(e))
        .filter((domain): domain is string => !!domain)
    )];

    await extractMemoryFromSession({
      sessionId,
      topic: session.targetTitle,
      durationMinutes: elapsedMinutes,
      focusScore: avgFocusScore,
      domains,
      interventions: session.blockedCount,
      overrides: session.overrideCount,
      reflection,
      mood: session.mood ?? null,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
    });
  })();
  emitSessionEvent(sessionId, {
    type: 'session_end',
    summary: {
      sessionId,
      elapsedMinutes: Math.max(1, Math.round((Date.now() - session.startedAt) / 60000)),
      focusScore: session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? 100,
      blockedCount: session.blockedCount,
      overrideCount: session.overrideCount,
      targetTitle: session.targetTitle,
    },
    explainability: 'Guardian session completed and heartbeat ownership was released.',
  });
  return cloneSession(session);
}

// ─── Post-session classification review ───────────────────────────────────────

/**
 * After session ends, find activities the AI wasn't confident about and send
 * the first one to Telegram with a confirm/flip/skip keyboard.
 * Each button press advances to the next item (handled by handleClassifyCallback
 * in the webhook route).
 */
async function sendSessionClassifyReview(sessionId: string) {
  try {
    // Deduplicate: only send ONE classify review per session
    const lastReviewedSession = getSetting('last_classify_review_session_id');
    if (lastReviewedSession === sessionId) return;

    const db = getDb();
    // Get the session start time to scope the activity query to THIS session only
    const sessionRow = db.prepare(`SELECT started_at FROM guardian_sessions WHERE session_id = ?`).get(sessionId) as { started_at: number } | undefined;
    const sessionStartIso = sessionRow?.started_at
      ? new Date(sessionRow.started_at).toISOString()
      : new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    // Low/medium confidence, meaningful dwell, not yet reviewed, deduplicated by domain.
    // Limit 5 so the review queue doesn't feel overwhelming.
    const rows = db.prepare(`
      SELECT id, domain, title, category, subcategory, classification_confidence, ai_classification
      FROM activities
      WHERE device_name = 'LifeOS Guardian'
        AND classification_confidence IN ('low', 'medium')
        AND classification_reviewed = 0
        AND duration_seconds >= 30
        AND started_at >= ?
      GROUP BY domain
      ORDER BY classification_confidence ASC, duration_seconds DESC
      LIMIT 5
    `).all(sessionStartIso) as Array<{
      id: number;
      domain: string;
      title: string;
      category: string;
      subcategory: string;
      classification_confidence: string;
      ai_classification: string;
    }>;

    if (rows.length === 0) return;

    const first = rows[0];
    const confLabel = first.classification_confidence === 'low' ? '🟡 not sure' : '🟠 unsure';
    const catLabel = first.category === 'productive' ? '✅ productive' : first.category === 'distraction' ? '❌ distraction' : '⚪ neutral';

    await sendTelegram(
      `🤔 <b>Quick calibration</b> (${rows.length} item${rows.length > 1 ? 's' : ''})\n\n` +
      `I classified <b>${first.domain}</b> as <b>${catLabel}</b> but I'm ${confLabel}.\n` +
      (first.title ? `📄 <i>${first.title.slice(0, 60)}</i>\n` : '') +
      `\nWas I right?`,
      'HTML',
      buildClassifyKeyboard(first.id)
    );
    // Mark this session as having received a classify review — prevents repeating
    setSetting('last_classify_review_session_id', sessionId);
  } catch (err) {
    console.error('[guardian] sendSessionClassifyReview failed:', err);
  }
}

export function pauseGuardianSession(sessionId: string) {
  const session = guardianSessions.get(sessionId);
  if (!session) return null;
  session.state = 'BREAK';
  emitSessionEvent(sessionId, {
    type: 'session_state',
    state: session.state,
    sessionId,
    explainability: 'Guardian session is paused and the runtime will ignore active-session interventions.',
  });
  return cloneSession(session);
}

export function resumeGuardianSession(sessionId: string) {
  const session = guardianSessions.get(sessionId);
  if (!session) return null;
  session.state = 'ACTIVE';
  emitSessionEvent(sessionId, {
    type: 'session_state',
    state: session.state,
    sessionId,
    explainability: 'Guardian session resumed and active intervention logic is enabled again.',
  });
  return cloneSession(session);
}

export function appendGuardianEvent(event: GuardianEvent): GuardianState | null {
  const session = guardianSessions.get(event.sessionId);
  if (!session || session.state !== 'ACTIVE') return null;

  const normalized: GuardianEvent = {
    ...event,
    timestamp: event.timestamp || Date.now(),
    domain: event.domain || getDomain(event.url),
    payload: {
      ...(event.payload || {}),
      classification: event.url ? classifyUrlForGuardian(event.url, session.sessionClassificationCache, true) : undefined,
      attentionCategory: event.url ? getAttentionCategory(session, event.url) : undefined,
    },
  };

  if (normalized.type === 'native_context') {
    const payload = normalized.payload ?? {};
    const app = typeof payload.appInFocus === 'string' && payload.appInFocus.trim()
      ? payload.appInFocus.trim()
      : 'Unknown App';
    const title = normalized.title || (typeof payload.windowTitle === 'string' ? payload.windowTitle : '') || app;
    const classification = classificationFromNativeCategory(payload.category);

    normalized.url = normalized.url || nativeAppUrl(app);
    normalized.domain = normalized.domain || `native:${app.toLowerCase()}`;
    normalized.title = title;
    normalized.payload = {
      ...payload,
      appInFocus: app,
      windowTitle: title,
      classification,
      attentionCategory: classification === 'on_topic'
        ? 'productive_support'
        : classification === 'distraction'
          ? 'blocked_distractor'
          : 'ambiguous_context',
    };

    session.currentUrl = normalized.url;
    session.currentTitle = title;
    session.currentClassification = classification;
    session.currentTabStartedAt = normalized.timestamp;
  }

  if (normalized.type === 'tab') {
    session.currentUrl = normalized.url || '';
    session.currentTitle = normalized.title || '';
    session.currentClassification = classifyUrlForGuardian(normalized.url, session.sessionClassificationCache, true);
    session.currentTabStartedAt = normalized.timestamp;

    // Fire-and-forget: run classifyActivity with session context so classification is
    // session-aware (YouTube = productive during "Watch lecture", distraction otherwise).
    // Fires whenever the domain has NOT yet been classified in this specific session —
    // even if domain_categories has a cached result, because a general cache entry
    // (e.g. github.com = productive) may be wrong for THIS session topic.
    let tabDomain = '';
    try { tabDomain = new URL(normalized.url || '').hostname.replace(/^www\./, ''); } catch { /* */ }
    if (normalized.url && tabDomain && !session.sessionClassificationCache[tabDomain]) {
      const sessionId = session.sessionId;
      const targetTitle = session.targetTitle;
      const goalTitle = session.goalTitle ?? null;
      const urlToClassify = normalized.url;
      const titleToClassify = normalized.title || '';
      void (async () => {
        try {
          const domain = tabDomain;
          if (!domain || domain.startsWith('chrome')) return;
          const r = await classifyActivity(urlToClassify, titleToClassify, domain, undefined, { targetTitle, goalTitle });
          const mapped: 'on_topic' | 'distraction' | 'unknown' =
            r.category === 'productive' ? 'on_topic' :
            r.category === 'distraction' ? 'distraction' : 'unknown';
          const live = guardianSessions.get(sessionId);
          if (live) {
            live.sessionClassificationCache[domain] = mapped;
            if (live.currentUrl === urlToClassify) live.currentClassification = mapped;
            // Write-through to DB so classification survives server restarts
            try {
              getDb().prepare(`
                INSERT OR REPLACE INTO session_domain_classifications
                  (session_id, domain, classification, classified_at)
                VALUES (?, ?, ?, ?)
              `).run(sessionId, domain, mapped, Date.now());
            } catch { /* non-fatal — table created by migration 020 */ }
            // Retroactively credit already-elapsed dwell time. Tab events were appended with
            // 'unknown' classification before this async result arrived — fix them now so the
            // focus score reflects actual continuity for time already spent on this domain.
            if (mapped !== 'unknown') {
              const attentionCategory = mapped === 'on_topic' ? 'productive_support' : 'blocked_distractor';
              for (const evt of live.tabEventLog) {
                if (evt.type === 'tab' && evt.payload?.classification === 'unknown') {
                  let evtDomain = '';
                  try { evtDomain = new URL(evt.url || '').hostname.replace(/^www\./, ''); } catch { /* */ }
                  if (evtDomain === domain) {
                    evt.payload.classification = mapped;
                    evt.payload.attentionCategory = attentionCategory;
                  }
                }
              }
              // Re-emit an updated focus score so the dashboard reflects the correction.
              const policy = session.sessionPolicy ?? getActiveGuardianPolicyBundle();
              const updated = computeFocusScore(live, policy);
              if (live.focusScoreHistory.length > 0) {
                live.focusScoreHistory[live.focusScoreHistory.length - 1] = updated.score;
              }
              emitSessionEvent(live.sessionId, {
                type: 'focus_score',
                score: updated.score,
                delta: 0,
                trend: updated.trend,
              });
            }
          }
        } catch { /* non-fatal */ }
      })();
    }
  }

  if (normalized.type === 'idle') {
    session.currentClassification = 'unknown';
  }

  if (normalized.type === 'screen_vision') {
    const { signal, screenContext } = (normalized.payload ?? {}) as {
      signal?: import('./guardian-types').ScreenVisionSignal;
      screenContext?: import('./guardian-types').ScreenContext;
      visionSkipped?: boolean;
    };

    // Update screenContext from the fully-computed context sent by the vision route
    if (screenContext) {
      session.screenContext = screenContext;
    }

    // Vision acts as classification authority — if confidence is high enough,
    // directly seed the session classification cache for the active domain.
    // This resolves the async timing gap for context-sensitive domains (e.g. youtube.com).
    if (signal && signal.confidence >= 0.65 && session.currentUrl) {
      let activeDomain = '';
      try { activeDomain = new URL(session.currentUrl).hostname.replace(/^www\./, ''); } catch { /* */ }

      if (activeDomain) {
        const mapped: 'on_topic' | 'distraction' | 'unknown' =
          signal.taskAlignment >= 65 ? 'on_topic' :
          signal.taskAlignment <= 25 ? 'distraction' : 'unknown';

        if (mapped !== 'unknown') {
          session.sessionClassificationCache[activeDomain] = mapped;
          session.currentClassification = mapped;

          // Retroactively patch prior tab events logged as 'unknown' for this domain
          for (const evt of session.tabEventLog) {
            if (evt.type === 'tab' && evt.payload?.classification === 'unknown') {
              let evtDomain = '';
              try { evtDomain = new URL(evt.url || '').hostname.replace(/^www\./, ''); } catch { /* */ }
              if (evtDomain === activeDomain) {
                evt.payload.classification = mapped;
                evt.payload.attentionCategory = mapped === 'on_topic' ? 'productive_support' : 'blocked_distractor';
              }
            }
          }
        }
      }
    }

    // Don't push screen_vision events to tabEventLog — they live in screenContext
    return cloneSession(session);
  }

  session.tabEventLog.push(normalized);
  return cloneSession(session);
}

export async function tickGuardianSession(sessionId: string, inputEvent?: GuardianEvent) {
  // Lazy restore: if session missing, try to pull it back from DB (handles server restarts)
  if (!guardianSessions.has(sessionId) && guardianSessions.size === 0) {
    restoreSessionsFromDb();
  }
  const session = guardianSessions.get(sessionId);
  const sourceEventType = inputEvent?.type ?? 'system';
  if (!session || session.state !== 'ACTIVE') {
    return {
      session: null,
      decision: finalizeDecision(
        sessionId,
        { type: 'silence', reason: 'Session not active', explainability: 'The runtime ignored the tick because the session is missing or not active.' },
        sourceEventType
      ),
      commands: [],
    };
  }

  // Auto-end session when planned duration has elapsed
  if (session.endsAt && Date.now() >= session.endsAt) {
    endGuardianSession(sessionId);
    return {
      session: null,
      decision: finalizeDecision(
        sessionId,
        { type: 'silence', reason: 'Session expired', explainability: 'The planned session duration was reached and the session was automatically ended.' },
        sourceEventType
      ),
      commands: [],
    };
  }

  if (inputEvent) {
    appendGuardianEvent(inputEvent);
  }

  emitExpiredOverrideCommands(session);

  session.tick += 1;
  const policy = session.sessionPolicy ?? getActiveGuardianPolicyBundle();
  const focus = computeFocusScore(session, policy, session.energyComposite);
  session.focusScoreHistory.push(focus.score);

  emitSessionEvent(sessionId, {
    type: 'focus_score',
    score: focus.score,
    delta: session.focusScoreHistory.length > 1 ? focus.score - session.focusScoreHistory[session.focusScoreHistory.length - 2] : 0,
    trend: focus.trend,
    components: focus.components,
  });

  emitSessionEvent(sessionId, {
    type: 'session_stats',
    elapsed: Math.max(1, Math.round((Date.now() - session.startedAt) / 1000)),
    onTopicTime: focus.onTopicSeconds,
    distractions: focus.distractionCount,
    blockedCount: session.blockedCount,
    overrideCount: session.overrideCount,
  });

  const decision = finalizeDecision(sessionId, decide(session, policy), sourceEventType);
  await executeDecision(session, decision);
  persistTick(session, decision);

  const commands = consumeGuardianCommands(sessionId);
  return { session: cloneSession(session), decision, commands };
}

export function consumeGuardianCommands(sessionId: string) {
  const commands = guardianCommands.get(sessionId) || [];
  guardianCommands.set(sessionId, []);
  return commands.map((command) => ({ ...command }));
}

function getAdaptiveOverrideFollowUpDelayMinutes(input: {
  decision: OverrideDecision;
  request: OverrideRequest;
  session?: GuardianState;
}): { minutes: number; reason: string } {
  const snapshot = buildPersonalizationSnapshot({
    surface: 'intervention',
    maxInsights: 2,
    includeMemoryFacts: 3,
    activeSession: input.session ? {
      sessionId: input.session.sessionId,
      targetTitle: input.session.targetTitle,
      focusScore: input.session.focusScoreHistory.at(-1) ?? null,
      elapsedMinutes: Math.max(0, Math.round((Date.now() - input.session.startedAt) / 60_000)),
    } : null,
  });
  const classification = classifyUrlForGuardian(input.request.url, input.session?.sessionClassificationCache, Boolean(input.session));
  const ttl = Math.max(1, input.decision.ttlMinutes);
  let minutes = Math.max(5, Math.round(ttl * 1.2));
  const reasons = [`${ttl}m approved TTL`];

  if (classification === 'distraction') {
    minutes = Math.min(minutes, Math.max(5, Math.round(ttl * 0.75)));
    reasons.push('domain looks distraction-prone');
  }
  if (snapshot.moment.mode === 'protect_focus') {
    minutes = Math.min(minutes, Math.max(5, Math.round(ttl * 0.8)));
    reasons.push('active focus should be protected');
  }
  if (snapshot.moment.mode === 'recovery' || snapshot.feedback.alertFatigueLevel === 'high') {
    minutes = Math.max(minutes, Math.min(45, ttl + 10));
    reasons.push(snapshot.moment.mode === 'recovery' ? 'recovery mode reduces interruption pressure' : 'alert fatigue is high');
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    minutes = Math.min(minutes, Math.max(6, ttl));
    reasons.push('deadline pressure needs faster accountability');
  }

  return {
    minutes: Math.max(5, Math.min(45, minutes)),
    reason: reasons.join('; '),
  };
}

export async function adjudicateOverride(request: OverrideRequest): Promise<OverrideDecision> {
  const session = guardianSessions.get(request.sessionId);
  const requestedMinutes = Math.max(1, Math.min(30, request.requestedMinutes || 10));
  const urlDomain = getDomain(request.url) || request.url;
  const rubric = getActiveGuardianPolicyBundle().prompts.overrideRubric;

  let decision: OverrideDecision = {
    approved: false,
    reason: 'Override denied',
    explainability: 'The requested target did not clear the study-relevance and boundedness checks.',
    ttlMinutes: requestedMinutes,
    reviewedAt: nowIso(),
  };

  const lowerReason = request.reason.toLowerCase();
  const blanketDisableAttempt =
    lowerReason.includes('disable guardian') ||
    lowerReason.includes('turn this off') ||
    lowerReason.includes('disable for the whole session') ||
    lowerReason.includes('let me do anything');
  const looksWorkRelated =
    lowerReason.includes('assignment') ||
    lowerReason.includes('reference') ||
    lowerReason.includes('solution') ||
    lowerReason.includes('docs') ||
    lowerReason.includes('tutorial');

  if (blanketDisableAttempt) {
    decision = {
      approved: false,
      reason: 'Override denied for blanket disable attempt',
      explainability: `Denied because overrides must stay scoped to one target and a short TTL. Blanket guardian disable requests are not allowed. Rubric: ${rubric}`,
      ttlMinutes: requestedMinutes,
      reviewedAt: nowIso(),
    };
  } else if (classifyUrlForGuardian(request.url, session?.sessionClassificationCache, true) === 'on_topic' || looksWorkRelated) {
    decision = {
      approved: true,
      reason: 'Targeted override approved',
      explainability: `Approved because the request was bounded, temporary, and plausibly related to the active session target. Rubric: ${rubric}`,
      ttlMinutes: requestedMinutes,
      reviewedAt: nowIso(),
    };
  } else if (classifyUrlForGuardian(request.url, session?.sessionClassificationCache, true) === 'distraction') {
    decision = {
      approved: false,
      reason: 'Override denied for distraction target',
      explainability: `Denied because the target appears to be a distraction domain and the reason was not strong enough to justify a temporary exception. Rubric: ${rubric}`,
      ttlMinutes: requestedMinutes,
      reviewedAt: nowIso(),
    };
  }

  const ai = getGenAI();
  if (ai) {
    try {
      const result = await generateWithFallback(ai, {
        model: MODEL_FLASH,
        contents: `Decide whether to approve this temporary browsing override during a hard study session. Return JSON only.
Session target: ${session?.targetTitle || 'unknown'}
URL: ${request.url}
Title: ${request.title || ''}
Reason: ${request.reason}
Requested minutes: ${requestedMinutes}
Rubric: ${rubric}

JSON schema:
{
  "approved": true,
  "reason": "short reason",
  "explainability": "1-2 sentence human-readable explanation",
  "ttlMinutes": 10
}`,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const parsed = JSON.parse((result.text || '').trim() || '{}') as Partial<OverrideDecision>;
      if (typeof parsed.approved === 'boolean' && parsed.reason && parsed.explainability) {
        decision = {
          approved: parsed.approved,
          reason: parsed.reason,
          explainability: parsed.explainability,
          ttlMinutes: Math.max(1, Math.min(30, parsed.ttlMinutes || requestedMinutes)),
          reviewedAt: nowIso(),
        };
      }
    } catch (error) {
      console.error('[GuardianRuntime] AI override adjudication failed', error);
    }
  }

  if (blanketDisableAttempt) {
    decision = {
      approved: false,
      reason: 'Override denied for blanket disable attempt',
      explainability: `Denied because overrides must stay scoped to one target and a short TTL. Blanket guardian disable requests are not allowed. Rubric: ${rubric}`,
      ttlMinutes: requestedMinutes,
      reviewedAt: nowIso(),
    };
  }

  if (session && decision.approved) {
    const activeOverride: ActiveOverride = {
      id: randomId('override'),
      urlPattern: urlDomain,
      title: request.title,
      reason: request.reason,
      approvedAt: Date.now(),
      expiresAt: Date.now() + decision.ttlMinutes * 60_000,
      explainability: decision.explainability,
    };
    session.activeOverrides.push(activeOverride);
    session.overrideCount += 1;
    queueCommand(request.sessionId, {
      id: randomId('cmd'),
      type: 'unblock',
      sessionId: request.sessionId,
      reason: decision.reason,
      explainability: decision.explainability,
      urlPattern: urlDomain,
      ttlSeconds: decision.ttlMinutes * 60,
      sourceEventType: 'override_decision',
      createdAt: Date.now(),
    });

    // Schedule a follow-up from the approved TTL and current intervention context.
    try {
      const db = getDb();
      const followUp = getAdaptiveOverrideFollowUpDelayMinutes({ decision, request, session });
      const followUpAt = new Date(Date.now() + followUp.minutes * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO override_follow_ups (session_id, override_url, override_reason, follow_up_at)
        VALUES (?, ?, ?, ?)
      `).run(request.sessionId, request.url, request.reason, followUpAt);
      console.log(`[GuardianRuntime] Override follow-up scheduled in ${followUp.minutes}m: ${followUp.reason}`);
    } catch (followUpErr) {
      console.error('[GuardianRuntime] Failed to schedule override follow-up', followUpErr);
    }
  }

  emitSessionEvent(request.sessionId, {
    type: 'override_decision',
    decision,
    url: request.url,
  });

  persistOverride(request, decision);
  return decision;
}

export function getGuardianContext() {
  const db = getDb();
  const recommendedSessionMinutes = getAdaptiveSessionMinutes();
  const activeGoals = db.prepare(`
    SELECT id, title, description
    FROM goals
    WHERE active = 1
  `).all();
  const activeTasks = db.prepare(`
    SELECT id, title, description, goal_id
    FROM tasks
    WHERE status IN ('doing', 'todo')
  `).all();
  const activeSession = listGuardianSessions().find((session) => session.state === 'ACTIVE') || null;
  // Consume pending speech (read-once) so the dashboard can speak it via Web Speech API.
  const pendingSpeech = activeSession ? consumePendingSpeech(activeSession.sessionId) : null;
  return {
    activeGoals,
    activeTasks,
    activeSession,
    pendingSpeech,
    adaptiveDefaults: {
      recommendedSessionMinutes,
    },
  };
}

export function recordGuardianCanary(score: number, notes: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO guardian_canary_results (guardian_eval_score, status, notes)
    VALUES (?, ?, ?)
  `).run(score, score >= 0 ? 'passed' : 'failed', notes);
}

export function seedGuardianBaselineEval() {
  recordGuardianEvalRun({
    guardianEvalScore: 0,
    status: 'passed',
    summary: 'Initial guardian baseline seeded.',
  });
}

// ─── SOFT_WATCH ──────────────────────────────────────────────────────────────

interface SoftWatchPolicy {
  reminderWindowMs: number;
  checkInDelayMs: number;
  expireMs: number;
  tone: 'gentle' | 'normal' | 'direct';
  reason: string;
}

export function buildSoftWatchPolicy(commitment: Pick<SoftWatchCommitment, 'plannedMinutes' | 'targetTitle'>): SoftWatchPolicy {
  try {
    const snapshot = buildPersonalizationSnapshot({
      surface: 'scheduler',
      maxInsights: 2,
      includeMemoryFacts: 3,
    });
    const plannedMinutes = Math.max(5, Number(commitment.plannedMinutes || getAdaptiveSessionMinutes()));
    const lowEnergy = snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low';
    const deadlinePressure = snapshot.moment.mode === 'deadline_pressure' || snapshot.today.overdueTasks > 0;
    const alertFatigue = snapshot.feedback.alertFatigueLevel;

    if (deadlinePressure) {
      return {
        reminderWindowMs: 8 * 60_000,
        checkInDelayMs: Math.max(10, Math.min(20, Math.round(plannedMinutes * 0.35))) * 60_000,
        expireMs: Math.max(45, Math.round(plannedMinutes * 1.25)) * 60_000,
        tone: 'direct',
        reason: 'deadline pressure shortens the follow-up loop',
      };
    }

    if (lowEnergy) {
      return {
        reminderWindowMs: 12 * 60_000,
        checkInDelayMs: Math.max(25, Math.min(45, Math.round(plannedMinutes * 0.7))) * 60_000,
        expireMs: Math.max(75, Math.round(plannedMinutes * 1.75)) * 60_000,
        tone: 'gentle',
        reason: 'recovery/low energy gives more ramp time',
      };
    }

    if (alertFatigue === 'high') {
      return {
        reminderWindowMs: 4 * 60_000,
        checkInDelayMs: Math.max(35, Math.round(plannedMinutes * 0.75)) * 60_000,
        expireMs: Math.max(70, Math.round(plannedMinutes * 1.5)) * 60_000,
        tone: 'gentle',
        reason: 'high alert fatigue reduces reminder pressure',
      };
    }

    return {
      reminderWindowMs: 5 * 60_000,
      checkInDelayMs: Math.max(20, Math.min(40, Math.round(plannedMinutes * 0.55))) * 60_000,
      expireMs: Math.max(60, Math.round(plannedMinutes * 1.5)) * 60_000,
      tone: 'normal',
      reason: 'balanced timing from planned session length',
    };
  } catch {
    return {
      reminderWindowMs: 5 * 60_000,
      checkInDelayMs: 30 * 60_000,
      expireMs: 60 * 60_000,
      tone: 'normal',
      reason: 'fallback soft-watch timing',
    };
  }
}

function formatPolicyMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function persistSoftWatch(c: SoftWatchCommitment) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, goal_id, task_id, intended_start_at, planned_minutes,
        source, reminder_sent_at, check_in_sent_at, status, locked_in_session_id, calendar_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        reminder_sent_at = excluded.reminder_sent_at,
        check_in_sent_at = excluded.check_in_sent_at,
        locked_in_session_id = excluded.locked_in_session_id,
        calendar_event_id = excluded.calendar_event_id
    `).run(
      c.id, c.targetTitle, c.goalId, c.taskId, c.intendedStartAt, c.plannedMinutes,
      c.source, c.reminderSentAt, c.checkInSentAt, c.status, c.lockedInSessionId, c.calendarEventId, c.createdAt
    );
  } catch (error) {
    console.error('[GuardianRuntime] Failed to persist soft watch', error);
  }
}

function updateCommitmentFollowThroughRate() {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT status FROM soft_watch_commitments
      WHERE status IN ('locked_in', 'expired')
    `).all() as Array<{ status: string }>;
    if (rows.length === 0) return;
    const lockedIn = rows.filter((r) => r.status === 'locked_in').length;
    const rate = lockedIn / rows.length;
    db.prepare(`
      UPDATE guardian_semantic_profiles
      SET commitment_follow_through_rate = ?, updated_at = datetime('now', 'localtime')
      WHERE user_id = 'default'
    `).run(rate);
  } catch (error) {
    console.error('[GuardianRuntime] Failed to update follow-through rate', error);
  }
}

function tickSoftWatchChecker() {
  const now = Date.now();
  for (const [id, commitment] of softWatchMap) {
    if (commitment.status !== 'pending') continue;

    const sincStart = now - commitment.intendedStartAt;

    const policy = buildSoftWatchPolicy(commitment);

    // Expire according to current mode and planned session length.
    if (sincStart > policy.expireMs) {
      commitment.status = 'expired';
      softWatchMap.set(id, commitment);
      persistSoftWatch(commitment);
      updateCommitmentFollowThroughRate();
      console.log(`[SoftWatch] Commitment ${id} expired: ${commitment.targetTitle}`);
      continue;
    }

    // Reminder: fire once inside the adaptive start window.
    if (!commitment.reminderSentAt && Math.abs(now - commitment.intendedStartAt) <= policy.reminderWindowMs) {
      commitment.reminderSentAt = now;
      softWatchMap.set(id, commitment);
      persistSoftWatch(commitment);
      void speak(
        'soft_watch',
        policy.tone === 'gentle'
          ? `Soft reminder — ${commitment.targetTitle} is coming up. Want to start small?`
          : `Heads up — you planned to work on ${commitment.targetTitle} now. Ready to lock in?`,
        policy.tone === 'direct' ? 'urgent' : 'normal',
        'midpoint_checkin'
      );
      void sendTelegram(`${formatSoftWatchReminder(commitment.targetTitle, 0)}\n\n<i>${policy.reason}</i>`, 'HTML', SOFT_WATCH_KEYBOARD);
      continue;
    }

    // Check-in: fire once after the adaptive grace period and still pending.
    if (!commitment.checkInSentAt && sincStart >= policy.checkInDelayMs) {
      commitment.checkInSentAt = now;
      softWatchMap.set(id, commitment);
      persistSoftWatch(commitment);
      const delayMinutes = formatPolicyMinutes(policy.checkInDelayMs);
      void speak(
        'soft_watch',
        policy.tone === 'gentle'
          ? `Still holding ${commitment.targetTitle}. Do you want a smaller start or should I let it go?`
          : `Still here. You committed to ${commitment.targetTitle} about ${delayMinutes} minutes ago. Start now or let it go?`,
        policy.tone === 'direct' ? 'urgent' : 'normal',
        'direct_push'
      );
      void sendTelegram(`⏰ <b>Still pending</b>\n\nYou committed to <b>${commitment.targetTitle}</b> about ${delayMinutes} min ago and haven't started. Lock in, shrink it, or reschedule?\n\n<i>${policy.reason}</i>`, 'HTML', SOFT_WATCH_KEYBOARD);
    }
  }
}

export function startSoftWatchChecker() {
  if (globalGuardian.softWatchCheckerInterval) return;
  // Load any pending commitments from DB on startup
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, target_title as targetTitle, goal_id as goalId, task_id as taskId,
        intended_start_at as intendedStartAt, planned_minutes as plannedMinutes,
        source, reminder_sent_at as reminderSentAt, check_in_sent_at as checkInSentAt,
        status, locked_in_session_id as lockedInSessionId, calendar_event_id as calendarEventId, created_at as createdAt
      FROM soft_watch_commitments
      WHERE status = 'pending'
    `).all() as SoftWatchCommitment[];
    for (const row of rows) {
      softWatchMap.set(row.id, row);
    }
  } catch {
    // Table may not exist yet; will be created on next DB init
  }

  const interval = setInterval(tickSoftWatchChecker, 5 * 60_000);
  globalGuardian.softWatchCheckerInterval = interval;
}

export function createSoftWatchCommitment(input: {
  targetTitle: string;
  goalId?: number | null;
  taskId?: number | null;
  intendedStartAt: number;
  plannedMinutes?: number;
  source?: 'voice' | 'dashboard' | 'calendar' | 'telegram';
}): SoftWatchCommitment {
  const commitment: SoftWatchCommitment = {
    id: randomId('sw'),
    targetTitle: input.targetTitle,
    goalId: input.goalId ?? null,
    taskId: input.taskId ?? null,
    intendedStartAt: input.intendedStartAt,
    plannedMinutes: input.plannedMinutes ?? getAdaptiveSessionMinutes(),
    source: input.source ?? 'voice',
    reminderSentAt: null,
    checkInSentAt: null,
    status: 'pending',
    lockedInSessionId: null,
    calendarEventId: null,
    createdAt: Date.now(),
  };
  softWatchMap.set(commitment.id, commitment);
  persistSoftWatch(commitment);

  // Start checker if not already running
  startSoftWatchChecker();

  void speak(
    'soft_watch',
    `Noted. I'll remind you to start ${commitment.targetTitle} at ${new Date(commitment.intendedStartAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
    'normal',
    'neutral'
  );

  return { ...commitment };
}

export function listSoftWatchCommitments(): SoftWatchCommitment[] {
  return Array.from(softWatchMap.values())
    .filter((c) => c.status === 'pending' || c.status === 'locked_in')
    .sort((a, b) => a.intendedStartAt - b.intendedStartAt)
    .map((c) => ({ ...c }));
}

function loadCurrentPendingSoftWatch(): SoftWatchCommitment | null {
  const now = Date.now();
  const selected = Array.from(softWatchMap.values())
    .filter((c) => c.status === 'pending')
    .sort((a, b) => {
      const aTouched = a.checkInSentAt || a.reminderSentAt ? 0 : 1;
      const bTouched = b.checkInSentAt || b.reminderSentAt ? 0 : 1;
      if (aTouched !== bTouched) return aTouched - bTouched;
      return Math.abs(a.intendedStartAt - now) - Math.abs(b.intendedStartAt - now);
    })[0];

  if (selected) return { ...selected };

  try {
    const row = getDb().prepare(`
      SELECT id, target_title as targetTitle, goal_id as goalId, task_id as taskId,
        intended_start_at as intendedStartAt, planned_minutes as plannedMinutes,
        source, reminder_sent_at as reminderSentAt, check_in_sent_at as checkInSentAt,
        status, locked_in_session_id as lockedInSessionId, calendar_event_id as calendarEventId, created_at as createdAt
      FROM soft_watch_commitments
      WHERE status = 'pending'
      ORDER BY
        CASE WHEN check_in_sent_at IS NOT NULL THEN 0 WHEN reminder_sent_at IS NOT NULL THEN 1 ELSE 2 END,
        ABS(intended_start_at - ?)
      LIMIT 1
    `).get(now) as SoftWatchCommitment | undefined;
    if (!row) return null;
    softWatchMap.set(row.id, row);
    return { ...row };
  } catch {
    return null;
  }
}

export function snoozeCurrentSoftWatchCommitment(): {
  ok: boolean;
  targetTitle?: string;
  snoozeMinutes?: number;
  reason?: string;
} {
  const commitment = loadCurrentPendingSoftWatch();
  if (!commitment) return { ok: false, reason: 'no pending soft watch found' };

  const policy = buildSoftWatchPolicy(commitment);
  const snoozeMinutes = Math.max(8, Math.min(45, formatPolicyMinutes(policy.checkInDelayMs)));
  const newStartAt = Date.now() + snoozeMinutes * 60_000;
  const ok = rescheduleSoftWatchCommitment(commitment.id, newStartAt, commitment.plannedMinutes);
  return {
    ok,
    targetTitle: commitment.targetTitle,
    snoozeMinutes,
    reason: policy.reason,
  };
}

export function dismissCurrentSoftWatchCommitment(): SoftWatchCommitment | null {
  const commitment = loadCurrentPendingSoftWatch();
  if (!commitment) return null;
  return dismissSoftWatchCommitment(commitment.id) ? commitment : null;
}

export function dismissSoftWatchCommitment(id: string): boolean {
  const commitment = softWatchMap.get(id);
  if (!commitment) return false;
  commitment.status = 'dismissed';
  softWatchMap.set(id, commitment);
  persistSoftWatch(commitment);
  
  if (commitment.calendarEventId) {
    deleteCalendarEvent(commitment.calendarEventId).catch(() => {});
  }
  return true;
}

export function rescheduleSoftWatchCommitment(id: string, newStartAt: number, newMinutes?: number): boolean {
  const commitment = softWatchMap.get(id);
  if (!commitment) return false;
  commitment.intendedStartAt = newStartAt;
  if (newMinutes) commitment.plannedMinutes = newMinutes;
  
  // Wipe triggers so they fire again at the new time
  commitment.reminderSentAt = null;
  commitment.checkInSentAt = null;
  
  softWatchMap.set(id, commitment);
  persistSoftWatch(commitment);
  
  if (commitment.calendarEventId) {
    const startTime = new Date(newStartAt);
    const endTime = new Date(newStartAt + commitment.plannedMinutes * 60_000);
    updateCalendarEvent(commitment.calendarEventId, { startTime, endTime }).catch(() => {});
  }
  return true;
}

function linkSoftWatchToSession(sessionId: string, targetTitle: string) {
  for (const [id, commitment] of softWatchMap) {
    if (commitment.status !== 'pending') continue;
    if (commitment.targetTitle.toLowerCase() !== targetTitle.toLowerCase()) continue;
    const now = Date.now();
    // Link if intended start was within the last 90 minutes
    if (now - commitment.intendedStartAt <= 90 * 60_000) {
      commitment.status = 'locked_in';
      commitment.lockedInSessionId = sessionId;
      softWatchMap.set(id, commitment);
      persistSoftWatch(commitment);
      updateCommitmentFollowThroughRate();
      break;
    }
  }
}

export function attachCalendarEventId(commitmentId: string, eventId: string): boolean {
  const commitment = softWatchMap.get(commitmentId);
  if (!commitment) return false;
  commitment.calendarEventId = eventId;
  softWatchMap.set(commitmentId, commitment);
  persistSoftWatch(commitment);
  return true;
}
