import { GuardianPolicyBundle, GuardianState } from './guardian-types';

export type Trend = 'rising' | 'stable' | 'falling';

export function computeFocusScore(
    session: Pick<GuardianState, 'tick' | 'startedAt' | 'tabEventLog' | 'focusScoreHistory'>,
    policy?: GuardianPolicyBundle
) {
    if (!session || session.tick === 0) return { score: 100, trend: 'stable' as Trend };

    const elapsedMs = Date.now() - session.startedAt;
    const elapsedMinutes = elapsedMs / 60000;

    // 1. On-topic continuity (35%)
    let onTopicSeconds = 0;
    let distractionRevisits = 0;
    const distractionDomains = new Set<string>();
    let switches = 0;
    let idleSeconds = 0;

    session.tabEventLog.forEach((event) => {
        if (event.type === 'idle' && event.idleSeconds) {
            idleSeconds += event.idleSeconds;
            return;
        }
        switches++;
        const url = event.url || '';
        const payloadClassification = event.payload?.classification;
        const payloadAttentionCategory = event.payload?.attentionCategory;
        const isDistraction =
            payloadClassification === 'distraction' || payloadAttentionCategory === 'blocked_distractor';
        const isProductive =
            payloadClassification === 'on_topic' || payloadAttentionCategory === 'productive_support' || payloadAttentionCategory === 'temporary_override';

        if (isProductive && event.dwellSeconds) {
            onTopicSeconds += event.dwellSeconds;
        }
        if (isDistraction) {
            try {
                const domain = new URL(url).hostname;
                if (distractionDomains.has(domain)) {
                    distractionRevisits++;
                }
                distractionDomains.add(domain);
            } catch { }
        }
    });

    const continuityScore = Math.min(100, (onTopicSeconds / Math.max(1, elapsedMs / 1000)) * 100);

    // 2. Tab switch rate (25%) -> Inverse of switches/min
    const switchesPerMin = switches / Math.max(1, elapsedMinutes);
    let switchScore = 100;
    if (switchesPerMin >= 3) switchScore = 0;
    else switchScore = 100 - (switchesPerMin * 33);

    // 3. Dwell depth (20%)
    const avgDwell = switches > 0 ? (elapsedMs / 1000) / switches : 0;
    const dwellScore = Math.min(100, (avgDwell / 180) * 100);

    // 4. Distraction revisit penalty (15%)
    const distractPenalty = distractionRevisits * 8;

    // 5. Idle penalty (5%)
    let idlePenalty = 0;
    const idleMinutes = idleSeconds / 60;
    if (idleMinutes > 10) idlePenalty = 30;
    else if (idleMinutes > 5) idlePenalty = 15;

    const weights = policy?.weights;
    const rawScore =
        (continuityScore * (weights?.continuity ?? 0.35)) +
        (switchScore * (weights?.switches ?? 0.25)) +
        (dwellScore * (weights?.dwell ?? 0.20)) -
        (distractPenalty * (weights?.distractionPenalty ?? 0.15)) -
        (idlePenalty * (weights?.idlePenalty ?? 0.05));

    // Cap between 0 and 100
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));

    // Compute trend
    let trend: Trend = 'stable';
    const history = session.focusScoreHistory;
    if (history.length >= 3) {
        const recent = history.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, history.length);
        if (score > recent + 5) trend = 'rising';
        else if (score < recent - 5) trend = 'falling';
    }

    return {
        score,
        components: { continuityScore, switchScore, dwellScore },
        trend,
        onTopicSeconds,
        distractionCount: distractionRevisits,
    };
}

export function buildReadout(score: number, trend: Trend): string {
    const arrows = { rising: "↑", stable: "→", falling: "↓" };
    return `Focus: ${score} ${arrows[trend]}`;
}
