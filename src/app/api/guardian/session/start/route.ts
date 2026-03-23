import { NextResponse } from 'next/server';
import { parseLockInIntent } from '@/lib/intent-engine';
import { startGuardianSession } from '@/lib/guardian-runtime';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const transcript = body.transcript as string | undefined;

    let startInput = {
      topic: body.topic as string | undefined,
      goalId: body.goalId as string | null | undefined,
      goalTitle: body.goalTitle as string | null | undefined,
      conceptNodeId: body.conceptNodeId as string | null | undefined,
      conceptNodeName: body.conceptNodeName as string | null | undefined,
      durationMinutes: body.durationMinutes as number | undefined,
      mood: body.mood as 'high' | 'medium' | 'low' | null | undefined,
      source: (body.source as 'voice' | 'dashboard' | 'extension' | 'api' | undefined) || 'api',
    };

    let parsedIntent: any = null;
    if (transcript) {
      parsedIntent = await parseLockInIntent(transcript);
      if (parsedIntent?.clarificationNeeded && !parsedIntent?.parameters?.topic) {
        return NextResponse.json({ success: true, clarification: parsedIntent.clarificationNeeded });
      }

      startInput = {
        ...startInput,
        topic: startInput.topic || parsedIntent?.parameters?.topic,
        durationMinutes: startInput.durationMinutes || parsedIntent?.parameters?.durationMinutes || 60,
        mood: startInput.mood || parsedIntent?.parameters?.mood || null,
        source: 'voice',
      };
    }

    const session = startGuardianSession(startInput);
    return NextResponse.json({ success: true, session, parsedIntent });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
