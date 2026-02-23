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
}

interface Badge {
    id: number;
    name: string;
    description: string;
    icon: string;
    metric: string;
    target: number;
    unlocked_at: string | null;
}

export default function StorePage() {
    const [balance, setBalance] = useState(0);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [store, setStore] = useState<StoreItem[]>([]);
    const [badges, setBadges] = useState<Badge[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchGamificationData();
    }, []);

    const fetchGamificationData = async () => {
        try {
            const res = await fetch('/api/gamification');
            if (res.ok) {
                const data = await res.json();
                setBalance(data.balance);
                setTransactions(data.transactions);
                setStore(data.store);
                setBadges(data.badges);
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

    return (
        <div className="max-w-5xl mx-auto space-y-8 pb-12">
            {/* Header & Balance */}
            <header className="flex items-end justify-between">
                <div>
                    <h1 className="text-3xl font-black tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>
                        Store & Badges
                    </h1>
                    <p style={{ color: 'var(--text-secondary)' }}>Spend your hard-earned Life Coins and track your achievements.</p>
                </div>
                <div className="card text-center" style={{ padding: '1rem 2rem', minWidth: '200px', background: 'var(--bg-card)', border: '2px solid var(--accent-orange)' }}>
                    <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--accent-orange)' }}>Coin Balance</p>
                    <p className="text-4xl font-black mt-1" style={{ color: 'var(--text-primary)' }}>{balance.toLocaleString()}</p>
                </div>
            </header>

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
                                                Goal: {badge.target} {badge.metric.replace('_', ' ')}
                                            </div>
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
