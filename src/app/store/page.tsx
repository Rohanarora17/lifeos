'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
    calculateRewardPrice,
    MAX_REWARD_COST,
    normalizeRewardCategory,
    parseRewardCost,
    type RewardCategory,
} from '@/lib/reward-pricing';

interface Transaction {
    id: number;
    amount: number;
    reason: string;
    created_at: string;
    redemption_id?: number | null;
    reward_id?: number | null;
    reward_title?: string | null;
    reward_icon?: string | null;
    reward_cost?: number | null;
}

interface StoreItem {
    id: number;
    title: string;
    cost: number;
    icon: string;
    category: RewardCategory | null;
    adaptive_reason: string | null;
    user_cost_override: number | null;
    is_custom: number;
    created_at: string;
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

interface GamificationPayload {
    balance?: number;
    transactions?: Transaction[];
    store?: StoreItem[];
    badges?: Badge[];
    rewardPolicy?: RewardPolicy;
    error?: string;
}

type PriceMode = 'adaptive' | 'custom';
type Notice = { tone: 'success' | 'error'; message: string } | null;

const MODE_LABEL: Record<RewardPolicy['mode'], string> = {
    protect_focus: 'Protect focus',
    deadline_pressure: 'Deadline pressure',
    recovery: 'Recovery',
    planning: 'Planning',
    normal: 'Balanced',
};

const CATEGORY_LABEL: Record<RewardCategory, string> = {
    restorative: 'Rest & recovery',
    leisure: 'Leisure',
    purchase: 'Something to buy',
    escape: 'Time off',
    social: 'Social',
    custom: 'Other',
};

const CATEGORY_ACCENT: Record<RewardCategory, string> = {
    restorative: '#34d399',
    leisure: '#a78bfa',
    purchase: '#60a5fa',
    escape: '#fb923c',
    social: '#f472b6',
    custom: '#fbbf24',
};

const REWARD_ICONS = ['🎁', '☕', '🎮', '🍿', '📚', '🍜', '🛍️', '🌿', '😴', '🎧', '✈️', '✨'];

const FIT_COLOR: Record<'high' | 'medium' | 'low', string> = {
    high: 'var(--accent-green)',
    medium: 'var(--accent-blue)',
    low: 'var(--accent-orange)',
};

function asCategory(value: string | null): RewardCategory {
    return normalizeRewardCategory(value);
}

function createRedemptionKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `reward-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function rewardNamePlaceholder(policy: RewardPolicy | null): string {
    if (!policy) return 'Coffee after I finish my focus block';
    if (policy.mode === 'recovery' || policy.energy === 'low') return 'A slow walk, early night, or guilt-free rest';
    if (policy.mode === 'deadline_pressure') return 'A movie after I submit';
    if (policy.mode === 'protect_focus') return 'Tea and a call after my deep-work block';
    if (policy.mode === 'planning') return 'A treat after I plan tomorrow';
    return 'Game time, a book, coffee, or a walk';
}

function formatTransactionDate(value: string): string {
    const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function readResponse(res: Response): Promise<{ message?: string; error?: string }> {
    try {
        return await res.json() as { message?: string; error?: string };
    } catch {
        return {};
    }
}

export default function StorePage() {
    const [balance, setBalance] = useState(0);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [store, setStore] = useState<StoreItem[]>([]);
    const [badges, setBadges] = useState<Badge[]>([]);
    const [rewardPolicy, setRewardPolicy] = useState<RewardPolicy | null>(null);
    const [draftTitle, setDraftTitle] = useState('');
    const [draftCategory, setDraftCategory] = useState<RewardCategory>('custom');
    const [draftCost, setDraftCost] = useState('');
    const [draftIcon, setDraftIcon] = useState('🎁');
    const [priceMode, setPriceMode] = useState<PriceMode>('adaptive');
    const [editingId, setEditingId] = useState<number | null>(null);
    const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [notice, setNotice] = useState<Notice>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const nameInputRef = useRef<HTMLInputElement>(null);
    const redemptionKeyRef = useRef<{ rewardId: number; key: string } | null>(null);

    const fetchGamificationData = useCallback(async (showLoader = false) => {
        if (showLoader) setLoading(true);
        try {
            const res = await fetch('/api/gamification', { cache: 'no-store' });
            const data = await readResponse(res) as GamificationPayload;
            if (!res.ok) throw new Error(data.error || 'Could not load rewards');
            setBalance(data.balance ?? 0);
            setTransactions(data.transactions ?? []);
            setStore(data.store ?? []);
            setBadges(data.badges ?? []);
            setRewardPolicy(data.rewardPolicy ?? null);
            setLoadError('');
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : 'Could not load rewards');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchGamificationData();
    }, [fetchGamificationData]);

    const resetForm = () => {
        setDraftTitle('');
        setDraftCategory('custom');
        setDraftCost('');
        setDraftIcon('🎁');
        setPriceMode('adaptive');
        setEditingId(null);
    };

    const parsedDraftCost = parseRewardCost(priceMode === 'custom' ? draftCost : null);
    const priceError = priceMode === 'custom' ? parsedDraftCost.error : null;
    const rewardPricePreview = calculateRewardPrice({
        title: draftTitle,
        desiredCost: parsedDraftCost.value,
        category: draftCategory,
        balance,
        context: {
            mode: rewardPolicy?.mode ?? 'normal',
            energy: rewardPolicy?.energy ?? 'medium',
            focusTrend: rewardPolicy?.focusTrend ?? 'stable',
        },
    });

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setNotice(null);
        const title = draftTitle.trim();
        if (!title) {
            setNotice({ tone: 'error', message: 'Give your reward a name first.' });
            nameInputRef.current?.focus();
            return;
        }
        if (priceMode === 'custom' && (priceError || parsedDraftCost.value === null)) {
            setNotice({ tone: 'error', message: priceError || 'Enter a custom price of at least 1 coin.' });
            return;
        }

        const actionKey = editingId ? `edit-${editingId}` : 'create';
        setBusyAction(actionKey);
        try {
            const res = await fetch('/api/gamification', {
                method: editingId ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: editingId,
                    title,
                    cost: priceMode === 'custom' ? draftCost : null,
                    category: draftCategory,
                    icon: draftIcon,
                }),
            });
            const data = await readResponse(res);
            if (!res.ok) throw new Error(data.error || 'Could not save reward');
            setNotice({ tone: 'success', message: editingId ? 'Reward updated.' : 'Your reward is ready to earn.' });
            resetForm();
            await fetchGamificationData();
        } catch (error) {
            setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not save reward' });
        } finally {
            setBusyAction(null);
        }
    };

    const startEditing = (item: StoreItem) => {
        setDraftTitle(item.title);
        setDraftCategory(asCategory(item.category));
        setDraftIcon(item.icon || '🎁');
        setPriceMode(item.user_cost_override ? 'custom' : 'adaptive');
        setDraftCost(item.user_cost_override ? String(item.cost) : '');
        setEditingId(item.id);
        setNotice(null);
        setPendingConfirmation(null);
        redemptionKeyRef.current = null;
        document.getElementById('reward-builder')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        requestAnimationFrame(() => nameInputRef.current?.focus());
    };

    const beginRedemption = (item: StoreItem) => {
        redemptionKeyRef.current = { rewardId: item.id, key: createRedemptionKey() };
        setPendingConfirmation(`redeem-${item.id}`);
    };

    const clearPendingConfirmation = () => {
        redemptionKeyRef.current = null;
        setPendingConfirmation(null);
    };

    const redeemReward = async (item: StoreItem) => {
        setBusyAction(`redeem-${item.id}`);
        setNotice(null);
        const idempotencyKey = redemptionKeyRef.current?.rewardId === item.id
            ? redemptionKeyRef.current.key
            : createRedemptionKey();
        redemptionKeyRef.current = { rewardId: item.id, key: idempotencyKey };
        try {
            const res = await fetch('/api/gamification', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reward_id: item.id, idempotency_key: idempotencyKey }),
            });
            const data = await readResponse(res);
            if (!res.ok) throw new Error(data.error || 'Could not redeem reward');
            setNotice({ tone: 'success', message: `${item.icon} ${item.title} redeemed. Enjoy it—you earned it.` });
            setPendingConfirmation(null);
            redemptionKeyRef.current = null;
            await fetchGamificationData();
        } catch (error) {
            setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not redeem reward' });
        } finally {
            setBusyAction(null);
        }
    };

    const deleteReward = async (item: StoreItem) => {
        setBusyAction(`delete-${item.id}`);
        setNotice(null);
        try {
            const res = await fetch(`/api/gamification?id=${item.id}`, { method: 'DELETE' });
            const data = await readResponse(res);
            if (!res.ok) throw new Error(data.error || 'Could not delete reward');
            if (editingId === item.id) resetForm();
            setNotice({ tone: 'success', message: `${item.title} was removed.` });
            setPendingConfirmation(null);
            redemptionKeyRef.current = null;
            await fetchGamificationData();
        } catch (error) {
            setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not delete reward' });
        } finally {
            setBusyAction(null);
        }
    };

    if (loading) {
        return (
            <div className="max-w-6xl mx-auto space-y-5 animate-pulse" role="status" aria-label="Loading rewards">
                <div className="h-24 rounded-3xl bg-[#1a1a2e]" />
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                    <div className="lg:col-span-2 h-96 rounded-3xl bg-[#1a1a2e]" />
                    <div className="h-96 rounded-3xl bg-[#1a1a2e]" />
                </div>
            </div>
        );
    }

    const customRewards = store.filter(item => item.is_custom === 1);
    const builtInRewards = store.filter(item => item.is_custom !== 1);
    const affordableCount = store.filter(item => balance >= item.cost).length;
    const unlockedBadges = badges.filter(badge => badge.unlocked_at);
    const lockedBadges = badges.filter(badge => !badge.unlocked_at);

    const renderRewardCard = (item: StoreItem) => {
        const category = asCategory(item.category);
        const canAfford = balance >= item.cost;
        const redeemKey = `redeem-${item.id}`;
        const deleteKey = `delete-${item.id}`;
        const isRedeemConfirmation = pendingConfirmation === redeemKey;
        const isDeleteConfirmation = pendingConfirmation === deleteKey;
        const isBusy = busyAction === redeemKey || busyAction === deleteKey;

        return (
            <article
                key={item.id}
                data-testid={`reward-card-${item.id}`}
                className="group rounded-2xl border p-4 transition-all hover:-translate-y-0.5"
                style={{ background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.09)' }}
            >
                <div className="flex items-start gap-3">
                    <div
                        className="h-12 w-12 shrink-0 rounded-2xl flex items-center justify-center text-2xl"
                        style={{ background: `${CATEGORY_ACCENT[category]}18`, border: `1px solid ${CATEGORY_ACCENT[category]}35` }}
                    >
                        {item.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                            <h3 className="font-bold leading-snug" style={{ color: 'var(--text-primary)' }}>{item.title}</h3>
                            {item.is_custom === 1 && (
                                <span className="shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--accent-orange)', background: 'rgba(249,115,22,0.12)' }}>
                                    Yours
                                </span>
                            )}
                        </div>
                        <p className="mt-1 text-xs font-semibold" style={{ color: CATEGORY_ACCENT[category] }}>
                            {CATEGORY_LABEL[category]}
                        </p>
                    </div>
                </div>

                <div className="mt-4 flex items-end justify-between gap-3">
                    <div>
                        <p className="text-2xl font-black tabular-nums">{item.cost.toLocaleString()}</p>
                        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            coins · {item.user_cost_override ? 'fixed by you' : 'adaptive price'}
                        </p>
                    </div>
                    {!isRedeemConfirmation && !isDeleteConfirmation && (
                        <button
                            type="button"
                            className="btn btn-primary"
                            style={{ background: canAfford ? 'var(--gradient-fire)' : 'var(--bg-secondary)', opacity: canAfford ? 1 : 0.65 }}
                            disabled={!canAfford || isBusy}
                            onClick={() => beginRedemption(item)}
                            aria-label={canAfford ? `Redeem ${item.title}` : `${item.cost - balance} more coins needed for ${item.title}`}
                        >
                            {canAfford ? 'Redeem' : `${(item.cost - balance).toLocaleString()} short`}
                        </button>
                    )}
                </div>

                {isRedeemConfirmation && (
                    <div className="mt-4 rounded-xl p-3" style={{ background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.25)' }}>
                        <p className="text-sm font-semibold">Spend {item.cost.toLocaleString()} coins?</p>
                        <div className="mt-2 flex gap-2">
                            <button type="button" className="btn btn-sm btn-primary" onClick={() => void redeemReward(item)} disabled={isBusy}>
                                {isBusy ? 'Redeeming…' : 'Yes, redeem'}
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={clearPendingConfirmation} disabled={isBusy}>Cancel</button>
                        </div>
                    </div>
                )}

                {isDeleteConfirmation && (
                    <div className="mt-4 rounded-xl p-3" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)' }}>
                        <p className="text-sm font-semibold">Remove this reward? Your coin history stays intact.</p>
                        <div className="mt-2 flex gap-2">
                            <button type="button" className="btn btn-sm" style={{ background: 'var(--accent-red)', color: 'white' }} onClick={() => void deleteReward(item)} disabled={isBusy}>
                                {isBusy ? 'Removing…' : 'Remove'}
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={clearPendingConfirmation} disabled={isBusy}>Cancel</button>
                        </div>
                    </div>
                )}

                {item.is_custom === 1 && !isRedeemConfirmation && !isDeleteConfirmation && (
                    <div className="mt-4 flex gap-3 border-t pt-3 text-xs" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                        <button type="button" className="font-semibold hover:underline" style={{ color: 'var(--text-secondary)' }} onClick={() => startEditing(item)}>Edit reward</button>
                        <button type="button" className="font-semibold hover:underline" style={{ color: 'var(--accent-red)' }} onClick={() => {
                            redemptionKeyRef.current = null;
                            setPendingConfirmation(deleteKey);
                        }}>Remove</button>
                    </div>
                )}
            </article>
        );
    };

    return (
        <div className="max-w-6xl mx-auto pb-16" data-testid="rewards-page">
            <header
                className="relative overflow-hidden rounded-3xl border px-5 py-6 sm:px-7 sm:py-8"
                style={{ background: 'linear-gradient(135deg, rgba(249,115,22,0.18), rgba(168,85,247,0.12) 55%, rgba(59,130,246,0.08))', borderColor: 'rgba(249,115,22,0.24)' }}
            >
                <div className="relative flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
                    <div className="max-w-2xl">
                        <p className="mb-2 text-xs font-black uppercase tracking-[0.22em]" style={{ color: 'var(--accent-orange)' }}>Your reward economy</p>
                        <h1 className="text-3xl sm:text-4xl font-black tracking-tight">Make progress feel worth it.</h1>
                        <p className="mt-3 text-sm sm:text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            Create rewards you genuinely want, earn coins through LifeOS, and redeem them without guilt.
                        </p>
                    </div>
                    <div className="rounded-2xl px-5 py-4 sm:min-w-56" style={{ background: 'rgba(10,10,15,0.58)', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Available balance</p>
                        <p className="mt-1 text-4xl font-black tabular-nums">{balance.toLocaleString()} <span className="text-base font-bold" style={{ color: 'var(--accent-orange)' }}>coins</span></p>
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{affordableCount} reward{affordableCount === 1 ? '' : 's'} within reach</p>
                    </div>
                </div>
            </header>

            {loadError && (
                <div className="mt-4 flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between" role="alert" style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.09)', borderColor: 'rgba(239,68,68,0.22)' }}>
                    <div>
                        <p className="font-bold">Rewards could not be refreshed.</p>
                        <p className="mt-1 text-xs font-medium">{loadError}</p>
                    </div>
                    <button type="button" className="btn btn-sm shrink-0" onClick={() => void fetchGamificationData(true)}>Try again</button>
                </div>
            )}

            {notice && (
                <div
                    className="fixed bottom-4 left-4 right-4 z-40 flex items-start justify-between gap-4 rounded-xl border px-4 py-3 text-sm font-semibold shadow-2xl sm:left-auto sm:max-w-md"
                    role={notice.tone === 'error' ? 'alert' : 'status'}
                    aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
                    style={{
                        color: notice.tone === 'success' ? 'var(--accent-green)' : '#fca5a5',
                        background: notice.tone === 'success' ? '#10251c' : '#291519',
                        borderColor: notice.tone === 'success' ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
                    }}
                >
                    <span>{notice.message}</span>
                    <button type="button" className="shrink-0 text-lg leading-none opacity-70 hover:opacity-100" onClick={() => setNotice(null)} aria-label="Dismiss message">×</button>
                </div>
            )}

            {rewardPolicy && (
                <section className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="card" style={{ padding: '1rem' }}>
                        <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Today’s mode</p>
                        <p className="mt-1 font-bold">{MODE_LABEL[rewardPolicy.mode]}</p>
                        <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>{rewardPolicy.energy} energy · {rewardPolicy.focusTrend} focus</p>
                    </div>
                    <div className="card" style={{ padding: '1rem' }}>
                        <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Earning boost</p>
                        <p className="mt-1 font-bold" style={{ color: 'var(--accent-green)' }}>{rewardPolicy.coinMultiplier.toFixed(2)}× coins</p>
                        <p className="mt-1 text-xs line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{rewardPolicy.earningGuidance}</p>
                    </div>
                    <div className="card" style={{ padding: '1rem' }}>
                        <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Spending cue</p>
                        <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{rewardPolicy.spendingGuidance}</p>
                    </div>
                </section>
            )}

            <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
                <div className="space-y-7">
                    <section>
                        <div className="mb-4 flex items-end justify-between gap-4">
                            <div>
                                <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-orange)' }}>Your shelf</p>
                                <h2 className="mt-1 text-2xl font-black">Custom rewards</h2>
                            </div>
                            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{customRewards.length} saved</span>
                        </div>
                        {customRewards.length > 0 ? (
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{customRewards.map(renderRewardCard)}</div>
                        ) : (
                            <div className="rounded-2xl border border-dashed p-8 text-center" style={{ borderColor: 'rgba(249,115,22,0.35)', background: 'rgba(249,115,22,0.045)' }}>
                                <div className="text-4xl">✨</div>
                                <h3 className="mt-3 font-bold">Make the first reward yours</h3>
                                <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--text-secondary)' }}>Choose something concrete you’ll enjoy after making progress. The builder is ready beside this list.</p>
                            </div>
                        )}
                    </section>

                    <section>
                        <div className="mb-4">
                            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-purple)' }}>Quick ideas</p>
                            <h2 className="mt-1 text-2xl font-black">LifeOS rewards</h2>
                        </div>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{builtInRewards.map(renderRewardCard)}</div>
                    </section>
                </div>

                <aside className="space-y-6">
                    <section id="reward-builder" className="card scroll-mt-6" style={{ padding: '1.35rem', borderColor: editingId ? 'rgba(96,165,250,0.45)' : 'rgba(249,115,22,0.32)' }}>
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-xs font-bold uppercase tracking-wider" style={{ color: editingId ? 'var(--accent-blue)' : 'var(--accent-orange)' }}>{editingId ? 'Editing' : 'Create your own'}</p>
                                <h2 className="mt-1 text-xl font-black">{editingId ? 'Update reward' : 'New reward'}</h2>
                            </div>
                            {editingId && <button type="button" className="btn btn-sm btn-ghost" onClick={resetForm}>Cancel</button>}
                        </div>

                        <form className="mt-5 space-y-5" onSubmit={handleSubmit} noValidate>
                            <div>
                                <label htmlFor="reward-name" className="mb-2 block text-sm font-bold">What do you want to earn?</label>
                                <input
                                    ref={nameInputRef}
                                    id="reward-name"
                                    name="reward-name"
                                    type="text"
                                    autoComplete="off"
                                    maxLength={120}
                                    placeholder={rewardNamePlaceholder(rewardPolicy)}
                                    className="input"
                                    value={draftTitle}
                                    onChange={event => setDraftTitle(event.target.value)}
                                    data-testid="reward-name-input"
                                />
                                <div className="mt-1.5 flex justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    <span>Be specific enough that redemption feels real.</span>
                                    <span>{draftTitle.length}/120</span>
                                </div>
                            </div>

                            <fieldset>
                                <legend className="mb-2 text-sm font-bold">Choose an icon</legend>
                                <div className="grid grid-cols-6 gap-2">
                                    {REWARD_ICONS.map(icon => (
                                        <button
                                            key={icon}
                                            type="button"
                                            aria-label={`Use ${icon} icon`}
                                            aria-pressed={draftIcon === icon}
                                            onClick={() => setDraftIcon(icon)}
                                            className="aspect-square rounded-xl text-xl transition-transform hover:scale-105"
                                            style={{ background: draftIcon === icon ? 'rgba(249,115,22,0.18)' : 'var(--bg-secondary)', border: draftIcon === icon ? '1px solid var(--accent-orange)' : '1px solid var(--border)' }}
                                        >
                                            {icon}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>

                            <div>
                                <label htmlFor="reward-category" className="mb-2 block text-sm font-bold">Category</label>
                                <select id="reward-category" className="input" value={draftCategory} onChange={event => setDraftCategory(event.target.value as RewardCategory)}>
                                    {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                </select>
                            </div>

                            <fieldset>
                                <legend className="mb-2 text-sm font-bold">How should it be priced?</legend>
                                <div className="grid grid-cols-2 gap-2 rounded-xl p-1" style={{ background: 'var(--bg-secondary)' }}>
                                    <button
                                        type="button"
                                        aria-pressed={priceMode === 'adaptive'}
                                        onClick={() => setPriceMode('adaptive')}
                                        className="rounded-lg px-3 py-2.5 text-sm font-bold"
                                        style={{ background: priceMode === 'adaptive' ? 'var(--bg-card-hover)' : 'transparent', color: priceMode === 'adaptive' ? 'var(--text-primary)' : 'var(--text-muted)' }}
                                    >
                                        Adaptive
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={priceMode === 'custom'}
                                        onClick={() => setPriceMode('custom')}
                                        className="rounded-lg px-3 py-2.5 text-sm font-bold"
                                        style={{ background: priceMode === 'custom' ? 'var(--bg-card-hover)' : 'transparent', color: priceMode === 'custom' ? 'var(--text-primary)' : 'var(--text-muted)' }}
                                    >
                                        Set it myself
                                    </button>
                                </div>
                            </fieldset>

                            {priceMode === 'custom' && (
                                <div>
                                    <label htmlFor="reward-cost" className="mb-2 block text-sm font-bold">Price in coins</label>
                                    <input
                                        id="reward-cost"
                                        name="reward-cost"
                                        type="number"
                                        inputMode="numeric"
                                        min="1"
                                        max={MAX_REWARD_COST}
                                        step="1"
                                        placeholder="500"
                                        className="input"
                                        value={draftCost}
                                        onChange={event => setDraftCost(event.target.value)}
                                        aria-invalid={Boolean(priceError)}
                                        aria-describedby={priceError ? 'reward-cost-error' : undefined}
                                        data-testid="reward-cost-input"
                                    />
                                    {priceError && <p id="reward-cost-error" className="mt-2 text-xs font-semibold" style={{ color: '#fca5a5' }}>{priceError}</p>}
                                </div>
                            )}

                            <div className="rounded-2xl p-4" style={{ background: `${CATEGORY_ACCENT[rewardPricePreview.category]}10`, border: `1px solid ${CATEGORY_ACCENT[rewardPricePreview.category]}30` }}>
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Reward preview</p>
                                        <p className="mt-1 font-bold">{draftIcon} {draftTitle.trim() || 'Your reward'}</p>
                                    </div>
                                    <p className="shrink-0 text-xl font-black tabular-nums" style={{ color: CATEGORY_ACCENT[rewardPricePreview.category] }}>{rewardPricePreview.cost.toLocaleString()}c</p>
                                </div>
                                <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{rewardPricePreview.reason}</p>
                            </div>

                            <button
                                type="submit"
                                className="btn btn-primary w-full justify-center"
                                style={{ background: editingId ? 'var(--gradient-primary)' : 'var(--gradient-fire)' }}
                                disabled={busyAction === 'create' || busyAction === `edit-${editingId}`}
                                data-testid="save-reward-button"
                            >
                                {busyAction === 'create' || busyAction === `edit-${editingId}` ? 'Saving…' : editingId ? 'Save changes' : 'Add to my rewards'}
                            </button>
                        </form>
                    </section>

                    <section className="card" style={{ padding: '1.25rem' }}>
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-black">Recent activity</h2>
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{transactions.length} entries</span>
                        </div>
                        <div className="mt-3 max-h-[360px] space-y-1 overflow-y-auto pr-1">
                            {transactions.map(transaction => (
                                <div key={transaction.id} className="flex items-center justify-between gap-3 border-b py-3 last:border-0" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold">
                                            {transaction.redemption_id ? `${transaction.reward_icon ?? '🎁'} ${transaction.reward_title ?? 'Reward redeemed'}` : transaction.reason}
                                        </p>
                                        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                            {formatTransactionDate(transaction.created_at)}{transaction.reward_cost ? ` · ${transaction.reward_cost.toLocaleString()} coins` : ''}
                                        </p>
                                    </div>
                                    <span className="shrink-0 font-black tabular-nums" style={{ color: transaction.amount >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                                        {transaction.amount > 0 ? '+' : ''}{transaction.amount}
                                    </span>
                                </div>
                            ))}
                            {transactions.length === 0 && <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Your earned and redeemed coins will appear here.</p>}
                        </div>
                    </section>
                </aside>
            </div>

            <section className="mt-9">
                <div className="mb-4 flex items-end justify-between gap-4">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-green)' }}>Milestones</p>
                        <h2 className="mt-1 text-2xl font-black">Trophy vault</h2>
                    </div>
                    <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{unlockedBadges.length}/{badges.length} unlocked</span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {unlockedBadges.map(badge => (
                        <article key={badge.id} className="card text-center" style={{ padding: '1rem', borderColor: 'rgba(34,197,94,0.35)' }}>
                            <div className="text-3xl">{badge.icon}</div>
                            <h3 className="mt-2 text-sm font-bold">{badge.name}</h3>
                            <p className="mt-1 text-[11px] line-clamp-2" style={{ color: 'var(--text-muted)' }}>{badge.description}</p>
                            <p className="mt-2 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--accent-green)' }}>Unlocked</p>
                        </article>
                    ))}
                    {lockedBadges.map(badge => (
                        <article key={badge.id} className="card text-center" style={{ padding: '1rem', opacity: 0.78 }}>
                            <div className="text-3xl grayscale">{badge.icon}</div>
                            <h3 className="mt-2 text-sm font-bold">{badge.name}</h3>
                            <p className="mt-1 text-[11px] line-clamp-2" style={{ color: 'var(--text-muted)' }}>{badge.description}</p>
                            <p className="mt-3 text-[11px] font-bold">{badge.adaptive_current_value ?? 0}/{badge.adaptive_unlock_target ?? badge.target} {badge.metric.replace('_', ' ')}</p>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                <div className="h-full rounded-full" style={{ width: `${badge.adaptive_progress ?? 0}%`, background: badge.adaptive_moment_fit ? FIT_COLOR[badge.adaptive_moment_fit] : 'var(--accent-orange)' }} />
                            </div>
                            {badge.adaptive_next_step && <p className="mt-2 text-[10px] line-clamp-2" style={{ color: 'var(--text-muted)' }}>{badge.adaptive_next_step}</p>}
                        </article>
                    ))}
                </div>
            </section>
        </div>
    );
}
