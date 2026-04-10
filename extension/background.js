// LifeOS Guardian — Background Service Worker
// GUARDIAN MODE ONLY — Zero passive tracking. Absolutely silent outside active sessions.

const DEFAULT_API_BASE = 'http://localhost:3000/api';
let API_BASE = DEFAULT_API_BASE;

/** Always reads storage fresh — safe across service worker restarts. */
async function getApiBase() {
    const { apiUrl } = await chrome.storage.local.get('apiUrl');
    if (apiUrl) API_BASE = apiUrl;
    return API_BASE;
}

let guardianActive = false;

// Domain config — loaded from server at startup so no hardcoded lists.
// Falls back to empty arrays on network error (fail open: server handles blocking).
let PRIVACY_BLOCKED_DOMAINS = [];
let CONTEXT_SENSITIVE_DOMAINS = [];

async function fetchGuardianConfig() {
    try {
        const res = await fetch(`${API_BASE}/guardian/config`);
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
    const durationMinutes = sessionContext.durationMinutes || 60;
    const endsAt = sessionContext.endsAt || (sessionContext.startedAt ? sessionContext.startedAt + durationMinutes * 60 * 1000 : now);

    return {
        active: true,
        sessionId: sessionContext.sessionId,
        context: sessionContext,
        targetTitle: sessionContext.targetTitle || sessionContext.conceptNodeName || sessionContext.goalTitle || 'Focus Session',
        durationMinutes,
        remainingSeconds: Math.max(0, Math.round((endsAt - now) / 1000)),
        blockedCount: sessionContext.blockedCount || 0,
        overrideCount: sessionContext.overrideCount || 0,
        productiveSeconds: sessionContext.productiveSeconds || 0,
        distractionSeconds: sessionContext.distractionSeconds || 0,
    };
}

// Sync config
chrome.storage.local.get(['apiUrl'], (data) => {
    if (data.apiUrl) API_BASE = data.apiUrl;
});
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.apiUrl) {
        API_BASE = changes.apiUrl.newValue || 'http://localhost:3000/api';
    }
});

// Context Menu Setup
chrome.runtime.onInstalled.addListener(() => {
    console.log('[LifeOS] Guardian installed. Silent mode active.');
    chrome.contextMenus.create({
        id: "send-to-lifeos",
        title: "Extract Task to LifeOS",
        contexts: ["selection"]
    });
    chrome.alarms.create('lifeos-guardian-poll', { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create('lifeos-guardian-poll', { periodInMinutes: 0.5 });
});

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
    const data = await chrome.storage.local.get('apiKey');
    const headers = { 'Content-Type': 'application/json' };
    if (data.apiKey) headers.Authorization = `Bearer ${data.apiKey}`;
    return headers;
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
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/guardian/events`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                sessionId: sessionContext.sessionId,
                timestamp: Date.now(),
                ...payload,
            }),
        });

        if (res.status === 409) {
            guardianActive = false;
            sessionContext = null;
            activeTabs.clear();
            chrome.alarms.clear('lifeos-guardian-heartbeat');
            chrome.action.setBadgeText({ text: '' });
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!guardianActive) return; // HARD STOP — ZERO PROCESSING
    if (changeInfo.status !== 'complete') return;
    if (isPrivacyBlocked(tab.url)) return;

    // Auto-group the tab into the session group if it isn't already
    if (tab.groupId === -1 || tab.groupId !== sessionGroupId) {
        if (sessionGroupId !== null) {
            await addTabToSessionGroup(tabId);
        } else {
            await ensureSessionGroup(tabId);
        }
    }

    if (!tab.active) return; // Only track the active tab for focus scoring
    currentActiveTabId = tabId;

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
        if (isPrivacyBlocked(tab.url)) return;
        currentActiveTabId = activeInfo.tabId;
        const groupInfo = await resolveTabGroup(tab.groupId);
        reportTabActivity(activeInfo.tabId, tab.url, tab.title, groupInfo);
    } catch (e) { }
});

// Sync when Chrome window regains focus (e.g. user Alt-Tabs back after starting a session via Telegram)
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    if (!guardianActive) {
        await checkExternalSession();
    }
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

// New tab opened during an active session → add to session group
chrome.tabs.onCreated.addListener(async (tab) => {
    if (!guardianActive) return;
    // Give the tab a moment to settle (it may already be getting a URL)
    setTimeout(async () => {
        try {
            const fresh = await chrome.tabs.get(tab.id);
            if (isPrivacyBlocked(fresh.url)) return;
            if (sessionGroupId !== null) {
                await addTabToSessionGroup(fresh.id);
            } else {
                await ensureSessionGroup(fresh.id);
            }
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
    if (!guardianActive || !sessionContext?.sessionId) return; // HARD STOP

    const idleSeconds = (state === 'idle' || state === 'locked') ? 60 : 0;

    await postGuardianEvent({
        type: 'idle',
        url: 'lifeos://idle',
        title: 'User Idle State',
        idleSeconds,
    }, currentActiveTabId);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'lifeos-guardian-poll') {
        await checkExternalSession();
        return;
    }
    if (alarm.name === 'lifeos-guardian-heartbeat') {
        if (!guardianActive || !sessionContext?.sessionId) return;
        await postGuardianEvent({ type: 'heartbeat' }, currentActiveTabId);
    }
});

async function checkExternalSession() {
    try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/guardian/state`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        const serverActive = data.activeSession?.state === 'ACTIVE';

        if (serverActive && !guardianActive) {
            console.log('[LifeOS] Discovered active session externally:', data.activeSession);
            guardianActive = true;
            sessionContext = data.activeSession;
            sessionGroupId = null;
            chrome.action.setBadgeText({ text: 'ON' });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
            activeTabs.clear();
            chrome.alarms.create('lifeos-guardian-heartbeat', { periodInMinutes: 0.5 });

            // Immediately track + group the currently-active tab so tracking starts now
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0] && !isPrivacyBlocked(tabs[0].url)) {
                    currentActiveTabId = tabs[0].id;
                    ensureSessionGroup(tabs[0].id);
                    reportTabActivity(tabs[0].id, tabs[0].url, tabs[0].title || '', null);
                }
            });
        } else if (!serverActive && guardianActive) {
            console.log('[LifeOS] Guardian Mode STOPPED (via polling)');
            guardianActive = false;
            sessionContext = null;
            chrome.action.setBadgeText({ text: '' });
            activeTabs.clear();
            chrome.alarms.clear('lifeos-guardian-heartbeat');
            if (sessionGroupId !== null) {
                chrome.tabGroups.update(sessionGroupId, { collapsed: true }).catch(() => { });
                sessionGroupId = null;
            }
        }
    } catch (e) {
        // ignore network error
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_GUARDIAN') {
        guardianActive = true;
        sessionContext = msg.context || msg;
        sessionGroupId = null;
        // Refresh domain config so this session gets the latest DB state
        fetchGuardianConfig();
        console.log('[LifeOS] Guardian Mode ACTIVE', sessionContext);
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        activeTabs.clear();
        chrome.alarms.create('lifeos-guardian-heartbeat', { periodInMinutes: 0.5 });
        // Start SSE listener for ElevenLabs TTS playback
        if (sessionContext?.sessionId) startGuardianSSE(sessionContext.sessionId);
        // Capture the currently active tab IMMEDIATELY — tracks dwell from session start, not from first navigation.
        // Without this, the time on the first tab is always lost (activeTabs was just cleared).
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tab = tabs[0];
            if (tab?.url && !isPrivacyBlocked(tab.url)) {
                const sessionStart = Date.now();
                activeTabs.set('current', {
                    url: tab.url,
                    title: tab.title || '',
                    startedAt: sessionStart,
                    tab_group_id: null,
                    tab_group_title: null,
                    tab_group_color: null,
                });
                ensureSessionGroup(tab.id);
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
            }
        });
        sendResponse({ ok: true });
    }

    if (msg.type === 'STOP_GUARDIAN') {
        // Flush the final tab's dwell time before clearing state.
        // The server flushes on endGuardianSession too, but this extension-side flush
        // ensures the event reaches the server before the session closes.
        const current = activeTabs.get('current');
        if (current && current.url && sessionContext?.sessionId) {
            const finalDwellSeconds = Math.round((Date.now() - current.startedAt) / 1000);
            if (finalDwellSeconds > 5) {
                // Fire-and-forget: send the final tab event (don't await — we're stopping).
                // tabStartedAt gives the server the exact start time so started_at is accurate.
                postGuardianEvent({
                    type: 'tab',
                    url: current.url,
                    title: current.title || '',
                    dwellSeconds: finalDwellSeconds,
                    tabStartedAt: current.startedAt,
                    timestamp: Date.now(),
                    prevUrl: current.url,
                    prevTitle: current.title || '',
                }).catch(() => { });
            }
        }

        guardianActive = false;
        sessionContext = null;
        console.log('[LifeOS] Guardian Mode STOPPED');
        chrome.action.setBadgeText({ text: '' });
        activeTabs.clear();
        chrome.alarms.clear('lifeos-guardian-heartbeat');
        stopGuardianSSE();
        // Collapse the session group so it's preserved but out of the way
        if (sessionGroupId !== null) {
            chrome.tabGroups.update(sessionGroupId, { collapsed: true }).catch(() => { });
            sessionGroupId = null;
        }
        sendResponse({ ok: true });
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

    // Agent Loop Actions -> Passed to guardian.js content script
    if (msg.type === 'BLOCK_TAB') {
        if (!guardianActive) return; // safety
        chrome.tabs.sendMessage(sender.tab ? sender.tab.id : msg.tabId, {
            type: 'BLOCK_TAB',
            reason: msg.reason,
            targetDisplay: sessionContext?.conceptNodeName || sessionContext?.goalTitle || 'Focus Session'
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

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENSHOTS — Capture MacBook screen every 60s via captureVisibleTab()
// ═══════════════════════════════════════════════════════════════════════════════

const SCREENSHOT_SENSITIVE_PATTERNS = [
    /1password/i, /keychain/i, /bitwarden/i, /lastpass/i,
    /chrome:\/\/password/i, /accounts\.google\.com/i,
];

chrome.alarms.create('lifeos-screenshot', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'lifeos-screenshot') return;

    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id || !tab.url) return;

        // Skip sensitive pages
        if (SCREENSHOT_SENSITIVE_PATTERNS.some(p => p.test(tab.url) || p.test(tab.title || ''))) return;
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 50 });
        if (!dataUrl) return;

        // Convert data URL to blob
        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });

        const form = new FormData();
        form.append('screenshot', blob, 'screen.jpg');
        form.append('url', tab.url);
        form.append('title', tab.title || '');
        form.append('source', 'extension_screenshot');
        if (sessionContext?.sessionId) form.append('sessionId', sessionContext.sessionId);

        const headers = await getAuthHeaders();
        delete headers['Content-Type']; // let browser set multipart boundary
        await fetch(`${API_BASE}/daemon/ingest`, { method: 'POST', body: form, headers });
    } catch (e) {
        // Silent fail — screenshots are best-effort
        if (!String(e).includes('No tab') && !String(e).includes('capture')) {
            console.warn('[Screenshot] Capture failed:', e);
        }
    }
});
