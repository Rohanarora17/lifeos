import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sanitizeText } from '@/lib/sanitize';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveRewardPolicy, priceAdaptiveReward } from '@/lib/adaptive-rewards';
import { buildAdaptiveBadgeProgress, type BadgeProgressInput } from '@/lib/adaptive-achievements';
import { getAchievementStats } from '@/lib/achievements';

interface RewardStoreRow {
    id: number;
    title: string;
    cost: number;
    icon: string;
    category: string | null;
    pricing_json: string | null;
    adaptive_reason: string | null;
    user_cost_override: number | null;
}

function priceStoreReward(row: RewardStoreRow, balance: number, snapshot: ReturnType<typeof buildPersonalizationSnapshot>) {
    const hasManualPrice = Number(row.user_cost_override ?? 0) === 1;
    if (hasManualPrice) {
        return {
            ...row,
            stored_cost: row.cost,
            adaptive_price_changed: false,
        };
    }

    const pricing = priceAdaptiveReward({
        title: row.title,
        category: row.category ?? undefined,
        balance,
        snapshot,
    });

    return {
        ...row,
        cost: pricing.cost,
        category: pricing.category,
        pricing_json: pricing.pricingJson,
        adaptive_reason: pricing.reason,
        user_cost_override: 0,
        stored_cost: row.cost,
        adaptive_price_changed: pricing.cost !== row.cost,
    };
}

export async function GET() {
    try {
        const db = getDb();
        const personalization = buildPersonalizationSnapshot({
            surface: 'rewards',
            maxInsights: 2,
            includeMemoryFacts: 3,
        });
        const achievementPersonalization = buildPersonalizationSnapshot({
            surface: 'achievements',
            maxInsights: 2,
            includeMemoryFacts: 3,
        });
        const rewardPolicy = getAdaptiveRewardPolicy(personalization);

        // Get coin balance
        const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };
        const balance = balanceQuery?.balance || 0;

        // Get recent transactions (last 10)
        const transactions = db.prepare('SELECT id, amount, reason, created_at FROM coin_ledger ORDER BY created_at DESC LIMIT 10').all();

        // Get store items
        const storeRows = db.prepare(`
            SELECT id, title, cost, icon, category, pricing_json, adaptive_reason, user_cost_override
            FROM rewards_store
            ORDER BY cost ASC
        `).all() as RewardStoreRow[];
        const store = storeRows
            .map((row) => priceStoreReward(row, balance, personalization))
            .sort((a, b) => a.cost - b.cost);

        // Get badges (unlocked and locked)
        const badges = db.prepare(`
	      SELECT b.id, b.name, b.description, b.icon, b.metric, b.target, u.unlocked_at
	      FROM badges b
	      LEFT JOIN user_badges u ON b.id = u.badge_id
	      ORDER BY b.target ASC
	    `).all() as BadgeProgressInput[];
        const adaptiveBadges = buildAdaptiveBadgeProgress(badges, getAchievementStats(), achievementPersonalization);

        return NextResponse.json({
            balance,
            transactions,
            store,
            badges: adaptiveBadges,
            rewardPolicy,
            personalization: {
                mode: personalization.moment.mode,
                guidance: personalization.moment.guidance,
                energy: personalization.userState.energy,
                mood: personalization.userState.mood,
                focusTrend: personalization.userState.focusTrend,
                alertFatigueLevel: personalization.feedback.alertFatigueLevel,
            },
        });
    } catch (error) {
        console.error('Gamification GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST to buy a reward or create a custom reward
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { reward_id, title, cost, icon, category } = body;

        const db = getDb();
        const personalization = buildPersonalizationSnapshot({
            surface: 'rewards',
            maxInsights: 2,
            includeMemoryFacts: 3,
        });
        const rewardPolicy = getAdaptiveRewardPolicy(personalization);

        // Action: Create Custom Reward
        if (title) {
            const safeTitle = sanitizeText(title, 200);
            const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };
            const pricing = priceAdaptiveReward({
                title: safeTitle,
                desiredCost: cost,
                category,
                balance: balanceQuery?.balance || 0,
                snapshot: personalization,
            });
            db.prepare(`
                INSERT INTO rewards_store (title, cost, icon, category, pricing_json, adaptive_reason, user_cost_override)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                safeTitle,
                pricing.cost,
                icon || '🎁',
                pricing.category,
                pricing.pricingJson,
                pricing.reason,
                pricing.userCostOverride ? 1 : 0,
            );
            return NextResponse.json({
                success: true,
                message: `Added custom reward: ${safeTitle} for ${pricing.cost} coins. ${pricing.reason}`,
                pricing,
                rewardPolicy,
            });
        }

        // Action: Buy existing Reward
        if (!reward_id) {
            return NextResponse.json({ error: 'reward_id or new reward details are required' }, { status: 400 });
        }

        const reward = db.prepare(`
            SELECT id, title, cost, icon, category, pricing_json, adaptive_reason, user_cost_override
            FROM rewards_store
            WHERE id = ?
        `).get(reward_id) as RewardStoreRow | undefined;
        if (!reward) return NextResponse.json({ error: 'Reward not found' }, { status: 404 });

        const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };
        const balance = balanceQuery?.balance || 0;
        const pricedReward = priceStoreReward(reward, balance, personalization);

        if (balance < pricedReward.cost) {
            return NextResponse.json({ error: 'Not enough coins' }, { status: 400 });
        }

        // Deduct coins
        db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(
            -pricedReward.cost,
            `Bought: ${pricedReward.title} (${rewardPolicy.mode}: ${rewardPolicy.spendingGuidance}; ${pricedReward.adaptive_reason ?? 'manual price'})`,
        );

        return NextResponse.json({
            success: true,
            message: `Purchased ${pricedReward.title} for ${pricedReward.cost} coins. ${rewardPolicy.spendingGuidance}`,
            pricing: pricedReward,
            rewardPolicy,
        });
    } catch (error) {
        console.error('Gamification POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
