import { NextRequest, NextResponse } from 'next/server';
import { getDb, setSetting } from '@/lib/db';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { buildAdaptiveSettingsPolicy } from '@/lib/adaptive-settings-policy';

// GET: Fetch all settings (hide sensitive keys partially)
export async function GET() {
    try {
        const db = getDb();
        const rows = db.prepare('SELECT * FROM settings').all() as { key: string; value: string }[];

        const settings: Record<string, string> = {};
        for (const row of rows) {
            if (row.key.includes('api_key') || row.key.includes('pat') || row.key.includes('token')) {
                // Mask sensitive values
                settings[row.key] = row.value ? '••••' + row.value.slice(-4) : '';
            } else {
                settings[row.key] = row.value;
            }
        }

        const personalization = buildPersonalizationSnapshot({
            surface: 'settings',
            maxInsights: 2,
            includeThresholds: true,
            includeMemoryFacts: 4,
        });
        const adaptivePolicy = buildAdaptiveSettingsPolicy(settings, personalization);

        return NextResponse.json({
            settings,
            adaptivePolicy,
            personalization: {
                mode: personalization.moment.mode,
                guidance: personalization.moment.guidance,
                energy: personalization.userState.energy,
                mood: personalization.userState.mood,
                focusTrend: personalization.userState.focusTrend,
                alertFatigueLevel: personalization.feedback.alertFatigueLevel,
                nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
            },
        });
    } catch (error) {
        console.error('Settings GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST: Update settings
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { settings } = body;

        if (!settings || typeof settings !== 'object') {
            return NextResponse.json({ error: 'settings object is required' }, { status: 400 });
        }

        for (const [key, value] of Object.entries(settings)) {
            // Don't overwrite with masked values
            if (typeof value === 'string' && !value.startsWith('••••')) {
                setSetting(key, value);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Settings POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
