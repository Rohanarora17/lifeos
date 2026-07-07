import { getDb } from './db';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import type { GuardianPolicyBundle, GuardianEvalScenario, LLMCalibrationSignal } from './guardian-types';

export async function extractEvalCaseFromFeedback(
  sessionId: string,
  llmSignal: LLMCalibrationSignal,
  sessionPolicy: GuardianPolicyBundle | null,
): Promise<boolean> {
  try {
    const db = getDb();

    const events = db.prepare(`
      SELECT event_type, url, title, payload, dwell_seconds, idle_seconds, created_at
      FROM guardian_event_log
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT 50
    `).all(sessionId) as Array<{
      event_type: string;
      url: string | null;
      title: string | null;
      payload: string | null;
      dwell_seconds: number | null;
      idle_seconds: number | null;
    }>;

    if (events.length === 0) return false;

    const scenarioEvents: GuardianEvalScenario['events'] = [];
    for (const e of events) {
      if (e.event_type === 'tab') {
        scenarioEvents.push({
          type: 'tab',
          url: e.url || undefined,
          title: e.title || undefined,
          dwellSeconds: e.dwell_seconds ?? undefined,
        });
      } else if (e.event_type === 'idle') {
        scenarioEvents.push({
          type: 'idle',
          idleSeconds: e.idle_seconds ?? undefined,
        });
      } else if (e.event_type === 'heartbeat') {
        scenarioEvents.push({ type: 'heartbeat' });
      }
    }

    if (scenarioEvents.length < 2) return false;

    let scenarioType = 'real_over_intervention';
    let expected: GuardianEvalScenario['expected'] = {};

    if (llmSignal.focusOverEstimated && llmSignal.specificComplaints.some(c => /block/i.test(c))) {
      scenarioType = 'real_false_positive_guard';
      expected = { mustBlock: false, maxBlockCount: 0, finalClassification: 'on_topic' };
    } else if (llmSignal.focusUnderEstimated && llmSignal.overallSessionQuality === 'poor') {
      scenarioType = 'real_missed_distraction';
      expected = { mustBlock: true };
    } else if (llmSignal.workModeMismatch) {
      scenarioType = 'real_work_mode_mismatch';
      expected = { finalClassification: 'on_topic', maxBlockCount: 0 };
    } else if (llmSignal.focusOverEstimated) {
      scenarioType = 'real_over_intervention';
      expected = { maxBlockCount: 0, maxSpeakCount: 0 };
    }

    const sessionRow = db.prepare(`
      SELECT target_title, duration_minutes FROM guardian_sessions WHERE session_id = ?
    `).get(sessionId) as { target_title: string; duration_minutes: number } | undefined;

    const scenario: GuardianEvalScenario = {
      durationMinutes: getAdaptiveSessionMinutes(sessionRow?.duration_minutes),
      targetTitle: sessionRow?.target_title ?? 'Unknown Session',
      events: scenarioEvents,
      expected,
    };

    const caseName = `${scenarioType}_${sessionId.slice(-6)}`;
    const expectedOutcome = `Real user correction: ${llmSignal.specificComplaints.slice(0, 2).join('; ')}`;

    db.prepare(`
      INSERT INTO guardian_eval_cases (suite_name, case_name, scenario_type, input_payload, expected_outcome, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      'real_user_corrections',
      caseName,
      scenarioType,
      JSON.stringify(scenario),
      expectedOutcome,
    );

    console.log(`[EvalExtractor] Created eval case: ${caseName} (${scenarioType})`);
    return true;
  } catch (err) {
    console.warn('[EvalExtractor] Failed to create eval case:', (err as Error).message);
    return false;
  }
}

export function loadUserDerivedEvalCases(limit: number = 5): Array<{
  id: number;
  caseName: string;
  scenarioType: string;
  inputPayload: string;
}> {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT id, case_name, scenario_type, input_payload
      FROM guardian_eval_cases
      WHERE scenario_type LIKE 'real_%' AND active = 1
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      caseName: string;
      scenarioType: string;
      inputPayload: string;
    }>;
  } catch {
    return [];
  }
}
