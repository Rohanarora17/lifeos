import { NextResponse } from 'next/server';
import {
  acceptRecoveryRestart,
  correctRecoveryContext,
  getCoachingState,
  handleRecoveryResponse,
  recordHumanContact,
  setCoachingPaused,
} from '@/lib/coaching-state';

type CoachingAction = 'pause' | 'resume' | 'reply' | 'correct' | 'accept_restart';

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action?: CoachingAction;
      text?: string;
      minutes?: number;
      nextActionText?: string;
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
