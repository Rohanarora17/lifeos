import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assessFreshness } from '@/lib/diagnostic-freshness';
import { getGuardianContext } from '@/lib/guardian-runtime';
import { getSchedulerStatus } from '@/lib/scheduler';
import { getAiServiceHealth } from '@/lib/ai-health';

export const dynamic = 'force-dynamic';

interface TimestampRow {
    observed_at?: string | null;
    observed_end?: string | null;
    started_at?: string | null;
}

function latestTimestamp(query: string, column: keyof TimestampRow) {
    try {
        const row = getDb().prepare(query).get() as TimestampRow | undefined;
        return row?.[column] || null;
    } catch {
        return null;
    }
}

function migrationState() {
    try {
        const row = getDb().prepare(`
            SELECT COUNT(*) AS count, MAX(applied_at) AS latest
            FROM _migrations
        `).get() as { count: number; latest: string | null };
        return { status: 'ready', applied: row.count, latestAppliedAt: row.latest };
    } catch {
        return { status: 'error', applied: 0, latestAppliedAt: null };
    }
}

export async function GET(request: NextRequest) {
    const scheduler = getSchedulerStatus();
    const guardian = getGuardianContext();
    const latestBrowserActivity = latestTimestamp(
        `SELECT observed_end
         FROM telemetry_events_v1
         WHERE source = 'browser_extension'
         ORDER BY observed_end DESC
         LIMIT 1`,
        'observed_end',
    );
    const latestScreenObservation = latestTimestamp(
        'SELECT observed_at FROM screen_observations ORDER BY observed_at DESC LIMIT 1',
        'observed_at',
    );

    const livekitConfigured = Boolean(
        process.env.LIVEKIT_WS_URL
        && process.env.LIVEKIT_API_KEY
        && process.env.LIVEKIT_API_SECRET,
    );
    const vertexConfigured = Boolean(
        process.env.GOOGLE_CLOUD_PROJECT
        && (process.env.GOOGLE_CLOUD_LOCATION || process.env.GOOGLE_CLOUD_REGION),
    );
    const vertexHealth = getAiServiceHealth();

    const response = NextResponse.json({
        generatedAt: new Date().toISOString(),
        deployment: {
            commit:
                process.env.LIFEOS_DEPLOYED_COMMIT
                || process.env.GITHUB_SHA
                || 'unknown',
            environment: process.env.NODE_ENV || 'unknown',
            node: process.version,
            uptimeSeconds: Math.floor(process.uptime()),
        },
        security: {
            authenticatedAs: request.headers.get('x-lifeos-auth-kind') || 'unknown',
            apiTokenConfigured: Boolean(process.env.LIFEOS_API_TOKEN),
            deviceTokenConfigured: Boolean(process.env.LIFEOS_DEVICE_TOKEN),
            allowedOriginsConfigured: Boolean(process.env.LIFEOS_ALLOWED_ORIGINS),
            extensionOriginConfigured: Boolean(process.env.LIFEOS_EXTENSION_ID),
        },
        database: migrationState(),
        services: {
            web: { status: 'running' },
            scheduler: {
                status: scheduler.initialized ? 'running' : 'not_initialized',
                jobs: scheduler.jobs.map(job => ({
                    name: job.name,
                    running: job.running,
                    lastRun: job.lastRun,
                    nextRun: job.nextRun,
                })),
            },
            guardian: {
                status: guardian.activeSession ? 'active' : 'idle',
                sessionId: guardian.activeSession?.sessionId || null,
            },
        },
        telemetry: {
            browser: assessFreshness(latestBrowserActivity, 5 * 60),
            screen: assessFreshness(latestScreenObservation, 2 * 60),
        },
        models: {
            vertex: {
                configured: vertexConfigured,
                projectConfigured: Boolean(process.env.GOOGLE_CLOUD_PROJECT),
                status: vertexHealth.status,
                model: vertexHealth.model,
                failureCode: vertexHealth.failureCode,
                message: vertexHealth.message,
                firstFailureAt: vertexHealth.firstFailureAt,
                lastFailureAt: vertexHealth.lastFailureAt,
                lastSuccessAt: vertexHealth.lastSuccessAt,
                consecutiveFailures: vertexHealth.consecutiveFailures,
                modelAvailabilityVerified: vertexHealth.status === 'healthy',
            },
            pushToTalk: {
                configured: Boolean(process.env.WHISPER_CPP_URL),
                realDeviceGatePassed: false,
            },
            realtimeVoice: {
                configured: livekitConfigured,
                enabled: process.env.LIFEOS_REALTIME_VOICE_ENABLED === 'true',
                model: process.env.LIVEKIT_GUARDIAN_MODEL || null,
                realDeviceGatePassed: false,
            },
        },
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
}
