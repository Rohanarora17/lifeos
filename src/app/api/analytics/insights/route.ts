import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { generateDeepCorrelations } from '@/lib/ai_analytics';

export async function GET() {
    try {
        const db = getDb();
        const insights = db.prepare('SELECT id, insight, type, created_at FROM ai_insights ORDER BY created_at DESC').all();
        return NextResponse.json({ insights });
    } catch (error) {
        console.error('Insights GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function POST() {
    try {
        await generateDeepCorrelations();
        return NextResponse.json({ success: true, message: 'Deep correlations generated' });
    } catch (error) {
        console.error('Insights POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
