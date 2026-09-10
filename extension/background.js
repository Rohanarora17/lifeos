// LifeOS Guardian — Background Service Worker
// Low-detail intervals run during configured waking hours. Rich context is
// restricted to an active Guardian session.

importScripts('server-config.js', 'activity-state.js');

const DEFAULT_API_BASE = LifeOSServerConfig.DEFAULT_API_BASE;
const TELEMETRY_ALARM = 'lifeos-telemetry-sample';
const TELEMETRY_STATE_KEY = 'telemetryEventV1Current';
const TELEMETRY_QUEUE_KEY = 'telemetryEventV1Queue';
const PRESENCE_NOTIFICATION_PREFIX = 'lifeos-presence-';
const GUARDIAN_EVIDENCE_SEQUENCE_KEY = 'guardianEvidenceSequenceV2';
let API_BASE = DEFAULT_API_BASE;

/** Always reads storage fresh — safe across service worker restarts. */
async function getApiBase() {
    API_BASE = await LifeOSServerConfig.loadApiBase(chrome.storage.local);
    return API_BASE;
}

let guardianActive = false;
let telemetryCurrent = undefined;
let telemetryLoadPromise = null;
let guardianIdleLastReportedAt = null;

// Domain config — loaded from server at startup so no hardcoded lists.
// Falls back to empty arrays on network error (fail open: server handles blocking).
let PRIVACY_BLOCKED_DOMAINS = [];
let CONTEXT_SENSITIVE_DOMAINS = [];

async function fetchGuardianConfig() {
    try {
        await getApiBase();
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/guardian/config`, { headers });
        if (res.ok) {
            const cfg = await res.json();
            PRIVACY_BLOCKED_DOMAINS = cfg.privacyDomains || [];
            CONTEXT_SENSITIVE_DOMAINS = cfg.contextSensitiveDomains || [];
        }
    } catch { /* server not reachable — keep empty defaults */ }
}

// Fetch config at service worker startup
fetchGuardianConfig();
let sessionContext = null;
let currentActiveTabId = null;
let sessionGroupId = null; // Chrome tab group for the active session
let guardianPersonalization = null;

function getUrlDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Uses the AI-computed block list for this specific session goal (no hardcoded lists).
// Falls back gracefully when immediateBlockDomains is empty — server handles blocking.
function isSessionDistraction(url) {
    if (!url || !sessionContext) return false;
    const domain = getUrlDomain(url);
    if (!domain) return false;
    const blockList = sessionContext.immediateBlockDomains || [];
    return blockList.some(d => domain === d || domain.endsWith('.' + d));
}

// ── Reliable block delivery: injects content script if not yet present in tab ──
async function sendBlockToTab(tabId, blockData) {
    try {
        await chrome.tabs.sendMessage(tabId, blockData);
    } catch {
        // Content script not loaded (pre-existing tab) — inject guardian.js then retry
        try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['guardian.js'] });
            // Small delay to let the script register its listener
            await new Promise(r => setTimeout(r, 50));
            chrome.tabs.sendMessage(tabId, blockData).catch(() => { });
        } catch (e2) {
            console.warn('[LifeOS] Could not inject guardian.js into tab', tabId, e2);
        }
    }
}

function buildGuardianStatus() {
    if (!guardianActive || !sessionContext?.sessionId) {
        return { active: false, context: null };
    }

    const now = Date.now();
    const durationMinutes =
        sessionContext.durationMinutes ||
        sessionContext.plannedMinutes ||
        guardianPersonalization?.recommendedSessionMinutes ||
        null;
    const endsAt = sessionContext.endsAt || (sessionContext.startedAt && durationMinutes ? sessionContext.startedAt + durationMinutes * 60 * 1000 : null);

    return {
        active: true,
        sessionId: sessionContext.sessionId,
        context: sessionContext,
        targetTitle: sessionContext.targetTitle || sessionContext.conceptNodeName || sessionContext.goalTitle || 'Focus Session',
        durationMinutes,
        remainingSeconds: endsAt ? Math.max(0, Math.round((endsAt - now) / 1000)) : null,
        blockedCount: sessionContext.blockedCount || 0,
        overrideCount: sessionContext.overrideCount || 0,
        productiveSeconds: sessionContext.productiveSeconds || 0,
        distractionSeconds: sessionContext.distractionSeconds || 0,
    };
}

function enableSessionCaptureAlarms() {
    chrome.alarms.create('lifeos-guardian-heartbeat', { periodInMinutes: 0.5 });
}

function disableSessionCaptureAlarms() {
    chrome.alarms.clear('lifeos-guardian-heartbeat');
    chrome.alarms.clear('lifeos-screenshot');
}

function enableTelemetryAlarm() {
    chrome.alarms.create(TELEMETRY_ALARM, {
        periodInMinutes: 0.5,
        persistAcrossSessions: true,
    });
}

// Manifest V3 service workers are suspended between events. Recreate the
// discovery alarm on every worker boot so externally-started sessions are
// rediscovered after Chrome wakes the extension.
function enableGuardianDiscoveryAlarm() {
    chrome.alarms.create('lifeos-guardian-poll', { periodInMinutes: 0.5 });
}

// Sync config and migrate the retired localhost default on worker startup.
LifeOSServerConfig.loadApiBase(chrome.storage.local)
    .then((apiBase) => { API_BASE = apiBase; })
    .catch(() => { API_BASE = DEFAULT_API_BASE; });
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.apiUrl) {
        API_BASE = LifeOSServerConfig.normalizeApiBase(changes.apiUrl.newValue);
    }
});

// Context Menu Setup
chrome.runtime.onInstalled.addListener(() => {
    console.log('[LifeOS] Guardian installed. Silent mode active.');
    disableSessionCaptureAlarms();
    chrome.contextMenus.create({
        id: "send-to-lifeos",
        title: "Extract Task to LifeOS",
        contexts: ["selection"]
    });
    chrome.alarms.create('lifeos-guardian-poll', { periodInMinutes: 0.5 });
    enableTelemetryAlarm();
});

chrome.runtime.onStartup.addListener(() => {
    disableSessionCaptureAlarms();
    enableGuardianDiscoveryAlarm();
    enableTelemetryAlarm();
    checkExternalSession()
        .then(() => sampleBrowserTelemetry())
        .catch(() => { });
});

enableTelemetryAlarm();
enableGuardianDiscoveryAlarm();
// The first event after suspension may be telemetry. Reconcile the server
// session before sampling so browser evidence retains its sessionId.
checkExternalSession()
    .then(() => sampleBrowserTelemetry())
    .catch(() => { });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "send-to-lifeos" && info.selectionText) {
        try {
            const dataInfo = await chrome.storage.local.get('apiKey');
            const apiKey = dataInfo.apiKey;
            const res = await fetch(`${API_BASE}/extension/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                body: JSON.stringify({ text: info.selectionText, url: tab?.url, title: tab?.title })
            });

            if (res.ok) {
                chrome.action.setBadgeText({ text: '✓', tabId: tab?.id });
                chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: tab?.id });
                setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab?.id }), 2000);
            }
        } catch (e) {
            console.error('Failed to send task to LifeOS:', e);
            chrome.action.setBadgeText({ text: '!', tabId: tab?.id });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: tab?.id });
        }
    }
});

function isPrivacyBlocked(url) {
    if (!url || typeof url !== 'string') return true;
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('file://')) return true;

    try {
        const domain = new URL(url).hostname;
        return PRIVACY_BLOCKED_DOMAINS.some(blocked => domain === blocked || domain.endsWith('.' + blocked));
    } catch {
        return true;
    }
}

// ── NEW GUARDIAN PATTERN ──
// Absolutely zero processing if guardianActive is false.

const activeTabs = new Map(); // tabId -> { url, startedAt }

async function getAuthHeaders() {
    await getApiBase();
    const data = await chrome.storage.local.get('apiKey');
    const headers = { 'Content-Type': 'application/json' };
    if (data.apiKey) headers.Authorization = `Bearer ${data.apiKey}`;
    return headers;
}

async function loadTelemetryState() {
    if (telemetryCurrent !== undefined) return;
    if (telemetryLoadPromise) return telemetryLoadPromise;

    telemetryLoadPromise = (async () => {
        const stored = await chrome.storage.local.get(TELEMETRY_STATE_KEY);
        const recovered = LifeOSActivityState.recoverPersistedInterval(
            stored[TELEMETRY_STATE_KEY] || null,
            Date.now(),
        );
        telemetryCurrent = recovered.current;
        if (recovered.closed && recovered.closed.endedAt > recovered.closed.startedAt) {
            await queueTelemetryInterval(recovered.closed);
        }
        await persistTelemetryState();
    })();
    await telemetryLoadPromise;
}

async function persistTelemetryState() {
    if (telemetryCurrent) {
        await chrome.storage.local.set({ [TELEMETRY_STATE_KEY]: telemetryCurrent });
    } else {
        await chrome.storage.local.remove(TELEMETRY_STATE_KEY);
    }
}

async function telemetrySettings() {
    const stored = await chrome.storage.local.get([
        'deviceName',
        'trackingWakeHour',
        'trackingSleepHour',
    ]);
    return {
        deviceId: stored.deviceName || 'MacBook',
        wakeHour: Number.isInteger(Number(stored.trackingWakeHour))
            ? Number(stored.trackingWakeHour)
            : 7,
        sleepHour: Number.isInteger(Number(stored.trackingSleepHour))
            ? Number(stored.trackingSleepHour)
            : 1,
    };
}

async function queueTelemetryInterval(interval) {
    if (!interval || interval.endedAt <= interval.startedAt) return;
    const settings = await telemetrySettings();
    const privacyDecision = interval.privacyBlocked ? 'redact' : 'allow';
    const includeRichContext = Boolean(interval.sessionId) && privacyDecision === 'allow';
    const event = {
        version: 1,
        eventId: interval.eventId,
        deviceId: settings.deviceId,
        source: 'browser_extension',
        observedStart: new Date(interval.startedAt).toISOString(),
        observedEnd: new Date(interval.endedAt).toISOString(),
        state: interval.state,
        sessionId: interval.sessionId || null,
        application: privacyDecision === 'allow'
            ? { name: 'Google Chrome', bundleId: 'com.google.Chrome' }
            : null,
        window: privacyDecision === 'allow'
            ? {
                id: interval.windowId == null ? null : String(interval.windowId),
                title: includeRichContext ? interval.windowTitle || null : null,
                focused: interval.state === 'active',
            }
            : null,
        tab: privacyDecision === 'allow' && interval.tabId != null
            ? {
                id: interval.tabId,
                url: includeRichContext ? interval.rawUrl || null : null,
                domain: interval.domain || null,
                title: includeRichContext ? interval.tabTitle || null : null,
                lastAccessed: interval.lastAccessed || null,
                frozen: typeof interval.frozen === 'boolean' ? interval.frozen : null,
                groupId: interval.groupId ?? null,
            }
            : null,
        group: privacyDecision === 'allow' && interval.groupId != null && interval.groupId !== -1
            ? {
                id: interval.groupId,
                title: includeRichContext ? interval.groupTitle || null : null,
                lifeosManaged: interval.groupId === sessionGroupId,
                relevanceConfidence: null,
            }
            : null,
        provenance: {
            collector: 'lifeos-extension',
            collectorVersion: chrome.runtime.getManifest().version,
            adaptedFrom: null,
        },
        privacy: {
            decision: privacyDecision,
            reason: interval.privacyBlocked
                ? 'sensitive_or_internal_page'
                : includeRichContext
                    ? 'guardian_focus_session'
                    : interval.outsideConfiguredHours
                        ? 'active_outside_configured_hours'
                    : 'waking_hours_metadata',
        },
    };

    const stored = await chrome.storage.local.get(TELEMETRY_QUEUE_KEY);
    const queue = Array.isArray(stored[TELEMETRY_QUEUE_KEY])
        ? stored[TELEMETRY_QUEUE_KEY]
        : [];
    queue.push(event);
    await chrome.storage.local.set({
        [TELEMETRY_QUEUE_KEY]: queue.slice(-1_000),
    });
}

async function flushTelemetryQueue() {
    const stored = await chrome.storage.local.get(TELEMETRY_QUEUE_KEY);
    const queue = Array.isArray(stored[TELEMETRY_QUEUE_KEY])
        ? stored[TELEMETRY_QUEUE_KEY]
        : [];
    if (queue.length === 0) return;

    try {
        const headers = await getAuthHeaders();
        const response = await fetch(`${API_BASE}/telemetry/events`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ events: queue.slice(0, 100) }),
        });
        if (!response.ok) return;
        await chrome.storage.local.set({
            [TELEMETRY_QUEUE_KEY]: queue.slice(100),
        });
    } catch {
        // The persisted queue is retried by the next alarm or browser event.
    }
}

async function transitionBrowserTelemetry(nextContext) {
    await loadTelemetryState();
    const transition = LifeOSActivityState.transitionInterval(
        telemetryCurrent,
        nextContext,
        Date.now(),
    );
    telemetryCurrent = transition.current;
    await persistTelemetryState();
    if (transition.closed) await queueTelemetryInterval(transition.closed);
    await flushTelemetryQueue();
}

async function sampleBrowserTelemetry() {
    await getApiBase();
    const settings = await telemetrySettings();
    const withinConfiguredHours = LifeOSActivityState.isWithinWakingHours(
        new Date(),
        settings.wakeHour,
        settings.sleepHour,
    );
    const idleState = await chrome.idle.queryState(60);
    if (!LifeOSActivityState.shouldCollectTelemetry(
        withinConfiguredHours,
        idleState,
        guardianActive && Boolean(sessionContext?.sessionId),
    )) {
        await transitionBrowserTelemetry(null);
        return;
    }

    if (idleState === 'idle' || idleState === 'locked') {
        await transitionBrowserTelemetry({
            eventId: crypto.randomUUID(),
            state: idleState,
            tabId: null,
            windowId: null,
            url: null,
            rawUrl: null,
            domain: null,
            sessionId: guardianActive ? sessionContext?.sessionId || null : null,
            privacyBlocked: false,
            outsideConfiguredHours: !withinConfiguredHours,
        });
        return;
    }

    const focusedWindow = await chrome.windows.getLastFocused({ populate: true });
    if (!focusedWindow?.focused) {
        await transitionBrowserTelemetry({
            eventId: crypto.randomUUID(),
            state: 'unfocused',
            tabId: null,
            windowId: null,
            url: null,
            rawUrl: null,
            domain: null,
            sessionId: guardianActive ? sessionContext?.sessionId || null : null,
            privacyBlocked: false,
            outsideConfiguredHours: !withinConfiguredHours,
        });
        return;
    }

    const tab = focusedWindow.tabs?.find(item => item.active);
    if (!tab) return;
    const domain = getUrlDomain(tab.url);
    const privacyBlocked = isPrivacyBlocked(tab.url);
    const groupInfo = await resolveTabGroup(tab.groupId);
    await transitionBrowserTelemetry({
        eventId: crypto.randomUUID(),
        state: 'active',
        tabId: tab.id,
        windowId: tab.windowId,
        url: guardianActive ? tab.url || null : domain ? `domain://${domain}` : null,
        rawUrl: guardianActive ? tab.url || null : null,
        domain: privacyBlocked ? null : domain,
        tabTitle: guardianActive ? tab.title || null : null,
        windowTitle: null,
        lastAccessed: tab.lastAccessed || null,
        frozen: typeof tab.frozen === 'boolean' ? tab.frozen : null,
        groupId: tab.groupId ?? -1,
        groupTitle: guardianActive ? groupInfo?.title || null : null,
        sessionId: guardianActive ? sessionContext?.sessionId || null : null,
        privacyBlocked,
        outsideConfiguredHours: !withinConfiguredHours,
    });
}

async function refreshGuardianPersonalization() {
    if (!guardianActive) return null;
    try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/guardian/insights`, { headers });
        if (!res.ok) return guardianPersonalization;
        const data = await res.json();
        guardianPersonalization = data.personalization || guardianPersonalization;
        return guardianPersonalization;
    } catch {
        return guardianPersonalization;
    }
}

function buildLocalInterventionPolicy() {
    const p = guardianPersonalization;
    const mode = p?.mode || 'normal';
    const energy = p?.energy || sessionContext?.mood || 'medium';
    const guidance = p?.guidance || 'Keep the protected session intentional.';

    if (mode === 'recovery' || energy === 'low') {
        return {
            mode,
            headline: 'Choose the smallest useful move',
            tone: 'gentle',
            contextLine: 'Low energy today. Keep the session protected without turning this into a fight.',
            overridePrompt: 'If this helps the task, name the one concrete thing you need from it.',
            overrideOptions: [
                { minutes: 3, label: '3 min check' },
                { minutes: 5, label: '5 min source check', default: true },
                { minutes: 10, label: '10 min bounded detour' },
            ],
            minReasonChars: 8,
            frictionSeconds: 2,
        };
    }

    if (mode === 'deadline_pressure') {
        return {
            mode,
            headline: 'Deadline capacity is protected',
            tone: 'urgent',
            contextLine: p?.standupGoal ? `Today is anchored on: ${p.standupGoal}` : 'Use exceptions only for direct deadline relief.',
            overridePrompt: 'Explain how this directly reduces the current deadline risk.',
            overrideOptions: [
                { minutes: 3, label: '3 min verify', default: true },
                { minutes: 5, label: '5 min reference' },
                { minutes: 10, label: '10 min only if essential' },
            ],
            minReasonChars: 14,
            frictionSeconds: 6,
        };
    }

    if (mode === 'protect_focus') {
        return {
            mode,
            headline: 'Protect this focus block',
            tone: 'firm',
            contextLine: guidance,
            overridePrompt: 'Explain why this is part of the current session, not a context switch.',
            overrideOptions: [
                { minutes: 5, label: '5 min task check', default: true },
                { minutes: 10, label: '10 min reference' },
                { minutes: 15, label: '15 min if necessary' },
            ],
            minReasonChars: 16,
            frictionSeconds: 10,
        };
    }

    return {
        mode,
        headline: mode === 'planning' ? 'Keep tonight clean' : 'Intervention',
        tone: mode === 'planning' ? 'gentle' : 'firm',
        contextLine: guidance,
        overridePrompt: 'If this is needed, explain the specific session-relevant reason.',
        overrideOptions: [
            { minutes: 5, label: '5 min check' },
            { minutes: 10, label: '10 min override', default: true },
            { minutes: 15, label: '15 min override' },
        ],
        minReasonChars: p?.alertFatigueLevel === 'high' ? 14 : 10,
        frictionSeconds: p?.alertFatigueLevel === 'high' ? 6 : 4,
    };
}

async function applyGuardianCommands(commands = [], tabIdHint = null) {
    for (const command of commands) {
        const targetTabId = tabIdHint || currentActiveTabId;
        if (!targetTabId) continue;

        if (command.type === 'block') {
            await sendBlockToTab(targetTabId, {
                type: 'BLOCK_TAB',
                reason: command.reason,
                explainability: command.explainability,
                targetDisplay: command.targetDisplay || sessionContext?.conceptNodeName || sessionContext?.goalTitle || 'Focus Session',
                urlPattern: command.urlPattern,
                interventionPolicy: command.interventionPolicy,
            });
            if (sessionContext) sessionContext.blockedCount = (sessionContext.blockedCount || 0) + 1;
        }

        if (command.type === 'unblock') {
            chrome.tabs.sendMessage(targetTabId, {
                type: 'UNBLOCK_TAB',
                reason: command.reason,
                explainability: command.explainability,
                ttlSeconds: command.ttlSeconds,
            }).catch(() => { });
        }

        if (command.type === 'classify') {
            chrome.tabs.sendMessage(targetTabId, {
                type: 'CLASSIFY_TOAST',
                conceptTitle: command.conceptTitle,
            }).catch(() => { });
        }
    }
}

async function postGuardianEvent(payload, tabIdHint = null) {
    if (!guardianActive || !sessionContext?.sessionId) return null;

    try {
        const focusedWindow = await chrome.windows.getLastFocused().catch(() => null);
        const mediaState = await getForegroundMediaPlaybackState(
            tabIdHint || currentActiveTabId,
            focusedWindow?.focused === true,
        );
        const commonPayload = {
            ...(payload?.payload || {}),
            deviceId: 'chrome-primary',
            browserWindowFocused: focusedWindow?.focused === true,
            collectorVersion: chrome.runtime.getManifest().version,
            mediaPlaybackActive: mediaState.active,
            mediaTitle: mediaState.title,
        };
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/guardian/events`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                sessionId: sessionContext.sessionId,
                timestamp: Date.now(),
                ...payload,
                payload: commonPayload,
            }),
        });

        if (res.status === 409) {
            guardianActive = false;
            sessionContext = null;
            await LifeOSServerConfig.saveGuardianSession(chrome.storage.session, null);
            activeTabs.clear();
            disableSessionCaptureAlarms();
            chrome.action.setBadgeText({ text: '' });
            clearPresenceNotifications().catch(() => { });
            return null;
        }

        if (!res.ok) return null;
        const data = await res.json();
        if (data?.session) {
            sessionContext = data.session;
        }
        if (Array.isArray(data.commands)) {
            await applyGuardianCommands(data.commands, tabIdHint);
        }
        if (data?.presenceCheck?.checkId) {
            await showPresenceCheck(data.presenceCheck);
        } else {
            await clearPresenceNotifications();
        }

        // Update badge with live focus score
        if (guardianActive && data?.session?.focusScoreHistory?.length) {
            const latestScore = data.session.focusScoreHistory[data.session.focusScoreHistory.length - 1];
            if (typeof latestScore === 'number') {
                const text = String(Math.round(latestScore));
                const color = latestScore >= 80 ? '#22c55e' : latestScore >= 60 ? '#f59e0b' : '#ef4444';
                chrome.action.setBadgeText({ text });
                chrome.action.setBadgeBackgroundColor({ color });
            }
        }

        return data;
    } catch (e) {
        console.error('[LifeOS] guardian event failed', e);
        return null;
    }
}

async function nextGuardianEvidenceSequence() {
    const stored = await chrome.storage.local.get(GUARDIAN_EVIDENCE_SEQUENCE_KEY);
    const next = Math.max(0, Number(stored[GUARDIAN_EVIDENCE_SEQUENCE_KEY] || 0)) + 1;
    await chrome.storage.local.set({ [GUARDIAN_EVIDENCE_SEQUENCE_KEY]: next });
    return next;
}

async function postGuardianPageEvidence(message, sender) {
    if (!guardianActive || !sessionContext?.sessionId || !sender?.tab?.id) return;
    await getApiBase();
    const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
    const focusedWindow = tab
        ? await chrome.windows.get(tab.windowId).catch(() => null)
        : null;
    const windowFocused = Boolean(tab?.active && focusedWindow?.focused);
    const privacyBlocked = isPrivacyBlocked(message.url || tab?.url);
    const sequence = await nextGuardianEvidenceSequence();
    const observedEnd = Date.parse(message.observedEnd) || Date.now();
    const declaredStart = Date.parse(message.observedStart);
    const observedStart = Number.isFinite(declaredStart)
        ? Math.max(observedEnd - 15_000, Math.min(declaredStart, observedEnd - 1))
        : observedEnd - 10_000;
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/guardian/evidence`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            events: [{
                schemaVersion: 2,
                eventId: `chrome-${sequence}-${crypto.randomUUID()}`,
                sequence,
                collector: 'chrome',
                collectorVersion: chrome.runtime.getManifest().version,
                deviceId: 'chrome-primary',
                sessionId: sessionContext.sessionId,
                observedStart: new Date(observedStart).toISOString(),
                observedEnd: new Date(observedEnd).toISOString(),
                capabilities: ['active_tab', 'interaction', 'media_progress', 'window_focus'],
                privacy: {
                    decision: privacyBlocked ? 'redact' : 'allow',
                    reason: privacyBlocked ? 'sensitive_or_internal_page' : 'guardian_session',
                },
                native: null,
                chrome: {
                    windowFocused,
                    url: privacyBlocked ? null : message.url || tab?.url || null,
                    domain: privacyBlocked ? null : getUrlDomain(message.url || tab?.url),
                    title: privacyBlocked ? null : message.title || tab?.title || null,
                    interaction: message.interaction || {
                        keyboard: false, pointer: false, scroll: false,
                        navigation: false, lastInputAt: null,
                    },
                    media: message.media || {
                        playing: false, progressed: false, currentTime: null, title: null,
                    },
                },
            }],
        }),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (data?.session) sessionContext = data.session;
    if (Array.isArray(data?.commands)) await applyGuardianCommands(data.commands, sender.tab.id);
    if (data?.presenceCheck?.checkId) await showPresenceCheck(data.presenceCheck);
    else await clearPresenceNotifications();
}

async function requestGuardianPageEvidence(tabId, navigation = false) {
    if (!guardianActive || !tabId) return;
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: 'LIFEOS_COLLECT_EVIDENCE_NOW',
            navigation,
        });
    } catch {
        try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['guardian.js'] });
            await chrome.tabs.sendMessage(tabId, {
                type: 'LIFEOS_COLLECT_EVIDENCE_NOW',
                navigation,
            });
        } catch { /* internal or unavailable page */ }
    }
}

async function showPresenceCheck(check) {
    const seconds = Math.max(0, Number(check.secondsRemaining || 0));
    await chrome.notifications.create(`${PRESENCE_NOTIFICATION_PREFIX}${check.checkId}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `Still working on ${check.targetTitle || 'your session'}?`,
        message: seconds > 0
            ? `No interaction for 3 minutes. Guardian pauses in ${seconds}s if unanswered.`
            : 'Guardian is paused. The uncertain interval is unscored.',
        requireInteraction: true,
        buttons: [
            { title: 'Yes, still working' },
            { title: 'Taking a break' },
        ],
    });
}

async function resolvePresenceFromExtension(checkId, action) {
    if (!sessionContext?.sessionId) return;
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/guardian/presence`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: sessionContext.sessionId, checkId, action }),
    });
    if (response.ok) {
        await chrome.notifications.clear(`${PRESENCE_NOTIFICATION_PREFIX}${checkId}`);
    }
}

async function clearPresenceNotifications() {
    const notifications = await chrome.notifications.getAll();
    await Promise.all(Object.keys(notifications)
        .filter((id) => id.startsWith(PRESENCE_NOTIFICATION_PREFIX))
        .map((id) => chrome.notifications.clear(id)));
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (!notificationId.startsWith(PRESENCE_NOTIFICATION_PREFIX)) return;
    const checkId = notificationId.slice(PRESENCE_NOTIFICATION_PREFIX.length);
    const action = buttonIndex === 0 ? 'still_working' : 'break';
    resolvePresenceFromExtension(checkId, action).catch(() => { });
});

chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(PRESENCE_NOTIFICATION_PREFIX)) return;
    const appBase = API_BASE.replace(/\/api\/?$/, '');
    chrome.tabs.create({ url: `${appBase}/guardian` }).catch(() => { });
});

async function getForegroundMediaPlaybackState(tabId, browserWindowFocused = true) {
    if (!tabId || !browserWindowFocused) return { active: false, title: null };
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                if (document.visibilityState !== 'visible') return { active: false, title: null };
                const elements = Array.from(document.querySelectorAll('video, audio'));
                const playing = elements.find((element) => (
                    !element.paused
                    && !element.ended
                    && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
                    && element.currentTime > 0
                ));
                return playing
                    ? { active: true, title: document.title || null }
                    : { active: false, title: null };
            },
        });
        const active = results.find((item) => item?.result?.active === true)?.result;
        return active || { active: false, title: null };
    } catch {
        return { active: false, title: null };
    }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    await sampleBrowserTelemetry().catch(() => { });
    if (!guardianActive) return;
    if (changeInfo.status !== 'complete') return;
    if (isPrivacyBlocked(tab.url)) return;

    if (!tab.active) return; // Only track the active tab for focus scoring
    currentActiveTabId = tabId;
    await requestGuardianPageEvidence(tabId, true);

    const groupInfo = await resolveTabGroup(tab.groupId);
    reportTabActivity(tabId, tab.url, tab.title, groupInfo);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    // Always check for externally-started sessions (Telegram, dashboard) when user switches tabs
    if (!guardianActive) {
        await checkExternalSession();
        // Don't return — if the check just activated guardian, fall through to track this tab
        if (!guardianActive) return;
    }
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await sampleBrowserTelemetry().catch(() => { });
        if (isPrivacyBlocked(tab.url)) return;
        currentActiveTabId = activeInfo.tabId;
        await requestGuardianPageEvidence(activeInfo.tabId, true);
        const groupInfo = await resolveTabGroup(tab.groupId);
        reportTabActivity(activeInfo.tabId, tab.url, tab.title, groupInfo);
    } catch (e) { }
});

// Sync when Chrome window regains focus (e.g. user Alt-Tabs back after starting a session via Telegram)
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        await sampleBrowserTelemetry().catch(() => { });
        await flushGuardianDwell('chrome_unfocused');
        return;
    }
    if (!guardianActive) {
        await checkExternalSession();
    }
    await sampleBrowserTelemetry().catch(() => { });
    const [activeTab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (activeTab?.id) await requestGuardianPageEvidence(activeTab.id, false);
});

async function resolveTabGroup(groupId) {
    if (!groupId || groupId === -1) return null;
    try {
        const group = await chrome.tabGroups.get(groupId);
        return { id: group.id, title: group.title || '', color: group.color };
    } catch (e) {
        return null;
    }
}

// ── Session auto-grouping ──────────────────────────────────────────────────

const SESSION_GROUP_COLOR = 'blue';

// Returns the session group id, creating it from the given tab if it doesn't exist yet.
async function ensureSessionGroup(tabId) {
    if (!guardianActive || !sessionContext) return;

    // Verify existing group is still alive
    if (sessionGroupId !== null) {
        try {
            await chrome.tabGroups.get(sessionGroupId);
            return; // group exists, just add the tab to it below
        } catch {
            sessionGroupId = null; // group was closed, recreate
        }
    }

    // Create a new group with this tab
    try {
        const gid = await chrome.tabs.group({ tabIds: [tabId] });
        const label = sessionContext.targetTitle || sessionContext.conceptNodeName || sessionContext.goalTitle || 'Focus Session';
        await chrome.tabGroups.update(gid, {
            title: label.slice(0, 32), // Chrome truncates long titles anyway
            color: SESSION_GROUP_COLOR,
        });
        sessionGroupId = gid;
    } catch (e) {
        console.warn('[LifeOS] Could not create session tab group:', e);
    }
}

async function addTabToSessionGroup(tabId) {
    if (!guardianActive || !sessionContext || !sessionGroupId) return;
    try {
        await chrome.tabs.group({ tabIds: [tabId], groupId: sessionGroupId });
    } catch {
        // Group may have been deleted; recreate on next tab
        sessionGroupId = null;
    }
}

// Preserve user groups. Only inherit the LifeOS group from a Guardian-group
// opener; explicit Guardian-created tabs are handled by OPEN_SESSION_TAB.
chrome.tabs.onCreated.addListener(async (tab) => {
    if (!guardianActive) return;
    setTimeout(async () => {
        try {
            const fresh = await chrome.tabs.get(tab.id);
            if (isPrivacyBlocked(fresh.url)) return;
            let openerGroupId = null;
            if (fresh.openerTabId != null) {
                const opener = await chrome.tabs.get(fresh.openerTabId).catch(() => null);
                openerGroupId = opener?.groupId ?? null;
            }
            const shouldGroup = LifeOSActivityState.shouldGroupTab({
                currentGroupId: fresh.groupId,
                openerGroupId,
                sessionGroupId,
            });
            if (shouldGroup) await addTabToSessionGroup(fresh.id);
        } catch { /* tab may have closed immediately */ }
    }, 300);
});

async function reportTabActivity(tabId, url, title, groupInfo) {
    if (!sessionContext || !sessionContext.sessionId) return;

    // Calculate dwell time on the PREVIOUS URL and capture it for attribution
    let dwellSeconds = 0;
    let prevUrl = null;
    let prevTitle = null;
    let prevStartedAt = null;
    if (activeTabs.has('current')) {
        const prev = activeTabs.get('current');

        // Prevent spamming the same URL
        if (prev.url === url) return;

        dwellSeconds = Math.round((Date.now() - prev.startedAt) / 1000);
        prevStartedAt = prev.startedAt; // exact epoch ms when previous tab became active
        prevUrl = prev.url;
        prevTitle = prev.title || null;
    }

    const newTabStartedAt = Date.now();
    activeTabs.set('current', {
        url,
        title,
        startedAt: newTabStartedAt,
        tab_group_id: groupInfo?.id ?? -1,
        tab_group_title: groupInfo?.title ?? null,
        tab_group_color: groupInfo?.color ?? null,
    });

    // Proactive local block — fires IMMEDIATELY without waiting for server round-trip.
    // Uses AI-derived immediateBlockDomains (computed at session start for this specific goal).
    // Server confirms with richer reasoning; this makes the first hit feel instant.
    if (isSessionDistraction(url)) {
        const domain = getUrlDomain(url);
        const target = sessionContext?.targetTitle || sessionContext?.conceptNodeName || sessionContext?.goalTitle || 'Focus Session';
        await sendBlockToTab(tabId, {
            type: 'BLOCK_TAB',
            reason: `${domain} is a distraction. You're in a focus session for: ${target}.`,
            explainability: 'You navigated to a known distraction site during an active guardian session.',
            targetDisplay: target,
            interventionPolicy: buildLocalInterventionPolicy(),
        });
        if (sessionContext) sessionContext.blockedCount = (sessionContext.blockedCount || 0) + 1;
    }

    await postGuardianEvent({
        type: 'tab',
        url,
        title,
        dwellSeconds,
        // tabStartedAt = exact epoch ms when the dwelled (previous) tab became active.
        // Server uses this for the activities.started_at column — no retrocomputation needed.
        tabStartedAt: prevStartedAt || undefined,
        // timestamp = when the NEW tab became active (server uses for currentTabStartedAt)
        timestamp: newTabStartedAt,
        // prevUrl/prevTitle tell the server which URL the dwell time actually belongs to
        prevUrl: prevUrl || undefined,
        prevTitle: prevTitle || undefined,
        tabGroupId: groupInfo?.id ?? undefined,
        tabGroupTitle: groupInfo?.title ?? undefined,
        tabGroupColor: groupInfo?.color ?? undefined,
    }, tabId);
}

// Idle detection (using chrome API)
chrome.idle.setDetectionInterval(60); // 60 seconds
chrome.idle.onStateChanged.addListener(async (state) => {
    await sampleBrowserTelemetry().catch(() => { });
    if (!guardianActive || !sessionContext?.sessionId) return;

    if (state === 'idle' || state === 'locked') {
        const mediaState = await getForegroundMediaPlaybackState(
            currentActiveTabId,
            (await chrome.windows.getLastFocused().catch(() => null))?.focused === true,
        );
        if (LifeOSActivityState.shouldTreatMediaPlaybackAsActive(state, mediaState.active)) {
            guardianIdleLastReportedAt = null;
            await postGuardianEvent({
                type: 'heartbeat',
                payload: {
                    mediaPlaybackActive: true,
                    mediaTitle: mediaState.title,
                    inputIdleSuppressed: true,
                },
            }, currentActiveTabId);
            return;
        }
        await flushGuardianDwell(state);
        guardianIdleLastReportedAt = Date.now() - 60_000;
        await reportGuardianIdleDelta(state);
    } else {
        await reportGuardianIdleDelta('active');
        guardianIdleLastReportedAt = null;
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id && tab.url && !isPrivacyBlocked(tab.url)) {
            const groupInfo = await resolveTabGroup(tab.groupId);
            await reportTabActivity(tab.id, tab.url, tab.title || '', groupInfo);
        }
    }
});

async function reportGuardianIdleDelta(state) {
    if (!guardianIdleLastReportedAt || !guardianActive || !sessionContext?.sessionId) return;
    const now = Date.now();
    const idleSeconds = Math.max(0, Math.floor((now - guardianIdleLastReportedAt) / 1_000));
    if (idleSeconds === 0) return;
    guardianIdleLastReportedAt = now;
    await postGuardianEvent({
        type: 'idle',
        url: `lifeos://${state}`,
        title: state === 'locked' ? 'Device Locked' : 'User Idle State',
        idleSeconds,
        payload: { state },
    }, currentActiveTabId);
}

async function flushGuardianDwell(reason) {
    const current = activeTabs.get('current');
    if (!current || !sessionContext?.sessionId) return;
    activeTabs.delete('current');
    const endedAt = Date.now();
    const dwellSeconds = Math.max(0, Math.floor((endedAt - current.startedAt) / 1_000));
    if (dwellSeconds === 0) return;
    await postGuardianEvent({
        type: 'tab',
        url: current.url,
        title: current.title || '',
        dwellSeconds,
        tabStartedAt: current.startedAt,
        timestamp: endedAt,
        prevUrl: current.url,
        prevTitle: current.title || '',
        payload: { intervalClosedBy: reason },
    }, currentActiveTabId);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === TELEMETRY_ALARM) {
        await checkExternalSession();
        await sampleBrowserTelemetry().catch(() => { });
        if (guardianIdleLastReportedAt) {
            const state = await chrome.idle.queryState(60).catch(() => 'idle');
            await reportGuardianIdleDelta(state);
        }
        return;
    }
    if (alarm.name === 'lifeos-guardian-poll') {
        await checkExternalSession();
        return;
    }
    if (alarm.name === 'lifeos-guardian-heartbeat') {
        if (!guardianActive || !sessionContext?.sessionId) {
            await checkExternalSession();
        }
        if (!guardianActive || !sessionContext?.sessionId) return;
        // Checkpoint sustained dwell so Activity begins at the session boundary
        // and stays current during a long-lived page such as a lecture video.
        // Canonical storage merges these adjacent 30-second chunks.
        await flushGuardianDwell('periodic_checkpoint');
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id && tab.url && !isPrivacyBlocked(tab.url)) {
            currentActiveTabId = tab.id;
            const groupInfo = await resolveTabGroup(tab.groupId);
            await reportTabActivity(tab.id, tab.url, tab.title || '', groupInfo);
        } else {
            await postGuardianEvent({ type: 'heartbeat' }, currentActiveTabId);
        }
    }
});

async function checkExternalSession() {
    try {
        const headers = await getAuthHeaders();
        const persisted = await LifeOSServerConfig.loadGuardianSession(chrome.storage.session);
        const request = await LifeOSServerConfig.requestGuardianState({
            storage: chrome.storage.local,
            fetchImpl: fetch,
            headers,
        });
        API_BASE = request.apiBase;
        const res = request.response;
        if (!res.ok) return;
        const data = await res.json();
        const serverActive = data.activeSession?.state === 'ACTIVE';

        if (serverActive) {
            const newlyDiscovered = !guardianActive;
            guardianActive = true;
            sessionContext = persisted?.sessionId === data.activeSession.sessionId
                ? { ...persisted, ...data.activeSession }
                : data.activeSession;
            await LifeOSServerConfig.saveGuardianSession(chrome.storage.session, sessionContext);
            if (!newlyDiscovered) return;
            console.log('[LifeOS] Discovered active session externally:', data.activeSession);
            sessionGroupId = null;
            refreshGuardianPersonalization();
            chrome.action.setBadgeText({ text: 'ON' });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
            activeTabs.clear();
            enableSessionCaptureAlarms();

            // Immediately track the active tab. Existing groups remain untouched.
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0] && !isPrivacyBlocked(tabs[0].url)) {
                    currentActiveTabId = tabs[0].id;
                    reportTabActivity(tabs[0].id, tabs[0].url, tabs[0].title || '', null);
                }
            });
        } else if (!serverActive && guardianActive) {
            console.log('[LifeOS] Guardian Mode STOPPED (via polling)');
            guardianActive = false;
            sessionContext = null;
            await LifeOSServerConfig.saveGuardianSession(chrome.storage.session, null);
            guardianPersonalization = null;
            chrome.action.setBadgeText({ text: '' });
            activeTabs.clear();
            disableSessionCaptureAlarms();
            clearPresenceNotifications().catch(() => { });
            if (sessionGroupId !== null) {
                chrome.tabGroups.update(sessionGroupId, { collapsed: true }).catch(() => { });
                sessionGroupId = null;
            }
        }
        if (!serverActive) await LifeOSServerConfig.saveGuardianSession(chrome.storage.session, null);
    } catch (e) {
        // ignore network error
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GUARDIAN_PAGE_EVIDENCE') {
        postGuardianPageEvidence(msg, sender)
            .then(() => sendResponse({ ok: true }))
            .catch(error => {
                console.warn('[LifeOS] Guardian evidence upload failed', error);
                sendResponse({ ok: false, error: String(error) });
            });
        return true;
    }
    if (msg.type === 'WAKE_COPILOT') {
        chrome.runtime.sendNativeMessage(
            'com.lifeos.copilot',
            { action: 'wake', requestedAt: new Date().toISOString() },
            (response) => {
                const error = chrome.runtime.lastError?.message;
                sendResponse(error
                    ? { ok: false, error }
                    : (response || { ok: false, error: 'Native helper returned no response' }));
            },
        );
        return true;
    }

    if (msg.type === 'START_GUARDIAN') {
        guardianActive = true;
        sessionContext = msg.context || msg;
        LifeOSServerConfig.saveGuardianSession(chrome.storage.session, sessionContext).catch(() => { });
        sessionGroupId = null;
        // Refresh domain config so this session gets the latest DB state
        fetchGuardianConfig();
        refreshGuardianPersonalization();
        console.log('[LifeOS] Guardian Mode ACTIVE', sessionContext);
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        activeTabs.clear();
        enableSessionCaptureAlarms();
        // Start SSE listener for ElevenLabs TTS playback
        if (sessionContext?.sessionId) startGuardianSSE(sessionContext.sessionId);
        // Capture the currently active tab IMMEDIATELY — tracks dwell from session start, not from first navigation.
        // Without this, the time on the first tab is always lost (activeTabs was just cleared).
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tab = tabs[0];
            if (tab?.url && !isPrivacyBlocked(tab.url)) {
                const sessionStart = LifeOSActivityState.guardianIntervalStart(
                    sessionContext.startedAt,
                    Date.now(),
                );
                activeTabs.set('current', {
                    url: tab.url,
                    title: tab.title || '',
                    startedAt: sessionStart,
                    tab_group_id: null,
                    tab_group_title: null,
                    tab_group_color: null,
                });
                // Send initial tab event so server registers currentUrl + currentTabStartedAt.
                // dwellSeconds=0 means no activity row is written — just URL registration.
                if (sessionContext?.sessionId) {
                    postGuardianEvent({
                        type: 'tab',
                        url: tab.url,
                        title: tab.title || '',
                        dwellSeconds: 0,
                        timestamp: sessionStart,
                    }).catch(() => { });
                }
                requestGuardianPageEvidence(tab.id, true).catch(() => { });
            }
        });
        sendResponse({ ok: true });
    }

    if (msg.type === 'STOP_GUARDIAN') {
        void (async () => {
            // Acknowledge the V2 flush before the web app asks the server to
            // finalize its 15-second evidence watermark.
            if (currentActiveTabId) {
                await requestGuardianPageEvidence(currentActiveTabId, false);
            }
            const current = activeTabs.get('current');
            if (current && current.url && sessionContext?.sessionId) {
                const finalDwellSeconds = Math.round((Date.now() - current.startedAt) / 1000);
                if (finalDwellSeconds > 5) {
                    await postGuardianEvent({
                        type: 'tab',
                        url: current.url,
                        title: current.title || '',
                        dwellSeconds: finalDwellSeconds,
                        tabStartedAt: current.startedAt,
                        timestamp: Date.now(),
                        prevUrl: current.url,
                        prevTitle: current.title || '',
                    }).catch(() => null);
                }
            }

            guardianActive = false;
            sessionContext = null;
            await LifeOSServerConfig.saveGuardianSession(chrome.storage.session, null);
            guardianPersonalization = null;
            console.log('[LifeOS] Guardian Mode STOPPED');
            chrome.action.setBadgeText({ text: '' });
            activeTabs.clear();
            disableSessionCaptureAlarms();
            await clearPresenceNotifications().catch(() => { });
            stopGuardianSSE();
            if (sessionGroupId !== null) {
                chrome.tabGroups.update(sessionGroupId, { collapsed: true }).catch(() => { });
                sessionGroupId = null;
            }
            sendResponse({ ok: true, flushed: true });
        })().catch(error => sendResponse({ ok: false, error: String(error) }));
        return true;
    }

    if (msg.type === 'GET_GUARDIAN_STATUS') {
        sendResponse(buildGuardianStatus());
    }

    // Force a fresh server check, then return updated status — used by popup on open
    if (msg.type === 'SYNC_SESSION') {
        checkExternalSession().then(() => {
            sendResponse(buildGuardianStatus());
        });
    }


    if (msg.type === 'GET_CURRENT_ACTIVITY') {
        const current = activeTabs.get('current');
        if (!current) { sendResponse(null); return; }
        let domain = '';
        try { domain = new URL(current.url).hostname.replace(/^www\./, ''); } catch { }
        sendResponse({
            activity: {
                url: current.url,
                domain,
                title: current.title || '',
                started_at: new Date(current.startedAt).toISOString(),
                tab_group_id: current.tab_group_id ?? -1,
                tab_group_title: current.tab_group_title ?? null,
                tab_group_color: current.tab_group_color ?? null,
            }
        });
    }

    if (msg.type === 'OPEN_SESSION_TAB') {
        if (!guardianActive || !sessionContext?.sessionId || typeof msg.url !== 'string') {
            sendResponse({ ok: false, error: 'No active Guardian session' });
            return true;
        }
        (async () => {
            try {
                const tab = await chrome.tabs.create({ url: msg.url, active: msg.active !== false });
                if (tab.id == null) throw new Error('Chrome did not return a tab id');
                if (tab.groupId !== -1) {
                    sendResponse({ ok: true, tabId: tab.id, grouped: false });
                    return;
                }
                if (sessionGroupId === null) await ensureSessionGroup(tab.id);
                else await addTabToSessionGroup(tab.id);
                sendResponse({ ok: true, tabId: tab.id, grouped: true });
            } catch (error) {
                sendResponse({ ok: false, error: String(error) });
            }
        })();
        return true;
    }

    // Agent Loop Actions -> Passed to guardian.js content script
    if (msg.type === 'BLOCK_TAB') {
        if (!guardianActive) return; // safety
        chrome.tabs.sendMessage(sender.tab ? sender.tab.id : msg.tabId, {
            type: 'BLOCK_TAB',
            reason: msg.reason,
            explainability: msg.explainability,
            targetDisplay: sessionContext?.conceptNodeName || sessionContext?.goalTitle || 'Focus Session',
            interventionPolicy: msg.interventionPolicy,
        });
        sendResponse({ ok: true });
    }

    if (msg.type === 'CLASSIFY_TOAST') {
        if (!guardianActive) return;
        chrome.tabs.sendMessage(sender.tab ? sender.tab.id : msg.tabId, {
            type: 'CLASSIFY_TOAST',
            conceptTitle: msg.conceptTitle
        });
        sendResponse({ ok: true });
    }

    if (msg.type === 'CLOSE_TAB') {
        if (sender.tab && sender.tab.id) chrome.tabs.remove(sender.tab.id);
        sendResponse({ ok: true });
    }

    if (msg.type === 'GUIDANCE_REQUEST') {
        if (!guardianActive || !sessionContext?.sessionId) {
            sendResponse({ ok: false, error: 'No active guardian session' });
            return true;
        }
        (async () => {
            try {
                const headers = await getAuthHeaders();
                await fetch(`${API_BASE}/guardian/guidance`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        sessionId: sessionContext.sessionId,
                        selectedText: msg.selectedText || '',
                        question: msg.question || 'Explain what I am looking at in the context of my session goal.',
                        appInFocus: 'Chrome',
                        windowTitle: msg.windowTitle || '',
                        source: msg.selectedText ? 'extension_selection' : 'extension_hotkey',
                    }),
                });
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
    }

    if (msg.type === 'REQUEST_OVERRIDE') {
        (async () => {
            try {
                const headers = await getAuthHeaders();
                const res = await fetch(`${API_BASE}/guardian/override`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        sessionId: sessionContext?.sessionId,
                        url: msg.url,
                        title: msg.title,
                        reason: msg.reason,
                        requestedMinutes: msg.requestedMinutes,
                    }),
                });
                const data = await res.json();
                if (data?.decision?.approved && sender.tab?.id) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'UNBLOCK_TAB',
                        reason: data.decision.reason,
                        explainability: data.decision.explainability,
                        ttlSeconds: data.decision.ttlMinutes * 60,
                    });
                } else if (sender.tab?.id) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'OVERRIDE_DECISION',
                        decision: data.decision,
                    });
                }
                sendResponse(data);
            } catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
        })();
    }

    return true;
});

// ═══════════════════════════════════════════════════════════════════════════════
// VOICE — Push-to-Talk (Cmd+Shift+Space) + ElevenLabs playback
// ═══════════════════════════════════════════════════════════════════════════════

let pttRecording = false;

async function ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) return;
    await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: 'Push-to-talk microphone capture and TTS audio playback',
    });
    // Wait until the offscreen document's message listener is registered.
    // Without this, sendMessage immediately after createDocument throws
    // "Receiving end does not exist" due to a race condition.
    await waitForOffscreenReady();
}

async function waitForOffscreenReady(maxWaitMs = 2000) {
    const step = 50;
    let waited = 0;
    while (waited < maxWaitMs) {
        try {
            // PING the offscreen doc — it replies when its listener is live.
            await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' });
            return; // got a reply — ready
        } catch {
            await new Promise(r => setTimeout(r, step));
            waited += step;
        }
    }
    // Timed out — proceed anyway (best-effort)
}

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'push-to-talk') return;
    if (!guardianActive || !sessionContext?.sessionId) {
        chrome.action.setBadgeText({ text: '' });
        return;
    }

    if (!pttRecording) {
        // Start recording
        pttRecording = true;
        try {
            await ensureOffscreenDocument();
            // Read storage fresh — service worker may have restarted and lost API_BASE
            const serverOrigin = (await getApiBase()).replace(/\/api$/, '');
            await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'START_RECORDING',
                sessionId: sessionContext?.sessionId || null,
                serverUrl: serverOrigin,
            });
            chrome.action.setBadgeText({ text: '\uD83C\uDF99' });
            chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
            broadcastPttState('recording');
        } catch (e) {
            console.error('[PTT] Start recording failed:', e);
            pttRecording = false;
            broadcastPttState('idle');
        }
    } else {
        // Stop recording — offscreen will send audio to server and play response
        pttRecording = false;
        try {
            broadcastPttState('sending');
            await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'STOP_RECORDING',
                sessionId: sessionContext?.sessionId || null,
            });
            chrome.action.setBadgeText({ text: guardianActive ? 'ON' : '' });
            chrome.action.setBadgeBackgroundColor({ color: guardianActive ? '#ef4444' : '#6b7280' });
        } catch (e) {
            console.error('[PTT] Stop recording failed:', e);
            broadcastPttState('idle');
        }
    }
});

// Handle messages from offscreen document
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RECORDING_STARTED') {
        console.log('[PTT] Recording started');
        broadcastPttState('recording');
    }
    if (msg.type === 'PTT_SENDING') {
        console.log('[PTT] Sending audio to server...');
        broadcastPttState('sending');
    }
    if (msg.type === 'PTT_SPEAKING') {
        console.log(`[PTT] Speaking. Transcript: "${msg.transcript}"`);
        broadcastPttState('speaking', msg.transcript);
    }
    if (msg.type === 'PTT_DONE') {
        console.log(`[PTT] Done. Transcript: "${msg.transcript}"`);
        broadcastPttState('done', msg.transcript);
        // Reset badge
        chrome.action.setBadgeText({ text: guardianActive ? 'ON' : '' });
    }
    if (msg.type === 'PTT_ERROR') {
        console.error('[PTT] Error:', msg.error);
        broadcastPttState('idle');
        chrome.action.setBadgeText({ text: guardianActive ? 'ON' : '' });
        pttRecording = false;
    }
    if (msg.type === 'RECORDING_ERROR') {
        console.error('[PTT] Mic error:', msg.error);
        broadcastPttState('idle');
        pttRecording = false;
        chrome.action.setBadgeText({ text: guardianActive ? 'ON' : '' });
    }
    if (msg.type === 'MIC_PERMISSION_NEEDED') {
        console.warn('[PTT] Mic permission not granted, reason:', msg.reason);
        pttRecording = false;
        chrome.action.setBadgeText({ text: guardianActive ? 'ON' : '' });
        // Broadcast a special state so the overlay shows a clear instruction
        broadcastPttState('permission');
        // Show a Chrome notification directing user to the popup
        chrome.notifications.create('lifeos-mic-permission', {
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'Microphone Access Needed',
            message: msg.reason === 'denied'
                ? 'Mic access is blocked. Go to Chrome \u2192 Settings \u2192 Site Settings to allow it for this extension.'
                : 'Click the LifeOS icon \u2192 "Enable Voice" to allow microphone access.',
            priority: 2,
        });
    }
});

/** Send PTT_STATE to the currently active tab so guardian.js can update the overlay. */
async function broadcastPttState(state, transcript = '') {
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) return;
        chrome.tabs.sendMessage(tab.id, { type: 'PTT_STATE', state, transcript }).catch(() => {});
    } catch {}
}

// SSE listener — guardian speaks via ElevenLabs → play on MacBook
let sseSource = null;

function startGuardianSSE(sessionId) {
    if (sseSource) { sseSource.close(); sseSource = null; }
    const url = `${API_BASE}/guardian/stream?sessionId=${encodeURIComponent(sessionId)}`;
    sseSource = new EventSource(url);

    sseSource.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'tts_speak' && data.text) {
                // Guardian wants to say something — play via ElevenLabs on MacBook
                await ensureOffscreenDocument();
                chrome.runtime.sendMessage({
                    target: 'offscreen',
                    type: 'PLAY_AUDIO_TEXT',
                    text: data.text,
                    sessionId,
                }).catch(() => { }); // offscreen may have closed between events — ignore
            }
        } catch { }
    };

    sseSource.onerror = () => {
        console.warn('[SSE] Stream error, will retry on next session');
        sseSource?.close();
        sseSource = null;
    };
}

function stopGuardianSSE() {
    if (sseSource) { sseSource.close(); sseSource = null; }
}
