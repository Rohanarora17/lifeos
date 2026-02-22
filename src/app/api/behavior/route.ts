import { NextResponse } from 'next/server';
import {
    runDeepAnalysis,
    getProfile,
    computeFocusSessions,
    computeFocusScore,
    computeAttentionEntropy,
    computeConsistencyIndex,
    computeGoalAlignment,
    classifyArchetype,
    recallMemories,
    feedbackOnInsight,
} from '@/lib/behavior';
import { getDb } from '@/lib/db';

// GET — Fetch behavioral analysis data
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'full';

    if (action === 'profile') {
        return NextResponse.json({ profile: getProfile() });
    }

    if (action === 'insights') {
        const db = getDb();
        const insights = db.prepare(
            'SELECT * FROM behavior_insights ORDER BY created_at DESC LIMIT 30'
        ).all();
        return NextResponse.json({ insights });
    }

    if (action === 'focus') {
        const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const sessions = computeFocusSessions(date);
        const score = computeFocusScore(sessions);
        const entropy = computeAttentionEntropy(date);
        return NextResponse.json({ sessions, score, entropy, date });
    }

    if (action === 'consistency') {
        const days = parseInt(searchParams.get('days') || '30');
        const consistency = computeConsistencyIndex(days);
        return NextResponse.json({ consistency });
    }

    if (action === 'goals') {
        const goalAlignment = computeGoalAlignment();
        return NextResponse.json(goalAlignment);
    }

    if (action === 'archetype') {
        const archetype = classifyArchetype(30);
        return NextResponse.json({ archetype });
    }

    if (action === 'memories') {
        const type = searchParams.get('type') || undefined;
        const memories = recallMemories(type, 20);
        return NextResponse.json({ memories });
    }

    // Full analysis (all at once)
    const today = new Date().toISOString().slice(0, 10);
    const sessions = computeFocusSessions(today);
    const focusScore = computeFocusScore(sessions);
    const entropy = computeAttentionEntropy(today);
    const consistency = computeConsistencyIndex(30);
    const archetype = classifyArchetype(30);
    const goalAlignment = computeGoalAlignment();
    const profile = getProfile();

    // Hourly heatmap
    const db = getDb();
    const hourly = db.prepare(`
    SELECT CAST(strftime('%H', started_at) AS INTEGER) as h,
      SUM(CASE WHEN category='productive' THEN duration_seconds ELSE 0 END)/60 as productive,
      SUM(CASE WHEN category='distraction' THEN duration_seconds ELSE 0 END)/60 as distraction,
      SUM(duration_seconds)/60 as total
    FROM activities WHERE started_at >= datetime('now', '-30 days')
    GROUP BY h ORDER BY h
  `).all();

    // Day of week
    const dayOfWeek = db.prepare(`
    SELECT CASE CAST(strftime('%w', started_at) AS INTEGER)
      WHEN 0 THEN 'Sunday' WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday'
      WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
      WHEN 6 THEN 'Saturday' END as day_name,
      SUM(CASE WHEN category='productive' THEN duration_seconds ELSE 0 END)/3600.0 as hours
    FROM activities WHERE started_at >= datetime('now', '-30 days')
    GROUP BY day_name
  `).all();

    // Top domains
    const topProductive = db.prepare(`
    SELECT domain, SUM(duration_seconds)/60 as mins FROM activities
    WHERE category='productive' AND started_at >= datetime('now', '-30 days')
    GROUP BY domain ORDER BY mins DESC LIMIT 8
  `).all();

    const topDistraction = db.prepare(`
    SELECT domain, SUM(duration_seconds)/60 as mins FROM activities
    WHERE category='distraction' AND started_at >= datetime('now', '-30 days')
    GROUP BY domain ORDER BY mins DESC LIMIT 8
  `).all();

    const insights = db.prepare(
        'SELECT * FROM behavior_insights ORDER BY created_at DESC LIMIT 20'
    ).all();

    // Get learned behavioral memories
    let memories: unknown[] = [];
    try { memories = recallMemories(undefined, 15); } catch { /* table may not be created yet */ }

    return NextResponse.json({
        profile,
        focusScore,
        entropy,
        consistency,
        archetype,
        goalAlignment,
        hourly,
        dayOfWeek,
        topProductive,
        topDistraction,
        insights,
        memories,
        sessions: sessions.slice(0, 10),
    });
}

// POST — Trigger deep analysis or record tab switch
export async function POST(request: Request) {
    const body = await request.json().catch(() => ({}));

    // Record tab switch event from extension
    if (body.type === 'tab_switch') {
        const db = getDb();
        db.prepare(
            'INSERT INTO tab_switches (from_domain, to_domain, from_category, to_category) VALUES (?, ?, ?, ?)'
        ).run(body.from_domain || '', body.to_domain || '', body.from_category || '', body.to_category || '');
        return NextResponse.json({ ok: true });
    }

    // Record insight feedback (the learning loop)
    if (body.type === 'insight_feedback') {
        feedbackOnInsight(body.insight_id, body.feedback);
        return NextResponse.json({ ok: true, message: `Feedback '${body.feedback}' recorded for insight ${body.insight_id}` });
    }

    // Run deep analysis
    try {
        const result = await runDeepAnalysis();
        return NextResponse.json({
            success: true,
            summary: result.summary,
            archetype: result.archetype,
            focusScore: result.focusScore,
            entropy: result.entropy,
            consistency: result.consistency,
            goalAlignment: result.goalAlignment,
            insightCount: result.insights.length,
        });
    } catch (err) {
        console.error('Deep analysis failed:', err);
        return NextResponse.json({ error: 'Analysis failed', details: String(err) }, { status: 500 });
    }
}
