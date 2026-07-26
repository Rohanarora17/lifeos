interface RateLimitOptions {
    limit: number;
    windowMs: number;
    now?: number;
    maxEntries?: number;
}

interface RateLimitBucket {
    count: number;
    resetAt: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
    resetAt: number;
}

const buckets = new Map<string, RateLimitBucket>();

function pruneBuckets(now: number, maxEntries: number) {
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }

    while (buckets.size >= maxEntries) {
        const oldestKey = buckets.keys().next().value;
        if (!oldestKey) break;
        buckets.delete(oldestKey);
    }
}

export function consumeRateLimit(
    key: string,
    options: RateLimitOptions,
): RateLimitResult {
    const now = options.now ?? Date.now();
    const limit = Math.max(1, Math.floor(options.limit));
    const windowMs = Math.max(1_000, Math.floor(options.windowMs));
    const maxEntries = Math.max(100, options.maxEntries ?? 10_000);

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        pruneBuckets(now, maxEntries);
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, limit - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));

    return {
        allowed: bucket.count <= limit,
        remaining,
        retryAfterSeconds,
        resetAt: bucket.resetAt,
    };
}

export function resetRateLimitsForTests() {
    buckets.clear();
}
