'use client';

import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const isExtension = pathname?.startsWith('/extension');

    if (isExtension) {
        // Strip out the global sidebar and padding for the narrow Chrome Extension view
        return (
            <div className="min-h-screen bg-[#0a0a0c] text-white">
                <main className="p-4 h-full overflow-y-auto w-full">
                    {children}
                </main>
            </div>
        );
    }

    // Default LifeOS View
    return (
        <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 ml-[260px] p-6 overflow-auto">
                {children}
            </main>
        </div>
    );
}
