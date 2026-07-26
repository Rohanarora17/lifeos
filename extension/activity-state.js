(function exposeActivityState(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.LifeOSActivityState = api;
}(typeof self !== 'undefined' ? self : globalThis, function createActivityState() {
    const RELEVANCE_THRESHOLD = 0.85;

    function isWithinWakingHours(date, wakeHour = 7, sleepHour = 1) {
        const hour = date.getHours();
        if (wakeHour === sleepHour) return true;
        if (wakeHour < sleepHour) return hour >= wakeHour && hour < sleepHour;
        return hour >= wakeHour || hour < sleepHour;
    }

    function sameContext(left, right) {
        if (!left || !right) return false;
        return left.state === right.state
            && left.tabId === right.tabId
            && left.url === right.url
            && left.windowId === right.windowId
            && left.sessionId === right.sessionId;
    }

    function transitionInterval(current, nextContext, now) {
        if (current && sameContext(current, nextContext)) {
            return {
                closed: null,
                current: { ...current, lastObservedAt: now },
            };
        }

        const closed = current && now > current.startedAt
            ? { ...current, endedAt: now }
            : null;
        const next = nextContext
            ? {
                ...nextContext,
                startedAt: now,
                lastObservedAt: now,
            }
            : null;
        return { closed, current: next };
    }

    function recoverPersistedInterval(current, now, maxUnobservedMs = 90_000) {
        if (!current) return { closed: null, current: null };
        const lastObservedAt = Number(current.lastObservedAt || current.startedAt);
        const gap = Math.max(0, now - lastObservedAt);
        if (gap <= maxUnobservedMs) {
            return {
                closed: null,
                current: { ...current, lastObservedAt: now },
            };
        }

        return {
            closed: {
                ...current,
                endedAt: lastObservedAt,
                recoveryReason: 'worker_gap',
            },
            current: null,
        };
    }

    function shouldGroupTab({
        currentGroupId,
        openerGroupId,
        sessionGroupId,
        openedByGuardian = false,
        relevanceConfidence = null,
    }) {
        if (currentGroupId !== -1 && currentGroupId !== null && currentGroupId !== undefined) {
            return false;
        }
        if (openedByGuardian) return true;
        if (
            sessionGroupId !== null
            && sessionGroupId !== undefined
            && openerGroupId === sessionGroupId
        ) {
            return true;
        }
        return typeof relevanceConfidence === 'number'
            && relevanceConfidence >= RELEVANCE_THRESHOLD;
    }

    return {
        RELEVANCE_THRESHOLD,
        isWithinWakingHours,
        recoverPersistedInterval,
        shouldGroupTab,
        transitionInterval,
    };
}));
