import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getLevel } from '@/lib/scoring';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const db = getDb();
        const totalXpRow = db.prepare('SELECT COALESCE(SUM(xp_earned), 0) as total FROM daily_scores').get() as { total: number };
        const levelInfo = getLevel(totalXpRow.total);
        const personalization = buildPersonalizationSnapshot({
            surface: 'achievements',
            maxInsights: 2,
            includeMemoryFacts: 3,
        });
        const pacing = personalization.moment.mode === 'recovery'
            ? 'Recovery mode: progress pacing is interpreted gently today.'
            : personalization.moment.mode === 'deadline_pressure'
                ? 'Deadline pressure: XP should come from useful progress, not busywork.'
                : personalization.moment.mode === 'protect_focus'
                    ? 'Protect focus: level feedback should stay quiet while momentum is high.'
                    : personalization.moment.mode === 'planning'
                        ? 'Planning mode: use level progress as a reflection signal.'
                        : "Balanced mode: level progress follows today's capacity.";
        return NextResponse.json({
            ...levelInfo,
            totalXp: totalXpRow.total,
            personalization: {
                mode: personalization.moment.mode,
                guidance: personalization.moment.guidance,
                energy: personalization.userState.energy,
                focusTrend: personalization.userState.focusTrend,
                pacing,
            },
        });
    } catch (error) {
        console.error('User level GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
