import { NextRequest, NextResponse } from 'next/server';
import { getDb, getSetting, setSetting } from '@/lib/db';

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

        return NextResponse.json({ settings });
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
