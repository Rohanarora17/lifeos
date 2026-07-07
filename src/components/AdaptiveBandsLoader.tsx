'use client';

import { useEffect } from 'react';
import { setClientBands } from '@/lib/score-classify';
import type { AdaptiveBands } from '@/lib/adaptive-bands';

interface BandsResponse {
    bands?: AdaptiveBands;
}

interface AdaptiveBandsLoaderProps {
    onLoaded?: () => void;
}

const REFRESH_MS = 15 * 60 * 1000;

export default function AdaptiveBandsLoader({ onLoaded }: AdaptiveBandsLoaderProps) {
    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        let lastPayload = '';

        const loadBands = async () => {
            try {
                const res = await fetch('/api/personalization/bands', { cache: 'no-store' });
                if (!res.ok) return;
                const data = await res.json() as BandsResponse;
                if (!cancelled && data.bands) {
                    const nextPayload = JSON.stringify(data.bands);
                    if (nextPayload === lastPayload) return;
                    lastPayload = nextPayload;
                    setClientBands(data.bands);
                    onLoaded?.();
                }
            } catch (error) {
                console.warn('Failed to load adaptive score bands', error);
            }
        };

        void loadBands();
        timer = setInterval(loadBands, REFRESH_MS);

        const onVisible = () => {
            if (document.visibilityState === 'visible') void loadBands();
        };
        document.addEventListener('visibilitychange', onVisible);

        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [onLoaded]);

    return null;
}
