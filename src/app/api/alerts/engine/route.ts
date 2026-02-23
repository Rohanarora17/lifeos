import { NextResponse } from 'next/server';
import { runAlertEngine } from '@/lib/notifications';

// POST — Run the alert engine (called by scheduler every 5 min)
export async function POST() {
    try {
        const result = await runAlertEngine();
        return NextResponse.json(result);
    } catch (error) {
        console.error('Alert engine error:', error);
        return NextResponse.json({ error: 'Alert engine failed' }, { status: 500 });
    }
}
