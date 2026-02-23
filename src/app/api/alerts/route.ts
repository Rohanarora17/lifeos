import { NextRequest, NextResponse } from 'next/server';
import { getUnreadAlerts, getRecentAlerts, markAlertsRead } from '@/lib/notifications';
import { getDb } from '@/lib/db';

// GET — Fetch alerts (unread by default, or all recent)
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const all = searchParams.get('all') === 'true';

    const alerts = all ? getRecentAlerts(50) : getUnreadAlerts(20);
    const unreadCount = getUnreadAlerts(100).length;

    return NextResponse.json({ alerts, unreadCount });
}

// PATCH — Mark alerts as read
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { ids } = body; // optional: specific IDs to mark
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
