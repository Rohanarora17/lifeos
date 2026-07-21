'use client';

import { useEffect, useState } from 'react';

interface Transaction {
    id: number;
    amount: number;
    reason: string;
    created_at: string;
}

interface StoreItem {
    id: number;
    title: string;
    cost: number;
    icon: string;
    category: string | null;
    adaptive_reason: string | null;
    user_cost_override: number | null;
}

interface Badge {
    id: number;
    name: string;
    description: string;
    icon: string;
    metric: string;
    target: number;
    unlocked_at: string | null;
    adaptive_current_value?: number;
    adaptive_unlock_target?: number;
    adaptive_progress?: number;
    adaptive_canonical_progress?: number;
    adaptive_remaining?: number;
    adaptive_unlock_ready?: boolean;
    adaptive_reason?: string;
    adaptive_next_step?: string;
    adaptive_moment_fit?: 'high' | 'medium' | 'low';
}

interface RewardPolicy {
    mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
    guidance: string;
    energy: 'high' | 'medium' | 'low';
    mood: 'high' | 'medium' | 'low' | null;
    focusTrend: 'improving' | 'declining' | 'stable';
    alertFatigueLevel: 'low' | 'medium' | 'high';
    helpfulRate: number | null;
    coinMultiplier: number;
    earningGuidance: string;
    spendingGuidance: string;
}

const MODE_LABEL: Record<RewardPolicy['mode'], string> = {
    protect_focus: 'Protect focus',
    deadline_pressure: 'Deadline pressure',
    recovery: 'Recovery',
    planning: 'Planning',
    normal: 'Balanced',
};

type RewardCategory = 'restorative' | 'leisure' | 'purchase' | 'escape' | 'social' | 'custom';

const FIT_COLOR: Record<'high' | 'medium' | 'low', string> = {
    high: 'var(--accent-green)',
    medium: 'var(--accent-blue)',
    low: 'var(--accent-orange)',
};

function inferDraftCategory(title: string, explicit: RewardCategory): RewardCategory {
    if (explicit !== 'custom') return explicit;
    const lower = title.toLowerCase();
    if (/(sleep|nap|walk|massage|bath|rest|meditat|stretch|tea)/.test(lower)) return 'restorative';
    if (/(game|gaming|movie|youtube|netflix|anime|scroll|instagram|twitter|reddit)/.test(lower)) return 'leisure';
    if (/(buy|order|coffee|food|book|course|device|shopping|purchase)/.test(lower)) return 'purchase';
    if (/(skip|avoid|bunk|delay|postpone|cheat)/.test(lower)) return 'escape';
    if (/(friend|call|party|date|meet|hangout)/.test(lower)) return 'social';
    return 'custom';
}

function draftRewardBaseCost(category: RewardCategory, title: string): number {
    const lower = title.toLowerCase();
    if (category === 'restorative') return 350;
    if (category === 'social') return 700;
    if (category === 'purchase') return /(expensive|device|keyboard|shoe|course)/.test(lower) ? 2200 : 1200;
    if (category === 'escape') return 2400;
    if (category === 'leisure') return /(hour|movie|gaming|game|netflix)/.test(lower) ? 1200 : 850;
    return 800;
}

function buildRewardPricePreview(input: {
    title: string;
    explicitCost: string;
    category: RewardCategory;
    balance: number;
    policy: RewardPolicy | null;
}) {
    const manual = Number(input.explicitCost);
    const category = inferDraftCategory(input.title, input.category);
    if (Number.isFinite(manual) && manual > 0) {
        return {
            cost: Math.round(manual),
            category,
            reason: 'manual price; LifeOS records context but will not override it',
        };
    }

    const policy = input.policy;
    const reasons: string[] = [];
    let multiplier = 1;
    if (policy?.mode === 'deadline_pressure' && (category === 'leisure' || category === 'escape')) {
        multiplier += 0.35;
        reasons.push('higher because deadline pressure makes escape rewards risky');
    }
    if (policy?.mode === 'recovery' && category === 'restorative') {
        multiplier -= 0.2;
        reasons.push('lower because restorative rewards support recovery');
    }
    if (policy?.energy === 'low' && category === 'escape') {
        multiplier += 0.15;
        reasons.push('higher because low energy can turn escape into avoidance');
    }
    if (policy?.focusTrend === 'declining' && category === 'leisure') {
        multiplier += 0.15;
        reasons.push('higher because focus trend is declining');
    }
    if (policy?.mode === 'protect_focus' && (category === 'restorative' || category === 'social')) {
        multiplier -= 0.1;
        reasons.push('slightly lower because it can preserve momentum after focus');
    }

    const base = draftRewardBaseCost(category, input.title);
    const balanceFloor = input.balance > 0 ? Math.max(100, Math.round(input.balance * 0.08 / 25) * 25) : 0;
    const balanceCeil = input.balance > 0 ? Math.max(500, Math.round(input.balance * 0.6 / 25) * 25) : 5000;
    const cost = Math.max(100, Math.min(balanceCeil, Math.max(balanceFloor, Math.round((base * Math.max(0.7, Math.min(1.75, multiplier))) / 25) * 25)));

    return {
        cost,
        category,
        reason: reasons[0] ?? `priced from ${category} baseline for ${policy ? MODE_LABEL[policy.mode].toLowerCase() : 'today'} mode`,
    };
}

export default function StorePage() {
    const [balance, setBalance] = useState(0);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [store, setStore] = useState<StoreItem[]>([]);
    const [badges, setBadges] = useState<Badge[]>([]);
    const [rewardPolicy, setRewardPolicy] = useState<RewardPolicy | null>(null);
    const [draftRewardTitle, setDraftRewardTitle] = useState('');
    const [draftRewardCategory, setDraftRewardCategory] = useState<RewardCategory>('custom');
    const [draftRewardCost, setDraftRewardCost] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchGamificationData();
    }, []);

    const fetchGamificationData = async () => {
        try {
            const res = await fetch('/api/gamification');
            if (res.ok) {
                const data = await res.json() as {
                    balance?: number;
                    transactions?: Transaction[];
                    store?: StoreItem[];
                    badges?: Badge[];
                    rewardPolicy?: RewardPolicy;
                };
                setBalance(data.balance ?? 0);
                setTransactions(data.transactions ?? []);
                setStore(data.store ?? []);
                setBadges(data.badges ?? []);
                setRewardPolicy(data.rewardPolicy ?? null);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const buyItem = async (itemId: number) => {
        try {
            const res = await fetch('/api/gamification', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reward_id: itemId })
            });
            const data = await res.json();
            if (res.ok) {
                alert(data.message || 'Item purchased!');
                fetchGamificationData();
            } else {
                alert(data.error || 'Failed to purchase item');
            }
        } catch (e) {
            console.error(e);
        }
    };

    if (loading) return <div className="p-8"><div className="animate-pulse flex space-x-4"><div className="flex-1 space-y-4 py-1"><div className="h-4 bg-[#2a2a2a] rounded w-3/4"></div><div className="space-y-2"><div className="h-4 bg-[#2a2a2a] rounded"></div><div className="h-4 bg-[#2a2a2a] rounded w-5/6"></div></div></div></div></div>;

    const unlockedBadges = badges.filter(b => b.unlocked_at);
    const lockedBadges = badges.filter(b => !b.unlocked_at);
    const rewardPricePreview = buildRewardPricePreview({
        title: draftRewardTitle,
        explicitCost: draftRewardCost,
        category: draftRewardCategory,
        balance,
        policy: rewardPolicy,
    });

    return (
        <div className="max-w-5xl mx-auto space-y-8 pb-12">
            {/* Header & Balance */}
            <header className="flex items-end justify-between">
                <div>
                    <h1 className="text-3xl font-black tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>
                        Store & Badges
                    </h1>
                    <p style={{ color: 'var(--text-secondary)' }}>
                        {rewardPolicy
                            ? `${MODE_LABEL[rewardPolicy.mode]} · ${rewardPolicy.energy} energy · ${rewardPolicy.earningGuidance}`
                            : 'Rewards adapt to today, your energy, and recent feedback.'}
                    </p>
                </div>
                <div className="card text-center" style={{ padding: '1rem 2rem', minWidth: '200px', background: 'var(--bg-card)', border: '2px solid var(--accent-orange)' }}>
                    <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-orange)' }}>Coin Balance</p>
                    <p className="text-4xl font-black mt-1" style={{ color: 'var(--text-primary)' }}>{balance.toLocaleString()}</p>
                </div>
            </header>

            {rewardPolicy && (
                <section
                    className="rounded-lg px-4 py-3 text-sm"
                    style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        color: 'var(--text-secondary)',
                    }}
                >
                    <span className="font-bold" style={{ color: 'var(--accent-orange)' }}>
                        Today&apos;s reward policy
                    </span>
                    {' · '}
                    Earn multiplier {rewardPolicy.coinMultiplier.toFixed(2)}x · {rewardPolicy.spendingGuidance}
                </section>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Store Column */}
                <div className="lg:col-span-2 space-y-6">
                    <section>
                        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">🛒 Rewards Store</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {store.map(item => (
                                <div key={item.id} className="card flex items-center gap-4 transition-transform hover:-translate-y-1" style={{ padding: '1.25rem' }}>
                                    <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl flex-shrink-0" style={{ background: 'rgba(255,165,0,0.1)' }}>
                                        {item.icon}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-bold whitespace-nowrap overflow-hidden text-ellipsis">{item.title}</h3>
                                        <p className="text-xs font-medium" style={{ color: 'var(--accent-orange)' }}>{item.cost} Coins</p>
                                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                                {item.user_cost_override ? 'manual price' : `adaptive ${item.category ?? 'custom'}`}
                                                {item.adaptive_reason ? ` · ${item.adaptive_reason}` : ''}
                                            </p>
                                    </div>
                                    <button
                                        onClick={() => buyItem(item.id)}
                                        disabled={balance < item.cost}
                                        className="btn btn-sm btn-primary shrink-0"
                                        style={{ opacity: balance < item.cost ? 0.5 : 1, cursor: balance < item.cost ? 'not-allowed' : 'pointer', background: 'var(--accent-orange)' }}
                                    >
                                        Buy
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/* Add Custom Reward Section */}
                    <section className="card" style={{ padding: '1.5rem', border: '1px dashed var(--accent-orange)' }}>
                        <h3 className="text-lg font-bold mb-3 flex items-center gap-2">✨ Create Custom Reward</h3>
                        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                            Name the real-world reward; LifeOS prices it from today&apos;s mode, energy, focus trend, and coin balance unless you override it.
                        </p>
                        <form
                            className="flex flex-col gap-3"
                            onSubmit={async (e) => {
                                e.preventDefault();
                                const title = draftRewardTitle.trim();
                                const cost = draftRewardCost.trim();
                                const category = draftRewardCategory;
                                if (!title) return;

                                try {
                                    const res = await fetch('/api/gamification', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ title, cost: cost || null, category, icon: '🌟' })
                                    });
                                    if (res.ok) {
                                        setDraftRewardTitle('');
                                        setDraftRewardCategory('custom');
                                        setDraftRewardCost('');
                                        fetchGamificationData();
                                    }
                                } catch { }
                            }}
                        >
                            <div className="flex flex-col sm:flex-row gap-3">
                                <input
                                    required
                                    name="title"
                                    type="text"
                                    placeholder="Reward Title..."
                                    className="input flex-1"
                                    value={draftRewardTitle}
                                    onChange={e => setDraftRewardTitle(e.target.value)}
                                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                                />
                                <select
                                    name="category"
                                    className="input w-40"
                                    value={draftRewardCategory}
                                    onChange={e => setDraftRewardCategory(e.target.value as RewardCategory)}
                                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                                >
                                    <option value="custom">Custom</option>
                                    <option value="restorative">Restorative</option>
                                    <option value="leisure">Leisure</option>
                                    <option value="purchase">Purchase</option>
                                    <option value="escape">Escape</option>
                                    <option value="social">Social</option>
                                </select>
                                <input
                                    name="cost"
                                    type="number"
                                    min="1"
                                    placeholder="Auto price"
                                    className="input w-32"
                                    value={draftRewardCost}
                                    onChange={e => setDraftRewardCost(e.target.value)}
                                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                                />
                                <button type="submit" className="btn btn-primary" style={{ background: 'var(--accent-orange)' }}>Add</button>
                            </div>
                            <div className="rounded-md px-3 py-2 text-xs" style={{ background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.16)', color: 'var(--text-secondary)' }}>
                                <strong style={{ color: 'var(--accent-orange)' }}>Price preview:</strong>
                                {' '}
                                {rewardPricePreview.cost} coins · {rewardPricePreview.category} · {rewardPricePreview.reason}
                            </div>
                        </form>
                    </section>

                    <section>
                        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">🏆 Trophy Vault</h2>
                        <div className="card space-y-6" style={{ padding: '1.5rem' }}>
                            {unlockedBadges.length > 0 && (
                                <div>
                                    <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--accent-green)' }}>Unlocked Achievements ({unlockedBadges.length})</h3>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                                        {unlockedBadges.map(badge => (
                                            <div key={badge.id} className="text-center p-3 rounded-xl border transition-all hover:scale-105" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--accent-green)' }}>
                                                <div className="text-3xl mb-2">{badge.icon}</div>
                                                <h4 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{badge.name}</h4>
                                                <p className="text-[10px] mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{badge.description}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div>
                                <h3 className="text-sm font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Locked ({lockedBadges.length})</h3>
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                                    {lockedBadges.map(badge => (
                                        <div key={badge.id} className="text-center p-3 rounded-xl border grayscale opacity-60" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
                                            <div className="text-3xl mb-2">{badge.icon}</div>
                                            <h4 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{badge.name}</h4>
                                            <p className="text-[10px] mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{badge.description}</p>
                                            <div className="mt-2 text-[10px] font-bold" style={{ color: 'var(--text-secondary)' }}>
                                                {badge.adaptive_current_value ?? 0}/{badge.adaptive_unlock_target ?? badge.target} {badge.metric.replace('_', ' ')}
                                            </div>
                                            {badge.adaptive_unlock_target !== undefined && badge.adaptive_unlock_target < badge.target && (
                                                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                                    Today&apos;s adaptive target · long-term badge {badge.target}
                                                </div>
                                            )}
                                            <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                                <div
                                                    className="h-full"
                                                    style={{
                                                        width: `${badge.adaptive_progress ?? 0}%`,
                                                        background: badge.adaptive_moment_fit ? FIT_COLOR[badge.adaptive_moment_fit] : 'var(--accent-orange)',
                                                    }}
                                                />
                                            </div>
                                            {badge.adaptive_next_step && (
                                                <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                                                    <span style={{ color: badge.adaptive_moment_fit ? FIT_COLOR[badge.adaptive_moment_fit] : 'var(--text-secondary)', fontWeight: 700 }}>
                                                        {badge.adaptive_moment_fit ?? 'medium'} fit
                                                    </span>
                                                    {' · '}
                                                    {badge.adaptive_next_step}
                                                </p>
                                            )}
                                            {badge.adaptive_remaining !== undefined && badge.adaptive_remaining > 0 && (
                                                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                                    {badge.adaptive_remaining} more for today&apos;s unlock target.
                                                </p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </section>
                </div>

                {/* Ledger Sidebar */}
                <div className="space-y-6">
                    <section className="card flex flex-col h-[500px]" style={{ padding: '1.25rem' }}>
                        <h2 className="text-lg font-bold mb-4 flex items-center gap-2">🧾 Recent Transactions</h2>
                        <div className="flex-1 overflow-y-auto pr-2 space-y-3">
                            {transactions.map(tx => (
                                <div key={tx.id} className="flex items-center justify-between text-sm py-2 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                                    <div className="min-w-0 pr-4">
                                        <p className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{tx.reason}</p>
                                        <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{new Date(tx.created_at).toLocaleString()}</p>
                                    </div>
                                    <span className="font-bold shrink-0" style={{ color: tx.amount > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                                        {tx.amount > 0 ? '+' : ''}{tx.amount}
                                    </span>
                                </div>
                            ))}
                            {transactions.length === 0 && (
                                <p className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>No transactions yet.</p>
                            )}
                        </div>
                    </section>
                </div>

            </div>
        </div>
    );
}
