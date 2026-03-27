import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { classifyActivity } from '@/lib/ai';
import { extractDomain } from '@/lib/categories';
import { getActiveGuardianSession } from '@/lib/guardian-runtime';

// POST: Log a new activity from browser extension
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { url, title, started_at, ended_at, duration_seconds, youtube_video_id, youtube_channel, device_name, is_actively_interacting } = body;

        if (!url || !started_at) {
            return NextResponse.json({ error: 'url and started_at are required' }, { status: 400 });
        }

        const domain = extractDomain(url);

        // Classify with session context so the same URL isn't mis-classified during an active study session
        const activeSession = getActiveGuardianSession();
        const sessionContext = activeSession
            ? { targetTitle: activeSession.targetTitle, goalTitle: activeSession.goalTitle ?? null }
            : undefined;
        const classification = await classifyActivity(url, title || '', domain, youtube_channel, sessionContext);

        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO activities (url, domain, title, category, subcategory, started_at, ended_at, duration_seconds, ai_classification, youtube_video_id, youtube_channel, device_name, is_actively_interacting)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            youtube_channel || null,
            device_name || 'Unknown Device',
            is_actively_interacting === false ? 0 : 1 // defaults to true if omitted
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

        let stats = null;
        if (date) {
            const { getDailyActivityStats } = require('@/lib/scoring');
            stats = getDailyActivityStats(db, date);
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

            // 3. Update domain_categories cache — closes the feedback loop permanently
            // User overrides use confidence 1.0 so they always win over AI (0.9) and seeds (0.8)
            if (!activity.youtube_video_id) {
                try {
                    db.prepare(`
                        INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
                        VALUES (?, ?, 'other', 1.0, ?)
                        ON CONFLICT(domain) DO UPDATE SET
                            category = ?, subcategory = 'other', confidence = 1.0,
                            ai_reasoning = ?, updated_at = datetime('now')
                    `).run(
                        activity.domain, category, `User manual override to ${category}`,
                        category, `User manual override to ${category}`
                    );
                } catch { /* ignore if table doesn't exist */ }
            }

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
