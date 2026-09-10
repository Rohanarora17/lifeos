import { NextResponse } from 'next/server';
import {
  acceptRecoveryRestart,
  correctRecoveryContext,
  getCoachingState,
  handleRecoveryResponse,
  recordHumanContact,
  setCoachingPaused,
} from '@/lib/coaching-state';
import {
  getCommitmentStartPlan,
  recordCommitmentBlocker,
  rescheduleCommitment,
} from '@/lib/coaching-commitments';

type CoachingAction = 'pause' | 'resume' | 'reply' | 'correct' | 'accept_restart'
  | 'commit_start' | 'commit_reschedule' | 'commit_blocked';

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action?: CoachingAction;
      text?: string;
      minutes?: number;
      nextActionText?: string;
      commitmentId?: number;
      delayMinutes?: number;
    };
    if (!body.action) {
      return NextResponse.json({ success: false, error: 'action is required' }, { status: 400 });
    }

    if (body.action === 'pause') {
      return NextResponse.json({ success: true, state: setCoachingPaused(true) });
    }
    if (body.action === 'resume') {
      recordHumanContact('coach_web', { action: 'resume' });
      return NextResponse.json({ success: true, state: setCoachingPaused(false) });
    }
    if (body.action === 'accept_restart') {
      recordHumanContact('coach_web', { action: 'accept_restart' });
      return NextResponse.json({
        success: true,
        state: acceptRecoveryRestart({ minutes: body.minutes, nextActionText: body.nextActionText }),
      });
    }
    if (body.action === 'commit_start') {
      if (!Number.isInteger(body.commitmentId)) {
        return NextResponse.json({ success: false, error: 'commitmentId is required' }, { status: 400 });
      }
      const startPlan = getCommitmentStartPlan(body.commitmentId!);
      if (!startPlan) return NextResponse.json({ success: false, error: 'commitment not found' }, { status: 404 });
      return NextResponse.json({ success: true, startPlan });
    }
    if (body.action === 'commit_reschedule') {
      if (!Number.isInteger(body.commitmentId)) {
        return NextResponse.json({ success: false, error: 'commitmentId is required' }, { status: 400 });
      }
      const commitment = rescheduleCommitment(body.commitmentId!, body.delayMinutes ?? 30);
      if (!commitment) return NextResponse.json({ success: false, error: 'commitment not found' }, { status: 404 });
      return NextResponse.json({ success: true, commitment });
    }
    if (body.action === 'commit_blocked') {
      if (!Number.isInteger(body.commitmentId) || !body.text?.trim()) {
        return NextResponse.json({ success: false, error: 'commitmentId and text are required' }, { status: 400 });
      }
      const commitment = recordCommitmentBlocker(body.commitmentId!, body.text);
      if (!commitment) return NextResponse.json({ success: false, error: 'commitment not found' }, { status: 404 });
      return NextResponse.json({ success: true, commitment });
    }
    if (body.action === 'correct') {
      if (!body.text?.trim()) {
        return NextResponse.json({ success: false, error: 'text is required' }, { status: 400 });
      }
      recordHumanContact('coach_web', { action: 'correct' });
      return NextResponse.json({ success: true, state: correctRecoveryContext(body.text) });
    }
    if (body.action === 'reply') {
      if (!body.text?.trim()) {
        return NextResponse.json({ success: false, error: 'text is required' }, { status: 400 });
      }
      recordHumanContact('coach_web', { action: 'reply' });
      const result = handleRecoveryResponse(body.text);
      return NextResponse.json({ success: true, handled: result.handled, reply: result.reply, state: result.state });
    }

    return NextResponse.json({ success: false, error: 'unsupported action' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error), state: getCoachingState() }, { status: 500 });
  }
}
