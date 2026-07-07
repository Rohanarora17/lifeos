import { NextResponse } from 'next/server';
import {
  cancelPlannedFocusSession,
  generateNextDayPlan,
  getNextDayPlan,
  updatePlannedFocusSession,
  type NextDayPlanInput,
} from '@/lib/next-day-planner';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') ?? undefined;
    return NextResponse.json({ success: true, ...getNextDayPlan(date) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as NextDayPlanInput;
    const payload = await generateNextDayPlan({
      planDate: body.planDate,
      sleepTime: body.sleepTime,
      wakeEstimate: body.wakeEstimate,
      mood: body.mood,
      energy: body.energy,
      eveningNotes: body.eveningNotes,
      tomorrowIntention: body.tomorrowIntention,
      selectedTaskIds: body.selectedTaskIds,
      syncCalendar: body.syncCalendar === true,
      regenerate: body.regenerate,
    });
    return NextResponse.json({ success: true, ...payload });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      id?: string;
      title?: string;
      plannedStart?: string;
      plannedEnd?: string;
      status?: 'planned' | 'started' | 'completed' | 'skipped' | 'cancelled';
      taskId?: number | null;
      syncCalendar?: boolean;
    };
    if (!body.id) {
      return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
    }
    const session = await updatePlannedFocusSession(body.id, {
      title: body.title,
      plannedStart: body.plannedStart,
      plannedEnd: body.plannedEnd,
      status: body.status,
      taskId: body.taskId,
      syncCalendar: body.syncCalendar === true,
    });
    if (!session) {
      return NextResponse.json({ success: false, error: 'planned session not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, session });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const syncCalendar = url.searchParams.get('syncCalendar') !== 'false';
    if (!id) {
      return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
    }
    const ok = await cancelPlannedFocusSession(id, syncCalendar);
    if (!ok) {
      return NextResponse.json({ success: false, error: 'planned session not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
