import { getDb } from '@/lib/db';
import {
    telemetryDurationSeconds,
    TelemetryEventV1,
    validateTelemetryEventV1,
} from '@/lib/telemetry-contract';
import { recordBrowserCollectorHeartbeat } from '@/lib/guardian-client-status';

export interface TelemetryIngestResult {
    accepted: number;
    duplicates: number;
    rejected: Array<{ index: number; errors: string[] }>;
}

function contextJson(event: TelemetryEventV1) {
    if (event.privacy.decision !== 'allow') return null;
    return JSON.stringify({
        application: event.application,
        window: event.window,
        tab: event.tab,
        group: event.group,
    });
}

function ingestGuardianBrowserEvidence(event: TelemetryEventV1) {
    if (event.source !== 'browser_extension') return;
    const focused = event.state === 'active' && event.window?.focused === true;
    recordBrowserCollectorHeartbeat({
        deviceId: `chrome:${event.deviceId}`,
        sessionId: event.sessionId ?? null,
        windowFocused: focused,
        collectorVersion: event.provenance.collectorVersion,
        observedAt: event.observedEnd,
    });
}

export function ingestTelemetryEvents(inputs: unknown[]): TelemetryIngestResult {
    const db = getDb();
    const insert = db.prepare(`
        INSERT OR IGNORE INTO telemetry_events_v1 (
            event_id,
            version,
            device_id,
            source,
            observed_start,
            observed_end,
            duration_seconds,
            state,
            session_id,
            context_json,
            provenance_json,
            privacy_decision,
            privacy_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result: TelemetryIngestResult = {
        accepted: 0,
        duplicates: 0,
        rejected: [],
    };

    db.transaction(() => {
        inputs.forEach((input, index) => {
            const validation = validateTelemetryEventV1(input);
            if (!validation.ok || !validation.event) {
                result.rejected.push({ index, errors: validation.errors });
                return;
            }

            const event = validation.event;
            const stored = insert.run(
                event.eventId,
                event.version,
                event.deviceId,
                event.source,
                event.observedStart,
                event.observedEnd,
                telemetryDurationSeconds(event),
                event.state,
                event.sessionId,
                contextJson(event),
                JSON.stringify(event.provenance),
                event.privacy.decision,
                event.privacy.reason,
            );
            if (stored.changes === 1) {
                result.accepted += 1;
                ingestGuardianBrowserEvidence(event);
            } else result.duplicates += 1;
        });
    })();

    return result;
}
