export const TELEMETRY_EVENT_VERSION = 1 as const;

export type TelemetrySource =
    | 'browser_extension'
    | 'native_macos'
    | 'legacy_adapter';

export type TelemetryState = 'active' | 'idle' | 'locked' | 'unfocused';
export type PrivacyDecision = 'allow' | 'redact' | 'drop';

export interface TelemetryEventV1 {
    version: 1;
    eventId: string;
    deviceId: string;
    source: TelemetrySource;
    observedStart: string;
    observedEnd: string;
    state: TelemetryState;
    sessionId: string | null;
    application: {
        name: string;
        bundleId: string | null;
    } | null;
    window: {
        id: string | null;
        title: string | null;
        focused: boolean;
    } | null;
    tab: {
        id: number | null;
        url: string | null;
        domain: string | null;
        title: string | null;
        lastAccessed: number | null;
        frozen: boolean | null;
        groupId: number | null;
    } | null;
    group: {
        id: number | null;
        title: string | null;
        lifeosManaged: boolean;
        relevanceConfidence: number | null;
    } | null;
    provenance: {
        collector: string;
        collectorVersion: string;
        adaptedFrom: string | null;
    };
    privacy: {
        decision: PrivacyDecision;
        reason: string;
    };
}

export interface TelemetryValidationResult {
    ok: boolean;
    event?: TelemetryEventV1;
    errors: string[];
}

const SOURCES = new Set<TelemetrySource>([
    'browser_extension',
    'native_macos',
    'legacy_adapter',
]);
const STATES = new Set<TelemetryState>(['active', 'idle', 'locked', 'unfocused']);
const PRIVACY_DECISIONS = new Set<PrivacyDecision>(['allow', 'redact', 'drop']);
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function text(value: unknown, maxLength: number, required = false) {
    if (typeof value !== 'string') return required ? null : '';
    const normalized = value.trim();
    if (required && !normalized) return null;
    return normalized.slice(0, maxLength);
}

function finiteNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableText(value: unknown, maxLength: number) {
    if (value === null || value === undefined || value === '') return null;
    return text(value, maxLength) || null;
}

export function validateTelemetryEventV1(input: unknown): TelemetryValidationResult {
    const errors: string[] = [];
    const value = input && typeof input === 'object'
        ? input as Record<string, unknown>
        : {};

    const eventId = text(value.eventId, 128, true);
    const deviceId = text(value.deviceId, 128, true);
    const source = value.source as TelemetrySource;
    const state = value.state as TelemetryState;
    const observedStartMs = Date.parse(String(value.observedStart || ''));
    const observedEndMs = Date.parse(String(value.observedEnd || ''));

    if (value.version !== TELEMETRY_EVENT_VERSION) errors.push('version');
    if (!eventId) errors.push('eventId');
    if (!deviceId) errors.push('deviceId');
    if (!SOURCES.has(source)) errors.push('source');
    if (!STATES.has(state)) errors.push('state');
    if (!Number.isFinite(observedStartMs)) errors.push('observedStart');
    if (!Number.isFinite(observedEndMs)) errors.push('observedEnd');
    if (
        Number.isFinite(observedStartMs)
        && Number.isFinite(observedEndMs)
        && (
            observedEndMs <= observedStartMs
            || observedEndMs - observedStartMs > MAX_INTERVAL_MS
        )
    ) {
        errors.push('observedInterval');
    }

    const privacyInput = value.privacy && typeof value.privacy === 'object'
        ? value.privacy as Record<string, unknown>
        : {};
    const privacyDecision = privacyInput.decision as PrivacyDecision;
    const privacyReason = text(privacyInput.reason, 256, true);
    if (!PRIVACY_DECISIONS.has(privacyDecision)) errors.push('privacy.decision');
    if (!privacyReason) errors.push('privacy.reason');

    const provenanceInput = value.provenance && typeof value.provenance === 'object'
        ? value.provenance as Record<string, unknown>
        : {};
    const collector = text(provenanceInput.collector, 64, true);
    const collectorVersion = text(provenanceInput.collectorVersion, 64, true);
    if (!collector) errors.push('provenance.collector');
    if (!collectorVersion) errors.push('provenance.collectorVersion');

    if (errors.length > 0) return { ok: false, errors };

    const applicationInput = value.application && typeof value.application === 'object'
        ? value.application as Record<string, unknown>
        : null;
    const windowInput = value.window && typeof value.window === 'object'
        ? value.window as Record<string, unknown>
        : null;
    const tabInput = value.tab && typeof value.tab === 'object'
        ? value.tab as Record<string, unknown>
        : null;
    const groupInput = value.group && typeof value.group === 'object'
        ? value.group as Record<string, unknown>
        : null;
    const retainContext = privacyDecision === 'allow';

    const event: TelemetryEventV1 = {
        version: TELEMETRY_EVENT_VERSION,
        eventId: eventId!,
        deviceId: deviceId!,
        source,
        observedStart: new Date(observedStartMs).toISOString(),
        observedEnd: new Date(observedEndMs).toISOString(),
        state,
        sessionId: nullableText(value.sessionId, 128),
        application: retainContext && applicationInput
            ? {
                name: text(applicationInput.name, 128) || 'Unknown',
                bundleId: nullableText(applicationInput.bundleId, 256),
            }
            : null,
        window: retainContext && windowInput
            ? {
                id: nullableText(windowInput.id, 128),
                title: nullableText(windowInput.title, 512),
                focused: windowInput.focused === true,
            }
            : null,
        tab: retainContext && tabInput
            ? {
                id: finiteNumber(tabInput.id),
                url: nullableText(tabInput.url, 2_048),
                domain: nullableText(tabInput.domain, 256),
                title: nullableText(tabInput.title, 512),
                lastAccessed: finiteNumber(tabInput.lastAccessed),
                frozen: typeof tabInput.frozen === 'boolean' ? tabInput.frozen : null,
                groupId: finiteNumber(tabInput.groupId),
            }
            : null,
        group: retainContext && groupInput
            ? {
                id: finiteNumber(groupInput.id),
                title: nullableText(groupInput.title, 256),
                lifeosManaged: groupInput.lifeosManaged === true,
                relevanceConfidence: finiteNumber(groupInput.relevanceConfidence),
            }
            : null,
        provenance: {
            collector: collector!,
            collectorVersion: collectorVersion!,
            adaptedFrom: nullableText(provenanceInput.adaptedFrom, 128),
        },
        privacy: {
            decision: privacyDecision,
            reason: privacyReason!,
        },
    };

    if (
        event.group
        && event.group.relevanceConfidence !== null
        && (
            event.group.relevanceConfidence < 0
            || event.group.relevanceConfidence > 1
        )
    ) {
        return { ok: false, errors: ['group.relevanceConfidence'] };
    }

    return { ok: true, event, errors: [] };
}

export function telemetryDurationSeconds(event: TelemetryEventV1) {
    return Math.max(
        0,
        Math.floor(
            (Date.parse(event.observedEnd) - Date.parse(event.observedStart)) / 1_000,
        ),
    );
}
