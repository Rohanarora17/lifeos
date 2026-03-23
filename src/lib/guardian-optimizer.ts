import { getDb } from './db';
import { DEFAULT_GUARDIAN_POLICY_BUNDLE } from './guardian-artifacts';
import {
  EvalRun,
  GuardianEvalCaseRecord,
  GuardianEvalScenario,
  GuardianEvalSummary,
  GuardianPolicyBundle,
  PolicyArtifactVersion,
} from './guardian-types';
import { evaluateGuardianPolicyScenario } from './guardian-eval';

const ACTIVE_POLICY_TYPE = 'guardian_policy_bundle';
const DEFAULT_PRIMARY_METRIC = 'guardian_eval_score';
const DEFAULT_SUITE_NAME = 'baseline_guardian_suite';
const DEFAULT_BUDGET_SECONDS = 300;

const DEFAULT_GUARDIAN_EVAL_CASES: Array<{
  caseName: string;
  scenarioType: string;
  inputPayload: GuardianEvalScenario;
  expectedOutcome: string;
}> = [
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
  // ─── Additional cases ────────────────────────────────────────────────────────
  {
    caseName: 'productive_url_never_blocked',
    scenarioType: 'false_positive_guard',
    inputPayload: {
      durationMinutes: 60,
      targetTitle: 'Algorithm Study',
      events: [
        { type: 'tab', url: 'https://leetcode.com/problems/two-sum', title: 'LeetCode', dwellSeconds: 300 },
        { type: 'heartbeat' },
        { type: 'tab', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', title: 'MDN', dwellSeconds: 240 },
        { type: 'heartbeat' },
        { type: 'tab', url: 'https://wikipedia.org/wiki/Dynamic_programming', title: 'Dynamic Programming', dwellSeconds: 180 },
      ],
      expected: { maxBlockCount: 0, finalClassification: 'on_topic' },
    },
    expectedOutcome: 'Guardian must never block a session that stays entirely on productive URLs.',
  },
  {
    caseName: 'deep_focus_long_silence',
    scenarioType: 'flow_protection',
    inputPayload: {
      durationMinutes: 90,
      targetTitle: 'Linear Algebra Deep Dive',
      events: [
        { type: 'tab', url: 'https://khanacademy.org/math/linear-algebra', title: 'Khan Academy', dwellSeconds: 480 },
        { type: 'heartbeat' },
        { type: 'heartbeat' },
        { type: 'tab', url: 'https://wikipedia.org/wiki/Eigenvalues_and_eigenvectors', title: 'Eigenvalues', dwellSeconds: 360 },
        { type: 'heartbeat' },
        { type: 'heartbeat' },
      ],
      expected: { maxBlockCount: 0, maxSpeakCount: 1, finalClassification: 'on_topic' },
    },
    expectedOutcome: 'Guardian should stay silent during long deep-focus stretches on productive content.',
  },
  {
    caseName: 'single_distraction_no_block',
    scenarioType: 'over_intervention_guard',
    inputPayload: {
      durationMinutes: 60,
      targetTitle: 'Operating Systems Assignment',
      events: [
        { type: 'tab', url: 'https://developer.mozilla.org', title: 'MDN', dwellSeconds: 300 },
        { type: 'tab', url: 'https://youtube.com/watch?v=xyz', title: 'YouTube', dwellSeconds: 15 },
        { type: 'tab', url: 'https://developer.mozilla.org', title: 'MDN', dwellSeconds: 240 },
      ],
      expected: { maxBlockCount: 0, finalClassification: 'on_topic' },
    },
    expectedOutcome: 'A single brief distraction visit should not trigger a block — only speak at most.',
  },
  {
    caseName: 'rapid_distraction_escalation_triggers_block',
    scenarioType: 'realtime',
    inputPayload: {
      durationMinutes: 45,
      targetTitle: 'Calculus Problem Set',
      events: [
        { type: 'tab', url: 'https://docs.python.org', title: 'Python Docs', dwellSeconds: 120 },
        { type: 'tab', url: 'https://twitter.com/home', title: 'Twitter', dwellSeconds: 30 },
        { type: 'tab', url: 'https://docs.python.org', title: 'Python Docs', dwellSeconds: 40 },
        { type: 'tab', url: 'https://twitter.com/home', title: 'Twitter', dwellSeconds: 25 },
        { type: 'tab', url: 'https://twitter.com/notifications', title: 'Twitter', dwellSeconds: 20 },
      ],
      expected: { mustBlock: true, finalClassification: 'distraction' },
    },
    expectedOutcome: 'Rapid escalating revisits to same distraction domain must trigger a block.',
  },
  {
    caseName: 'idle_then_return_no_block',
    scenarioType: 'over_intervention_guard',
    inputPayload: {
      durationMinutes: 60,
      targetTitle: 'Reading Sprint',
      events: [
        { type: 'tab', url: 'https://coursera.org/learn/ml', title: 'Coursera', dwellSeconds: 200 },
        { type: 'idle', idleSeconds: 540 },
        { type: 'tab', url: 'https://coursera.org/learn/ml', title: 'Coursera', dwellSeconds: 180 },
      ],
      expected: { mustSpeak: true, maxBlockCount: 0, finalClassification: 'on_topic' },
    },
    expectedOutcome: 'Idle followed by return to productive URL should prompt a check-in, not a block.',
  },
  {
    caseName: 'mixed_session_proportionate_response',
    scenarioType: 'realtime',
    inputPayload: {
      durationMinutes: 60,
      targetTitle: 'Data Structures',
      events: [
        { type: 'tab', url: 'https://leetcode.com', title: 'LeetCode', dwellSeconds: 300 },
        { type: 'tab', url: 'https://reddit.com/r/programming', title: 'Reddit', dwellSeconds: 30 },
        { type: 'tab', url: 'https://leetcode.com', title: 'LeetCode', dwellSeconds: 200 },
        { type: 'heartbeat' },
        { type: 'tab', url: 'https://reddit.com/r/programming', title: 'Reddit', dwellSeconds: 20 },
        { type: 'tab', url: 'https://leetcode.com', title: 'LeetCode', dwellSeconds: 160 },
      ],
      expected: { mustSpeak: true, maxBlockCount: 1 },
    },
    expectedOutcome: 'Mixed session with moderate distraction should speak and block at most once.',
  },
];

export function ensureDefaultGuardianArtifacts(): PolicyArtifactVersion {
  const db = getDb();
  const active = db.prepare(`
    SELECT *
    FROM guardian_artifact_versions
    WHERE artifact_type = ? AND is_active = 1
    ORDER BY id DESC
    LIMIT 1
  `).get(ACTIVE_POLICY_TYPE) as PolicyArtifactVersion | undefined;

  if (active) {
    return active;
  }

  const info = db.prepare(`
    INSERT INTO guardian_artifact_versions (
      artifact_type,
      version,
      content,
      guardian_eval_score,
      is_active,
      promoted_at,
      notes
    ) VALUES (?, ?, ?, ?, 1, datetime('now', 'localtime'), ?)
  `).run(
    ACTIVE_POLICY_TYPE,
    DEFAULT_GUARDIAN_POLICY_BUNDLE.version,
    JSON.stringify(DEFAULT_GUARDIAN_POLICY_BUNDLE),
    0,
    'Auto-seeded default guardian policy bundle'
  );

  return db.prepare('SELECT * FROM guardian_artifact_versions WHERE id = ?').get(info.lastInsertRowid) as PolicyArtifactVersion;
}

export function getActiveGuardianPolicyBundle(): GuardianPolicyBundle {
  const row = ensureDefaultGuardianArtifacts();
  try {
    const parsed = JSON.parse(row.content) as GuardianPolicyBundle;
    return parsed;
  } catch {
    return DEFAULT_GUARDIAN_POLICY_BUNDLE;
  }
}

export function recordGuardianEvalRun(input: {
  artifactVersionId?: number | null;
  suiteName?: string;
  wallClockBudgetSeconds?: number;
  guardianEvalScore: number;
  hardFailures?: number;
  status: 'pending' | 'passed' | 'failed';
  summary?: string | null;
}): EvalRun {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO guardian_eval_runs (
      artifact_version_id,
      suite_name,
      wall_clock_budget_seconds,
      primary_metric,
      guardian_eval_score,
      hard_failures,
      status,
      summary,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.artifactVersionId ?? null,
    input.suiteName ?? DEFAULT_SUITE_NAME,
    input.wallClockBudgetSeconds ?? DEFAULT_BUDGET_SECONDS,
    DEFAULT_PRIMARY_METRIC,
    input.guardianEvalScore,
    input.hardFailures ?? 0,
    input.status,
    input.summary ?? null,
    input.status === 'pending' ? null : new Date().toISOString()
  );

  return db.prepare('SELECT * FROM guardian_eval_runs WHERE id = ?').get(info.lastInsertRowid) as EvalRun;
}

export function promoteGuardianPolicyVersion(versionId: number, reason: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE guardian_artifact_versions SET is_active = 0 WHERE artifact_type = ?').run(ACTIVE_POLICY_TYPE);
    db.prepare(`
      UPDATE guardian_artifact_versions
      SET is_active = 1, promoted_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(versionId);
    db.prepare(`
      INSERT INTO guardian_promotions (artifact_version_id, reason)
      VALUES (?, ?)
    `).run(versionId, reason);
  })();
}

export function seedDefaultGuardianEvalCases(suiteName: string = DEFAULT_SUITE_NAME): number {
  const db = getDb();
  // INSERT OR IGNORE so new cases are added without re-inserting existing ones.
  // Requires the UNIQUE index on (suite_name, case_name) created in db.ts.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO guardian_eval_cases (suite_name, case_name, scenario_type, input_payload, expected_outcome)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const testCase of DEFAULT_GUARDIAN_EVAL_CASES) {
      insert.run(
        suiteName,
        testCase.caseName,
        testCase.scenarioType,
        JSON.stringify(testCase.inputPayload),
        testCase.expectedOutcome
      );
    }
  })();

  const count = db.prepare('SELECT COUNT(*) as count FROM guardian_eval_cases WHERE suite_name = ?').get(suiteName) as { count: number };
  return count.count;
}

export function listGuardianEvalCases(suiteName: string = DEFAULT_SUITE_NAME): GuardianEvalCaseRecord[] {
  seedDefaultGuardianEvalCases(suiteName);
  const db = getDb();
  return db.prepare(`
    SELECT *
    FROM guardian_eval_cases
    WHERE suite_name = ? AND active = 1
    ORDER BY id ASC
  `).all(suiteName) as GuardianEvalCaseRecord[];
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function scoreBundleAgainstSuite(policy: GuardianPolicyBundle, suiteName: string = DEFAULT_SUITE_NAME): GuardianEvalSummary {
  const cases = listGuardianEvalCases(suiteName);
  const caseResults = cases.map((record) =>
    evaluateGuardianPolicyScenario(record.id, record.caseName, policy, JSON.parse(record.inputPayload) as GuardianEvalScenario)
  );
  const hardFailures = caseResults.filter((item) => item.hardFailure).length;
  const totalScore = caseResults.reduce((sum, item) => sum + item.score, 0);
  const guardianEvalScore = round2(totalScore / Math.max(1, caseResults.length));
  return {
    suiteName,
    guardianEvalScore,
    hardFailures,
    caseResults,
  };
}

function createMutatedCandidates(base: GuardianPolicyBundle): GuardianPolicyBundle[] {
  const variants: GuardianPolicyBundle[] = [];
  const makeClone = () => structuredClone(base) as GuardianPolicyBundle;

  {
    const variant = makeClone();
    variant.version = `${base.version}-cooldown-tight`;
    variant.thresholds.speechCooldownMs = Math.max(45_000, base.thresholds.speechCooldownMs - 15_000);
    variants.push(variant);
  }
  {
    const variant = makeClone();
    variant.version = `${base.version}-cooldown-loose`;
    variant.thresholds.speechCooldownMs = base.thresholds.speechCooldownMs + 15_000;
    variants.push(variant);
  }
  {
    const variant = makeClone();
    variant.version = `${base.version}-focus-stricter`;
    variant.thresholds.flowSilenceThreshold = Math.min(95, base.thresholds.flowSilenceThreshold + 3);
    variants.push(variant);
  }
  {
    const variant = makeClone();
    variant.version = `${base.version}-scatter-earlier`;
    variant.thresholds.highScatterSpeakThreshold = Math.max(4, base.thresholds.highScatterSpeakThreshold - 1);
    variants.push(variant);
  }
  {
    const variant = makeClone();
    variant.version = `${base.version}-block-faster`;
    variant.thresholds.distractionRevisitBlockCount = Math.max(2, base.thresholds.distractionRevisitBlockCount - 1);
    variants.push(variant);
  }
  {
    const variant = makeClone();
    variant.version = `${base.version}-voice-tighter`;
    variant.prompts.voicePolicyPrompt = `${base.prompts.voicePolicyPrompt} Keep interventions even shorter and avoid repeated phrasing.`;
    variants.push(variant);
  }

  return variants;
}

function insertCandidateArtifact(policy: GuardianPolicyBundle, score: number, notes: string): PolicyArtifactVersion {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO guardian_artifact_versions (
      artifact_type,
      version,
      content,
      guardian_eval_score,
      is_active,
      notes
    ) VALUES (?, ?, ?, ?, 0, ?)
  `).run(ACTIVE_POLICY_TYPE, policy.version, JSON.stringify(policy), score, notes);
  return db.prepare('SELECT * FROM guardian_artifact_versions WHERE id = ?').get(info.lastInsertRowid) as PolicyArtifactVersion;
}

function recordGuardianCanary(score: number, notes: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO guardian_canary_results (guardian_eval_score, status, notes)
    VALUES (?, ?, ?)
  `).run(score, score >= 0 ? 'passed' : 'failed', notes);
}

export function runGuardianOptimizationCycle(input?: {
  suiteName?: string;
  wallClockBudgetSeconds?: number;
}) {
  const suiteName = input?.suiteName || DEFAULT_SUITE_NAME;
  const wallClockBudgetSeconds = input?.wallClockBudgetSeconds || DEFAULT_BUDGET_SECONDS;
  const activeArtifact = ensureDefaultGuardianArtifacts();
  const activePolicy = getActiveGuardianPolicyBundle();
  const baselineSummary = scoreBundleAgainstSuite(activePolicy, suiteName);

  recordGuardianEvalRun({
    artifactVersionId: activeArtifact.id,
    suiteName,
    wallClockBudgetSeconds,
    guardianEvalScore: baselineSummary.guardianEvalScore,
    hardFailures: baselineSummary.hardFailures,
    status: baselineSummary.hardFailures === 0 ? 'passed' : 'failed',
    summary: `Baseline: ${baselineSummary.guardianEvalScore}`,
  });

  const candidates = createMutatedCandidates(activePolicy);
  const evaluatedCandidates = candidates.map((candidate) => {
    const summary = scoreBundleAgainstSuite(candidate, suiteName);
    const artifact = insertCandidateArtifact(candidate, summary.guardianEvalScore, `Auto-generated candidate for ${suiteName}`);
    recordGuardianEvalRun({
      artifactVersionId: artifact.id,
      suiteName,
      wallClockBudgetSeconds,
      guardianEvalScore: summary.guardianEvalScore,
      hardFailures: summary.hardFailures,
      status: summary.hardFailures === 0 ? 'passed' : 'failed',
      summary: JSON.stringify(summary.caseResults),
    });
    return { artifact, summary };
  });

  const winner = evaluatedCandidates
    .filter((item) => item.summary.hardFailures === 0)
    .sort((left, right) => right.summary.guardianEvalScore - left.summary.guardianEvalScore)[0];

  let promoted = null;
  if (winner && winner.summary.guardianEvalScore > baselineSummary.guardianEvalScore) {
    promoteGuardianPolicyVersion(
      winner.artifact.id,
      `Promoted automatically: ${winner.summary.guardianEvalScore} > ${baselineSummary.guardianEvalScore}`
    );
    recordGuardianCanary(winner.summary.guardianEvalScore, `Promotion candidate ${winner.artifact.version} passed.`);
    promoted = winner.artifact;
  } else {
    recordGuardianCanary(baselineSummary.guardianEvalScore, 'No candidate beat baseline; active policy retained.');
  }

  return {
    suiteName,
    baseline: baselineSummary,
    candidates: evaluatedCandidates.map((item) => ({
      artifactId: item.artifact.id,
      version: item.artifact.version,
      score: item.summary.guardianEvalScore,
      hardFailures: item.summary.hardFailures,
    })),
    promoted,
  };
}
