// LifeOS Guardian — Background Service Worker
// GUARDIAN MODE ONLY — Zero passive tracking. Absolutely silent outside active sessions.

let API_BASE = 'http://localhost:3000/api';
let guardianActive = false;
let sessionContext = null;
let currentActiveTabId = null;
let sessionGroupId = null; // Chrome tab group for the active session

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
        const PRIVACY_BLOCKED_DOMAINS = [
            'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'fidelity.com',
            'paypal.com', 'venmo.com', 'robinhood.com', 'coinbase.com',
            'mychart.com', 'myhealth.va.gov', 'patient.info',
            'accounts.google.com', 'login.microsoftonline.com', 'auth0.com',
            'web.whatsapp.com', 'web.telegram.org'
        ];
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
            chrome.tabs.sendMessage(targetTabId, {
                type: 'BLOCK_TAB',
                reason: command.reason,
                explainability: command.explainability,
                targetDisplay: command.targetDisplay || sessionContext?.conceptNodeName || sessionContext?.goalTitle || 'Focus Session',
                urlPattern: command.urlPattern,
            });
        }

        if (command.type === 'unblock') {
            chrome.tabs.sendMessage(targetTabId, {
                type: 'UNBLOCK_TAB',
                reason: command.reason,
                explainability: command.explainability,
                ttlSeconds: command.ttlSeconds,
            });
        }

        if (command.type === 'classify') {
            chrome.tabs.sendMessage(targetTabId, {
                type: 'CLASSIFY_TOAST',
                conceptTitle: command.conceptTitle,
            });
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
    if (!guardianActive) return; // HARD STOP
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (isPrivacyBlocked(tab.url)) return;
        currentActiveTabId = activeInfo.tabId;
        const groupInfo = await resolveTabGroup(tab.groupId);
        reportTabActivity(activeInfo.tabId, tab.url, tab.title, groupInfo);
    } catch (e) { }
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

    // Calculate dwell time of the previous tab
    let dwellSeconds = 0;
    if (activeTabs.has('current')) {
        const prev = activeTabs.get('current');
        dwellSeconds = Math.round((Date.now() - prev.startedAt) / 1000);

        // Prevent spamming the same URL
        if (prev.url === url) return;
    }

    activeTabs.set('current', {
        url,
        title,
        startedAt: Date.now(),
        tab_group_id: groupInfo?.id ?? -1,
        tab_group_title: groupInfo?.title ?? null,
        tab_group_color: groupInfo?.color ?? null,
    });

    await postGuardianEvent({
        type: 'tab',
        url,
        title,
        dwellSeconds,
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
        const res = await fetch(`${API_BASE}/extension/session`, { headers });
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

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0] && !isPrivacyBlocked(tabs[0].url)) {
                    ensureSessionGroup(tabs[0].id);
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
        console.log('[LifeOS] Guardian Mode ACTIVE', sessionContext);
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        activeTabs.clear();
        chrome.alarms.create('lifeos-guardian-heartbeat', { periodInMinutes: 0.5 });
        // Group the currently active tab immediately
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && !isPrivacyBlocked(tabs[0].url)) {
                ensureSessionGroup(tabs[0].id);
            }
        });
        sendResponse({ ok: true });
    }

    if (msg.type === 'STOP_GUARDIAN') {
        guardianActive = false;
        sessionContext = null;
        console.log('[LifeOS] Guardian Mode STOPPED');
        chrome.action.setBadgeText({ text: '' });
        activeTabs.clear();
        chrome.alarms.clear('lifeos-guardian-heartbeat');
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
