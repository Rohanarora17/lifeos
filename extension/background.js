// LifeOS — Background Service Worker
// Tracks active tab, time on page, and polls for nudges

const API_BASE = 'http://localhost:3000/api';
const NUDGE_INTERVAL_MS = 60000; // Check nudges every 60s
const IDLE_THRESHOLD_S = 300; // 5 minutes

let currentActivity = null;
let isUserActive = true;

// Initialize
chrome.runtime.onInstalled.addListener(() => {
    console.log('LifeOS Tracker installed');
    chrome.alarms.create('flushActivities', { periodInMinutes: 2 });
    chrome.alarms.create('checkNudge', { periodInMinutes: 1 });
});

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
        // Window lost focus — finalize current activity
        finalizeCurrentActivity();
    } else {
        // Window gained focus — start tracking active tab
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
        isUserActive = false;
        finalizeCurrentActivity();
    }
});

// Handle tab change
function handleTabChange(tab) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
        return;
    }

    const newDomain = extractDomain(tab.url);

    // Track tab switch for focus/entropy analysis
    if (currentActivity && currentActivity.domain !== newDomain) {
        try {
            fetch(`${API_BASE}/behavior`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'tab_switch',
                    from_domain: currentActivity.domain,
                    to_domain: newDomain,
                    from_category: currentActivity._category || '',
                    to_category: '',
                }),
            }).catch(() => { });
        } catch (e) { }
    }

    // Finalize previous activity
    finalizeCurrentActivity();

    // Start new activity
    currentActivity = {
        url: tab.url,
        domain: newDomain,
        title: tab.title || '',
        started_at: new Date().toISOString(),
        youtube_video_id: null,
        youtube_channel: null,
        _category: null, // filled by backend response
    };

    // If YouTube, the content script will send video details
    if (newDomain === 'youtube.com' || newDomain === 'www.youtube.com' || newDomain === 'm.youtube.com') {
        const videoId = extractYouTubeVideoId(tab.url);
        if (videoId) {
            currentActivity.youtube_video_id = videoId;
        }
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
async function finalizeCurrentActivity() {
    if (!currentActivity) return;

    const now = new Date().toISOString();
    const startTime = new Date(currentActivity.started_at).getTime();
    const endTime = new Date(now).getTime();
    const durationSeconds = Math.round((endTime - startTime) / 1000);

    // Only log if > 2 seconds
    if (durationSeconds < 2) {
        currentActivity = null;
        return;
    }

    const activity = {
        ...currentActivity,
        ended_at: now,
        duration_seconds: durationSeconds,
    };

    currentActivity = null;
    chrome.storage.local.remove('currentActivity');
    await queueActivity(activity);
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
                await queueActivity({
                    ...currentActivity,
                    ended_at: now,
                    duration_seconds: durationSeconds,
                });
                currentActivity.started_at = now;
            }
        }

        // Flush pending activities in a batch
        const { pendingActivities } = await chrome.storage.local.get('pendingActivities');
        if (pendingActivities && pendingActivities.length > 0) {
            try {
                const res = await fetch(`${API_BASE}/activity/batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
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

    if (alarm.name === 'checkNudge') {
        if (!currentActivity || !isUserActive) return;

        const domain = currentActivity.domain;
        const minutesOnSite = Math.round(
            (Date.now() - new Date(currentActivity.started_at).getTime()) / 60000
        );

        try {
            const videoIdParam = currentActivity.youtube_video_id ? `&videoId=${encodeURIComponent(currentActivity.youtube_video_id)}` : '';
            const res = await fetch(
                `${API_BASE}/nudge?url=${encodeURIComponent(currentActivity.url)}&domain=${encodeURIComponent(domain)}&minutes=${minutesOnSite}&title=${encodeURIComponent(currentActivity.title || '')}${videoIdParam}`
            );
            const data = await res.json();

            if (data.nudge && data.message) {
                // Show notification
                chrome.notifications.create('lifeos-nudge', {
                    type: 'basic',
                    iconUrl: 'icons/icon128.png',
                    title: '⚡ LifeOS — Refocus!',
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

    if (message.type === 'GET_CURRENT_ACTIVITY') {
        sendResponse({ activity: currentActivity, isActive: isUserActive });
    }
});

// Utilities
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
