export type FreshnessStatus = 'fresh' | 'stale' | 'missing' | 'invalid';

export interface FreshnessAssessment {
    status: FreshnessStatus;
    observedAt: string | null;
    ageSeconds: number | null;
    maxAgeSeconds: number;
}

export function assessFreshness(
    observedAt: string | number | Date | null | undefined,
    maxAgeSeconds: number,
    now = Date.now(),
): FreshnessAssessment {
    const threshold = Math.max(1, Math.floor(maxAgeSeconds));
    if (observedAt === null || observedAt === undefined || observedAt === '') {
        return {
            status: 'missing',
            observedAt: null,
            ageSeconds: null,
            maxAgeSeconds: threshold,
        };
    }

    const parsed = observedAt instanceof Date
        ? observedAt.getTime()
        : typeof observedAt === 'number'
            ? observedAt
            : Date.parse(observedAt);

    if (!Number.isFinite(parsed)) {
        return {
            status: 'invalid',
            observedAt: String(observedAt),
            ageSeconds: null,
            maxAgeSeconds: threshold,
        };
    }

    const ageSeconds = Math.max(0, Math.floor((now - parsed) / 1_000));
    return {
        status: ageSeconds <= threshold ? 'fresh' : 'stale',
        observedAt: new Date(parsed).toISOString(),
        ageSeconds,
        maxAgeSeconds: threshold,
    };
}
