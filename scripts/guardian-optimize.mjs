#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = path.join(process.cwd(), 'data', 'lifeos.db');
const ACTIVE_POLICY_TYPE = 'guardian_policy_bundle';
const SUITE_NAME = 'baseline_guardian_suite';

const DISTRACTION_DOMAINS = ['youtube.com', 'twitter.com', 'x.com', 'reddit.com', 'instagram.com', 'facebook.com'];
const PRODUCTIVE_DOMAINS = ['docs.', 'developer.mozilla.org', 'leetcode.com', 'khanacademy.org', 'coursera.org', 'edx.org', 'wikipedia.org'];

const DEFAULT_POLICY = {
  version: 'guardian-v1',
  prompts: {
    interventionPrompt: 'Be concise and intervention-focused.',
    overrideRubric: 'Approve only targeted, temporary overrides that support the active session.',
    retrievalPrompt: 'Prefer recent session failures and current target context.',
    sessionPlannerPrompt: 'Turn lock-in intent into a scoped study session.',
    voicePolicyPrompt: 'Keep interventions short and specific.',
    redTeamRules: 'Never disable privacy guarantees or allow blanket overrides.',
  },
  thresholds: {
    speechCooldownMs: 90000,
    flowSilenceThreshold: 85,
    distractionRevisitBlockCount: 3,
    distractionTabSwitchBlockCount: 4,
    highScatterSpeakThreshold: 6,
    idleConcernSeconds: 480,
    focusDropSpeakThreshold: 15,
    lowFocusThreshold: 60,
  },
  weights: {
    continuity: 0.35,
    switches: 0.25,
    dwell: 0.2,
    distractionPenalty: 0.15,
    idlePenalty: 0.05,
  },
};

const DEFAULT_CASES = [
  {
    caseName: 'repeated_distraction_triggers_block',
    scenarioType: 'realtime',
    inputPayload: {
      durationMinutes: 60,
      targetTitle: 'Polynomials IOP',
      events: [
        { type: 'tab', url: 'https://docs.rs', title: 'Docs', dwellSeconds: 240 },
        { type: 'tab', url: 'https://youtube.com/watch?v=abc', title: 'Video', dwellSeconds: 30 },
        { type: 'tab', url: 'https://reddit.com/r/all', title: 'Reddit', dwellSeconds: 20 },
        { type: 'tab', url: 'https://youtube.com/watch?v=abc', title: 'Video', dwellSeconds: 20 },
      ],
      expected: { mustBlock: true, maxSpeakCount: 2, finalClassification: 'distraction' },
    },
    expectedOutcome: 'Must block repeated distraction revisits.',
  },
  {
    caseName: 'steady_productive_flow_stays_quiet',
    scenarioType: 'realtime',
    inputPayload: {
      durationMinutes: 90,
      targetTitle: 'Finite Fields Assignment',
      events: [
        { type: 'tab', url: 'https://developer.mozilla.org', title: 'MDN', dwellSeconds: 300 },
        { type: 'heartbeat' },
        { type: 'tab', url: 'https://wikipedia.org/wiki/Finite_field', title: 'Finite field', dwellSeconds: 360 },
        { type: 'heartbeat' },
      ],
      expected: { maxBlockCount: 0, maxSpeakCount: 1, finalClassification: 'on_topic' },
    },
    expectedOutcome: 'Should stay mostly silent in flow.',
  },
  {
    caseName: 'idle_session_prompts_concern',
    scenarioType: 'realtime',
    inputPayload: {
      durationMinutes: 45,
      targetTitle: 'Assignment Sprint',
      events: [
        { type: 'tab', url: 'https://leetcode.com', title: 'LeetCode', dwellSeconds: 180 },
        { type: 'idle', idleSeconds: 600 },
      ],
      expected: { mustSpeak: true, maxBlockCount: 0 },
    },
    expectedOutcome: 'Should speak on extended idle.',
  },
  {
    caseName: 'scatter_without_distraction_gets_nudge_not_block',
    scenarioType: 'realtime',
    inputPayload: {
      durationMinutes: 60,
      targetTitle: 'Research Notes',
      events: [
        { type: 'tab', url: 'https://wikipedia.org/wiki/Polynomial_commitment', title: 'Wiki', dwellSeconds: 40 },
        { type: 'tab', url: 'https://developer.mozilla.org', title: 'MDN', dwellSeconds: 35 },
        { type: 'tab', url: 'https://docs.python.org', title: 'Docs', dwellSeconds: 30 },
        { type: 'tab', url: 'https://wikipedia.org/wiki/Zero-knowledge_proof', title: 'Wiki', dwellSeconds: 20 },
        { type: 'tab', url: 'https://khanacademy.org', title: 'Khan', dwellSeconds: 20 },
        { type: 'tab', url: 'https://coursera.org', title: 'Course', dwellSeconds: 20 },
      ],
      expected: { mustSpeak: true, maxBlockCount: 0 },
    },
    expectedOutcome: 'Should nudge for scatter without blocking productive browsing.',
  },
];

function openDb() {
  return new Database(DB_PATH);
}

function getDomain(url) {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function classifyUrl(url) {
  const domain = getDomain(url);
  if (!domain) return 'unknown';
  if (DISTRACTION_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) return 'distraction';
  if (PRODUCTIVE_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) return 'on_topic';
  return 'unknown';
}

function ensureActivePolicy(db) {
  const active = db.prepare(`
    SELECT *
    FROM guardian_artifact_versions
    WHERE artifact_type = ? AND is_active = 1
    ORDER BY id DESC
    LIMIT 1
  `).get(ACTIVE_POLICY_TYPE);

  if (active) return active;

  const info = db.prepare(`
    INSERT INTO guardian_artifact_versions (
      artifact_type, version, content, guardian_eval_score, is_active, promoted_at, notes
    ) VALUES (?, ?, ?, 0, 1, datetime('now', 'localtime'), ?)
  `).run(
    ACTIVE_POLICY_TYPE,
    DEFAULT_POLICY.version,
    JSON.stringify(DEFAULT_POLICY),
    'Auto-seeded default guardian policy bundle'
  );

  return db.prepare('SELECT * FROM guardian_artifact_versions WHERE id = ?').get(info.lastInsertRowid);
}

function ensureEvalCases(db) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM guardian_eval_cases WHERE suite_name = ?').get(SUITE_NAME);
  if (row.count > 0) return;

  const insert = db.prepare(`
    INSERT INTO guardian_eval_cases (suite_name, case_name, scenario_type, input_payload, expected_outcome)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const item of DEFAULT_CASES) {
      insert.run(SUITE_NAME, item.caseName, item.scenarioType, JSON.stringify(item.inputPayload), item.expectedOutcome);
    }
  });
  tx();
}

function computeFocusScore(session, policy) {
  if (!session.tick) return 100;
  const elapsedMs = Math.max(1000, session.tick * 30000);
  const elapsedMinutes = elapsedMs / 60000;
  let onTopicSeconds = 0;
  let distractionRevisits = 0;
  const distractionDomains = new Set();
  let switches = 0;
  let idleSeconds = 0;

  for (const event of session.events) {
    if (event.type === 'idle') {
      idleSeconds += event.idleSeconds || 0;
      continue;
    }
    switches += 1;
    const isDistraction = classifyUrl(event.url) === 'distraction';
    if (!isDistraction && event.dwellSeconds) onTopicSeconds += event.dwellSeconds;
    if (isDistraction) {
      const domain = getDomain(event.url);
      if (domain && distractionDomains.has(domain)) distractionRevisits += 1;
      if (domain) distractionDomains.add(domain);
    }
  }

  const continuityScore = Math.min(100, (onTopicSeconds / Math.max(1, elapsedMs / 1000)) * 100);
  const switchesPerMin = switches / Math.max(1, elapsedMinutes);
  const switchScore = switchesPerMin >= 3 ? 0 : 100 - (switchesPerMin * 33);
  const avgDwell = switches > 0 ? (elapsedMs / 1000) / switches : 0;
  const dwellScore = Math.min(100, (avgDwell / 180) * 100);
  const distractPenalty = distractionRevisits * 8;
  let idlePenalty = 0;
  if (idleSeconds / 60 > 10) idlePenalty = 30;
  else if (idleSeconds / 60 > 5) idlePenalty = 15;

  const rawScore =
    continuityScore * policy.weights.continuity +
    switchScore * policy.weights.switches +
    dwellScore * policy.weights.dwell -
    distractPenalty * policy.weights.distractionPenalty -
    idlePenalty * policy.weights.idlePenalty;

  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

function evaluateScenario(policy, scenario) {
  const session = { tick: 0, events: [], currentClassification: 'unknown' };
  let blockCount = 0;
  let speakCount = 0;

  for (const event of scenario.events) {
    session.events.push(event);
    session.tick += 1;
    if (event.type === 'tab') session.currentClassification = classifyUrl(event.url);
    if (event.type === 'idle') session.currentClassification = 'unknown';

    const score = computeFocusScore(session, policy);
    const tabSwitches = session.events.filter((item) => item.type === 'tab').length;
    const distractionRevisits = session.events.filter((item) => item.type === 'tab' && classifyUrl(item.url) === 'distraction').length;
    const idleSeconds = session.events.filter((item) => item.type === 'idle').reduce((sum, item) => sum + (item.idleSeconds || 0), 0);

    if (session.currentClassification === 'distraction' && distractionRevisits >= policy.thresholds.distractionRevisitBlockCount) blockCount += 1;
    else if (session.currentClassification === 'distraction' && tabSwitches >= policy.thresholds.distractionTabSwitchBlockCount) blockCount += 1;
    else if (tabSwitches >= policy.thresholds.highScatterSpeakThreshold && score < policy.thresholds.flowSilenceThreshold) speakCount += 1;
    else if (idleSeconds >= policy.thresholds.idleConcernSeconds && score < policy.thresholds.flowSilenceThreshold) speakCount += 1;
  }

  let score = 100;
  let hardFailure = false;
  const expected = scenario.expected || {};

  if (expected.mustBlock && blockCount === 0) {
    hardFailure = true;
    score -= 60;
  }
  if (expected.mustSpeak && speakCount === 0) score -= 30;
  if (typeof expected.maxBlockCount === 'number' && blockCount > expected.maxBlockCount) score -= 20 * (blockCount - expected.maxBlockCount);
  if (typeof expected.maxSpeakCount === 'number' && speakCount > expected.maxSpeakCount) score -= 15 * (speakCount - expected.maxSpeakCount);
  if (expected.finalClassification && session.currentClassification !== expected.finalClassification) score -= 10;

  return { score: Math.max(0, score), hardFailure };
}

function mutateCandidates(base) {
  const clone = () => structuredClone(base);
  const variants = [];

  {
    const variant = clone();
    variant.version = `${base.version}-cooldown-tight`;
    variant.thresholds.speechCooldownMs = Math.max(45000, base.thresholds.speechCooldownMs - 15000);
    variants.push(variant);
  }
  {
    const variant = clone();
    variant.version = `${base.version}-cooldown-loose`;
    variant.thresholds.speechCooldownMs = base.thresholds.speechCooldownMs + 15000;
    variants.push(variant);
  }
  {
    const variant = clone();
    variant.version = `${base.version}-block-faster`;
    variant.thresholds.distractionRevisitBlockCount = Math.max(2, base.thresholds.distractionRevisitBlockCount - 1);
    variants.push(variant);
  }
  {
    const variant = clone();
    variant.version = `${base.version}-scatter-earlier`;
    variant.thresholds.highScatterSpeakThreshold = Math.max(4, base.thresholds.highScatterSpeakThreshold - 1);
    variants.push(variant);
  }
  {
    const variant = clone();
    variant.version = `${base.version}-voice-tighter`;
    variant.prompts.voicePolicyPrompt = `${base.prompts.voicePolicyPrompt} Keep interventions even shorter.`;
    variants.push(variant);
  }

  return variants;
}

function recordEvalRun(db, payload) {
  db.prepare(`
    INSERT INTO guardian_eval_runs (
      artifact_version_id, suite_name, wall_clock_budget_seconds, primary_metric,
      guardian_eval_score, hard_failures, status, summary, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.artifactVersionId ?? null,
    SUITE_NAME,
    payload.wallClockBudgetSeconds,
    'guardian_eval_score',
    payload.guardianEvalScore,
    payload.hardFailures,
    payload.status,
    payload.summary,
    new Date().toISOString()
  );
}

function runCycle() {
  const db = openDb();
  const wallClockBudgetSeconds = Number(process.env.GUARDIAN_EVAL_BUDGET_SECONDS || '300');
  ensureEvalCases(db);
  const activeRow = ensureActivePolicy(db);
  const activePolicy = JSON.parse(activeRow.content);
  const cases = db.prepare(`
    SELECT id, case_name, input_payload
    FROM guardian_eval_cases
    WHERE suite_name = ? AND active = 1
    ORDER BY id ASC
  `).all(SUITE_NAME);

  const evaluateBundle = (policy) => {
    const caseResults = cases.map((record) => evaluateScenario(policy, JSON.parse(record.input_payload)));
    const hardFailures = caseResults.filter((item) => item.hardFailure).length;
    const guardianEvalScore = Math.round((caseResults.reduce((sum, item) => sum + item.score, 0) / Math.max(1, caseResults.length)) * 100) / 100;
    return { guardianEvalScore, hardFailures };
  };

  const baseline = evaluateBundle(activePolicy);
  recordEvalRun(db, {
    artifactVersionId: activeRow.id,
    wallClockBudgetSeconds,
    guardianEvalScore: baseline.guardianEvalScore,
    hardFailures: baseline.hardFailures,
    status: baseline.hardFailures === 0 ? 'passed' : 'failed',
    summary: 'Baseline evaluation',
  });

  const candidates = mutateCandidates(activePolicy).map((candidate) => {
    const summary = evaluateBundle(candidate);
    const info = db.prepare(`
      INSERT INTO guardian_artifact_versions (
        artifact_type, version, content, guardian_eval_score, is_active, notes
      ) VALUES (?, ?, ?, ?, 0, ?)
    `).run(ACTIVE_POLICY_TYPE, candidate.version, JSON.stringify(candidate), summary.guardianEvalScore, `Auto candidate for ${SUITE_NAME}`);
    recordEvalRun(db, {
      artifactVersionId: info.lastInsertRowid,
      wallClockBudgetSeconds,
      guardianEvalScore: summary.guardianEvalScore,
      hardFailures: summary.hardFailures,
      status: summary.hardFailures === 0 ? 'passed' : 'failed',
      summary: 'Candidate evaluation',
    });
    return { artifactId: info.lastInsertRowid, version: candidate.version, ...summary };
  });

  const winner = candidates.filter((item) => item.hardFailures === 0).sort((a, b) => b.guardianEvalScore - a.guardianEvalScore)[0];

  let promoted = null;
  if (winner && winner.guardianEvalScore > baseline.guardianEvalScore) {
    db.transaction(() => {
      db.prepare('UPDATE guardian_artifact_versions SET is_active = 0 WHERE artifact_type = ?').run(ACTIVE_POLICY_TYPE);
      db.prepare('UPDATE guardian_artifact_versions SET is_active = 1, promoted_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(winner.artifactId);
      db.prepare('INSERT INTO guardian_promotions (artifact_version_id, reason) VALUES (?, ?)').run(
        winner.artifactId,
        `Promoted automatically: ${winner.guardianEvalScore} > ${baseline.guardianEvalScore}`
      );
      db.prepare('INSERT INTO guardian_canary_results (guardian_eval_score, status, notes) VALUES (?, ?, ?)').run(
        winner.guardianEvalScore,
        'passed',
        `Promotion candidate ${winner.version} passed.`
      );
    })();
    promoted = { artifactId: winner.artifactId, version: winner.version };
  } else {
    db.prepare('INSERT INTO guardian_canary_results (guardian_eval_score, status, notes) VALUES (?, ?, ?)').run(
      baseline.guardianEvalScore,
      'passed',
      'No candidate beat baseline; active policy retained.'
    );
  }

  return {
    suiteName: SUITE_NAME,
    wallClockBudgetSeconds,
    baseline: { score: baseline.guardianEvalScore, hardFailures: baseline.hardFailures },
    candidates: candidates.map((item) => ({
      artifactId: item.artifactId,
      version: item.version,
      score: item.guardianEvalScore,
      hardFailures: item.hardFailures,
    })),
    promoted,
  };
}

const jsonMode = process.argv.includes('--json');

try {
  const result = runCycle();
  if (jsonMode) process.stdout.write(JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (jsonMode) process.stdout.write(JSON.stringify({ error: String(error) }));
  else console.error(String(error));
  process.exitCode = 1;
}
