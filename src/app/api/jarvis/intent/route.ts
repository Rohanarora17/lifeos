import { NextResponse } from 'next/server';
import { parseLockInIntent } from '@/lib/intent-engine';
import { getDayBriefing, generateOpeningLine } from '@/lib/longitudinal-engine';
import { startSession } from '@/lib/session-state';
import { speak } from '@/lib/tts';

export async function POST(req: Request) {
    try {
        const { transcript, sessionId } = await req.json();

        if (!transcript) return NextResponse.json({ error: 'Missing transcript' }, { status: 400 });

        const intent = await parseLockInIntent(transcript);

        if (intent?.action === 'lock_in' && intent.parameters) {
            if (intent.clarificationNeeded && !intent.parameters.topic) {
                speak('default', intent.clarificationNeeded, 'urgent', 'neutral');
                return NextResponse.json({ success: true, clarification: intent.clarificationNeeded });
            } else if (intent.parameters.topic) {
                const session = startSession({
                    durationMinutes: intent.parameters.durationMinutes || 60,
                    conceptNodeName: intent.parameters.topic,
                    mood: intent.parameters.mood
                });

                const briefing = getDayBriefing();
                const opening = generateOpeningLine(briefing, intent.parameters);

                speak(session.sessionId, opening, 'urgent', 'flow_confirmed');
                return NextResponse.json({ success: true, session });
            }
        }

        return NextResponse.json({ success: true, intent });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
