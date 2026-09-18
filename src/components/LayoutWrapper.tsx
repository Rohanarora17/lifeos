'use client';

import { useCallback, useState } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import AdaptiveBandsLoader from './AdaptiveBandsLoader';
import LifeOSSyncProvider from './LifeOSSyncProvider';

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const isExtension = pathname?.startsWith('/extension');
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [, setBandsVersion] = useState(0);
    const handleBandsLoaded = useCallback(() => {
        setBandsVersion(version => version + 1);
    }, []);

    if (isExtension) {
        // Strip out the global sidebar and padding for the narrow Chrome Extension view
        return (
            <div className="min-h-screen bg-[#0a0a0c] text-white">
                <LifeOSSyncProvider />
                <AdaptiveBandsLoader onLoaded={handleBandsLoaded} />
                <main className="p-4 h-full overflow-y-auto w-full">
                    {children}
                </main>
            </div>
        );
    }

    // Default LifeOS View
    return (
        <div className="min-h-screen">
            <LifeOSSyncProvider />
            <AdaptiveBandsLoader onLoaded={handleBandsLoaded} />
            <button
                type="button"
                className="fixed left-4 top-4 z-40 flex h-11 w-11 items-center justify-center rounded-xl border text-xl shadow-lg lg:hidden"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                onClick={() => setIsSidebarOpen(true)}
                aria-controls="lifeos-sidebar"
                aria-expanded={isSidebarOpen}
                aria-label="Open navigation"
            >
                ☰
            </button>
            {isSidebarOpen && (
                <button
                    type="button"
                    className="fixed inset-0 z-40 bg-black/65 lg:hidden"
                    onClick={() => setIsSidebarOpen(false)}
                    aria-label="Close navigation"
                />
            )}
            <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
            <main className="min-w-0 px-4 pb-6 pt-20 sm:px-6 lg:ml-[260px] lg:pt-6">
                {children}
            </main>
        </div>
    );
}
