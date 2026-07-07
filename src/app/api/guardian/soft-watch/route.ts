import { NextResponse } from 'next/server';
import {
  createSoftWatchCommitment,
  dismissSoftWatchCommitment,
  listSoftWatchCommitments,
  startSoftWatchChecker,
} from '@/lib/guardian-runtime';

// GET /api/guardian/soft-watch — list pending and locked-in commitments
export function GET() {
  try {
    startSoftWatchChecker();
    const commitments = listSoftWatchCommitments();
    return NextResponse.json({ commitments });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/guardian/soft-watch — create a new commitment
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { targetTitle, goalId, taskId, intendedStartAt, plannedMinutes, source } = body as {
      targetTitle?: string;
      goalId?: number | null;
      taskId?: number | null;
      intendedStartAt?: number;
      plannedMinutes?: number;
      source?: 'voice' | 'dashboard' | 'calendar';
    };

    if (!targetTitle) {
      return NextResponse.json({ error: 'targetTitle is required' }, { status: 400 });
    }
    if (!intendedStartAt || typeof intendedStartAt !== 'number') {
      return NextResponse.json({ error: 'intendedStartAt (Unix ms) is required' }, { status: 400 });
    }

    startSoftWatchChecker();
    const commitment = createSoftWatchCommitment({
      targetTitle,
      goalId: goalId ?? null,
      taskId: taskId ?? null,
      intendedStartAt,
      plannedMinutes,
      source: source ?? 'dashboard',
    });

    return NextResponse.json({ success: true, commitment });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/guardian/soft-watch?id=<id> — dismiss a commitment
export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'id query param is required' }, { status: 400 });
    }
    const dismissed = dismissSoftWatchCommitment(id);
    if (!dismissed) {
      return NextResponse.json({ error: 'Commitment not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
