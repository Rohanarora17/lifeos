import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
    try {
        const db = getDb();

        // Get coin balance
        const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };
        const balance = balanceQuery?.balance || 0;

        // Get recent transactions (last 10)
        const transactions = db.prepare('SELECT id, amount, reason, created_at FROM coin_ledger ORDER BY created_at DESC LIMIT 10').all();

        // Get store items
        const store = db.prepare('SELECT id, title, cost, icon FROM rewards_store ORDER BY cost ASC').all();

        // Get badges (unlocked and locked)
        const badges = db.prepare(`
      SELECT b.id, b.name, b.description, b.icon, b.metric, b.target, u.unlocked_at
      FROM badges b
      LEFT JOIN user_badges u ON b.id = u.badge_id
      ORDER BY b.target ASC
    `).all();

        return NextResponse.json({
            balance,
            transactions,
            store,
            badges
        });
    } catch (error) {
        console.error('Gamification GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST to buy a reward
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { reward_id } = body;

        if (!reward_id) {
            return NextResponse.json({ error: 'reward_id is required' }, { status: 400 });
        }

        const db = getDb();

        const reward = db.prepare('SELECT * FROM rewards_store WHERE id = ?').get(reward_id) as any;
        if (!reward) return NextResponse.json({ error: 'Reward not found' }, { status: 404 });

        const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };

        if ((balanceQuery?.balance || 0) < reward.cost) {
            return NextResponse.json({ error: 'Not enough coins' }, { status: 400 });
        }

        // Deduct coins
        db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(-reward.cost, `Bought: ${reward.title}`);

        return NextResponse.json({ success: true, message: `Purchased ${reward.title} for ${reward.cost} coins!` });
    } catch (error) {
        console.error('Gamification POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
