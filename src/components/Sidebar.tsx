'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const navItems = [
    { href: '/', label: 'Dashboard', icon: '🏠' },
    { href: '/activity', label: 'Activity', icon: '📊' },
    { href: '/tasks', label: 'Tasks', icon: '📋' },
    { href: '/habits', label: 'Habits', icon: '🔥' },
    { href: '/goals', label: 'Goals', icon: '🎯' },
    { href: '/study-plan', label: 'Study Plans', icon: '📚' },
    { href: '/guardian', label: 'Guardian', icon: '🛡️' },
    { href: '/focus-sessions', label: 'Focus Sessions', icon: '⏱️' },
    { href: '/chat', label: 'Jarvis', icon: '💬' },
    { href: '/store', label: 'Store & Badges', icon: '💎' },
    { href: '/analytics', label: 'Analytics', icon: '📈' },
    { href: '/calendar', label: 'Calendar', icon: '📅' },
    { href: '/insights', label: 'AI Insights', icon: '🧠' },
    { href: '/knowledge-graph', label: 'Knowledge Graph', icon: '🕸️' },
    { href: '/memory', label: 'Memory', icon: '🧬' },
    { href: '/settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar() {
    const pathname = usePathname();
    const [level, setLevel] = useState<number | null>(null);

    useEffect(() => {
        fetch('/api/user/level')
            .then(res => res.json())
            .then(data => {
                if (data && typeof data.level === 'number') {
                    setLevel(data.level);
                }
            })
            .catch(err => console.error('Failed to fetch level:', err));
    }, []);

    return (
        <aside className="fixed left-0 top-0 bottom-0 w-[260px] flex flex-col border-r"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
            {/* Logo */}
            <div className="p-6 pb-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                        style={{ background: 'var(--gradient-primary)' }}>
                        ⚡
                    </div>
                    <div>
                        <h1 className="text-lg font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>LifeOS</h1>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Personal Productivity OS</p>
                    </div>
                </div>
            </div>

            {/* Nav */}
            <nav className="flex-1 px-3 py-2 flex flex-col gap-1">
                {navItems.map(item => (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={`nav-link ${pathname === item.href ? 'active' : ''}`}
                    >
                        <span className="text-lg">{item.icon}</span>
                        <span>{item.label}</span>
                    </Link>
                ))}
            </nav>

            {/* Footer */}
            <div className="p-4 border-t" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                        style={{ background: 'var(--gradient-primary)' }}>
                        R
                    </div>
                    <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Rohan</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Level {level !== null ? level : '—'}</p>
                    </div>
                </div>
            </div>
        </aside>
    );
}
