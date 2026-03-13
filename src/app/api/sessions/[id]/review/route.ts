import { NextResponse } from 'next/server';
import getDb from '@/lib/db';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const sessionId = resolvedParams.id;
    try {
        const db = getDb();

        // Note: session_ticks and jarvis_explanations tables will be created by migrations if needed
        let ticks: any[] = [];
        let explanations: any[] = [];

        try {
            ticks = db.prepare('SELECT * FROM session_ticks WHERE session_id = ? ORDER BY tick ASC').all(sessionId);
        } catch (e) { }

        try {
            explanations = db.prepare('SELECT * FROM jarvis_explanations WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
        } catch (e) { }

        return NextResponse.json({ success: true, ticks, explanations });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
