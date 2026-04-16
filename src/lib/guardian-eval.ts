import { computeFocusScore } from './focus-score';
import {
  GuardianEvalCaseResult,
  GuardianEvalScenario,
  GuardianPolicyBundle,
  GuardianState,
} from './guardian-types';
import { getDb } from './db';

function classifyUrlSync(url: string | undefined): 'on_topic' | 'distraction' | 'unknown' {
  if (!url) return 'unknown';
  let domain: string;
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
  if (!domain || domain.startsWith('chrome')) return 'unknown';
  try {
    const row = getDb().prepare('SELECT category, confidence FROM domain_categories WHERE domain = ?').get(domain) as { category: string; confidence: number } | undefined;
    if (row && row.confidence >= 0.6) {
      if (row.category === 'productive') return 'on_topic';
      if (row.category === 'distraction') return 'distraction';
    }
  } catch { /* DB not ready */ }
  return 'unknown';
}

function createEvalSession(scenario: GuardianEvalScenario): GuardianState {
  return {
    sessionId: `eval_${Math.random().toString(36).slice(2, 8)}`,
    state: 'ACTIVE',
    goalId: null,
    goalTitle: null,
    conceptNodeId: null,
    conceptNodeName: scenario.targetTitle,
    durationMinutes: scenario.durationMinutes,
    mood: scenario.mood || 'medium',
    startedAt: Date.now(),
    endsAt: Date.now() + scenario.durationMinutes * 60_000,
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
    targetTitle: scenario.targetTitle,
    personalBestFocusScore: null,
    energyComposite: null,
    sessionClassificationCache: {},
    immediateBlockDomains: [],
    currentTabStartedAt: null,
    intentProfile: null,
    sessionPolicy: null,
  };
}

function shouldSpeak(session: GuardianState, policy: GuardianPolicyBundle, focusScore: number) {
  const cooldownPassed = !session.lastSpeechAt || Date.now() - session.lastSpeechAt > policy.thresholds.speechCooldownMs;
  return cooldownPassed && focusScore < policy.thresholds.flowSilenceThreshold;
}

function simulateDecision(session: GuardianState, policy: GuardianPolicyBundle, focusScore: number) {
  const recentEvents = session.tabEventLog.filter((event) => event.timestamp >= session.startedAt - 1 || true);
  const tabSwitchesLast5Min = recentEvents.filter((event) => event.type === 'tab').length;
  const distractionRevisits = recentEvents.filter((event) => event.type === 'tab' && classifyUrlSync(event.url) === 'distraction').length;
  const idleSeconds = recentEvents.filter((event) => event.type === 'idle').reduce((sum, event) => sum + (event.idleSeconds || 0), 0);

  if (session.currentClassification === 'distraction' && distractionRevisits >= policy.thresholds.distractionRevisitBlockCount) {
    return 'block';
  }
  if (session.currentClassification === 'distraction' && tabSwitchesLast5Min >= policy.thresholds.distractionTabSwitchBlockCount) {
    return 'block';
  }
  if (tabSwitchesLast5Min >= policy.thresholds.highScatterSpeakThreshold && shouldSpeak(session, policy, focusScore)) {
    return 'speak';
  }
  if (idleSeconds >= policy.thresholds.idleConcernSeconds && shouldSpeak(session, policy, focusScore)) {
    return 'speak';
  }
  if (session.currentClassification === 'on_topic' &&     focusScore > (policy.thresholds.flowConfirmationScore ?? 88) && shouldSpeak(session, policy, focusScore)) {
    return 'speak';
  }
  return 'silence';
}

export function evaluateGuardianPolicyScenario(
  caseId: number,
  caseName: string,
  policy: GuardianPolicyBundle,
  scenario: GuardianEvalScenario
): GuardianEvalCaseResult {
  const session = createEvalSession(scenario);
  let speakCount = 0;
  let blockCount = 0;

  for (const scenarioEvent of scenario.events) {
    const event = {
      sessionId: session.sessionId,
      type: scenarioEvent.type,
      timestamp: Date.now() + session.tick * 30_000,
      url: scenarioEvent.url,
      title: scenarioEvent.title,
      dwellSeconds: scenarioEvent.dwellSeconds,
      idleSeconds: scenarioEvent.idleSeconds,
    };

    if (event.type === 'tab') {
      session.currentUrl = event.url || '';
      session.currentTitle = event.title || '';
      session.currentClassification = classifyUrlSync(event.url);
    } else if (event.type === 'idle') {
      session.currentClassification = 'unknown';
    }

    // Only tab and idle events go into tabEventLog — heartbeats drive ticks only.
    // This matches real runtime behaviour where appendGuardianEvent is never called for heartbeats.
    if (event.type !== 'heartbeat') {
      session.tabEventLog.push(event);
    }
    session.tick += 1;
    const focus = computeFocusScore(session, policy);
    session.focusScoreHistory.push(focus.score);
    const decision = simulateDecision(session, policy, focus.score);

    if (decision === 'block') blockCount += 1;
    if (decision === 'speak') speakCount += 1;
  }

  const reasons: string[] = [];
  let score = 100;
  let passed = true;
  let hardFailure = false;

  // Hard-fail: blocking while on a productive URL is a false-positive — never acceptable.
  if (blockCount > 0 && session.currentClassification === 'on_topic') {
    passed = false;
    hardFailure = true;
    score -= 60;
    reasons.push(`Hard fail: guardian blocked while final classification was on_topic (false-positive block).`);
  }

  if (scenario.expected.mustBlock && blockCount === 0) {
    passed = false;
    hardFailure = true;
    score -= 60;
    reasons.push('Expected a block but none occurred.');
  }
  if (scenario.expected.mustSpeak && speakCount === 0) {
    passed = false;
    score -= 30;
    reasons.push('Expected a spoken intervention but none occurred.');
  }
  if (typeof scenario.expected.maxBlockCount === 'number' && blockCount > scenario.expected.maxBlockCount) {
    passed = false;
    score -= 20 * (blockCount - scenario.expected.maxBlockCount);
    reasons.push(`Blocked too often (${blockCount} > ${scenario.expected.maxBlockCount}).`);
  }
  if (typeof scenario.expected.maxSpeakCount === 'number' && speakCount > scenario.expected.maxSpeakCount) {
    passed = false;
    score -= 15 * (speakCount - scenario.expected.maxSpeakCount);
    reasons.push(`Spoke too often (${speakCount} > ${scenario.expected.maxSpeakCount}).`);
  }
  if (scenario.expected.finalClassification && session.currentClassification !== scenario.expected.finalClassification) {
    passed = false;
    score -= 10;
    reasons.push(`Final classification was ${session.currentClassification}, expected ${scenario.expected.finalClassification}.`);
  }

  return {
    caseId,
    caseName,
    passed,
    score: Math.max(0, score),
    hardFailure,
    reasons,
  };
}
