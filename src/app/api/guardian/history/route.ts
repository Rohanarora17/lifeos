import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

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

    const sessions = db.prepare(`
      SELECT session_id, target_title, goal_title, mood,
             duration_minutes, elapsed_minutes, average_focus_score,
             final_focus_score, blocked_count, override_count,
             distraction_events, productive_events,
             dominant_distraction_domain, completed_at
      FROM guardian_session_summaries
      ORDER BY id DESC LIMIT 7
    `).all() as Array<{
      session_id: string;
      target_title: string;
      goal_title: string | null;
      mood: string | null;
      duration_minutes: number;
      elapsed_minutes: number;
      average_focus_score: number;
      final_focus_score: number;
      blocked_count: number;
      override_count: number;
      distraction_events: number;
      productive_events: number;
      dominant_distraction_domain: string | null;
      completed_at: string;
    }>;

    // Pending session completions (post-session review queue)
    const pendingCompletions = db.prepare(`
      SELECT sc.id, sc.session_id, sc.task_id, sc.status,
             sc.completion_note, sc.blocker_note, sc.created_at,
             t.title as task_title,
             gs.target_title, gs.average_focus_score, gs.elapsed_minutes,
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
      average_focus_score: number | null;
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
