export type AssessmentClaimStatus =
    | 'unknown'
    | 'hypothesis'
    | 'supported'
    | 'confirmed'
    | 'disputed'
    | 'expired';

export type AssessmentUserStance =
    | 'unreviewed'
    | 'confirmed'
    | 'disputed';

export interface AssessmentClaimV1<T = unknown> {
    version: 1;
    id: string;
    value: T | null;
    status: AssessmentClaimStatus;
    sampleSize: number;
    distinctDays: number;
    confidence: number;
    evidenceReferences: string[];
    observationWindow: {
        start: string | null;
        end: string | null;
    };
    computedAt: string;
    expiresAt: string;
    algorithmVersion: string;
    modelVersion: string | null;
    userStance: AssessmentUserStance;
}

export type ClaimStrength = 'hypothesis' | 'decision' | 'identity';

interface BuildAssessmentClaimInput<T> {
    id: string;
    value: T | null;
    sampleSize: number;
    distinctDays: number;
    evidenceReferences: string[];
    observationStart?: string | null;
    observationEnd?: string | null;
    computedAt: string;
    expiresAt: string;
    algorithmVersion: string;
    modelVersion?: string | null;
    userStance?: AssessmentUserStance;
    strength: ClaimStrength;
    valueValid?: boolean;
}

const RELATIVE_DATE_PATTERN = /\b(today|tomorrow|yesterday|tonight|next\s+(day|week|month)|this\s+(morning|afternoon|evening|week))\b/i;

export function containsRelativeDateLanguage(value: unknown) {
    return typeof value === 'string' && RELATIVE_DATE_PATTERN.test(value);
}

export function buildAssessmentClaim<T>(
    input: BuildAssessmentClaimInput<T>,
    now = Date.now(),
): AssessmentClaimV1<T> {
    const sampleSize = Math.max(0, Math.floor(input.sampleSize));
    const distinctDays = Math.max(0, Math.floor(input.distinctDays));
    const userStance = input.userStance || 'unreviewed';
    const expired = Date.parse(input.expiresAt) <= now;
    const invalidValue = input.value === null
        || input.valueValid === false
        || containsRelativeDateLanguage(input.value);

    let status: AssessmentClaimStatus = 'unknown';
    if (userStance === 'disputed') {
        status = 'disputed';
    } else if (expired) {
        status = 'expired';
    } else if (!invalidValue && sampleSize >= 5) {
        status = 'hypothesis';
        if (sampleSize >= 10 && distinctDays >= 5) status = 'supported';
        if (input.strength === 'identity') {
            status = (
                sampleSize >= 20
                && distinctDays >= 14
                && userStance === 'confirmed'
            ) ? 'confirmed' : 'hypothesis';
        } else if (userStance === 'confirmed' && status === 'supported') {
            status = 'confirmed';
        }
    }

    const sampleConfidence = Math.min(1, sampleSize / 20);
    const dayConfidence = Math.min(1, distinctDays / 14);
    const confidence = status === 'unknown' || status === 'disputed' || status === 'expired'
        ? 0
        : Math.round(((sampleConfidence + dayConfidence) / 2) * 100) / 100;

    return {
        version: 1,
        id: input.id,
        value: invalidValue ? null : input.value,
        status,
        sampleSize,
        distinctDays,
        confidence,
        evidenceReferences: input.evidenceReferences.slice(0, 50),
        observationWindow: {
            start: input.observationStart || null,
            end: input.observationEnd || null,
        },
        computedAt: input.computedAt,
        expiresAt: input.expiresAt,
        algorithmVersion: input.algorithmVersion,
        modelVersion: input.modelVersion || null,
        userStance,
    };
}

export function canDriveDecision(claim: AssessmentClaimV1) {
    return claim.status === 'supported' || claim.status === 'confirmed';
}
