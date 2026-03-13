import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getLevel } from '@/lib/scoring';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const db = getDb();
        const totalXpRow = db.prepare('SELECT COALESCE(SUM(xp_earned), 0) as total FROM daily_scores').get() as { total: number };
        const levelInfo = getLevel(totalXpRow.total);
        return NextResponse.json(levelInfo);
    } catch (error) {
        console.error('User level GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
