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
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import { buildPersonalizationSnapshot, formatPersonalizationContext, type PersonalizationSnapshot } from './personalization-context';

const ACTIVE_POLICY_TYPE = 'guardian_policy_bundle';
const DEFAULT_PRIMARY_METRIC = 'guardian_eval_score';
const DEFAULT_SUITE_NAME = 'baseline_guardian_suite';
const DEFAULT_BUDGET_SECONDS = 300;
const MAX_LLM_MUTATIONS = 4;

// ─── Policy Bounds (LLM mutations must stay within these) ─────────────────────

const THRESHOLD_BOUNDS: Record<string, [number, number]> = {
  speechCooldownMs:             [30_000, 300_000],
  flowSilenceThreshold:         [70,     100],
  distractionRevisitBlockCount: [2,      6],
  distractionTabSwitchBlockCount:[2,     8],
  highScatterSpeakThreshold:    [3,      10],
  idleConcernSeconds:           [120,    900],
  focusDropSpeakThreshold:      [5,      30],
  lowFocusThreshold:            [40,     80],
  dwellDepthTargetSeconds:      [60,     600],
  stableFlowMinDwellSeconds:    [30,     300],
  stableFlowMaxTabSwitches:     [1,      8],
  flowConfirmationScore:        [75,     98],
  flowConfirmationMinElapsedMinutes: [5, 30],
  lowEnergyThreshold:           [20,     50],
};

const WEIGHT_KEYS = ['continuity', 'switches', 'dwell', 'distractionPenalty', 'idlePenalty'] as const;
const WEIGHT_BOUNDS: [number, number] = [0.05, 0.60];
const PROMPT_KEYS = ['interventionPrompt', 'overrideRubric', 'retrievalPrompt', 'sessionPlannerPrompt', 'voicePolicyPrompt', 'redTeamRules'] as const;
const PROMPT_MAX_LENGTH = 1500;

// ─── Canary Holdout Cases (never used in training suite) ──────────────────────

const CANARY_EVAL_CASES: Array<{ caseName: string; inputPayload: GuardianEvalScenario }> = [
  {
    caseName: 'canary_repeated_distraction_must_block',
    inputPayload: {
      durationMinutes: 60,
      targetTitle: 'Canary Session',
      events: [
        { type: 'tab', url: 'https://wikipedia.org/wiki/Calculus', title: 'Wikipedia', dwellSeconds: 180 },
        { type: 'tab', url: 'https://instagram.com', title: 'Instagram', dwellSeconds: 30 },
        { type: 'tab', url: 'https://wikipedia.org/wiki/Calculus', title: 'Wikipedia', dwellSeconds: 60 },
        { type: 'tab', url: 'https://instagram.com/explore', title: 'Instagram Explore', dwellSeconds: 25 },
        { type: 'tab', url: 'https://instagram.com/reels', title: 'Instagram Reels', dwellSeconds: 20 },
      ],
      expected: { mustBlock: true, finalClassification: 'distraction' },
    },
  },
  {
    caseName: 'canary_productive_only_never_blocked',
    inputPayload: {
      durationMinutes: 45,
      targetTitle: 'Canary Deep Work',
      events: [
        { type: 'tab', url: 'https://edx.org/learn/cs', title: 'edX', dwellSeconds: 400 },
        { type: 'heartbeat' },
        { type: 'tab', url: 'https://khanacademy.org/computing', title: 'Khan', dwellSeconds: 300 },
      ],
      expected: { maxBlockCount: 0, finalClassification: 'on_topic' },
    },
  },
];

// ─── Default Eval Cases ───────────────────────────────────────────────────────

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

// ─── Artifact CRUD ────────────────────────────────────────────────────────────

export function ensureDefaultGuardianArtifacts(): PolicyArtifactVersion {
  const db = getDb();
  const active = db.prepare(`
    SELECT * FROM guardian_artifact_versions
    WHERE artifact_type = ? AND is_active = 1
    ORDER BY id DESC LIMIT 1
  `).get(ACTIVE_POLICY_TYPE) as PolicyArtifactVersion | undefined;

  if (active) return active;

  const info = db.prepare(`
    INSERT INTO guardian_artifact_versions (
      artifact_type, version, content, guardian_eval_score,
      is_active, promoted_at, notes
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
  let bundle: GuardianPolicyBundle;
  try {
    bundle = JSON.parse(row.content) as GuardianPolicyBundle;
  } catch {
    bundle = DEFAULT_GUARDIAN_POLICY_BUNDLE;
  }

  // Overlay per-user focus-score weights from the most recent calibrated semantic profile.
  // Calibration may adjust these over time — always use the latest values.
  try {
    const db = getDb();
    const profile = db.prepare(`
      SELECT focus_weight_continuity, focus_weight_tab_switches,
             focus_weight_dwell, focus_weight_distraction_revisit, focus_weight_idle
      FROM guardian_semantic_profiles
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as {
      focus_weight_continuity: number | null;
      focus_weight_tab_switches: number | null;
      focus_weight_dwell: number | null;
      focus_weight_distraction_revisit: number | null;
      focus_weight_idle: number | null;
    } | undefined;

    if (profile && profile.focus_weight_continuity !== null) {
      bundle = {
        ...bundle,
        weights: {
          continuity:        profile.focus_weight_continuity,
          switches:          profile.focus_weight_tab_switches ?? bundle.weights.switches,
          dwell:             profile.focus_weight_dwell ?? bundle.weights.dwell,
          distractionPenalty: profile.focus_weight_distraction_revisit ?? bundle.weights.distractionPenalty,
          idlePenalty:       profile.focus_weight_idle ?? bundle.weights.idlePenalty,
        },
      };
    }
  } catch { /* non-fatal — fall through with artifact weights */ }

  return bundle;
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
      artifact_version_id, suite_name, wall_clock_budget_seconds, primary_metric,
      guardian_eval_score, hard_failures, status, summary, completed_at
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
    db.prepare('INSERT INTO guardian_promotions (artifact_version_id, reason) VALUES (?, ?)').run(versionId, reason);
  })();
}

export function seedDefaultGuardianEvalCases(suiteName: string = DEFAULT_SUITE_NAME): number {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO guardian_eval_cases (suite_name, case_name, scenario_type, input_payload, expected_outcome)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const c of DEFAULT_GUARDIAN_EVAL_CASES) {
      insert.run(suiteName, c.caseName, c.scenarioType, JSON.stringify(c.inputPayload), c.expectedOutcome);
    }
  })();
  const count = db.prepare('SELECT COUNT(*) as count FROM guardian_eval_cases WHERE suite_name = ?').get(suiteName) as { count: number };
  return count.count;
}

export function listGuardianEvalCases(suiteName: string = DEFAULT_SUITE_NAME): GuardianEvalCaseRecord[] {
  seedDefaultGuardianEvalCases(suiteName);
  return getDb().prepare(`
    SELECT * FROM guardian_eval_cases WHERE suite_name = ? AND active = 1 ORDER BY id ASC
  `).all(suiteName) as GuardianEvalCaseRecord[];
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function round2(v: number) { return Math.round(v * 100) / 100; }

function scoreBundleAgainstSuite(policy: GuardianPolicyBundle, suiteName: string = DEFAULT_SUITE_NAME): GuardianEvalSummary {
  const cases = listGuardianEvalCases(suiteName);
  const caseResults = cases.map((r) =>
    evaluateGuardianPolicyScenario(r.id, r.caseName, policy, JSON.parse(r.inputPayload) as GuardianEvalScenario)
  );

  // Load real-user-derived eval cases (1.5x weight)
  let realCaseResults: import('./guardian-types').GuardianEvalCaseResult[] = [];
  try {
    const { loadUserDerivedEvalCases } = require('./eval-case-extractor') as typeof import('./eval-case-extractor');
    const realCases = loadUserDerivedEvalCases(5);
    realCaseResults = realCases.map((r) =>
      evaluateGuardianPolicyScenario(r.id, r.caseName, policy, JSON.parse(r.inputPayload) as GuardianEvalScenario)
    );
  } catch { /* non-fatal — extractor may not exist yet */ }

  const syntheticTotal = caseResults.reduce((s, r) => s + r.score, 0);
  const realTotal = realCaseResults.reduce((s, r) => s + r.score * 1.5, 0);
  const totalCount = caseResults.length + realCaseResults.length * 1.5;
  const scenarioScore = round2((syntheticTotal + realTotal) / Math.max(1, totalCount));

  const allCaseResults = [...caseResults, ...realCaseResults];

  let blendedScore = scenarioScore;
  try {
    const { getCalibrationStatus } = require('./guardian-calibration') as typeof import('./guardian-calibration');
    const calibration = getCalibrationStatus();
    if (calibration.accuracy !== null && calibration.sessions_count >= 3) {
      const calibAccuracy100 = calibration.accuracy * 100;
      blendedScore = round2(0.85 * scenarioScore + 0.15 * calibAccuracy100);
    }
  } catch { /* non-fatal — calibration module may not exist yet */ }

  return {
    suiteName,
    guardianEvalScore: blendedScore,
    hardFailures: allCaseResults.filter((r) => r.hardFailure).length,
    caseResults: allCaseResults,
  };
}

function runCanaryValidation(candidate: GuardianPolicyBundle, baseline: GuardianPolicyBundle): {
  passed: boolean;
  canaryScore: number;
  baselineCanaryScore: number;
  hardFailures: number;
} {
  const evalCanary = (policy: GuardianPolicyBundle) =>
    CANARY_EVAL_CASES.map((c, i) =>
      evaluateGuardianPolicyScenario(10_000 + i, c.caseName, policy, c.inputPayload)
    );

  const candidateResults = evalCanary(candidate);
  const baselineResults = evalCanary(baseline);

  const hardFailures = candidateResults.filter((r) => r.hardFailure).length;
  const canaryScore = round2(candidateResults.reduce((s, r) => s + r.score, 0) / candidateResults.length);
  const baselineCanaryScore = round2(baselineResults.reduce((s, r) => s + r.score, 0) / baselineResults.length);

  return {
    passed: hardFailures === 0 && canaryScore >= baselineCanaryScore,
    canaryScore,
    baselineCanaryScore,
    hardFailures,
  };
}

function insertCandidateArtifact(policy: GuardianPolicyBundle, score: number, notes: string): PolicyArtifactVersion {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO guardian_artifact_versions (artifact_type, version, content, guardian_eval_score, is_active, notes)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(ACTIVE_POLICY_TYPE, policy.version, JSON.stringify(policy), score, notes);
  return db.prepare('SELECT * FROM guardian_artifact_versions WHERE id = ?').get(info.lastInsertRowid) as PolicyArtifactVersion;
}

function recordGuardianCanary(score: number, notes: string): void {
  getDb().prepare(`
    INSERT INTO guardian_canary_results (guardian_eval_score, status, notes) VALUES (?, ?, ?)
  `).run(score, score >= 0 ? 'passed' : 'failed', notes);
}

// ─── Mutation Context (feeds the LLM) ────────────────────────────────────────

interface RecentSessionSummary {
  target_title: string;
  duration_minutes: number;
  elapsed_minutes: number;
  focus_score: number;
  blocked_count: number;
  override_count: number;
  mood: string | null;
  reflection_text: string | null;
}

interface EvalCaseFailure {
  caseName: string;
  score: number;
  reasons: string[];
}

function buildMutationContext(): { recentSessions: RecentSessionSummary[]; lastEvalFailures: EvalCaseFailure[] } {
  const db = getDb();

  const recentSessions = db.prepare(`
    SELECT
      s.target_title, s.duration_minutes, s.elapsed_minutes,
      s.final_focus_score AS focus_score, s.blocked_count, s.override_count, s.mood,
      r.reflection_text
    FROM guardian_session_summaries s
    LEFT JOIN guardian_session_reflections r ON r.session_id = s.session_id
    ORDER BY s.completed_at DESC
    LIMIT 6
  `).all() as RecentSessionSummary[];

  let lastEvalFailures: EvalCaseFailure[] = [];
  try {
    const lastRun = db.prepare(`
      SELECT summary FROM guardian_eval_runs
      WHERE status != 'pending' AND summary IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get() as { summary: string } | undefined;

    if (lastRun?.summary) {
      const parsed = JSON.parse(lastRun.summary) as Array<{ caseName: string; passed: boolean; score: number; reasons?: string[] }>;
      if (Array.isArray(parsed)) {
        lastEvalFailures = parsed
          .filter((r) => !r.passed && r.reasons && r.reasons.length > 0)
          .map((r) => ({ caseName: r.caseName, score: r.score, reasons: r.reasons! }))
          .slice(0, 8);
      }
    }
  } catch { /* non-fatal */ }

  return { recentSessions, lastEvalFailures };
}

// ─── Policy Bundle Validator ──────────────────────────────────────────────────

export function validatePolicyBundle(obj: unknown): GuardianPolicyBundle {
  if (typeof obj !== 'object' || obj === null) throw new Error('Policy must be an object');
  const p = obj as Record<string, unknown>;

  if (typeof p.version !== 'string' || !p.version.trim()) throw new Error('Missing or empty version');
  if (typeof p.prompts !== 'object' || !p.prompts) throw new Error('Missing prompts');
  if (typeof p.thresholds !== 'object' || !p.thresholds) throw new Error('Missing thresholds');
  if (typeof p.weights !== 'object' || !p.weights) throw new Error('Missing weights');

  const prompts = p.prompts as Record<string, unknown>;
  const thresholds = p.thresholds as Record<string, unknown>;
  const weights = p.weights as Record<string, unknown>;

  for (const key of PROMPT_KEYS) {
    if (typeof prompts[key] !== 'string' || !(prompts[key] as string).trim()) {
      throw new Error(`Missing or empty prompt field: ${key}`);
    }
    if ((prompts[key] as string).length > PROMPT_MAX_LENGTH) {
      throw new Error(`Prompt field too long (max ${PROMPT_MAX_LENGTH} chars): ${key}`);
    }
  }

  for (const [key, [min, max]] of Object.entries(THRESHOLD_BOUNDS)) {
    if (typeof thresholds[key] !== 'number') throw new Error(`Missing threshold: ${key}`);
    const val = thresholds[key] as number;
    if (val < min || val > max) throw new Error(`Threshold ${key}=${val} out of bounds [${min}, ${max}]`);
  }

  let weightSum = 0;
  for (const key of WEIGHT_KEYS) {
    if (typeof weights[key] !== 'number') throw new Error(`Missing weight: ${key}`);
    const val = weights[key] as number;
    if (val < WEIGHT_BOUNDS[0] || val > WEIGHT_BOUNDS[1]) {
      throw new Error(`Weight ${key}=${val} out of bounds [${WEIGHT_BOUNDS[0]}, ${WEIGHT_BOUNDS[1]}]`);
    }
    weightSum += val;
  }
  if (Math.abs(weightSum - 1.0) > 0.015) {
    throw new Error(`Weights must sum to 1.0, got ${weightSum.toFixed(3)}`);
  }

  return p as unknown as GuardianPolicyBundle;
}

// ─── LLM Mutation Generator ───────────────────────────────────────────────────

async function generateLLMMutations(
  policy: GuardianPolicyBundle,
  context: { recentSessions: RecentSessionSummary[]; lastEvalFailures: EvalCaseFailure[]; personalization: PersonalizationSnapshot }
): Promise<Array<GuardianPolicyBundle & { _rationale?: string }>> {
  const ai = getGenAI();
  if (!ai) return [];

  const sessionLines = context.recentSessions.length > 0
    ? context.recentSessions.map((s) =>
        `- "${s.target_title}" (${s.elapsed_minutes}/${s.duration_minutes}min, mood:${s.mood ?? 'unknown'}): ` +
        `focus=${s.focus_score}/100, blocks=${s.blocked_count}, overrides=${s.override_count}` +
        (s.reflection_text ? `, reflection: "${s.reflection_text.slice(0, 100)}"` : '')
      ).join('\n')
    : `No completed sessions yet. Use the current personalization context as the live prior:
${formatPersonalizationContext(context.personalization)}`;

  const failureLines = context.lastEvalFailures.length > 0
    ? context.lastEvalFailures.map((f) => `- ${f.caseName} (score:${f.score}): ${f.reasons.join('; ')}`).join('\n')
    : 'No failures in last eval run — policy is passing all cases.';

  const thresholdDocs = Object.entries(THRESHOLD_BOUNDS)
    .map(([k, [mn, mx]]) => `  ${k}: [${mn}, ${mx}]`)
    .join('\n');

  const prompt = `You are a policy optimizer for LifeOS Guardian — a personal AI that watches focus sessions and intervenes when the user gets distracted.

Your job: propose ${MAX_LLM_MUTATIONS} improved candidate policy bundles based on real session outcomes and eval failures.

CURRENT ACTIVE POLICY:
${JSON.stringify(policy, null, 2)}

RECENT SESSION OUTCOMES (latest first):
${sessionLines}

CURRENT PERSONALIZATION:
${formatPersonalizationContext(context.personalization)}

LAST EVAL CASE FAILURES:
${failureLines}

WHAT YOU MAY CHANGE:
Prompts (any of: interventionPrompt, overrideRubric, voicePolicyPrompt — rewrite to improve coaching quality, tone, and specificity):
  Max length per prompt: ${PROMPT_MAX_LENGTH} chars. Must be non-empty.
  Do NOT change: retrievalPrompt, sessionPlannerPrompt, redTeamRules

Thresholds (valid ranges):
${thresholdDocs}

Weights (each in [${WEIGHT_BOUNDS[0]}, ${WEIGHT_BOUNDS[1]}], must sum to EXACTLY 1.0):
  continuity, switches, dwell, distractionPenalty, idlePenalty

HARD CONSTRAINTS — never violate:
${policy.prompts.redTeamRules}
- Every mutation must differ from the current policy in at least one field
- Weights must sum to exactly 1.0 (tolerance ±0.01)
- Do not add or remove fields from the policy bundle

STRATEGY GUIDE:
- If sessions show low focus scores with many blocks → the guardian is too aggressive; loosen thresholds
- If sessions show high override rates → override rubric may be too strict; soften it
- If eval shows "spoke too often" failures → increase speechCooldownMs or flowSilenceThreshold
- If eval shows "mustBlock but none occurred" failures → lower distractionRevisitBlockCount
- If eval shows "mustSpeak but none occurred" failures → lower highScatterSpeakThreshold or idleConcernSeconds
- If sessions show good focus with no issues → experiment with weight shifts to reward dwell depth more

Return ONLY a JSON array of exactly ${MAX_LLM_MUTATIONS} complete policy bundles.
Each bundle must contain ALL fields. Include a "_rationale" field (not part of the schema, will be stripped):

[{
  "_rationale": "one sentence: which specific weakness this targets and why this change addresses it",
  "version": "guardian-v1-<short-kebab-name>",
  "prompts": {
    "interventionPrompt": "...",
    "overrideRubric": "...",
    "retrievalPrompt": "${policy.prompts.retrievalPrompt}",
    "sessionPlannerPrompt": "${policy.prompts.sessionPlannerPrompt}",
    "voicePolicyPrompt": "...",
    "redTeamRules": "${policy.prompts.redTeamRules}"
  },
  "thresholds": { "speechCooldownMs": 90000, "flowSilenceThreshold": 85, "distractionRevisitBlockCount": 3, "distractionTabSwitchBlockCount": 4, "highScatterSpeakThreshold": 6, "idleConcernSeconds": 480, "focusDropSpeakThreshold": 15, "lowFocusThreshold": 60, "dwellDepthTargetSeconds": 180, "stableFlowMinDwellSeconds": 120, "stableFlowMaxTabSwitches": 2, "flowConfirmationScore": 88, "flowConfirmationMinElapsedMinutes": 10, "lowEnergyThreshold": 35 },
  "weights": { "continuity": 0.35, "switches": 0.25, "dwell": 0.20, "distractionPenalty": 0.15, "idlePenalty": 0.05 }
}]`;

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const raw = JSON.parse((result.text || '').trim()) as unknown[];
    if (!Array.isArray(raw)) return [];

    const validated: Array<GuardianPolicyBundle & { _rationale?: string }> = [];
    for (const item of raw) {
      try {
        const rationale = typeof (item as Record<string, unknown>)._rationale === 'string'
          ? (item as Record<string, unknown>)._rationale as string
          : undefined;
        delete (item as Record<string, unknown>)._rationale;

        const bundle = validatePolicyBundle(item) as GuardianPolicyBundle & { _rationale?: string };
        bundle._rationale = rationale;
        validated.push(bundle);
      } catch (err) {
        console.warn('[GuardianOptimizer] Skipping invalid LLM mutation:', (err as Error).message);
      }
    }

    console.log(`[GuardianOptimizer] LLM produced ${validated.length}/${raw.length} valid mutations`);
    return validated;
  } catch (err) {
    console.error('[GuardianOptimizer] LLM mutation generation failed:', err);
    return [];
  }
}

// ─── Fallback: hand-coded mutations (when LLM is unavailable) ─────────────────

function createFallbackMutations(base: GuardianPolicyBundle): GuardianPolicyBundle[] {
  const clone = () => structuredClone(base) as GuardianPolicyBundle;
  const variants: GuardianPolicyBundle[] = [];

  { const v = clone(); v.version = `${base.version}-cooldown-tight`; v.thresholds.speechCooldownMs = Math.max(45_000, base.thresholds.speechCooldownMs - 15_000); variants.push(v); }
  { const v = clone(); v.version = `${base.version}-cooldown-loose`; v.thresholds.speechCooldownMs = Math.min(300_000, base.thresholds.speechCooldownMs + 15_000); variants.push(v); }
  { const v = clone(); v.version = `${base.version}-block-faster`; v.thresholds.distractionRevisitBlockCount = Math.max(2, base.thresholds.distractionRevisitBlockCount - 1); variants.push(v); }
  { const v = clone(); v.version = `${base.version}-scatter-earlier`; v.thresholds.highScatterSpeakThreshold = Math.max(3, base.thresholds.highScatterSpeakThreshold - 1); variants.push(v); }

  return variants;
}

// ─── Main Optimization Cycle ──────────────────────────────────────────────────

export async function runGuardianOptimizationCycle(input?: {
  suiteName?: string;
  wallClockBudgetSeconds?: number;
}): Promise<{
  suiteName: string;
  wallClockBudgetSeconds: number;
  mutationSource: 'llm' | 'fallback';
  baseline: { score: number; hardFailures: number };
  candidates: Array<{ artifactId: number; version: string; score: number; hardFailures: number; rationale: string | null }>;
  promoted: PolicyArtifactVersion | null;
  canary: { status: string; canaryScore?: number; baselineCanaryScore?: number };
}> {
  const db = getDb();
  const suiteName = input?.suiteName ?? DEFAULT_SUITE_NAME;
  const wallClockBudgetSeconds = input?.wallClockBudgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  const cycleStartMs = Date.now();
  const budgetMs = wallClockBudgetSeconds * 1_000;

  // Guard: never run during an active session
  const activeSession = db.prepare(
    "SELECT session_id FROM guardian_session_summaries WHERE completed_at IS NULL LIMIT 1"
  ).get();
  if (activeSession) {
    throw new Error('Cannot run optimization during an active guardian session.');
  }

  const activeArtifact = ensureDefaultGuardianArtifacts();
  const activePolicy = getActiveGuardianPolicyBundle();

  // 1. Baseline eval
  const baselineSummary = scoreBundleAgainstSuite(activePolicy, suiteName);
  recordGuardianEvalRun({
    artifactVersionId: activeArtifact.id,
    suiteName,
    wallClockBudgetSeconds,
    guardianEvalScore: baselineSummary.guardianEvalScore,
    hardFailures: baselineSummary.hardFailures,
    status: baselineSummary.hardFailures === 0 ? 'passed' : 'failed',
    summary: JSON.stringify(baselineSummary.caseResults),
  });

  // 2. Generate mutations — LLM first, fall back to hand-coded
  const mutationContext = {
    ...buildMutationContext(),
    personalization: buildPersonalizationSnapshot({
      surface: 'intervention',
      maxInsights: 3,
      includeThresholds: true,
      includeMemoryFacts: 6,
    }),
  };
  let mutationSource: 'llm' | 'fallback' = 'llm';
  let candidates = await generateLLMMutations(activePolicy, mutationContext);
  if (candidates.length === 0) {
    console.warn('[GuardianOptimizer] LLM unavailable or returned no valid mutations — using fallback');
    candidates = createFallbackMutations(activePolicy);
    mutationSource = 'fallback';
  }

  // 3. Evaluate each candidate within budget
  const evaluatedCandidates: Array<{
    artifact: PolicyArtifactVersion;
    summary: GuardianEvalSummary;
    rationale: string | null;
  }> = [];

  for (const candidate of candidates) {
    if (Date.now() - cycleStartMs >= budgetMs) {
      console.warn(`[GuardianOptimizer] Budget (${wallClockBudgetSeconds}s) reached — ${candidates.length - evaluatedCandidates.length} candidates skipped`);
      break;
    }

    const rationale = (candidate as GuardianPolicyBundle & { _rationale?: string })._rationale ?? null;
    delete (candidate as GuardianPolicyBundle & { _rationale?: string })._rationale;

    const summary = scoreBundleAgainstSuite(candidate, suiteName);
    const artifact = insertCandidateArtifact(
      candidate,
      summary.guardianEvalScore,
      rationale ? `[LLM] ${rationale}` : `Auto candidate for ${suiteName} (${mutationSource})`
    );
    recordGuardianEvalRun({
      artifactVersionId: artifact.id,
      suiteName,
      wallClockBudgetSeconds,
      guardianEvalScore: summary.guardianEvalScore,
      hardFailures: summary.hardFailures,
      status: summary.hardFailures === 0 ? 'passed' : 'failed',
      summary: JSON.stringify(summary.caseResults),
    });
    evaluatedCandidates.push({ artifact, summary, rationale });
  }

  // 4. Pick winner: no hard failures, best score
  const winner = evaluatedCandidates
    .filter((c) => c.summary.hardFailures === 0)
    .sort((a, b) => b.summary.guardianEvalScore - a.summary.guardianEvalScore)[0] ?? null;

  let promoted: PolicyArtifactVersion | null = null;
  let canaryResult: { status: string; canaryScore?: number; baselineCanaryScore?: number } = { status: 'no_candidate' };

  if (winner && winner.summary.guardianEvalScore > baselineSummary.guardianEvalScore) {
    // 5. Promote winner (tentatively)
    promoteGuardianPolicyVersion(
      winner.artifact.id,
      `Score ${winner.summary.guardianEvalScore} > baseline ${baselineSummary.guardianEvalScore}` +
      (winner.rationale ? ` — ${winner.rationale}` : '')
    );

    // 6. Canary validation on holdout suite
    const winnerPolicy = JSON.parse(
      (db.prepare('SELECT content FROM guardian_artifact_versions WHERE id = ?').get(winner.artifact.id) as { content: string }).content
    ) as GuardianPolicyBundle;

    const canary = runCanaryValidation(winnerPolicy, activePolicy);

    if (!canary.passed) {
      // Rollback: re-activate the previous version
      db.transaction(() => {
        db.prepare('UPDATE guardian_artifact_versions SET is_active = 0 WHERE artifact_type = ?').run(ACTIVE_POLICY_TYPE);
        db.prepare(`UPDATE guardian_artifact_versions SET is_active = 1, promoted_at = datetime('now', 'localtime') WHERE id = ?`).run(activeArtifact.id);
      })();
      recordGuardianCanary(
        canary.canaryScore,
        `Canary FAILED for ${winner.artifact.version}: hardFails=${canary.hardFailures}, score=${canary.canaryScore} < baseline ${canary.baselineCanaryScore}. Rolled back to v${activeArtifact.id}.`
      );
      canaryResult = { status: 'rolled_back', canaryScore: canary.canaryScore, baselineCanaryScore: canary.baselineCanaryScore };
    } else {
      recordGuardianCanary(
        canary.canaryScore,
        `Canary passed for ${winner.artifact.version}: score ${canary.canaryScore} >= baseline ${canary.baselineCanaryScore}.`
      );
      promoted = winner.artifact;
      canaryResult = { status: 'passed', canaryScore: canary.canaryScore, baselineCanaryScore: canary.baselineCanaryScore };
    }
  } else {
    recordGuardianCanary(
      baselineSummary.guardianEvalScore,
      'No candidate beat baseline — active policy retained.'
    );
  }

  return {
    suiteName,
    wallClockBudgetSeconds,
    mutationSource,
    baseline: { score: baselineSummary.guardianEvalScore, hardFailures: baselineSummary.hardFailures },
    candidates: evaluatedCandidates.map((c) => ({
      artifactId: c.artifact.id,
      version: c.artifact.version,
      score: c.summary.guardianEvalScore,
      hardFailures: c.summary.hardFailures,
      rationale: c.rationale,
    })),
    promoted,
    canary: canaryResult,
  };
}
