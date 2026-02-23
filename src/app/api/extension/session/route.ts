import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// GET: Returns the user's current context (Active Goals and Today's Tasks)
// The Chrome Extension uses this to determine what the user "should" be doing
// and feed it into the Context-Aware AI blocker.
export async function GET() {
    try {
        const db = getDb();

        // Fetch active goals
        const activeGoals = db.prepare(`
            SELECT id, title, description 
            FROM goals 
            WHERE active = 1
        `).all();

        // Fetch active/today tasks
        const activeTasks = db.prepare(`
            SELECT id, title, description, goal_id 
            FROM tasks 
            WHERE status IN ('doing', 'today')
        `).all();

        return NextResponse.json({
            activeGoals,
            activeTasks
        });
    } catch (error) {
        console.error('Extension Session API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
