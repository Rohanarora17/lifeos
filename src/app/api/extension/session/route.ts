import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGuardianContext } from '@/lib/guardian-runtime';

// GET: Returns the user's current context (Active Goals and Today's Tasks)
// The Chrome Extension uses this to determine what the user "should" be doing
// and feed it into the Context-Aware AI blocker.
export async function GET() {
    try {
        const { activeGoals, activeTasks, activeSession } = getGuardianContext();

        return NextResponse.json({
            activeGoals,
            activeTasks,
            activeSession,
        });
    } catch (error) {
        console.error('Extension Session API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
