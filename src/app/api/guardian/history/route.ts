import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getSessionScoringIntervals } from '@/lib/session-activity';

export async function GET() {
  try {
    const db = getDb();

    const overrides = db.prepare(`
      SELECT id, session_id, url, title, reason, requested_minutes,
             approved, decision_reason, explainability, created_at
      FROM guardian_override_requests
      ORDER BY id DESC LIMIT 10
    `).all() as Array<{
      id: number;
      session_id: string;
      url: string;
      title: string | null;
      reason: string;
      requested_minutes: number | null;
      approved: number;
      decision_reason: string;
      explainability: string;
      created_at: string;
    }>;

    const sessionRows = db.prepare(`
      SELECT gs.session_id, gs.target_title, gs.goal_title, gs.mood,
             gs.duration_minutes, gs.elapsed_minutes,
             gs.average_focus_score AS trajectory_average_focus_score,
             gs.final_focus_score, gs.final_focus_score AS focus_score,
             gs.blocked_count, gs.override_count,
             gs.distraction_events, gs.productive_events,
             gs.dominant_distraction_domain, gs.completed_at
      FROM guardian_session_summaries gs
      ORDER BY gs.id DESC LIMIT 7
    `).all() as Array<{
      session_id: string;
      target_title: string;
      goal_title: string | null;
      mood: string | null;
      duration_minutes: number;
      elapsed_minutes: number;
      trajectory_average_focus_score: number;
      final_focus_score: number;
      focus_score: number;
      blocked_count: number;
      override_count: number;
      distraction_events: number;
      productive_events: number;
      dominant_distraction_domain: string | null;
      completed_at: string;
    }>;

    const sessions = sessionRows.map((session) => {
      const seconds = { productive: 0, neutral: 0, distraction: 0 };
      for (const interval of getSessionScoringIntervals(session.session_id)) {
        if (!interval.scoreEligible) continue;
        seconds[interval.category] += Math.max(0, interval.durationSeconds);
      }
      const observedSeconds = seconds.productive + seconds.neutral + seconds.distraction;
      const minutes = (value: number) => Math.round(value / 6) / 10;
      const plannedEvidenceSeconds = Math.max(0, session.elapsed_minutes * 60);
      const evidenceCoveragePercent = plannedEvidenceSeconds > 0
        ? Math.min(100, Math.round(observedSeconds * 100 / plannedEvidenceSeconds))
        : 0;
      return {
        ...session,
        productive_minutes: minutes(seconds.productive),
        neutral_minutes: minutes(seconds.neutral),
        distraction_minutes: minutes(seconds.distraction),
        evidence_coverage_percent: evidenceCoveragePercent,
      };
    });

    // Pending session completions (post-session review queue)
    const pendingCompletions = db.prepare(`
      SELECT sc.id, sc.session_id, sc.task_id, sc.status,
             sc.completion_note, sc.blocker_note, sc.created_at,
             t.title as task_title,
             gs.target_title, gs.final_focus_score AS focus_score, gs.elapsed_minutes,
             gs.mood, gs.completed_at as session_completed_at
      FROM session_completions sc
      LEFT JOIN tasks t ON t.id = sc.task_id
      LEFT JOIN guardian_session_summaries gs ON gs.session_id = sc.session_id
      WHERE sc.status = 'pending'
      ORDER BY sc.created_at DESC
      LIMIT 10
    `).all() as Array<{
      id: number;
      session_id: string;
      task_id: number | null;
      status: string;
      completion_note: string | null;
      blocker_note: string | null;
      created_at: string;
      task_title: string | null;
      target_title: string | null;
      focus_score: number | null;
      elapsed_minutes: number | null;
      mood: string | null;
      session_completed_at: string | null;
    }>;

    return NextResponse.json({ success: true, overrides, sessions, pendingCompletions });
  } catch (error) {
    console.error('[guardian/history] GET failed', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
