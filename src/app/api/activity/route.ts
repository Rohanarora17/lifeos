import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { classifyActivity } from '@/lib/ai';
import { extractDomain } from '@/lib/categories';
import { getActiveGuardianSession } from '@/lib/guardian-runtime';
import { buildAdaptiveActivityPolicy } from '@/lib/adaptive-activity-policy';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import {
    saveNativeAppPreference,
    toActivityCategory,
} from '@/lib/native-app-classification';
import { getGuardianClientReadiness } from '@/lib/guardian-client-status';
import { lifeosDayBoundsUtc } from '@/lib/timezone';
import { getDailyActivityStats } from '@/lib/scoring';
import { getGuardianShadowRolloutStatus } from '@/lib/guardian-evidence-shadow';

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
        if (activeSession) {
            return NextResponse.json({
                accepted: true,
                counted: false,
                reason: 'Guardian session activity is recorded through the canonical source arbiter.',
                sessionId: activeSession.sessionId,
            }, { status: 202 });
        }
        const classification = await classifyActivity(url, title || '', domain, youtube_channel, undefined);

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
        const diagnostics = searchParams.get('diagnostics') === 'true';

        const db = getDb();
        const bounds = date ? lifeosDayBoundsUtc(date) : null;
        let query = 'SELECT * FROM activities WHERE COALESCE(counted, 1) = 1';
        const params: (string | number)[] = [];

        if (date) {
            query += ' AND started_at >= ? AND started_at < ?';
            params.push(bounds!.startIso, bounds!.endIso);
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

        const rawActivities = db.prepare(query).all(...params) as Array<Record<string, unknown> & { category?: string }>;
        // Normalize legacy native categories so the UI select always shows productive|neutral|distraction
        const legacyActivities = rawActivities.map((act) => ({
            ...act,
            category: toActivityCategory(act.category),
            raw_category: act.category,
            record_type: 'legacy',
            capture_source: act.capture_source || 'legacy',
            counted: 1,
            score_eligible: 1,
        }));

        let intervalQuery = `
          SELECT interval_id, session_id, source, observed_start, observed_end,
                 duration_seconds, state, app, window_title, url, domain, title,
                 category, subcategory, score_eligible, counted, selection_reason, capture_status
                 , engagement_state, engagement_confidence, confirmation_status
          FROM session_activity_intervals
          WHERE counted = 1
            AND NOT EXISTS (
              SELECT 1 FROM guardian_sessions gs
              WHERE gs.session_id = session_activity_intervals.session_id
                AND gs.evidence_pipeline_mode = 'authoritative'
            )
        `;
        const intervalParams: Array<string> = [];
        if (date) {
            intervalQuery += ' AND observed_start >= ? AND observed_start < ?';
            intervalParams.push(bounds!.startIso, bounds!.endIso);
        }
        if (category) {
            intervalQuery += ' AND category = ?';
            intervalParams.push(category);
        }
        if (domain) {
            intervalQuery += ' AND domain = ?';
            intervalParams.push(domain);
        }
        intervalQuery += ' ORDER BY observed_start DESC LIMIT 500';
        const intervals = (db.prepare(intervalQuery).all(...intervalParams) as Array<Record<string, unknown>>).map(row => ({
            id: `interval:${row.interval_id}`,
            interval_id: row.interval_id,
            session_id: row.session_id,
            url: row.url || `native://${encodeURIComponent(String(row.app || 'activity'))}`,
            domain: row.domain || row.app || 'macOS',
            title: row.title || row.window_title || row.app || 'Verified activity',
            category: toActivityCategory(typeof row.category === 'string' ? row.category : null),
            raw_category: row.category,
            subcategory: row.subcategory || row.state,
            started_at: row.observed_start,
            ended_at: row.observed_end,
            duration_seconds: row.duration_seconds,
            device_name: row.source === 'chrome' ? 'Chrome extension' : 'MacBook vision client',
            record_type: 'guardian_interval',
            capture_source: row.source,
            counted: row.counted,
            score_eligible: row.score_eligible,
            selection_reason: row.selection_reason,
            capture_status: row.capture_status,
            window_title: row.window_title,
            app: row.app,
            engagement_state: row.engagement_state,
            engagement_confidence: row.engagement_confidence,
            confirmation_status: row.confirmation_status,
        }));

        let segmentQuery = `
          SELECT * FROM guardian_activity_segments
          WHERE (pipeline_mode = 'authoritative' OR (? = 1 AND pipeline_mode = 'shadow'))
        `;
        const segmentParams: Array<string | number> = [diagnostics ? 1 : 0];
        if (date) {
            segmentQuery += ' AND observed_start >= ? AND observed_start < ?';
            segmentParams.push(bounds!.startIso, bounds!.endIso);
        }
        if (category) {
            segmentQuery += ' AND category = ?';
            segmentParams.push(category);
        }
        if (domain) {
            segmentQuery += ' AND domain = ?';
            segmentParams.push(domain);
        }
        segmentQuery += ' ORDER BY observed_start DESC LIMIT 500';
        const evidenceSegments = (db.prepare(segmentQuery).all(...segmentParams) as Array<Record<string, unknown>>).map(row => ({
            id: `evidence:${row.segment_id}`,
            interval_id: row.segment_id,
            session_id: row.session_id,
            url: row.url || `native://${encodeURIComponent(String(row.app || 'activity'))}`,
            domain: row.domain || row.app || 'macOS',
            title: row.title || row.window_title || row.app || 'Verified activity',
            category: toActivityCategory(typeof row.category === 'string' ? row.category : null),
            raw_category: row.category,
            subcategory: row.subcategory || row.state,
            started_at: row.observed_start,
            ended_at: row.observed_end,
            duration_seconds: Number(row.duration_seconds || 0),
            device_name: row.source === 'chrome' ? 'Chrome extension' : 'MacBook vision client',
            record_type: 'guardian_evidence_segment',
            capture_source: row.source,
            counted: row.counted,
            score_eligible: row.score_eligible,
            selection_reason: row.selection_reason,
            capture_status: Number(row.provisional) === 1 ? 'provisional' : 'finalized',
            provisional: row.provisional,
            window_title: row.window_title,
            app: row.app,
            engagement_state: row.engagement_state,
            engagement_confidence: row.engagement_confidence,
            evidence_ids: row.evidence_ids_json,
            pipeline_mode: row.pipeline_mode,
        }));
        const activities = ([...evidenceSegments, ...intervals, ...legacyActivities] as Array<Record<string, unknown> & { started_at?: unknown; duration_seconds?: unknown; capture_source?: unknown; score_eligible?: unknown }>)
            .sort((a, b) => Date.parse(String(b.started_at)) - Date.parse(String(a.started_at)))
            .slice(0, limit);

        let stats = null;
        if (date) {
            stats = getDailyActivityStats(db, date);
        }

        const personalization = buildPersonalizationSnapshot({
            surface: 'analytics',
            maxInsights: 2,
            includeMemoryFacts: 3,
        });
        const summaryWhere = bounds
            ? 'WHERE counted = 1 AND observed_start >= ? AND observed_start < ?'
            : 'WHERE counted = 1';
        const legacySourceRows = db.prepare(`
            SELECT source,
                   SUM(CASE WHEN score_eligible = 1 THEN duration_seconds ELSE 0 END) AS seconds,
                   SUM(CASE WHEN score_eligible = 0 THEN duration_seconds ELSE 0 END) AS unscored_seconds
            FROM session_activity_intervals
            ${summaryWhere}
              AND NOT EXISTS (
                SELECT 1 FROM guardian_sessions gs
                WHERE gs.session_id = session_activity_intervals.session_id
                  AND gs.evidence_pipeline_mode = 'authoritative'
              )
            GROUP BY source
        `).all(...(bounds ? [bounds.startIso, bounds.endIso] : [])) as Array<{
            source: string; seconds: number | null; unscored_seconds: number | null;
        }>;
        const evidenceWhere = bounds
            ? `WHERE pipeline_mode = 'authoritative' AND provisional = 0 AND slice_start >= ? AND slice_start < ?`
            : `WHERE pipeline_mode = 'authoritative' AND provisional = 0`;
        const evidenceSourceRows = db.prepare(`
            SELECT source,
                   SUM(CASE WHEN counted = 1 AND score_eligible = 1 THEN duration_seconds ELSE 0 END) AS seconds,
                   SUM(CASE WHEN score_eligible = 0 THEN duration_seconds ELSE 0 END) AS unscored_seconds
            FROM guardian_activity_slices
            ${evidenceWhere}
            GROUP BY source
        `).all(...(bounds ? [bounds.startIso, bounds.endIso] : [])) as Array<{
            source: string; seconds: number | null; unscored_seconds: number | null;
        }>;
        const sourceRows = [...legacySourceRows, ...evidenceSourceRows];
        const sourceSeconds = (source: string) => sourceRows
            .filter(row => row.source === source)
            .reduce((sum, row) => sum + Number(row.seconds ?? 0), 0);
        const unscoredSourceSeconds = (source: string) => sourceRows
            .filter(row => row.source === source)
            .reduce((sum, row) => sum + Number(row.unscored_seconds ?? 0), 0);
        const diagnosticEvidence = diagnostics ? db.prepare(`
            SELECT event_id, collector, collector_version, observed_start, observed_end,
                   compatible, late_after_watermark, privacy_decision
            FROM guardian_evidence_events
            ${bounds ? 'WHERE observed_start >= ? AND observed_start < ?' : ''}
            ORDER BY observed_start DESC LIMIT 200
        `).all(...(bounds ? [bounds.startIso, bounds.endIso] : [])) : [];

        return NextResponse.json({
            activities,
            stats,
            activityPolicy: buildAdaptiveActivityPolicy(personalization, stats),
            sourceSummary: {
                chromeSeconds: sourceSeconds('chrome'),
                visionSeconds: sourceSeconds('vision'),
                unscoredSeconds: sourceRows.reduce((sum, row) => sum + Number(row.unscored_seconds ?? 0), 0),
                unverifiedSeconds: unscoredSourceSeconds('unverified'),
            },
            collectorStatus: getGuardianClientReadiness(),
            diagnostics: diagnostics ? {
                rawEvidence: diagnosticEvidence,
                shadowRollout: getGuardianShadowRolloutStatus(10),
            } : undefined,
        });
    } catch (error) {
        console.error('Activity GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH: Manually override an activity category
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, category: rawCategory } = body;
        const category = toActivityCategory(rawCategory);

        if (!id || !rawCategory) {
            return NextResponse.json({ error: 'Missing id or category' }, { status: 400 });
        }
        if (!['productive', 'neutral', 'distraction'].includes(category)) {
            return NextResponse.json({ error: 'category must be productive, neutral, or distraction' }, { status: 400 });
        }

        const db = getDb();

        if (typeof id === 'string' && id.startsWith('interval:')) {
            const intervalId = id.slice('interval:'.length);
            db.prepare(`UPDATE session_activity_intervals SET category = ?, updated_at = datetime('now') WHERE interval_id = ?`)
                .run(category, intervalId);
            return NextResponse.json({ success: true, id, category, recordType: 'guardian_interval' });
        }

        if (typeof id === 'string' && id.startsWith('evidence:')) {
            const segmentId = id.slice('evidence:'.length);
            const segment = db.prepare(`
              SELECT session_id, observed_start, observed_end
              FROM guardian_activity_segments WHERE segment_id = ?
            `).get(segmentId) as { session_id: string; observed_start: string; observed_end: string } | undefined;
            if (!segment) return NextResponse.json({ error: 'segment not found' }, { status: 404 });
            db.prepare(`
              UPDATE guardian_activity_slices SET category = ?, updated_at = datetime('now')
              WHERE session_id = ? AND slice_start >= ? AND slice_end <= ?
            `).run(category, segment.session_id, segment.observed_start, segment.observed_end);
            return NextResponse.json({ success: true, id, category, recordType: 'guardian_evidence_segment' });
        }

        // 1. Update the activity record
        db.prepare('UPDATE activities SET category = ? WHERE id = ?').run(category, id);

        // 2. Fetch the updated activity to inject a rule into memory
        const activity = db.prepare('SELECT domain, url, youtube_video_id, title, device_name, subcategory FROM activities WHERE id = ?').get(id) as {
            domain: string; url: string; youtube_video_id: string | null; title: string;
            device_name: string | null; subcategory: string | null;
        } | undefined;

        if (activity) {
            const { learnMemory } = await import('@/lib/behavior');

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

            // Native apps: shared preference + intelligence refresh
            if (
                activity.device_name === 'LifeOS Native Copilot' ||
                activity.subcategory === 'native_app' ||
                (typeof activity.url === 'string' && activity.url.startsWith('native://'))
            ) {
                const appName = activity.domain || activity.title || 'Unknown App';
                saveNativeAppPreference(appName, category, `user correct via activity UI`);
                try {
                    const { recordExplicitFeedbackLearning } = await import('@/lib/feedback-learning');
                    const { touchIntelligence } = await import('@/lib/intelligence');
                    recordExplicitFeedbackLearning({
                        source: 'native_classification',
                        feedback: category === 'distraction' ? 'wrong' : category === 'productive' ? 'helpful' : 'dismissed',
                        surface: 'activity_ui',
                        reason: `Activity UI labeled native app ${appName} as ${category}`,
                        subject: appName,
                        metadata: { category, activityId: id },
                    });
                    touchIntelligence('native_app_classification_ui');
                } catch (err) {
                    console.warn('[activity PATCH] intelligence hook failed:', err);
                }
            }

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
            const existingAi = db.prepare('SELECT ai_classification FROM activities WHERE id = ?').get(id) as { ai_classification: string | null } | undefined;
            if (existingAi && existingAi.ai_classification) {
                try {
                    const parsed = JSON.parse(existingAi.ai_classification);
                    parsed.category = category;
                    parsed.reasoning = `Manually overridden by user to ${category}`;
                    db.prepare('UPDATE activities SET ai_classification = ? WHERE id = ?').run(JSON.stringify(parsed), id);
                } catch { /* retain the manual category even if legacy JSON is malformed */ }
            }
        }

        return NextResponse.json({ success: true, id, category });
    } catch (error) {
        console.error('Activity PATCH error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
