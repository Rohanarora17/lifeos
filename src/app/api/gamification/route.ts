import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sanitizeText } from '@/lib/sanitize';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveRewardPolicy, priceAdaptiveReward } from '@/lib/adaptive-rewards';
import { buildAdaptiveBadgeProgress, type BadgeProgressInput } from '@/lib/adaptive-achievements';
import { getAchievementStats } from '@/lib/achievements';
import { normalizeRewardCategory, parseRewardCost } from '@/lib/reward-pricing';

interface RewardStoreRow {
    id: number;
    title: string;
    cost: number;
    icon: string;
    category: string | null;
    pricing_json: string | null;
    adaptive_reason: string | null;
    user_cost_override: number | null;
    is_custom: number;
    created_at: string;
}

function parseRewardIcon(value: unknown): string {
    if (typeof value !== 'string') return '🎁';
    return sanitizeText(value, 16) || '🎁';
}

function parseRewardId(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseIdempotencyKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    return /^[A-Za-z0-9._:-]{8,128}$/.test(key) ? key : null;
}

interface RewardRedemptionRow {
    id: number;
    idempotency_key: string;
    reward_id: number | null;
    reward_title: string;
    reward_icon: string;
    cost: number;
    category: string | null;
    pricing_json: string | null;
    adaptive_reason: string | null;
    ledger_entry_id: number;
    redeemed_at: string;
}

function getRewardRedemption(db: ReturnType<typeof getDb>, idempotencyKey: string): RewardRedemptionRow | undefined {
    return db.prepare(`
        SELECT id, idempotency_key, reward_id, reward_title, reward_icon, cost,
               category, pricing_json, adaptive_reason, ledger_entry_id, redeemed_at
        FROM reward_redemptions
        WHERE idempotency_key = ?
    `).get(idempotencyKey) as RewardRedemptionRow | undefined;
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
        const transactions = db.prepare(`
            SELECT ledger.id, ledger.amount, ledger.reason, ledger.created_at,
                   redemption.id AS redemption_id,
                   redemption.reward_id,
                   redemption.reward_title,
                   redemption.reward_icon,
                   redemption.cost AS reward_cost
            FROM coin_ledger AS ledger
            LEFT JOIN reward_redemptions AS redemption
              ON redemption.ledger_entry_id = ledger.id
            ORDER BY ledger.created_at DESC, ledger.id DESC
            LIMIT 10
        `).all();

        // Get store items
        const storeRows = db.prepare(`
            SELECT id, title, cost, icon, category, pricing_json, adaptive_reason,
                   user_cost_override, is_custom, created_at
            FROM rewards_store
            ORDER BY is_custom DESC, created_at DESC
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
        const { reward_id, title, cost, icon, category, idempotency_key } = body;

        const db = getDb();
        const personalization = buildPersonalizationSnapshot({
            surface: 'rewards',
            maxInsights: 2,
            includeMemoryFacts: 3,
        });
        const rewardPolicy = getAdaptiveRewardPolicy(personalization);

        // Action: Create Custom Reward
        if (typeof title === 'string') {
            const safeTitle = sanitizeText(title, 120);
            if (!safeTitle) {
                return NextResponse.json({ error: 'Reward name is required' }, { status: 400 });
            }
            const parsedCost = parseRewardCost(cost);
            if (parsedCost.error) {
                return NextResponse.json({ error: parsedCost.error }, { status: 400 });
            }
            const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };
            const pricing = priceAdaptiveReward({
                title: safeTitle,
                desiredCost: parsedCost.value,
                category: normalizeRewardCategory(category),
                balance: balanceQuery?.balance || 0,
                snapshot: personalization,
            });
            db.prepare(`
                INSERT INTO rewards_store (
                    title, cost, icon, category, pricing_json, adaptive_reason,
                    user_cost_override, is_custom
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `).run(
                safeTitle,
                pricing.cost,
                parseRewardIcon(icon),
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
        const rewardId = parseRewardId(reward_id);
        if (!rewardId) {
            return NextResponse.json({ error: 'reward_id or new reward details are required' }, { status: 400 });
        }
        const idempotencyKey = parseIdempotencyKey(idempotency_key);
        if (!idempotencyKey) {
            return NextResponse.json({ error: 'A valid idempotency_key is required to redeem a reward' }, { status: 400 });
        }

        const priorRedemption = getRewardRedemption(db, idempotencyKey);
        if (priorRedemption) {
            if (priorRedemption.reward_id !== rewardId) {
                return NextResponse.json({ error: 'That redemption request key was already used for another reward' }, { status: 409 });
            }
            return NextResponse.json({
                success: true,
                deduplicated: true,
                message: `${priorRedemption.reward_title} was already redeemed. You were not charged again.`,
                redemption: priorRedemption,
                rewardPolicy,
            });
        }

        const reward = db.prepare(`
            SELECT id, title, cost, icon, category, pricing_json, adaptive_reason,
                   user_cost_override, is_custom, created_at
            FROM rewards_store
            WHERE id = ?
        `).get(rewardId) as RewardStoreRow | undefined;
        if (!reward) return NextResponse.json({ error: 'Reward not found' }, { status: 404 });

        const redeem = db.transaction(() => {
            const duplicate = getRewardRedemption(db, idempotencyKey);

            if (duplicate) {
                return duplicate.reward_id === rewardId
                    ? { status: 'duplicate' as const, redemption: duplicate }
                    : { status: 'conflict' as const };
            }

            const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };
            const balance = balanceQuery?.balance || 0;
            const pricedReward = priceStoreReward(reward, balance, personalization);
            if (balance < pricedReward.cost) {
                return { status: 'insufficient' as const, cost: pricedReward.cost, balance };
            }

            const reason = `Bought: ${pricedReward.title} (${rewardPolicy.mode}: ${rewardPolicy.spendingGuidance}; ${pricedReward.adaptive_reason ?? 'manual price'})`;
            const ledgerResult = db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(
                -pricedReward.cost,
                reason,
            );
            const redemptionResult = db.prepare(`
                INSERT INTO reward_redemptions (
                    idempotency_key, reward_id, reward_title, reward_icon, cost,
                    category, pricing_json, adaptive_reason, ledger_entry_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                idempotencyKey,
                reward.id,
                pricedReward.title,
                pricedReward.icon,
                pricedReward.cost,
                pricedReward.category,
                pricedReward.pricing_json,
                pricedReward.adaptive_reason,
                Number(ledgerResult.lastInsertRowid),
            );
            const redemption = db.prepare(`
                SELECT id, idempotency_key, reward_id, reward_title, reward_icon, cost,
                       category, pricing_json, adaptive_reason, ledger_entry_id, redeemed_at
                FROM reward_redemptions
                WHERE id = ?
            `).get(Number(redemptionResult.lastInsertRowid)) as RewardRedemptionRow;
            return { status: 'created' as const, redemption, pricing: pricedReward };
        });
        const redemptionResult = redeem.immediate();

        if (redemptionResult.status === 'conflict') {
            return NextResponse.json({ error: 'That redemption request key was already used for another reward' }, { status: 409 });
        }
        if (redemptionResult.status === 'insufficient') {
            return NextResponse.json({ error: 'Not enough coins' }, { status: 400 });
        }
        if (redemptionResult.status === 'duplicate') {
            return NextResponse.json({
                success: true,
                deduplicated: true,
                message: `${redemptionResult.redemption.reward_title} was already redeemed. You were not charged again.`,
                redemption: redemptionResult.redemption,
                rewardPolicy,
            });
        }

        return NextResponse.json({
            success: true,
            deduplicated: false,
            message: `Purchased ${redemptionResult.pricing.title} for ${redemptionResult.pricing.cost} coins. ${rewardPolicy.spendingGuidance}`,
            pricing: redemptionResult.pricing,
            redemption: redemptionResult.redemption,
            rewardPolicy,
        });
    } catch (error) {
        console.error('Gamification POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH updates user-created rewards. Seeded catalog items intentionally remain read-only.
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const rewardId = parseRewardId(body.id);
        if (!rewardId) return NextResponse.json({ error: 'A valid reward id is required' }, { status: 400 });

        const safeTitle = sanitizeText(typeof body.title === 'string' ? body.title : '', 120);
        if (!safeTitle) return NextResponse.json({ error: 'Reward name is required' }, { status: 400 });

        const parsedCost = parseRewardCost(body.cost);
        if (parsedCost.error) return NextResponse.json({ error: parsedCost.error }, { status: 400 });

        const db = getDb();
        const existing = db.prepare(`
            SELECT id, is_custom
            FROM rewards_store
            WHERE id = ?
        `).get(rewardId) as { id: number; is_custom: number } | undefined;
        if (!existing) return NextResponse.json({ error: 'Reward not found' }, { status: 404 });
        if (existing.is_custom !== 1) {
            return NextResponse.json({ error: 'Built-in rewards cannot be edited' }, { status: 403 });
        }

        const personalization = buildPersonalizationSnapshot({
            surface: 'rewards',
            maxInsights: 2,
            includeMemoryFacts: 3,
        });
        const balanceQuery = db.prepare('SELECT COALESCE(SUM(amount), 0) as balance FROM coin_ledger').get() as { balance: number };
        const pricing = priceAdaptiveReward({
            title: safeTitle,
            desiredCost: parsedCost.value,
            category: normalizeRewardCategory(body.category),
            balance: balanceQuery?.balance || 0,
            snapshot: personalization,
        });

        db.prepare(`
            UPDATE rewards_store
            SET title = ?, cost = ?, icon = ?, category = ?, pricing_json = ?,
                adaptive_reason = ?, user_cost_override = ?
            WHERE id = ? AND is_custom = 1
        `).run(
            safeTitle,
            pricing.cost,
            parseRewardIcon(body.icon),
            pricing.category,
            pricing.pricingJson,
            pricing.reason,
            pricing.userCostOverride ? 1 : 0,
            rewardId,
        );

        return NextResponse.json({
            success: true,
            message: `Updated ${safeTitle}`,
            pricing,
            rewardPolicy: getAdaptiveRewardPolicy(personalization),
        });
    } catch (error) {
        console.error('Gamification PATCH error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE removes only user-created rewards. Purchases remain in the immutable coin ledger.
export async function DELETE(request: NextRequest) {
    try {
        const rewardId = parseRewardId(request.nextUrl.searchParams.get('id'));
        if (!rewardId) return NextResponse.json({ error: 'A valid reward id is required' }, { status: 400 });

        const db = getDb();
        const existing = db.prepare(`
            SELECT id, title, is_custom
            FROM rewards_store
            WHERE id = ?
        `).get(rewardId) as { id: number; title: string; is_custom: number } | undefined;
        if (!existing) return NextResponse.json({ error: 'Reward not found' }, { status: 404 });
        if (existing.is_custom !== 1) {
            return NextResponse.json({ error: 'Built-in rewards cannot be deleted' }, { status: 403 });
        }

        db.prepare('DELETE FROM rewards_store WHERE id = ? AND is_custom = 1').run(rewardId);
        return NextResponse.json({ success: true, message: `Deleted ${existing.title}` });
    } catch (error) {
        console.error('Gamification DELETE error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
