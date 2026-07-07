import { NextRequest, NextResponse } from 'next/server';
import {
  recordTaskRecommendationFeedback,
  type TaskRecommendationFeedback,
} from '@/lib/adaptive-task-recommendations';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { touchIntelligence } from '@/lib/intelligence';
import { recordExplicitFeedbackLearning } from '@/lib/feedback-learning';
import { getDb } from '@/lib/db';

const allowedFeedback: TaskRecommendationFeedback[] = [
  'helpful',
  'not_now',
  'wrong',
  'started',
  'completed',
  'dismissed',
];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      taskId?: unknown;
      feedback?: unknown;
      reason?: unknown;
      surface?: unknown;
    };

    const taskId = Number(body.taskId);
    const feedback = typeof body.feedback === 'string' ? body.feedback as TaskRecommendationFeedback : null;
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    }
    if (!feedback || !allowedFeedback.includes(feedback)) {
      return NextResponse.json({ error: 'valid feedback is required' }, { status: 400 });
    }

    const snapshot = buildPersonalizationSnapshot({
      surface: 'dashboard',
      maxInsights: 1,
      includeMemoryFacts: 2,
    });

    const ok = recordTaskRecommendationFeedback({
      taskId,
      feedback,
      momentMode: snapshot.moment.mode,
      surface: typeof body.surface === 'string' ? body.surface : 'dashboard',
      reason: typeof body.reason === 'string' ? body.reason : null,
    });

    if (!ok) return NextResponse.json({ error: 'task not found' }, { status: 404 });

    const task = getDb().prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
    recordExplicitFeedbackLearning({
      source: 'task_recommendation',
      feedback,
      reason: typeof body.reason === 'string' ? body.reason : null,
      surface: typeof body.surface === 'string' ? body.surface : 'dashboard',
      momentMode: snapshot.moment.mode,
      subject: task?.title ?? `task ${taskId}`,
      metadata: { taskId },
    });

    touchIntelligence(`task_recommendation_feedback:${feedback}`);
    return NextResponse.json({ ok: true, momentMode: snapshot.moment.mode });
  } catch (error) {
    console.error('Recommendation feedback error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
