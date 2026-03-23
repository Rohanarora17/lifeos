import { getDb, getSetting } from './db';
import { computeFocusScore } from './focus-score';
import { speak } from './tts';
import { getDayBriefing, generateOpeningLine, updateGuardianSemanticProfile } from './longitudinal-engine';
import { getGenAI } from './ai';
import { MODEL_FLASH } from './models';
import { getActiveGuardianPolicyBundle, recordGuardianEvalRun } from './guardian-optimizer';
import { emitGuardianRuntimeEvent } from './guardian-bus';
import {
  ActiveOverride,
  GuardianCommand,
  GuardianDecision,
  GuardianDecisionSource,
  GuardianEvent,
  GuardianPolicyBundle,
  GuardianStartRequest,
  GuardianState,
  OverrideDecision,
  OverrideRequest,
  SoftWatchCommitment,
} from './guardian-types';

const DISTRACTION_DOMAINS = ['youtube.com', 'twitter.com', 'x.com', 'reddit.com', 'instagram.com', 'facebook.com'];
const PRODUCTIVE_DOMAINS = ['docs.', 'developer.mozilla.org', 'leetcode.com', 'khanacademy.org', 'coursera.org', 'edx.org', 'wikipedia.org'];

// guardian-runtime is the single owner of live session state.
// Routes ingest input and render output, but do not mutate session state directly.
const globalGuardian = global as unknown as {
  guardianSessions?: Map<string, GuardianState>;
  guardianIntervals?: Map<string, ReturnType<typeof setInterval>>;
  guardianCommands?: Map<string, GuardianCommand[]>;
  softWatchMap?: Map<string, SoftWatchCommitment>;
  softWatchCheckerInterval?: ReturnType<typeof setInterval>;
};

const guardianSessions = globalGuardian.guardianSessions || new Map<string, GuardianState>();
const guardianIntervals = globalGuardian.guardianIntervals || new Map<string, ReturnType<typeof setInterval>>();
const guardianCommands = globalGuardian.guardianCommands || new Map<string, GuardianCommand[]>();
const softWatchMap = globalGuardian.softWatchMap || new Map<string, SoftWatchCommitment>();

if (process.env.NODE_ENV !== 'production') {
  globalGuardian.guardianSessions = guardianSessions;
  globalGuardian.guardianIntervals = guardianIntervals;
  globalGuardian.guardianCommands = guardianCommands;
  globalGuardian.softWatchMap = softWatchMap;
}

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

function readDomainSetting(key: string, fallback: string[]) {
  const raw = getSetting(key);
  if (!raw || raw === 'undefined' || raw === 'null') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isDistractionUrl(url: string | undefined) {
  const domain = getDomain(url);
  if (!domain) return false;
  const domains = readDomainSetting('distraction_domains', DISTRACTION_DOMAINS);
  return domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

function isProductiveUrl(url: string | undefined) {
  const domain = getDomain(url);
  if (!domain) return false;
  const domains = readDomainSetting('productive_domains', PRODUCTIVE_DOMAINS);
  return domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

function classifyUrl(url: string | undefined): 'on_topic' | 'distraction' | 'unknown' {
  if (isDistractionUrl(url)) return 'distraction';
  if (isProductiveUrl(url)) return 'on_topic';
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
  };
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
      if (event.type !== 'tab') continue;
      if (classifyUrl(event.url) === 'distraction') {
        distractionEvents += 1;
        const domain = getDomain(event.url);
        if (domain) {
          domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
        }
      } else if (classifyUrl(event.url) === 'on_topic') {
        productiveEvents += 1;
      } else {
        neutralEvents += 1;
      }
    }

    const dominantDistractionDomain =
      Array.from(domainCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id,
        target_title,
        goal_title,
        concept_node_name,
        mood,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        target_title = excluded.target_title,
        goal_title = excluded.goal_title,
        concept_node_name = excluded.concept_node_name,
        mood = excluded.mood,
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
      (e) => e.type === 'tab' && classifyUrl(e.url) === 'distraction'
    ).length;

    const focusQuality =
      averageFocusScore >= 85 ? 'excellent' :
      averageFocusScore >= 70 ? 'good' :
      averageFocusScore >= 55 ? 'neutral' : 'poor';

    const ai = getGenAI();
    if (!ai) return;

    const prompt = `You are the LifeOS guardian reflecting on a just-completed study session. Write 2–3 concise sentences (max 60 words total) as a personal coach speaking directly to the user. Be honest and specific. No filler phrases.

Session: ${session.targetTitle}
Planned: ${session.durationMinutes} min | Elapsed: ${elapsedMinutes} min
Average focus: ${averageFocusScore}/100 | Final focus: ${finalFocusScore}/100
Blocks: ${session.blockedCount} | Overrides: ${session.overrideCount} | Distraction events: ${distractionCount}`;

    const result = await ai.models.generateContent({ model: MODEL_FLASH, contents: prompt });
    const reflectionText = (result.text ?? '').trim().slice(0, 400);

    db.prepare(`
      INSERT INTO guardian_session_reflections (session_id, reflection_text, focus_quality)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        reflection_text = excluded.reflection_text,
        focus_quality = excluded.focus_quality,
        generated_at = datetime('now', 'localtime')
    `).run(session.sessionId, reflectionText, focusQuality);
  } catch (error) {
    console.error('[GuardianRuntime] Failed to generate session reflection', error);
  }
}

function buildSpeechText(session: GuardianState, kind: GuardianDecision['type']) {
  const score = session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? 100;
  const elapsed = Math.max(1, Math.floor((Date.now() - session.startedAt) / 60000));
  const remaining = Math.max(0, session.durationMinutes - elapsed);
  const site = getDomain(session.currentUrl) || 'that site';

  switch (kind) {
    case 'block':
      return `You are drifting to ${site}. Back to ${session.targetTitle}.`;
    case 'nudge':
      return `You are scattered. One thing. ${remaining} minutes left.`;
    case 'speak':
    default:
      if (score > 88) return `Locked in. ${elapsed} clean minutes. Keep this pace.`;
      if (elapsed >= Math.floor(session.durationMinutes * 0.8)) return `${remaining} minutes left. Finish what you started.`;
      return `Halfway check. Score ${score}. Stay with ${session.targetTitle}.`;
  }
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

function decide(session: GuardianState, policy: GuardianPolicyBundle): GuardianDecision {
  const focusScore = session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? 100;
  const history = session.focusScoreHistory;
  const recentEvents = session.tabEventLog.filter((event) => event.timestamp >= Date.now() - 300_000);
  const tabSwitchesLast5Min = recentEvents.filter((event) => event.type === 'tab').length;
  const distractionRevisits = recentEvents.filter((event) => event.type === 'tab' && classifyUrl(event.url) === 'distraction').length;
  const idleSeconds = recentEvents
    .filter((event) => event.type === 'idle')
    .reduce((sum, event) => sum + (event.idleSeconds || 0), 0);
  const recentDwells = recentEvents
    .filter((event) => event.type === 'tab' && typeof event.dwellSeconds === 'number')
    .map((event) => event.dwellSeconds || 0);
  const avgRecentDwell = recentDwells.length > 0 ? recentDwells.reduce((sum, dwell) => sum + dwell, 0) / recentDwells.length : 0;
  const cooldownPassed = decisionCooldownPassed(session, policy);
  const inFlow = focusScore >= policy.thresholds.flowSilenceThreshold;
  const attentionCategory = getAttentionCategory(session, session.currentUrl);
  const explainabilityBase = `score=${focusScore}, tabSwitchesLast5Min=${tabSwitchesLast5Min}, distractionRevisits=${distractionRevisits}, idleSeconds=${idleSeconds}, avgRecentDwell=${Math.round(avgRecentDwell)}, attentionCategory=${attentionCategory}`;

  if (attentionCategory === 'temporary_override') {
    return {
      type: 'silence',
      reason: 'Temporary override active',
      explainability: `${explainabilityBase}; a temporary override is active so the guardian stays quiet until it expires`,
    };
  }

  if (
    attentionCategory === 'productive_support' &&
    avgRecentDwell >= 120 &&
    tabSwitchesLast5Min <= 2 &&
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
    tabSwitchesLast5Min <= 2 &&
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
          createdAt: Date.now(),
        },
      };
    }
  }

  if (tabSwitchesLast5Min >= policy.thresholds.highScatterSpeakThreshold && cooldownPassed && !inFlow && attentionCategory !== 'ambiguous_context') {
    return {
      type: 'speak',
      tone: 'grounding_nudge',
      text: buildSpeechText(session, 'nudge'),
      reason: 'High scatter detected',
      explainability: `${explainabilityBase}; scatter threshold crossed`,
    };
  }

  if (idleSeconds >= policy.thresholds.idleConcernSeconds && cooldownPassed && !inFlow) {
    return {
      type: 'speak',
      tone: 'break_suggestion',
      text: 'You have been idle a while. Either reset intentionally or get back into the work.',
      reason: 'Extended idle time during active session',
      explainability: `${explainabilityBase}; idle threshold crossed`,
    };
  }

  if (history.length >= 3) {
    const previous = history[Math.max(0, history.length - 3)];
    if (previous - focusScore >= policy.thresholds.focusDropSpeakThreshold && cooldownPassed && !inFlow) {
      return {
        type: 'speak',
        tone: 'direct_push',
        text: 'Focus is slipping. Pull it back now.',
        reason: 'Sharp focus score drop',
        explainability: `${explainabilityBase}; focus drop threshold crossed`,
      };
    }
  }

  const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
  if (
    !session.emittedMilestones.includes('midpoint') &&
    elapsed >= Math.floor(session.durationMinutes * 0.5) &&
    cooldownPassed &&
    attentionCategory === 'productive_support'
  ) {
    session.emittedMilestones.push('midpoint');
    return {
      type: 'speak',
      tone: 'midpoint_checkin',
      text: buildSpeechText(session, 'speak'),
      reason: 'Midpoint check-in',
      explainability: `${explainabilityBase}; midpoint milestone reached`,
    };
  }

  if (
    !session.emittedMilestones.includes('final_push') &&
    elapsed >= Math.floor(session.durationMinutes * 0.8) &&
    cooldownPassed &&
    attentionCategory === 'productive_support'
  ) {
    session.emittedMilestones.push('final_push');
    return {
      type: 'speak',
      tone: 'final_push',
      text: buildSpeechText(session, 'speak'),
      reason: 'Final push milestone',
      explainability: `${explainabilityBase}; final push milestone reached`,
    };
  }

  if (
    attentionCategory === 'productive_support' &&
    cooldownPassed &&
    focusScore > 88 &&
    elapsed >= 10 &&
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

export function listGuardianSessions() {
  return Array.from(guardianSessions.values()).map(cloneSession);
}

export function getGuardianSession(sessionId: string) {
  const session = guardianSessions.get(sessionId);
  return session ? cloneSession(session) : null;
}

export function startGuardianSession(input: GuardianStartRequest): GuardianState {
  const sessionId = randomId('session');
  const durationMinutes = input.durationMinutes || 60;
  const targetTitle = input.conceptNodeName || input.goalTitle || input.topic || 'Deep Work';
  const briefing = getDayBriefing('default');
  const openingLine = generateOpeningLine(briefing, {
    durationMinutes,
    topic: targetTitle,
    mood: input.mood,
  });

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
  });

  guardianSessions.set(sessionId, session);
  linkSoftWatchToSession(sessionId, targetTitle);

  emitSessionEvent(sessionId, {
    type: 'session_state',
    state: session.state,
    targetTitle,
    plannedMinutes: session.durationMinutes,
    sessionId,
    explainability: 'Guardian session started and runtime ownership is now active for this session.',
  });

  void speak(sessionId, openingLine, 'urgent', 'flow_confirmed');
  session.lastSpeechAt = Date.now();

  const timer = setInterval(() => {
    void tickGuardianSession(sessionId, { sessionId, type: 'heartbeat', timestamp: Date.now() });
  }, 30_000);
  guardianIntervals.set(sessionId, timer);

  return cloneSession(session);
}

export function endGuardianSession(sessionId: string) {
  const session = guardianSessions.get(sessionId);
  if (!session) return null;
  session.state = 'COMPLETE';
  clearHeartbeat(sessionId);
  persistSessionSummary(session);
  void generateSessionReflection(session);
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
      classification: event.url ? classifyUrl(event.url) : undefined,
      attentionCategory: event.url ? getAttentionCategory(session, event.url) : undefined,
    },
  };

  if (normalized.type === 'tab') {
    session.currentUrl = normalized.url || '';
    session.currentTitle = normalized.title || '';
    session.currentClassification = classifyUrl(normalized.url);
  }

  if (normalized.type === 'idle') {
    session.currentClassification = 'unknown';
  }

  session.tabEventLog.push(normalized);
  return cloneSession(session);
}

export async function tickGuardianSession(sessionId: string, inputEvent?: GuardianEvent) {
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

  if (inputEvent) {
    appendGuardianEvent(inputEvent);
  }

  emitExpiredOverrideCommands(session);

  session.tick += 1;
  const policy = getActiveGuardianPolicyBundle();
  const focus = computeFocusScore(session, policy);
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
  } else if (isProductiveUrl(request.url) || looksWorkRelated) {
    decision = {
      approved: true,
      reason: 'Targeted override approved',
      explainability: `Approved because the request was bounded, temporary, and plausibly related to the active session target. Rubric: ${rubric}`,
      ttlMinutes: requestedMinutes,
      reviewedAt: nowIso(),
    };
  } else if (isDistractionUrl(request.url)) {
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
      const result = await ai.models.generateContent({
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
  const activeGoals = db.prepare(`
    SELECT id, title, description
    FROM goals
    WHERE active = 1
  `).all();
  const activeTasks = db.prepare(`
    SELECT id, title, description, goal_id
    FROM tasks
    WHERE status IN ('doing', 'today')
  `).all();
  const activeSession = listGuardianSessions().find((session) => session.state === 'ACTIVE') || null;
  return { activeGoals, activeTasks, activeSession };
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

const SOFT_WATCH_REMINDER_WINDOW_MS = 5 * 60_000;    // remind within 5 min of intended start
const SOFT_WATCH_CHECKIN_DELAY_MS = 30 * 60_000;     // check-in 30 min after intended start
const SOFT_WATCH_EXPIRE_MS = 60 * 60_000;             // expire 60 min after intended start

function persistSoftWatch(c: SoftWatchCommitment) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, goal_id, task_id, intended_start_at, planned_minutes,
        source, reminder_sent_at, check_in_sent_at, status, locked_in_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        reminder_sent_at = excluded.reminder_sent_at,
        check_in_sent_at = excluded.check_in_sent_at,
        locked_in_session_id = excluded.locked_in_session_id
    `).run(
      c.id, c.targetTitle, c.goalId, c.taskId, c.intendedStartAt, c.plannedMinutes,
      c.source, c.reminderSentAt, c.checkInSentAt, c.status, c.lockedInSessionId, c.createdAt
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

    // Expire if more than 60 min past intended start
    if (sincStart > SOFT_WATCH_EXPIRE_MS) {
      commitment.status = 'expired';
      softWatchMap.set(id, commitment);
      persistSoftWatch(commitment);
      updateCommitmentFollowThroughRate();
      console.log(`[SoftWatch] Commitment ${id} expired: ${commitment.targetTitle}`);
      continue;
    }

    // Reminder: fire once when within 5 min of intended start time
    if (!commitment.reminderSentAt && Math.abs(now - commitment.intendedStartAt) <= SOFT_WATCH_REMINDER_WINDOW_MS) {
      commitment.reminderSentAt = now;
      softWatchMap.set(id, commitment);
      persistSoftWatch(commitment);
      void speak(
        'soft_watch',
        `Heads up — you planned to work on ${commitment.targetTitle} now. Ready to lock in?`,
        'normal',
        'midpoint_checkin'
      );
      continue;
    }

    // Check-in: fire once if 30 min past intended start and still pending
    if (!commitment.checkInSentAt && sincStart >= SOFT_WATCH_CHECKIN_DELAY_MS) {
      commitment.checkInSentAt = now;
      softWatchMap.set(id, commitment);
      persistSoftWatch(commitment);
      void speak(
        'soft_watch',
        `Still here. You committed to ${commitment.targetTitle} about 30 minutes ago. Start now or let it go?`,
        'normal',
        'direct_push'
      );
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
        status, locked_in_session_id as lockedInSessionId, created_at as createdAt
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
  source?: 'voice' | 'dashboard' | 'calendar';
}): SoftWatchCommitment {
  const commitment: SoftWatchCommitment = {
    id: randomId('sw'),
    targetTitle: input.targetTitle,
    goalId: input.goalId ?? null,
    taskId: input.taskId ?? null,
    intendedStartAt: input.intendedStartAt,
    plannedMinutes: input.plannedMinutes ?? 60,
    source: input.source ?? 'voice',
    reminderSentAt: null,
    checkInSentAt: null,
    status: 'pending',
    lockedInSessionId: null,
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

export function dismissSoftWatchCommitment(id: string): boolean {
  const commitment = softWatchMap.get(id);
  if (!commitment) return false;
  commitment.status = 'dismissed';
  softWatchMap.set(id, commitment);
  persistSoftWatch(commitment);
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
