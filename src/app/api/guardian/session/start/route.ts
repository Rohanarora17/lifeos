import { NextResponse } from 'next/server';
import { parseLockInIntent } from '@/lib/intent-engine';
import { startGuardianSession } from '@/lib/guardian-runtime';
import { getConflictingEvents, isCalendarConfigured } from '@/lib/google-calendar';

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

    // Calendar conflict check — warn if there's something in the planned window
    let calendarWarning: string | null = null;
    let calendarConflicts: Array<{ title: string; start: string; end: string }> = [];
    if (isCalendarConfigured() && startInput.durationMinutes) {
      try {
        const sessionStart = new Date();
        const sessionEnd = new Date(sessionStart.getTime() + startInput.durationMinutes * 60_000);
        const conflicts = await getConflictingEvents(sessionStart, sessionEnd);
        if (conflicts.length > 0) {
          calendarConflicts = conflicts;
          const firstConflict = conflicts[0];
          const t = new Date(firstConflict.start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          calendarWarning = `Calendar conflict: "${firstConflict.title}" starts at ${t}. Consider a shorter sprint.`;
        }
      } catch { /* non-fatal */ }
    }

    const session = startGuardianSession(startInput);
    return NextResponse.json({ success: true, session, parsedIntent, calendarWarning, calendarConflicts });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
