import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { classifyActivity } from '@/lib/ai';
import { extractDomain } from '@/lib/categories';

// POST: Log a new activity from browser extension
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { url, title, started_at, ended_at, duration_seconds, youtube_video_id, youtube_channel } = body;

        if (!url || !started_at) {
            return NextResponse.json({ error: 'url and started_at are required' }, { status: 400 });
        }

        const domain = extractDomain(url);

        // Classify activity
        const classification = await classifyActivity(url, title || '', domain, youtube_channel);

        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO activities (url, domain, title, category, subcategory, started_at, ended_at, duration_seconds, ai_classification, youtube_video_id, youtube_channel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const result = stmt.run(
            url,
            domain,
            title || '',
            classification.category,
            classification.subcategory,
            started_at,
            ended_at || null,
            duration_seconds || 0,
            JSON.stringify(classification),
            youtube_video_id || null,
            youtube_channel || null
        );

        return NextResponse.json({
            id: result.lastInsertRowid,
            category: classification.category,
            subcategory: classification.subcategory
        }, { status: 201 });
    } catch (error) {
        console.error('Activity POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// GET: Fetch activities with optional filters
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const date = searchParams.get('date');
        const category = searchParams.get('category');
        const domain = searchParams.get('domain');
        const limit = parseInt(searchParams.get('limit') || '100');
        const offset = parseInt(searchParams.get('offset') || '0');

        const db = getDb();
        let query = 'SELECT * FROM activities WHERE 1=1';
        const params: (string | number)[] = [];

        if (date) {
            query += " AND date(started_at, 'localtime') = ?";
            params.push(date);
        }
        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }
        if (domain) {
            query += ' AND domain = ?';
            params.push(domain);
        }

        query += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const activities = db.prepare(query).all(...params);

        // Also get summary stats for the requested date
        let stats = null;
        if (date) {
            stats = db.prepare(`
        SELECT 
          COUNT(*) as total_activities,
          SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) / 60 as productive_minutes,
          SUM(CASE WHEN category = 'distraction' THEN duration_seconds ELSE 0 END) / 60 as distraction_minutes,
          SUM(CASE WHEN category = 'neutral' THEN duration_seconds ELSE 0 END) / 60 as neutral_minutes,
          SUM(duration_seconds) / 60 as total_minutes
        FROM activities WHERE date(started_at, 'localtime') = ?
      `).get(date);
        }

        return NextResponse.json({ activities, stats });
    } catch (error) {
        console.error('Activity GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH: Manually override an activity category
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, category } = body;

        if (!id || !category) {
            return NextResponse.json({ error: 'Missing id or category' }, { status: 400 });
        }

        const db = getDb();

        // 1. Update the activity record
        db.prepare('UPDATE activities SET category = ? WHERE id = ?').run(category, id);

        // 2. Fetch the updated activity to inject a rule into memory
        const activity = db.prepare('SELECT domain, url, youtube_video_id, title FROM activities WHERE id = ?').get(id) as any;

        if (activity) {
            const { learnMemory } = require('@/lib/behavior');

            // If it's a YouTube video, remember the specific title/type.
            let detail = activity.domain;
            if (activity.youtube_video_id) {
                detail += ` (Video: ${activity.title})`;
            }

            const memoryContent = JSON.stringify({
                type: 'manual_override',
                domain: activity.domain,
                url: activity.url,
                youtube_video_id: activity.youtube_video_id,
                user_designated_category: category,
                reason: `User manually re-categorized ${detail} as ${category}`
            });

            // Store in behavioral_memory so AI considers it in future summaries/context
            learnMemory('user_preference', memoryContent, 'classification_override');

            // Modify ai_classification row so if it gets cached, it gets the new category
            const existingAi = db.prepare('SELECT ai_classification FROM activities WHERE id = ?').get(id) as any;
            if (existingAi && existingAi.ai_classification) {
                try {
                    const parsed = JSON.parse(existingAi.ai_classification);
                    parsed.category = category;
                    parsed.reasoning = `Manually overridden by user to ${category}`;
                    db.prepare('UPDATE activities SET ai_classification = ? WHERE id = ?').run(JSON.stringify(parsed), id);
                } catch (e) { }
            }
        }

        return NextResponse.json({ success: true, id, category });
    } catch (error) {
        console.error('Activity PATCH error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
