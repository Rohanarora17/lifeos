import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { classifyActivityBatch } from '@/lib/ai';
import { extractDomain } from '@/lib/categories';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { activities } = body;

        if (!Array.isArray(activities) || activities.length === 0) {
            return NextResponse.json({ success: true, count: 0 });
        }

        const validActivities = activities.filter(a => a.url && a.started_at).map(a => ({
            ...a,
            domain: extractDomain(a.url)
        }));

        const classifications = await classifyActivityBatch(validActivities);

        const db = getDb();
        const stmt = db.prepare(`
            INSERT INTO activities (url, domain, title, category, subcategory, started_at, ended_at, duration_seconds, ai_classification, youtube_video_id, youtube_channel)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((acts: any[], classes: any[]) => {
            for (let i = 0; i < acts.length; i++) {
                const a = acts[i];
                const c = classes[i] || { category: 'neutral', subcategory: 'other', confidence: 'low' };
                stmt.run(
                    a.url,
                    a.domain,
                    a.title || '',
                    c.category,
                    c.subcategory,
                    a.started_at,
                    a.ended_at || null,
                    a.duration_seconds || 0,
                    JSON.stringify(c),
                    a.youtube_video_id || null,
                    a.youtube_channel || null
                );
            }
        });

        insertMany(validActivities, classifications);

        return NextResponse.json({ success: true, count: validActivities.length }, { status: 201 });
    } catch (error) {
        console.error('Batch Activity POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
