// LifeOS — Background Service Worker
// Tracks active tab, time on page, and polls for nudges

let API_BASE = 'http://localhost:3000/api';
let DEVICE_NAME = 'MacBook';

chrome.storage.local.get(['apiUrl', 'deviceName'], (data) => {
    if (data.apiUrl) API_BASE = data.apiUrl;
    if (data.deviceName) DEVICE_NAME = data.deviceName;
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.apiUrl) API_BASE = changes.apiUrl.newValue || 'http://localhost:3000/api';
        if (changes.deviceName) DEVICE_NAME = changes.deviceName.newValue || 'MacBook';
    }
});
const NUDGE_INTERVAL_MS = 60000; // Check nudges every 60s
const IDLE_THRESHOLD_S = 60; // 1 minute (Stanford target)

// Privacy & Scalability thresholds
const MICRO_CONTEXT_THRESHOLD_S = 12; // Visits shorter than this are bundled

// Privacy blocklist — domain-level matching only (no false positives on substrings)
const PRIVACY_BLOCKED_DOMAINS = new Set([
    // Finance
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'fidelity.com',
    'paypal.com', 'venmo.com', 'robinhood.com', 'coinbase.com',
    // Medical
    'mychart.com', 'myhealth.va.gov', 'patient.info',
    // Auth pages (standalone auth providers)
    'accounts.google.com', 'login.microsoftonline.com', 'auth0.com',
    // Private messaging (NOT Slack/Discord — those are work tools)
    'web.whatsapp.com', 'web.telegram.org',
]);

// URL patterns that should never be tracked (protocol-level)
const PRIVACY_URL_PATTERNS = [
    /^chrome:\/\//i,
    /^chrome-extension:\/\//i,
    /^about:/i,
    /^file:\/\//i,
];

function isPrivacyBlocked(url, domain) {
    // Check URL protocol patterns
    for (const pattern of PRIVACY_URL_PATTERNS) {
        if (pattern.test(url)) return true;
    }
    // Check exact domain matches
    if (PRIVACY_BLOCKED_DOMAINS.has(domain)) return true;
    // Check if any blocked domain is a suffix (e.g. 'online.chase.com' matches 'chase.com')
    for (const blocked of PRIVACY_BLOCKED_DOMAINS) {
        if (domain.endsWith('.' + blocked)) return true;
    }
    return false;
}

let currentActivity = null;
let isUserActive = true;

// --- Focus Session State ---
let focusSession = null; // { active, sessionId, goalId, goalTitle, taskId, taskTitle, startedAt, durationMinutes, activitiesLog, blockedCount, overrideCount, tabGroupId }

// Ensure alarms exist (called on install AND startup)
function ensureAlarms() {
    chrome.alarms.get('flushActivities', (alarm) => {
        if (!alarm) chrome.alarms.create('flushActivities', { periodInMinutes: 0.167 });
    });
    chrome.alarms.get('checkNudge', (alarm) => {
        if (!alarm) chrome.alarms.create('checkNudge', { periodInMinutes: 0.5 });
    });
}

// Initialize
chrome.runtime.onInstalled.addListener(() => {
    console.log('LifeOS Tracker installed');
    ensureAlarms();
    // Phase 20: Context Menu
    chrome.contextMenus.create({
        id: "send-to-lifeos",
        title: "Extract Task to LifeOS",
        contexts: ["selection"]
    });
});

// Re-create alarms on service worker startup (Chrome kills workers aggressively)
chrome.runtime.onStartup.addListener(() => {
    ensureAlarms();
});

// Also ensure alarms on every activation (belt and suspenders)
ensureAlarms();

// Track tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        handleTabChange(tab);
    } catch (e) { }
});

// Track URL changes within same tab
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
        handleTabChange(tab);
    }
});

// Track window focus
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        // Window lost focus. 
        // Check if the current tab is playing audio before we kill the session (e.g., dual monitor YouTube)
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (activeTab && activeTab.audible) {
                // Keep tracking if audio is playing in the background
                isUserActive = true;
            } else {
                isUserActive = false;
                finalizeCurrentActivity();
            }
        });
    } else {
        // Window gained focus — start tracking active tab
        isUserActive = true;
        chrome.tabs.query({ active: true, windowId }, (tabs) => {
            if (tabs[0]) handleTabChange(tabs[0]);
        });
    }
});

// Idle detection
chrome.idle.setDetectionInterval(IDLE_THRESHOLD_S);
chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'active') {
        isUserActive = true;
        // Resume tracking
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) handleTabChange(tabs[0]);
        });
    } else {
        // User went idle (walked away). 
        // We do the same check: if music/podcast is playing, keep tracking it loosely as active
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (activeTab && activeTab.audible) {
                isUserActive = true;
            } else {
                isUserActive = false;
                finalizeCurrentActivity();
            }
        });
    }
});

// Handle tab change with 200ms debounce to prevent SPA navigation spam
let handleTabChangeTimeout = null;
function handleTabChange(tab) {
    // Capture tab properties immediately (tab object may become stale)
    const snapshot = {
        url: tab.url, title: tab.title, id: tab.id,
        active: tab.active, audible: tab.audible,
        groupId: tab.groupId ?? -1  // -1 = ungrouped
    };
    if (handleTabChangeTimeout) clearTimeout(handleTabChangeTimeout);
    handleTabChangeTimeout = setTimeout(() => {
        _handleTabChange(snapshot);
    }, 200);
}

function _handleTabChange(tab) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        return;
    }

    const newDomain = extractDomain(tab.url);

    // 1. Check Privacy Blocklist (domain-level, not substring)
    if (isPrivacyBlocked(tab.url, newDomain)) {
        finalizeCurrentActivity();
        currentActivity = null;
        return;
    }

    // Track tab switch for focus/entropy analysis
    if (currentActivity && currentActivity.domain !== newDomain) {
        chrome.storage.local.get('apiKey', (data) => {
            const apiKey = data.apiKey;
            try {
                fetch(`${API_BASE}/behavior`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                    body: JSON.stringify({
                        type: 'tab_switch',
                        from_domain: currentActivity.domain,
                        to_domain: newDomain,
                        from_category: currentActivity._category || '',
                        to_category: '',
                        from_workspace: currentActivity.tab_group_title || null,
                        to_workspace_group_id: tab.groupId !== -1 ? tab.groupId : null,
                    }),
                }).catch(() => { });
            } catch (e) { }
        });
    }

    // Ignore updates that don't change the URL (e.g., hash changes or title updates in SPAs)
    // Unless we're returning from an idle state where currentActivity was cleared
    if (currentActivity && currentActivity.url === tab.url && isUserActive) {
        // Just update title if it changed
        currentActivity.title = tab.title || currentActivity.title;
        return;
    }

    // Finalize previous activity
    finalizeCurrentActivity();

    // Start new activity
    currentActivity = {
        url: tab.url,
        domain: newDomain,
        title: tab.title || '',
        started_at: new Date().toISOString(),
        _originalStartedAt: new Date().toISOString(), // Preserved across flush resets for accurate total time-on-site
        youtube_video_id: null,
        youtube_channel: null,
        _category: null, // filled by backend response
        is_actively_interacting: true, // Defaults to true on fresh tab load
        tab_group_id: -1,
        tab_group_title: null,
        tab_group_color: null,
    };

    // If YouTube, the content script will send video details
    if (newDomain === 'youtube.com' || newDomain === 'www.youtube.com' || newDomain === 'm.youtube.com') {
        const videoId = extractYouTubeVideoId(tab.url);
        if (videoId) {
            currentActivity.youtube_video_id = videoId;
        }
    }

    // Resolve tab group (workspace) info
    if (tab.groupId && tab.groupId !== -1 && chrome.tabGroups) {
        try {
            chrome.tabGroups.get(tab.groupId, (group) => {
                if (chrome.runtime.lastError || !group) return;
                if (currentActivity && currentActivity.url === tab.url) {
                    currentActivity.tab_group_id = group.id;
                    currentActivity.tab_group_title = group.title || null;
                    currentActivity.tab_group_color = group.color || null;
                    chrome.storage.local.set({ currentActivity });
                }
            });
        } catch (e) { /* tabGroups API not available */ }
    }

    // Save to local storage
    chrome.storage.local.set({ currentActivity });
}

// Add activity to queue
async function queueActivity(activity) {
    const data = await chrome.storage.local.get('pendingActivities');
    const pending = data.pendingActivities || [];
    pending.push(activity);
    if (pending.length > 500) pending.splice(0, pending.length - 500);
    await chrome.storage.local.set({ pendingActivities: pending });
}

// Finalize and send current activity
async function finalizeCurrentActivity(overrideEndTime = null, interactionOverride = null) {
    if (!currentActivity) return;

    const now = overrideEndTime || new Date().toISOString();
    const startTime = new Date(currentActivity.started_at).getTime();
    const endTime = new Date(now).getTime();
    const durationSeconds = Math.round((endTime - startTime) / 1000);

    // Only log if > 2 seconds
    if (durationSeconds < 2) {
        currentActivity = null;
        return;
    }

    // Micro-Context Filtering
    // If user hopped tabs too fast (<15s), abstract it to save DB bloat
    const actualActivity = {
        ...currentActivity,
        ended_at: now,
        duration_seconds: durationSeconds,
        device_name: DEVICE_NAME,
        is_actively_interacting: interactionOverride !== null ? interactionOverride : (currentActivity.is_actively_interacting !== false)
    };

    if (durationSeconds <= MICRO_CONTEXT_THRESHOLD_S) {
        actualActivity.url = 'lifeos://context-switch';
        actualActivity.domain = 'context-switch';
        actualActivity.title = 'Micro-Context Switching';
        actualActivity.youtube_video_id = null;
        actualActivity.youtube_channel = null;
    }

    currentActivity = null;
    chrome.storage.local.remove('currentActivity');

    // Log activity to focus session if active
    if (focusSession && focusSession.active && actualActivity.domain !== 'context-switch') {
        focusSession.activitiesLog.push({
            url: actualActivity.url,
            domain: actualActivity.domain,
            title: actualActivity.title,
            category: actualActivity._category || 'neutral',
            duration_seconds: actualActivity.duration_seconds,
            started_at: actualActivity.started_at,
        });
        // Cap log size to prevent memory issues
        if (focusSession.activitiesLog.length > 200) {
            focusSession.activitiesLog.splice(0, focusSession.activitiesLog.length - 200);
        }
        chrome.storage.local.set({ focusSession });
    }

    // Attempt to merge with the last pending activity if it's identical
    const data = await chrome.storage.local.get('pendingActivities');
    const pending = data.pendingActivities || [];

    if (pending.length > 0) {
        const last = pending[pending.length - 1];
        const isSameUrl = last.url === actualActivity.url;
        const isSameVideo = last.youtube_video_id === actualActivity.youtube_video_id;

        // If it's the exact same activity and happened roughly contiguously (within 60s), just extend it
        if (isSameUrl && isSameVideo) {
            const gapSeconds = Math.round((new Date(actualActivity.started_at).getTime() - new Date(last.ended_at).getTime()) / 1000);
            if (gapSeconds < 60) {
                last.duration_seconds += actualActivity.duration_seconds;
                last.ended_at = actualActivity.ended_at;
                await chrome.storage.local.set({ pendingActivities: pending });
                return;
            }
        }
    }

    await queueActivity(actualActivity);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'flushActivities') {
        // Send current activity checkpoint (keep tracking)
        if (currentActivity && isUserActive) {
            const now = new Date().toISOString();
            const durationSeconds = Math.round(
                (new Date(now).getTime() - new Date(currentActivity.started_at).getTime()) / 1000
            );

            if (durationSeconds >= 5) {
                const activityCheckpoint = {
                    ...currentActivity,
                    ended_at: now,
                    duration_seconds: durationSeconds,
                };

                // Merge this periodic checkpoint via our merge-aware finalizer
                const data = await chrome.storage.local.get('pendingActivities');
                const pending = data.pendingActivities || [];
                let merged = false;

                if (pending.length > 0) {
                    const last = pending[pending.length - 1];
                    const isSameUrl = last.url === activityCheckpoint.url;
                    const isSameVideo = last.youtube_video_id === activityCheckpoint.youtube_video_id;

                    if (isSameUrl && isSameVideo) {
                        const gapSeconds = Math.round((new Date(activityCheckpoint.started_at).getTime() - new Date(last.ended_at).getTime()) / 1000);
                        if (gapSeconds < 60) {
                            last.duration_seconds += activityCheckpoint.duration_seconds;
                            last.ended_at = activityCheckpoint.ended_at;
                            await chrome.storage.local.set({ pendingActivities: pending });
                            merged = true;
                        }
                    }
                }

                if (!merged) {
                    await queueActivity(activityCheckpoint);
                }

                // Reset started_at for next checkpoint window, but keep _originalStartedAt
                currentActivity.started_at = now;
                // _originalStartedAt stays the same — tracks true start of this site visit
                await chrome.storage.local.set({ currentActivity });
            }
        }

        // Flush pending activities in a batch
        const dataInfo = await chrome.storage.local.get(['pendingActivities', 'apiKey']);
        const pendingActivities = dataInfo.pendingActivities;
        const apiKey = dataInfo.apiKey;

        if (pendingActivities && pendingActivities.length > 0) {
            try {
                const res = await fetch(`${API_BASE}/activity/batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                    body: JSON.stringify({ activities: pendingActivities }),
                });
                if (res.ok) {
                    await chrome.storage.local.set({ pendingActivities: [] });
                }
            } catch (e) {
                // Keep pending if fetch fails
            }
        }
    }

    if (alarm.name === 'focusSessionEnd') {
        // Focus session timer expired — auto-complete
        console.log('[LifeOS] Focus session timer expired, completing...');
        await endFocusSession('completed');
    }

    if (alarm.name === 'checkNudge' || alarm.name === 'focusNudge') {
        if (!currentActivity || !isUserActive) return;

        const domain = currentActivity.domain;
        // Use _originalStartedAt for accurate total time on site (started_at is reset every 10s flush)
        const actualStart = currentActivity._originalStartedAt || currentActivity.started_at;
        const minutesOnSite = Math.round(
            (Date.now() - new Date(actualStart).getTime()) / 60000
        );

        const inFocus = focusSession && focusSession.active;

        // --- 🎯 Focus Session Drift Detection (runs every 30s during focus) ---
        if (inFocus && alarm.name === 'focusNudge') {
            const sessionGoal = focusSession.taskTitle || focusSession.goalTitle || 'your task';
            const log = focusSession.activitiesLog || [];
            const now = Date.now();

            // Deduplication: don't spam the same alert type within 3 minutes
            if (!focusSession._lastAlerts) focusSession._lastAlerts = {};
            const canAlert = (type) => {
                const last = focusSession._lastAlerts[type] || 0;
                if (now - last < 180000) return false; // 3 min cooldown
                focusSession._lastAlerts[type] = now;
                return true;
            };

            // Known tool domains that should NEVER trigger "you're off-task" alerts
            // (these are allowed even if you've been there a while)
            const TOOL_DOMAINS = new Set([
                'google.com', 'github.com', 'gitlab.com', 'stackoverflow.com',
                'stackexchange.com', 'developer.mozilla.org', 'wikipedia.org',
                'en.wikipedia.org', 'localhost', 'notion.so', 'docs.google.com',
                'chat.openai.com', 'chatgpt.com', 'claude.ai', 'gemini.google.com',
                'npmjs.com', 'pypi.org', 'drive.google.com', 'figma.com',
            ]);
            const isToolDomain = (d) => {
                if (TOOL_DOMAINS.has(d)) return true;
                for (const tool of TOOL_DOMAINS) { if (d.endsWith('.' + tool)) return true; }
                return false;
            };

            // ── CHECK 1: Time-on-current-site (catches "stayed on YouTube 15 min") ──
            // If you've been on a single non-tool site for 3+ minutes, alert.
            // This is the KEY check the old system missed entirely.
            if (minutesOnSite >= 3 && !isToolDomain(domain)) {
                // Check if evaluate cache flagged this domain as distraction
                const wasFlaggedDistraction = [...evaluationCache.values()].some(
                    v => v.isDistraction && new URL(currentActivity.url).hostname.includes(domain)
                );

                if (wasFlaggedDistraction && canAlert('time-on-distraction')) {
                    chrome.notifications.create('focus-time-distraction', {
                        type: 'basic',
                        iconUrl: 'icons/icon128.png',
                        title: '🎯 You\'ve been distracted for ' + minutesOnSite + ' minutes!',
                        message: `You're still on ${domain}. Your focus: "${sessionGoal}". Close this tab and get back to work!`,
                        priority: 2,
                    });
                } else if (minutesOnSite >= 8 && !wasFlaggedDistraction && canAlert('time-on-unknown')) {
                    // Even if not flagged, 8+ min on a single non-tool site is suspicious
                    chrome.notifications.create('focus-long-visit', {
                        type: 'basic',
                        iconUrl: 'icons/icon128.png',
                        title: '⏰ ' + minutesOnSite + ' minutes on ' + domain,
                        message: `Is this still related to "${sessionGoal}"? If not, time to refocus.`,
                        priority: 1,
                    });
                }
            }

            // ── CHECK 2: Rapid context-switching (many domains in short time) ──
            // Count unique domains visited in the last 3 minutes (time-based, not count-based)
            const threeMinAgo = new Date(now - 180000).toISOString();
            const recentVisits = log.filter(a => a.started_at > threeMinAgo);
            if (recentVisits.length >= 4) {
                const uniqueRecentDomains = new Set(recentVisits.map(a => a.domain)).size;
                if (uniqueRecentDomains >= 4 && canAlert('context-switching')) {
                    chrome.notifications.create('focus-context-switch', {
                        type: 'basic',
                        iconUrl: 'icons/icon128.png',
                        title: '🔄 Slow down — ' + uniqueRecentDomains + ' sites in 3 minutes',
                        message: `You're jumping between tabs too fast. Deep work on "${sessionGoal}" needs sustained attention.`,
                        priority: 2,
                    });
                }
            }

            // ── CHECK 3: Override abuse (3+ overrides in a session) ──
            if (focusSession.overrideCount >= 3 && canAlert('override-abuse')) {
                chrome.notifications.create('focus-override-warn', {
                    type: 'basic',
                    iconUrl: 'icons/icon128.png',
                    title: '⚠️ ' + focusSession.overrideCount + ' overrides used',
                    message: `You've bypassed ${focusSession.overrideCount} blocks. Are these sites really needed for "${sessionGoal}"?`,
                    priority: 2,
                });
            }

            // ── CHECK 4: Blocked-to-time ratio (if getting blocked a lot) ──
            // If 3+ pages were blocked in the session, you're clearly trying to go off-task
            const sessionMinutes = Math.round((now - focusSession.startedAt) / 60000);
            if (focusSession.blockedCount >= 3 && sessionMinutes >= 5 && canAlert('blocked-ratio')) {
                chrome.notifications.create('focus-blocked-warn', {
                    type: 'basic',
                    iconUrl: 'icons/icon128.png',
                    title: '� ' + focusSession.blockedCount + ' distractions blocked!',
                    message: `Your brain is resisting focus. Take a 30-second breath, then commit to "${sessionGoal}" for the next 10 minutes.`,
                    priority: 2,
                });
            }
        }

        // --- General nudge (AI-driven, runs every 1 min) ---
        try {
            const dataInfo = await chrome.storage.local.get('apiKey');
            const apiKey = dataInfo.apiKey;

            const videoIdParam = currentActivity.youtube_video_id ? `&videoId=${encodeURIComponent(currentActivity.youtube_video_id)}` : '';
            const focusParam = inFocus ? `&focusMode=true&focusGoal=${encodeURIComponent(focusSession.goalTitle || focusSession.taskTitle || '')}` : '';
            const res = await fetch(
                `${API_BASE}/nudge?url=${encodeURIComponent(currentActivity.url)}&domain=${encodeURIComponent(domain)}&minutes=${minutesOnSite}&title=${encodeURIComponent(currentActivity.title || '')}${videoIdParam}${focusParam}`,
                { headers: { ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) } }
            );
            const data = await res.json();

            if (data.nudge && data.message) {
                chrome.notifications.create('lifeos-nudge', {
                    type: 'basic',
                    iconUrl: 'icons/icon128.png',
                    title: inFocus ? '🎯 Focus Session — Refocus!' : '⚡ LifeOS — Refocus!',
                    message: data.message,
                    priority: 2,
                });
            }
        } catch (e) { }
    }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'YOUTUBE_VIDEO_INFO') {
        if (currentActivity) {
            currentActivity.youtube_video_id = message.videoId || currentActivity.youtube_video_id;
            currentActivity.youtube_channel = message.channel || currentActivity.youtube_channel;
            if (message.title) currentActivity.title = message.title;
        }
        sendResponse({ ok: true });
    }

    if (message.type === 'PAGE_META_INFO') {
        if (currentActivity && currentActivity.url === message.url) {
            currentActivity.meta_description = message.metaDescription || '';
            currentActivity.h1_text = message.h1Text || '';
        }
        sendResponse({ ok: true });
    }

    if (message.type === 'GET_CURRENT_ACTIVITY') {
        sendResponse({ activity: currentActivity, isActive: isUserActive });
    }

    // Phase 21: Override Logging — AI Learning Signal
    if (message.type === 'LOG_OVERRIDE') {
        chrome.storage.local.get('apiKey', (data) => {
            const apiKey = data.apiKey;
            fetch(`${API_BASE}/extension/override`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                body: JSON.stringify({
                    url: message.url,
                    title: message.title,
                    reason: message.reason
                })
            }).catch(() => { });
        });
        sendResponse({ ok: true });
    }

    // Phase 21: Close Tab from block overlay
    if (message.type === 'CLOSE_TAB') {
        if (sender.tab && sender.tab.id) {
            chrome.tabs.remove(sender.tab.id);
        }
        sendResponse({ ok: true });
    }

    // Phase 24: Micro-Interaction Detection
    if (message.type === 'MICRO_IDLE_STATE_CHANGED') {
        if (currentActivity && sender.tab && sender.tab.active) {
            // We transitioned from idle->active or active->idle
            const transitionTime = new Date(message.lastInteraction + 60000).toISOString(); // roughly when the threshold was crossed

            // Finalize the previous chunk (which was whatever the OPPOSITE of the new state is)
            finalizeCurrentActivity(transitionTime, !message.isIdle);

            // Start the new chunk tracking perfectly
            chrome.tabs.get(sender.tab.id, (tab) => {
                if (chrome.runtime.lastError) return;
                handleTabChange(tab);
                // Immediately fix the new chunk to reflect the current idle state
                if (currentActivity) {
                    currentActivity.started_at = transitionTime;
                    currentActivity.is_actively_interacting = !message.isIdle;
                }
            });
        }
        sendResponse({ ok: true });
    }

    // Phase 21: Focus Session Management
    if (message.type === 'START_FOCUS') {
        (async () => {
            try {
                const dataInfo = await chrome.storage.local.get('apiKey');
                const apiKey = dataInfo.apiKey;

                // Start session on backend
                const res = await fetch(`${API_BASE}/focus-session`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                    body: JSON.stringify({
                        action: 'start',
                        goalId: message.goalId || null,
                        goalTitle: message.goalTitle || null,
                        taskId: message.taskId || null,
                        taskTitle: message.taskTitle || null,
                        durationMinutes: message.durationMinutes || 60,
                    })
                });

                const data = await res.json();

                // Initialize focus session state
                focusSession = {
                    active: true,
                    sessionId: data.sessionId,
                    goalId: message.goalId || null,
                    goalTitle: message.goalTitle || null,
                    taskId: message.taskId || null,
                    taskTitle: message.taskTitle || null,
                    startedAt: Date.now(),
                    durationMinutes: message.durationMinutes || 60,
                    activitiesLog: [],
                    blockedCount: 0,
                    overrideCount: 0,
                    tabGroupId: -1,
                };

                // Clear evaluation cache so all pages get re-evaluated in focus context
                evaluationCache.clear();

                // Auto-create a Chrome tab group for this session
                try {
                    const tabs = await chrome.tabs.query({ currentWindow: true, active: true });
                    if (tabs[0]) {
                        const groupId = await chrome.tabs.group({ tabIds: [tabs[0].id] });
                        const groupTitle = message.taskTitle || message.goalTitle || 'Focus Session';
                        await chrome.tabGroups.update(groupId, {
                            title: `🎯 ${groupTitle}`,
                            color: 'blue',
                            collapsed: false,
                        });
                        focusSession.tabGroupId = groupId;
                    }
                } catch (e) { console.warn('Could not create focus tab group:', e); }

                // Set a timer alarm for session expiry
                chrome.alarms.create('focusSessionEnd', {
                    delayInMinutes: message.durationMinutes || 60
                });

                // Set a fast nudge alarm for focus drift detection (every 30s)
                chrome.alarms.create('focusNudge', {
                    periodInMinutes: 0.5
                });

                // Update badge to show focus mode
                chrome.action.setBadgeText({ text: '🎯' });
                chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });

                // Persist to storage
                chrome.storage.local.set({ focusSession });

                console.log('[LifeOS] Focus session started:', focusSession);
            } catch (e) {
                console.error('[LifeOS] Failed to start focus session:', e);
            }
        })();
        sendResponse({ ok: true });
    }

    if (message.type === 'STOP_FOCUS') {
        (async () => {
            try {
                await endFocusSession('completed');
            } catch (e) {
                console.error('[LifeOS] Failed to stop focus session:', e);
            }
        })();
        sendResponse({ ok: true });
    }

    if (message.type === 'GET_FOCUS_STATUS') {
        if (focusSession && focusSession.active) {
            const elapsed = Math.round((Date.now() - focusSession.startedAt) / 1000);
            const remaining = (focusSession.durationMinutes * 60) - elapsed;
            sendResponse({
                active: true,
                goalTitle: focusSession.goalTitle,
                taskTitle: focusSession.taskTitle,
                durationMinutes: focusSession.durationMinutes,
                elapsedSeconds: elapsed,
                remainingSeconds: Math.max(0, remaining),
                blockedCount: focusSession.blockedCount,
                overrideCount: focusSession.overrideCount,
                tabGroupId: focusSession.tabGroupId,
            });
        } else {
            sendResponse({ active: false });
        }
    }

    if (message.type === 'FOCUS_OVERRIDE_LOGGED') {
        if (focusSession && focusSession.active) {
            focusSession.overrideCount++;
            chrome.storage.local.set({ focusSession });
        }
        sendResponse({ ok: true });
    }

    return true; // Keep message channel open for async responses
});

// Utilities

// Track tab group renames/recoloring in real-time
if (chrome.tabGroups && chrome.tabGroups.onUpdated) {
    chrome.tabGroups.onUpdated.addListener((group) => {
        if (currentActivity && currentActivity.tab_group_id === group.id) {
            currentActivity.tab_group_title = group.title || null;
            currentActivity.tab_group_color = group.color || null;
            chrome.storage.local.set({ currentActivity });
        }
    });
}

function extractDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

function extractYouTubeVideoId(url) {
    try {
        const u = new URL(url);
        return u.searchParams.get('v') || null;
    } catch {
        return null;
    }
}

// ==========================================
// Phase 20: TabAI Replacements (Context Engine, Tasks, Sidebar)
// ==========================================

// 1. Context Menu Task Extraction Listener
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "send-to-lifeos" && info.selectionText) {

        // Ensure we don't accidentally extract tasks from sensitive domains
        if (tab && tab.url) {
            const taskDomain = extractDomain(tab.url);
            if (isPrivacyBlocked(tab.url, taskDomain)) {
                console.warn('LifeOS: Blocked attempt to extract task from sensitive domain.');
                return;
            }
        }

        try {
            const dataInfo = await chrome.storage.local.get('apiKey');
            const apiKey = dataInfo.apiKey;
            const res = await fetch(`${API_BASE}/extension/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                body: JSON.stringify({
                    text: info.selectionText,
                    url: tab?.url,
                    title: tab?.title
                })
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

// 2. Context-Aware Blocking Engine
let activeContext = { activeGoals: [], activeTasks: [] };
let lastContextFetch = 0;

async function refreshContext() {
    if (Date.now() - lastContextFetch < 30000) return;
    try {
        const res = await fetch(`${API_BASE}/extension/session`);
        if (res.ok) {
            activeContext = await res.json();
            lastContextFetch = Date.now();
        }
    } catch (e) {
        console.warn('LifeOS backend unreachable. Context polling failed.');
    }
}

// 3. Intercept new pages being loaded for Distraction AI
const evaluationCache = new Map();

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
        // Skip privacy-sensitive domains — never send to AI
        const evalDomain = extractDomain(tab.url);
        if (isPrivacyBlocked(tab.url, evalDomain)) return;

        // Determine if we should evaluate for blocking
        const inFocus = focusSession && focusSession.active;

        // In non-focus mode, still need active goals to evaluate
        if (!inFocus) {
            await refreshContext();
            if (!activeContext.activeGoals || activeContext.activeGoals.length === 0) return;
        }

        const cacheKey = inFocus
            ? `focus::${focusSession.sessionId}::${tab.url}`
            : `${tab.url}::${activeContext.activeGoals.map(g => g.id).join('-')}`;

        if (evaluationCache.has(cacheKey)) {
            const cached = evaluationCache.get(cacheKey);
            if (Date.now() - cached.timestamp < 3600000) {
                if (cached.isDistraction) {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'BLOCK_PAGE',
                        reason: cached.reason,
                        goals: inFocus ? [{ title: focusSession.goalTitle || focusSession.taskTitle || 'Focus Session' }] : activeContext.activeGoals,
                        focusMode: inFocus,
                        focusGoalTitle: inFocus ? focusSession.goalTitle : null,
                        focusTaskTitle: inFocus ? focusSession.taskTitle : null,
                        remainingMinutes: inFocus ? Math.max(0, Math.round(((focusSession.durationMinutes * 60) - (Date.now() - focusSession.startedAt) / 1000) / 60)) : null,
                    });
                }
                return;
            } else {
                evaluationCache.delete(cacheKey);
            }
        }

        try {
            const dataInfo = await chrome.storage.local.get('apiKey');
            const apiKey = dataInfo.apiKey;

            const evalBody = {
                url: tab.url,
                title: tab.title || '',
                activeGoals: inFocus ? [] : activeContext.activeGoals,
                focusMode: inFocus,
                focusGoalTitle: inFocus ? focusSession.goalTitle : undefined,
                focusTaskTitle: inFocus ? focusSession.taskTitle : undefined,
            };

            const res = await fetch(`${API_BASE}/extension/evaluate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
                body: JSON.stringify(evalBody)
            });

            if (res.ok) {
                const { isDistraction, reason, confidence } = await res.json();

                evaluationCache.set(cacheKey, { isDistraction, reason, timestamp: Date.now() });

                if (isDistraction) {
                    // Track blocked count during focus sessions
                    if (inFocus) {
                        focusSession.blockedCount++;
                        chrome.storage.local.set({ focusSession });
                    }

                    chrome.tabs.sendMessage(tabId, {
                        type: 'BLOCK_PAGE',
                        reason: reason,
                        goals: inFocus ? [{ title: focusSession.goalTitle || focusSession.taskTitle || 'Focus Session' }] : activeContext.activeGoals,
                        focusMode: inFocus,
                        focusGoalTitle: inFocus ? focusSession.goalTitle : null,
                        focusTaskTitle: inFocus ? focusSession.taskTitle : null,
                        remainingMinutes: inFocus ? Math.max(0, Math.round(((focusSession.durationMinutes * 60) - (Date.now() - focusSession.startedAt) / 1000) / 60)) : null,
                    });
                }
            }
        } catch (e) { }
    }
});

// --- Focus Session Helper: End Session ---
async function endFocusSession(status = 'completed') {
    if (!focusSession || !focusSession.active) return;

    const actualDurationSeconds = Math.round((Date.now() - focusSession.startedAt) / 1000);
    focusSession.active = false;

    // Cancel the timer alarm
    chrome.alarms.clear('focusSessionEnd');
    chrome.alarms.clear('focusNudge');

    // Clear focus badge
    chrome.action.setBadgeText({ text: '' });

    try {
        const dataInfo = await chrome.storage.local.get('apiKey');
        const apiKey = dataInfo.apiKey;

        // Send session data to backend for AI report generation
        const res = await fetch(`${API_BASE}/focus-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({
                action: 'complete',
                sessionId: focusSession.sessionId,
                activities: focusSession.activitiesLog,
                blockedCount: focusSession.blockedCount,
                overrideCount: focusSession.overrideCount,
                actualDurationSeconds,
            })
        });

        if (res.ok) {
            const data = await res.json();
            // Show notification with session summary
            chrome.notifications.create('focus-complete', {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: '🎯 Focus Session Complete!',
                message: `${Math.round(actualDurationSeconds / 60)} minutes focused on "${focusSession.goalTitle || focusSession.taskTitle || 'Session'}". Open LifeOS for your detailed report.`,
            });

            // Store report ID for popup to link to
            chrome.storage.local.set({
                lastFocusReport: {
                    sessionId: focusSession.sessionId,
                    report: data.report,
                    stats: data.stats,
                    timestamp: Date.now(),
                }
            });
        }
    } catch (e) {
        console.error('[LifeOS] Failed to complete focus session on backend:', e);
    }

    // Clear focus session state
    focusSession = null;
    chrome.storage.local.remove('focusSession');
    evaluationCache.clear();
}
