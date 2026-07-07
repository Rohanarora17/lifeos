import { NextRequest, NextResponse } from 'next/server';
import { getUnreadAlerts, getRecentAlerts, markAlertsRead, sendAlert, recordAlertFeedback, AlertType, Severity, AlertFeedback } from '@/lib/notifications';
import { getDb } from '@/lib/db';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { buildAdaptiveAlertCenterPolicy } from '@/lib/adaptive-alert-policy';

// GET — Fetch alerts (unread by default, or all recent)
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const all = searchParams.get('all') === 'true';

    const rawAlerts = all ? getRecentAlerts(50) : getUnreadAlerts(20);
    const personalization = buildPersonalizationSnapshot({
        surface: 'notification',
        maxInsights: 2,
        includeMemoryFacts: 3,
    });
    const { visibleAlerts, policy } = buildAdaptiveAlertCenterPolicy(rawAlerts, personalization);
    const unreadCount = getUnreadAlerts(100).length;

    return NextResponse.json({
        alerts: all ? rawAlerts : visibleAlerts,
        unreadCount,
        alertPolicy: {
            ...policy,
            rawUnreadCount: unreadCount,
            mode: personalization.moment.mode,
            alertFatigueLevel: personalization.feedback.alertFatigueLevel,
        },
    });
}

// POST — Create a new alert (used by extension for focus session alerts)
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { type, message, severity } = body;

        if (!type || !message) {
            return NextResponse.json({ error: 'type and message required' }, { status: 400 });
        }

        const sent = await sendAlert(
            type as AlertType,
            message,
            (severity || 'warning') as Severity
        );

        return NextResponse.json({ ok: true, sent });
    } catch (error) {
        console.error('Alert POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH — Mark alerts as read
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json() as {
            ids?: number[];
            id?: number;
            feedback?: AlertFeedback;
            reason?: string;
        };
        const { ids } = body; // optional: specific IDs to mark
        if (body.id && body.feedback) {
            if (!['helpful', 'not_helpful', 'dismissed'].includes(body.feedback)) {
                return NextResponse.json({ error: 'invalid feedback' }, { status: 400 });
            }
            const alert = recordAlertFeedback(body.id, body.feedback, body.reason);
            if (!alert) return NextResponse.json({ error: 'alert not found' }, { status: 404 });
            return NextResponse.json({ ok: true, alert });
        }
        markAlertsRead(ids);
        return NextResponse.json({ ok: true });
    } catch {
        markAlertsRead();
        return NextResponse.json({ ok: true });
    }
}

// DELETE — Clear old alerts
export async function DELETE() {
    const db = getDb();
    db.prepare("DELETE FROM alerts WHERE created_at < datetime('now', '-7 days')").run();
    return NextResponse.json({ ok: true });
}
