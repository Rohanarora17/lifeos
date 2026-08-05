import { GuardianPolicyBundle, GuardianState } from './guardian-types';
import type { CanonicalScoringInterval } from './session-activity';

export type Trend = 'rising' | 'stable' | 'falling';

function isContinuityEvent(event: { type: string }) {
    return event.type === 'tab' || event.type === 'native_context';
}

function nativeClassification(category?: unknown) {
    if (category === 'distraction') return 'distraction';
    if (category === 'deep_work' || category === 'shallow_work' || category === 'communication') return 'on_topic';
    return 'unknown';
}

function eventClassification(event: { url?: string; payload?: Record<string, unknown> }) {
    const payloadClassification = event.payload?.classification;
    if (payloadClassification === 'on_topic' || payloadClassification === 'distraction') return payloadClassification;
    return nativeClassification(event.payload?.category);
}

function eventAttentionCategory(event: { payload?: Record<string, unknown> }) {
    const attention = event.payload?.attentionCategory;
    return typeof attention === 'string' ? attention : null;
}

function eventDomainKey(event: { url?: string; domain?: string; payload?: Record<string, unknown> }) {
    if (event.domain) return event.domain;
    if (typeof event.payload?.appInFocus === 'string' && event.payload.appInFocus.trim()) {
        return `native:${event.payload.appInFocus.trim().toLowerCase()}`;
    }
    try {
        return new URL(event.url || '').hostname;
    } catch {
        return null;
    }
}

export function computeFocusScore(
    session: Pick<GuardianState, 'tick' | 'startedAt' | 'tabEventLog' | 'focusScoreHistory' | 'screenContext' | 'totalPausedMs'>,
    policy?: GuardianPolicyBundle,
    energyComposite?: number | null,
    canonicalIntervals?: CanonicalScoringInterval[],
) {
    if (!session || session.tick === 0) return { score: 100, trend: 'stable' as Trend };

    const elapsedMs = Math.max(1, Date.now() - session.startedAt - session.totalPausedMs);
    const elapsedMinutes = elapsedMs / 60000;

    const thresholds = policy?.thresholds;
    const weights = policy?.weights;

    let onTopicSeconds = 0;
    let distractionRevisits = 0;
    const distractionDomains = new Set<string>();
    let switches = 0;
    let idleSeconds = 0;

    const eligibleCanonical = canonicalIntervals?.filter(interval => interval.scoreEligible) ?? null;
    if (canonicalIntervals) {
        for (const interval of canonicalIntervals) {
            if (!interval.scoreEligible || interval.state === 'idle' || interval.state === 'locked') {
                idleSeconds += interval.durationSeconds;
                continue;
            }
            switches += 1;
            if (interval.category === 'productive') onTopicSeconds += interval.durationSeconds;
            if (interval.category === 'distraction') {
                if (interval.domain && distractionDomains.has(interval.domain)) distractionRevisits += 1;
                if (interval.domain) distractionDomains.add(interval.domain);
            }
        }
    } else {
        session.tabEventLog.forEach((event) => {
            if (event.type === 'idle' && event.idleSeconds) {
                idleSeconds += event.idleSeconds;
                return;
            }
            if (!isContinuityEvent(event)) return;
            switches++;
            const payloadClassification = eventClassification(event);
            const payloadAttentionCategory = eventAttentionCategory(event);
            const isDistraction =
                payloadClassification === 'distraction' || payloadAttentionCategory === 'blocked_distractor';
            const isProductive =
                payloadClassification === 'on_topic' || payloadAttentionCategory === 'productive_support' || payloadAttentionCategory === 'temporary_override';

            if (isProductive && event.dwellSeconds) onTopicSeconds += event.dwellSeconds;
            if (isDistraction) {
                const domain = eventDomainKey(event);
                if (domain && distractionDomains.has(domain)) distractionRevisits++;
                if (domain) distractionDomains.add(domain);
            }
        });
    }

    const verifiedActiveSeconds = eligibleCanonical
        ? eligibleCanonical.reduce((sum, interval) => sum + interval.durationSeconds, 0)
        : elapsedMs / 1000;
    const tabContinuityScore = Math.min(100, (onTopicSeconds / Math.max(1, verifiedActiveSeconds)) * 100);

    // Vision blending: when screen observations are available, blend vision task alignment
    // with tab-based continuity. Vision is evidence-based (sees actual content); tabs are
    // inference-based (URL classification). More observations → trust vision more.
    const screenCtx = session.screenContext;
    const canonicalVisionAssessments = eligibleCanonical?.flatMap(interval => {
        const assessment = interval.evidence.visionAssessment;
        return assessment && typeof assessment === 'object' ? [assessment as Record<string, unknown>] : [];
    }) ?? [];
    const visionObsCount = canonicalIntervals ? canonicalVisionAssessments.length : (screenCtx?.recentObservations.length ?? 0);
    let continuityScore = tabContinuityScore;
    const latestContinuitySource = canonicalIntervals
        ? eligibleCanonical?.at(-1)?.source
        : [...session.tabEventLog].reverse().find(isContinuityEvent)?.payload?.captureSource;
    const canonicalVisionAlignment = canonicalVisionAssessments.length > 0
        ? canonicalVisionAssessments.reduce((sum, item) => sum + Number(item.taskAlignment || 0), 0) / canonicalVisionAssessments.length
        : null;
    const visionAlignment = canonicalIntervals ? canonicalVisionAlignment : (screenCtx?.taskAlignmentAvg ?? null);
    if (visionAlignment !== null && visionObsCount >= 1 && latestContinuitySource === 'vision') {
        // Weight: ramp from 30% vision at 1 obs → 60% vision at 5+ obs
        const visionWeight = Math.min(0.6, 0.3 + (visionObsCount - 1) * 0.075);
        continuityScore = Math.min(100,
            visionAlignment * visionWeight + tabContinuityScore * (1 - visionWeight)
        );
    }

    const scatterThreshold = thresholds?.highScatterSpeakThreshold ?? 6;
    const switchesPerMin = switches / Math.max(1, elapsedMinutes);
    let switchScore = Math.max(0, 100 - (switchesPerMin / scatterThreshold) * 100);

    // Vision-aware switch adjustment: if vision shows active_learning engagement,
    // the user may be productively comparing tabs (research mode) — reduce penalty.
    const engagementDepth = canonicalIntervals
        ? String(canonicalVisionAssessments.at(-1)?.engagementDepth || '')
        : screenCtx?.engagementDepth;
    if (engagementDepth === 'active_learning' && switchesPerMin > 2) {
        switchScore = Math.min(100, switchScore * 1.25);
    }

    const dwellTarget = thresholds?.dwellDepthTargetSeconds ?? 180;
    const tabsWithDwell = eligibleCanonical ?? session.tabEventLog.filter(
        (e) => isContinuityEvent(e) && typeof e.dwellSeconds === 'number'
    );
    const totalDwellSeconds = tabsWithDwell.reduce(
        (sum, item) => sum + ('durationSeconds' in item ? item.durationSeconds : (item.dwellSeconds || 0)),
        0,
    );
    const avgDwell = tabsWithDwell.length > 0 ? totalDwellSeconds / tabsWithDwell.length : 0;
    let dwellScore = Math.min(100, (avgDwell / dwellTarget) * 100);

    // Vision-aware dwell boost: active_creation (coding, writing) often shows sustained
    // engagement without many tab switches — give it a modest dwell credit.
    if (engagementDepth === 'active_creation') {
        dwellScore = Math.min(100, dwellScore * 1.15);
    }

    const distractPenalty = distractionRevisits * 8;

    const idleConcernSec = thresholds?.idleConcernSeconds ?? 480;
    const idleConcernMinutes = idleConcernSec / 60;
    const idleMinutes = idleSeconds / 60;
    const idlePenaltyRaw = (idleMinutes / idleConcernMinutes) * 30;
    const idlePenalty = Math.min(30, idlePenaltyRaw);

    // Fatigue curve (Yerkes-Dodson): on low-energy days, be more forgiving
    let idleMultiplier = 1.0;
    let distractionMultiplier = 1.0;
    if (energyComposite != null) {
        if (energyComposite < 35) {
            idleMultiplier = 0.5;
            distractionMultiplier = 0.7;
        } else if (energyComposite >= 85) {
            idleMultiplier = 1.3;
        }
    }

    const rawScore =
        (continuityScore * (weights?.continuity ?? 0.35)) +
        (switchScore * (weights?.switches ?? 0.25)) +
        (dwellScore * (weights?.dwell ?? 0.20)) -
        (distractPenalty * distractionMultiplier * (weights?.distractionPenalty ?? 0.15)) -
        (idlePenalty * idleMultiplier * (weights?.idlePenalty ?? 0.05));

    const score = Math.max(0, Math.min(100, Math.round(rawScore)));

    let trend: Trend = 'stable';
    const history = session.focusScoreHistory;
    if (history.length >= 3) {
        const recent = history.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, history.length);
        if (score > recent + 5) trend = 'rising';
        else if (score < recent - 5) trend = 'falling';
    }

    return {
        score,
        components: { continuityScore, switchScore, dwellScore, visionAlignment },
        trend,
        onTopicSeconds,
        distractionCount: distractionRevisits,
    };
}

export function buildReadout(score: number, trend: Trend): string {
    const arrows = { rising: "↑", stable: "→", falling: "↓" };
    return `Focus: ${score} ${arrows[trend]}`;
}
