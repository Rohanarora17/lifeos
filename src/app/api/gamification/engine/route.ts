import { NextResponse } from 'next/server';
import { checkAchievements } from '@/lib/intelligence';

export async function POST() {
    try {
        checkAchievements();
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Gamification Engine POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
